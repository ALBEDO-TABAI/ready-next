import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import {
  buildExtractionScriptForTest,
  fetchFeedViaBrowserSession,
  normalizeBrowserAcquisitionUrl,
  supportsBrowserSessionAcquisition,
} from '../main/modules/rss-engine/browser-acquisition'

async function runExtractionScript(
  platform: Parameters<typeof buildExtractionScriptForTest>[0],
  targetUrl: string,
  options?: {
    bodyText?: string
    title?: string
    href?: string
  },
) {
  const script = buildExtractionScriptForTest(platform, targetUrl)
  return vm.runInNewContext(script, {
    document: {
      title: options?.title || '',
      body: { innerText: options?.bodyText || '' },
      scripts: [],
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    location: { href: options?.href || targetUrl },
    window: { scrollTo: () => undefined },
    MouseEvent: function MouseEvent() {},
    setTimeout: (fn: () => void) => {
      fn()
      return 0
    },
    clearTimeout: () => undefined,
    URL,
  })
}

describe('RSS browser acquisition', () => {
  it('marks weibo/xiaohongshu/douyin as browser-session capable', () => {
    assert.equal(supportsBrowserSessionAcquisition('weibo'), true)
    assert.equal(supportsBrowserSessionAcquisition('xiaohongshu'), true)
    assert.equal(supportsBrowserSessionAcquisition('douyin'), true)
    assert.equal(supportsBrowserSessionAcquisition('youtube'), false)
  })

  it('normalizes extracted browser candidates into scraped items', async () => {
    const controller = {
      captureBackgroundPage: async () => ({
        title: '创作者主页',
        finalUrl: 'https://www.xiaohongshu.com/user/profile/abc',
        items: [
          {
            title: '第一条内容',
            link: 'https://www.xiaohongshu.com/explore/1',
            description: '描述一',
          },
          {
            title: '第一条内容',
            link: 'https://www.xiaohongshu.com/explore/1',
            description: '重复内容',
          },
          {
            title: '第二条内容',
            link: 'https://www.xiaohongshu.com/explore/2',
            description: '描述二',
          },
          {
            title: '坏链接',
            link: 'https://www.xiaohongshu.com/explore/',
            description: '应当被过滤',
          },
        ],
      }),
    }

    const result = await fetchFeedViaBrowserSession(controller as any, 'xiaohongshu', 'https://xhslink.com/demo')

    assert.equal(result.feedTitle, '创作者主页')
    assert.equal(result.items.length, 2)
    assert.equal(result.items[0]?.title, '第一条内容')
    assert.equal(result.items[1]?.title, '第二条内容')
    assert.equal(result.error, undefined)
  })

  it('accepts bilibili video links returned by browser capture', async () => {
    const controller = {
      captureBackgroundPage: async () => ({
        title: 'UP主空间',
        finalUrl: 'https://space.bilibili.com/39627524/upload/video',
        items: [
          {
            title: '最新视频',
            link: 'https://www.bilibili.com/video/BV1fr421M7y7',
            description: '视频简介',
          },
        ],
      }),
    }

    const result = await fetchFeedViaBrowserSession(
      controller as any,
      'bilibili' as any,
      'https://space.bilibili.com/39627524/upload/video',
    )

    assert.equal(result.items.length, 1)
    assert.equal(result.items[0]?.link, 'https://www.bilibili.com/video/BV1fr421M7y7')
    assert.equal(result.error, undefined)
  })

  it('enriches bilibili browser items with view count and exact publish time', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/x/web-interface/view?bvid=BV1fr421M7y7')) {
        return {
          json: async () => ({
            code: 0,
            data: {
              desc: '这是完整视频简介',
              pubdate: 1774957200,
              stat: { view: 793379 },
            },
          }),
        } as Response
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    try {
      const controller = {
        captureBackgroundPage: async () => ({
          title: 'UP主空间',
          finalUrl: 'https://space.bilibili.com/39627524/upload/video',
          items: [
            {
              title: '最新视频',
              link: 'https://www.bilibili.com/video/BV1fr421M7y7',
              description: '79.3万 4321 03-31',
            },
          ],
        }),
      }

      const result = await fetchFeedViaBrowserSession(
        controller as any,
        'bilibili' as any,
        'https://space.bilibili.com/39627524/upload/video',
      )

      assert.equal(result.items[0]?.author, '播放量 79.3万')
      assert.equal(result.items[0]?.pubDate, '2026-03-31T11:40:00.000Z')
      assert.equal(result.items[0]?.description, '这是完整视频简介')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('filters malformed xiaohongshu links returned by browser capture', async () => {
    const controller = {
      captureBackgroundPage: async () => ({
        title: '创作者主页',
        finalUrl: 'https://www.xiaohongshu.com/user/profile/abc',
        items: [
          {
            title: '坏链接',
            link: 'https://www.xiaohongshu.com/explore/',
            description: '应当被过滤',
          },
        ],
      }),
    }

    const result = await fetchFeedViaBrowserSession(controller as any, 'xiaohongshu', 'https://xhslink.com/demo')

    assert.equal(result.items.length, 0)
    assert.match(result.error || '', /未提取到可用条目/)
  })

  it('uses a lightweight xiaohongshu follow-up capture after the source has already been seeded', async () => {
    let captureOptions: { timeoutMs?: number; settleMs?: number; script?: string } | null = null
    const controller = {
      captureBackgroundPage: async (_url: string, options?: { timeoutMs?: number; settleMs?: number; script?: string }) => {
        captureOptions = options || null
        return {
          title: '创作者主页',
          finalUrl: 'https://www.xiaohongshu.com/user/profile/abc',
          items: [
            {
              title: '首屏新内容',
              link: 'https://www.xiaohongshu.com/explore/new',
              description: '描述一',
            },
          ],
        }
      },
    }

    const result = await (fetchFeedViaBrowserSession as any)(
      controller,
      'xiaohongshu',
      'https://www.xiaohongshu.com/user/profile/abc',
      { mode: 'incremental' },
    )

    assert.equal(result.items.length, 1)
    assert.equal(captureOptions?.timeoutMs, 6_000)
    assert.equal(captureOptions?.settleMs, 1_000)
    assert.doesNotMatch(captureOptions?.script || '', /window\.scrollTo/)
  })

  it('accepts xiaohongshu profile-card fallback links when note ids are missing', async () => {
    const controller = {
      captureBackgroundPage: async () => ({
        title: '创作者主页',
        finalUrl: 'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60',
        items: [
          {
            title: '第一条内容',
            link: 'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60#note-first-1',
            description: '描述一',
          },
          {
            title: '第二条内容',
            link: 'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60#note-second-2',
            description: '描述二',
          },
        ],
      }),
    }

    const result = await fetchFeedViaBrowserSession(
      controller as any,
      'xiaohongshu',
      'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60',
    )

    assert.equal(result.items.length, 2)
    assert.equal(
      result.items[0]?.link,
      'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60#note-first-1',
    )
    assert.equal(
      result.items[1]?.link,
      'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60#note-second-2',
    )
    assert.equal(result.error, undefined)
  })

  it('treats xiaohongshu fallback profile cards with changed content as new items', async () => {
    const firstController = {
      captureBackgroundPage: async () => ({
        title: '创作者主页',
        finalUrl: 'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60',
        items: [
          {
            title: '小红书内容',
            link: 'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60#note-card-1',
            description: '第一条图文内容',
          },
        ],
      }),
    }
    const secondController = {
      captureBackgroundPage: async () => ({
        title: '创作者主页',
        finalUrl: 'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60',
        items: [
          {
            title: '小红书内容',
            link: 'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60#note-card-1',
            description: '第二条新内容',
          },
        ],
      }),
    }

    const first = await fetchFeedViaBrowserSession(
      firstController as any,
      'xiaohongshu',
      'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60',
    )
    const second = await fetchFeedViaBrowserSession(
      secondController as any,
      'xiaohongshu',
      'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60',
    )

    assert.equal(first.items.length, 1)
    assert.equal(second.items.length, 1)
    assert.notEqual(first.items[0]?.itemId, second.items[0]?.itemId)
  })

  it('normalizes browser acquisition URLs into canonical profile routes', async () => {
    const douyin = await normalizeBrowserAcquisitionUrl(
      'douyin',
      'https://www.iesdouyin.com/share/user/demo?sec_uid=MS4wLjABAAAATEST',
    )
    const xiaohongshu = await normalizeBrowserAcquisitionUrl(
      'xiaohongshu',
      'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60?foo=bar',
    )
    const weibo = await normalizeBrowserAcquisitionUrl(
      'weibo',
      'https://m.weibo.cn/profile/6182606334',
    )

    assert.equal(
      douyin,
      'https://www.iesdouyin.com/share/user/demo?sec_uid=MS4wLjABAAAATEST',
    )
    assert.equal(xiaohongshu, 'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60')
    assert.equal(weibo, 'https://weibo.com/u/6182606334')
  })

  it('compiles the xiaohongshu browser extraction script', () => {
    const script = buildExtractionScriptForTest(
      'xiaohongshu',
      'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60',
    )

    assert.doesNotThrow(() => {
      new vm.Script(script)
    })
  })

  it('compiles the bilibili browser extraction script', () => {
    const script = buildExtractionScriptForTest(
      'bilibili' as any,
      'https://space.bilibili.com/39627524/upload/video',
    )

    assert.doesNotThrow(() => {
      new vm.Script(script)
    })
  })

  it('compiles the weibo browser extraction script', () => {
    const script = buildExtractionScriptForTest(
      'weibo',
      'https://weibo.com/u/6182606334',
    )

    assert.doesNotThrow(() => {
      new vm.Script(script)
    })
  })

  it('prefers reusable live tabs before background capture for weibo', async () => {
    let liveCalled = 0
    let backgroundCalled = 0
    const controller = {
      captureLiveTabPage: async () => {
        liveCalled += 1
        return {
          title: '微博主页',
          finalUrl: 'https://weibo.com/u/6182606334',
          items: [
            {
              title: '微博内容一',
              link: 'https://weibo.com/detail/Pabc123',
              description: '内容一',
            },
          ],
        }
      },
      captureBackgroundPage: async () => {
        backgroundCalled += 1
        return null
      },
    }

    const result = await fetchFeedViaBrowserSession(
      controller as any,
      'weibo',
      'https://weibo.com/u/6182606334',
    )

    assert.equal(liveCalled, 1)
    assert.equal(backgroundCalled, 0)
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0]?.link, 'https://weibo.com/detail/Pabc123')
  })

  it('surfaces a useful error when the page loads but no feed-like items are found', async () => {
    const controller = {
      captureBackgroundPage: async () => ({
        title: '空白主页',
        finalUrl: 'https://www.douyin.com/user/demo',
        items: [],
      }),
    }

    const result = await fetchFeedViaBrowserSession(controller as any, 'douyin', 'https://v.douyin.com/demo')

    assert.equal(result.items.length, 0)
    assert.match(result.error || '', /未提取到可用条目/)
  })

  it('surfaces a login-required error when browser session is redirected to login', async () => {
    let seenOptions: Record<string, unknown> | undefined
    const controller = {
      captureBackgroundPage: async (_url: string, options?: Record<string, unknown>) => {
        seenOptions = options
        return ({
        title: '小红书登录',
        finalUrl: 'https://www.xiaohongshu.com/login?redirectPath=%2Fuser%2Fprofile%2Fabc',
        state: 'auth',
        items: [],
        })
      },
    }

    const result = await fetchFeedViaBrowserSession(
      controller as any,
      'xiaohongshu',
      'https://www.xiaohongshu.com/user/profile/abc',
    )

    assert.equal(result.items.length, 0)
    assert.match(result.error || '', /未登录|登录页/)
    assert.equal(seenOptions?.cookies, undefined)
  })

  it('treats bilibili empty pages with login prompts as auth-required instead of generic empty results', async () => {
    const result = await runExtractionScript(
      'bilibili' as any,
      'https://space.bilibili.com/1577804/upload/video',
      {
        title: '某幻君投稿视频-某幻君视频分享-哔哩哔哩视频',
        bodyText:
          '登录后你可以 免费看高清视频 多端同步播放记录 立即登录 首次使用？ 点我注册 空间主人还没投过视频，这里什么也没有...',
      },
    )

    assert.equal((result as { state?: string }).state, 'auth')
    assert.equal((result as { detail?: string }).detail, 'browser_session_login_required')
  })

  it('surfaces an anti-bot error when browser session hits verification', async () => {
    const controller = {
      captureBackgroundPage: async () => ({
        title: '抖音',
        finalUrl: 'https://www.douyin.com/user/demo',
        state: 'anti_bot',
        textSnippet: '系统检测到异常行为，请先完成验证',
        items: [],
      }),
    }

    const result = await fetchFeedViaBrowserSession(
      controller as any,
      'douyin',
      'https://v.douyin.com/demo',
    )

    assert.equal(result.items.length, 0)
    assert.match(result.error || '', /验证码|风控|验证/)
  })
})
