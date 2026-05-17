import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { detectPlatform } from '../main/modules/rss-engine/scrapers/index'
import {
  BilibiliScraper,
  DouyinScraper,
  WeiboScraper,
  XiaohongshuScraper,
  isLikelyStaleBilibiliResult,
  resolveBilibiliStaleRouteResult,
} from '../main/modules/rss-engine/scrapers/rsshub'

describe('RSS scraper platform detection', () => {
  it('detects creator watchlist URLs by platform', () => {
    assert.equal(detectPlatform('https://space.bilibili.com/1577804'), 'bilibili')
    assert.equal(detectPlatform('https://www.youtube.com/@matthewencina'), 'youtube')
    assert.equal(detectPlatform('https://www.xiaohongshu.com/user/profile/5fc91b41000000000101fe32'), 'xiaohongshu')
    assert.equal(detectPlatform('https://xhsurl.cn/abc123'), 'xiaohongshu')
    assert.equal(detectPlatform('https://weibo.com/u/6182606334'), 'weibo')
    assert.equal(detectPlatform('https://m.weibo.cn/profile/6182606334'), 'weibo')
    assert.equal(detectPlatform('https://vimeo.com/offf'), 'vimeo')
    assert.equal(detectPlatform('https://www.behance.net/yokohara6e48'), 'behance')
    assert.equal(detectPlatform('https://x.com/op7418'), 'twitter')
    assert.equal(detectPlatform('https://t.zsxq.com/7DCdg'), 'zsxq')
  })
})

describe('DouyinScraper', () => {
  it('extracts sec_uid from Douyin share URLs after redirect resolution', () => {
    const scraper = new DouyinScraper('http://127.0.0.1:1240')
    const url =
      'https://www.iesdouyin.com/share/user/MS4wLjABAAAALOZo7U1a1Vx6naYNstpIKkhwgCA6Gxiz9H_yKHu_hKKIynxXzGDdoFesfAkBc6O0?did=MS4wLjABAAAAZ1KBsSPaEumKpeiiuVw-Zl1lKS9wrfJW9Gb22FVDOs7cVBRghFYZD89PQ8NC6UKp&iid=MS4wLjABAAAA2riyDQLlqSkpi5dtS_r6YSKVmSUF7e_JCIVWo9zYEa_q3zdu6XNqKuPhJZFnnq5a&with_sec_did=1&sec_uid=MS4wLjABAAAALOZo7U1a1Vx6naYNstpIKkhwgCA6Gxiz9H_yKHu_hKKIynxXzGDdoFesfAkBc6O0'

    assert.equal(
      scraper.extractUserId(url),
      'MS4wLjABAAAALOZo7U1a1Vx6naYNstpIKkhwgCA6Gxiz9H_yKHu_hKKIynxXzGDdoFesfAkBc6O0',
    )
  })

  it('does not retry WAF-like route failures', async () => {
    const scraper = new DouyinScraper('http://127.0.0.1:1240') as DouyinScraper & {
      fetchRoute: (routePath: string, platform: string) => Promise<{
        items: never[]
        feedTitle: string
        platform: string
        error?: string
      }>
    }

    let attempts = 0
    scraper.fetchRoute = async (_routePath, platform) => {
      attempts += 1
      return {
        items: [],
        feedTitle: '',
        platform,
        error: 'Empty post data',
      }
    }

    await scraper.fetchItems('https://www.douyin.com/user/MS4wLjABAAAATEST')

    assert.equal(attempts, 1)
  })
})

describe('Bilibili freshness heuristic', () => {
  it('treats very old bilibili route results as likely stale', () => {
    const stale = isLikelyStaleBilibiliResult({
      items: [
        {
          itemId: 'bilibili_1',
          title: '旧视频',
          description: '',
          link: 'https://www.bilibili.com/video/BV1fr421M7y7',
          pubDate: '2026-03-04T11:00:00.000Z',
          author: '',
          coverImage: null,
          metadata: {},
        },
      ],
      feedTitle: 'Bilibili 39627524',
      platform: 'bilibili',
    }, Date.parse('2026-03-31T08:00:00.000Z'))

    assert.equal(stale, true)
  })

  it('prefers browser items when stale bilibili upstream data is replaced by a fresher browser result', () => {
    const resolved = resolveBilibiliStaleRouteResult(
      {
        items: [
          {
            itemId: 'bilibili_old',
            title: '旧视频',
            description: '',
            link: 'https://www.bilibili.com/video/BV1oldoldold',
            pubDate: '2026-03-04T11:00:00.000Z',
            author: '',
            coverImage: null,
            metadata: {},
          },
        ],
        feedTitle: 'Bilibili 39627524',
        platform: 'bilibili',
      },
      {
        items: [
          {
            itemId: 'bilibili_new',
            title: '新视频',
            description: '',
            link: 'https://www.bilibili.com/video/BV1newnewnew',
            pubDate: '',
            author: '',
            coverImage: null,
            metadata: {},
          },
        ],
        feedTitle: '某幻君投稿视频',
        platform: 'bilibili',
      },
      Date.parse('2026-03-31T08:00:00.000Z'),
    )

    assert.equal(resolved.backend, 'browser')
    assert.equal(resolved.result.items[0]?.title, '新视频')
    assert.match(resolved.result.error || '', /浏览器页面兜底/)
  })

  it('surfaces the browser failure instead of silently accepting stale bilibili results', () => {
    const resolved = resolveBilibiliStaleRouteResult(
      {
        items: [
          {
            itemId: 'bilibili_old',
            title: '旧视频',
            description: '',
            link: 'https://www.bilibili.com/video/BV1oldoldold',
            pubDate: '2026-03-04T11:00:00.000Z',
            author: '',
            coverImage: null,
            metadata: {},
          },
        ],
        feedTitle: 'Bilibili 39627524',
        platform: 'bilibili',
      },
      {
        items: [],
        feedTitle: '某幻君投稿视频',
        platform: 'bilibili',
        error: 'Bilibili 应用内浏览器会话当前未登录，或已被重定向到登录页。',
      },
      Date.parse('2026-03-31T08:00:00.000Z'),
    )

    assert.equal(resolved.backend, 'browser')
    assert.equal(resolved.result.items.length, 0)
    assert.match(resolved.result.error || '', /接口返回内容偏旧/)
    assert.match(resolved.result.error || '', /未登录/)
  })
})

describe('BilibiliScraper route priority', () => {
  it('prefers the rsshub video route over older polymer fallback data', async () => {
    const scraper = new BilibiliScraper('http://127.0.0.1:1240') as BilibiliScraper & {
      resolveUserId: (url: string) => Promise<string | null>
      fetchViaPolymerAPI: (userId: string) => Promise<import('../main/modules/rss-engine/scrapers/base').ScrapeResult>
      fetchRoute: (routePath: string, platform: string) => Promise<import('../main/modules/rss-engine/scrapers/base').ScrapeResult>
      fetchViaOfficialAPI: (userId: string) => Promise<import('../main/modules/rss-engine/scrapers/base').ScrapeResult>
    }

    const calls: string[] = []
    scraper.resolveUserId = async () => '946974'
    scraper.fetchViaPolymerAPI = async () => {
      calls.push('polymer')
      return {
        items: [
          {
            itemId: 'polymer_old',
            title: '旧合集内容',
            description: '',
            link: 'https://www.bilibili.com/video/BV1oldoldold',
            pubDate: '2026-01-06T09:00:00.000Z',
            author: '',
            coverImage: null,
            metadata: {},
          },
        ],
        feedTitle: '影视飓风',
        platform: 'bilibili',
      }
    }
    scraper.fetchRoute = async (routePath, platform) => {
      calls.push(routePath)
      if (routePath.includes('/video/')) {
        return {
          items: [
            {
              itemId: 'rsshub_new',
              title: '最新投稿',
              description: '',
              link: 'https://www.bilibili.com/video/BV1newnewnew',
              pubDate: '2026-03-31T09:00:00.000Z',
              author: '',
              coverImage: null,
              metadata: {},
            },
          ],
          feedTitle: '影视飓风',
          platform,
        }
      }
      return {
        items: [],
        feedTitle: '',
        platform,
        error: 'should not reach dynamic when video route already works',
      }
    }
    scraper.fetchViaOfficialAPI = async () => {
      calls.push('official')
      return {
        items: [],
        feedTitle: '',
        platform: 'bilibili',
        error: 'should not reach official when video route already works',
      }
    }

    const result = await scraper.fetchItems('https://space.bilibili.com/946974')

    assert.equal(result.items[0]?.title, '最新投稿')
    assert.equal(calls[0], '/bilibili/user/video/946974')
    assert.equal(calls.includes('polymer'), false)
  })
})

describe('WeiboScraper', () => {
  it('extracts user id from mobile profile URLs', () => {
    const scraper = new WeiboScraper('http://127.0.0.1:1240')

    assert.equal(scraper.extractUserId('https://m.weibo.cn/profile/6182606334'), '6182606334')
    assert.equal(scraper.extractUserId('https://m.weibo.cn/u/6182606334'), '6182606334')
    assert.equal(
      scraper.extractUserId('https://m.weibo.cn/p/index?containerid=1005056182606334'),
      '6182606334',
    )
  })
})

describe('XiaohongshuScraper', () => {
  it('keeps RSSHub JSON items separate when the route reuses the profile link', () => {
    class TestXiaohongshuScraper extends XiaohongshuScraper {
      parseForTest(payload: {
        item: Array<{ title: string; link: string; guid: string }>
        title: string
      }) {
        return this.parseJSONFeed(payload, 'xiaohongshu')
      }
    }
    const scraper = new TestXiaohongshuScraper('http://127.0.0.1:1240')
    const result = scraper.parseForTest({
      title: '广州潮会吃 - 小红书笔记',
      item: [
        {
          title: '广州越来越少见的纯手工茶楼。。。。',
          link: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06',
          guid: '广州越来越少见的纯手工茶楼。。。。',
        },
        {
          title: '广州真正好味的纯手工茶楼！！！',
          link: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06',
          guid: '广州真正好味的纯手工茶楼！！！',
        },
      ],
    })

    assert.equal(result.items.length, 2)
    assert.notEqual(result.items[0]?.itemId, result.items[1]?.itemId)
    assert.equal(result.items[0]?.metadata.rssGuid, '广州越来越少见的纯手工茶楼。。。。')
  })

  it('does not treat note or explore URLs as user IDs', () => {
    const scraper = new XiaohongshuScraper('http://127.0.0.1:1240')

    assert.equal(
      scraper.extractUserId('https://www.xiaohongshu.com/explore/65a123456789012345678901'),
      null,
    )
    assert.equal(
      scraper.extractUserId('https://www.xiaohongshu.com/discovery/item/65a123456789012345678901'),
      null,
    )
  })

  it('resolves xhs short links before extracting user id', async () => {
    const scraper = new XiaohongshuScraper('http://127.0.0.1:1240') as XiaohongshuScraper & {
      resolveFinalUrl: (url: string) => Promise<string>
      fetchRouteWithRecovery: (routePath: string, platform: string) => Promise<{
        items: never[]
        feedTitle: string
        platform: string
      }>
    }

    let requestedRoute = ''
    scraper.resolveFinalUrl = async () => 'https://www.xiaohongshu.com/user/profile/5fc91b41000000000101fe32'
    scraper.fetchRouteWithRecovery = async (routePath, platform) => {
      requestedRoute = `${platform}:${routePath}`
      return {
        items: [],
        feedTitle: '',
        platform,
      }
    }

    await scraper.fetchItems('https://xhslink.com/abc123')

    assert.equal(requestedRoute, 'xiaohongshu:/xiaohongshu/user/5fc91b41000000000101fe32/notes')
  })

  it('explains RSSHub parser failures without exposing raw route internals', async () => {
    const scraper = new XiaohongshuScraper('http://127.0.0.1:1240') as XiaohongshuScraper & {
      fetchRoute: (routePath: string, platform: string) => Promise<{
        items: never[]
        feedTitle: string
        platform: string
        error?: string
      }>
    }

    scraper.fetchRoute = async (_routePath, platform) => ({
      items: [],
      feedTitle: '',
      platform,
      error: "HTTP 503: Service Unavailable | Cannot read properties of undefined (reading 'user')",
    })

    const result = await scraper.fetchItems('https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06')

    assert.match(result.error || '', /RSSHub 暂时没有解析到公开笔记/)
  })

  it('explains RSSHub timeouts without leaking AbortError text', async () => {
    const scraper = new XiaohongshuScraper('http://127.0.0.1:1240') as XiaohongshuScraper & {
      fetchRoute: (routePath: string, platform: string) => Promise<{
        items: never[]
        feedTitle: string
        platform: string
        error?: string
      }>
    }

    scraper.fetchRoute = async (_routePath, platform) => ({
      items: [],
      feedTitle: '',
      platform,
      error: 'This operation was aborted',
    })

    const result = await scraper.fetchItems('https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06')

    assert.match(result.error || '', /RSSHub 路由请求超时/)
  })

  it('retries transient browser route failures once', async () => {
    const scraper = new XiaohongshuScraper('http://127.0.0.1:1240') as XiaohongshuScraper & {
      fetchRoute: (routePath: string, platform: string) => Promise<{
        items: never[]
        feedTitle: string
        platform: string
        error?: string
      }>
    }

    let attempts = 0
    scraper.fetchRoute = async (_routePath, platform) => {
      attempts += 1
      if (attempts === 1) {
        return {
          items: [],
          feedTitle: '',
          platform,
          error: 'TargetCloseError: target closed',
        }
      }
      return {
        items: [],
        feedTitle: '',
        platform,
      }
    }

    await scraper.fetchItems('https://www.xiaohongshu.com/user/profile/5fc91b41000000000101fe32')

    assert.equal(attempts, 2)
  })
})
