import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import vm from 'node:vm'

import type { BackgroundPageHandle, CapturedPageResponse } from '../main/modules/browser-engine/background-capture-page'
import {
  buildExtractionScriptForTest,
  classifySessionLanding,
  fetchFeedViaBrowserSession,
  knownBilibiliSpaceUrl,
  normalizeBrowserAcquisitionUrl,
  supportsBrowserSessionAcquisition,
} from '../main/modules/rss-engine/browser-acquisition'

const NOTE_A = '65f0a1b2c3d4e5f6a7b8c9d0'
const NOTE_B = '65f0a1b2c3d4e5f6a7b8c9d1'
const XHS_PROFILE = '5e31b693000000000100bb06'
const XHS_URL = `https://www.xiaohongshu.com/user/profile/${XHS_PROFILE}`
const BILI_OWNER = '946974'
const BILI_URL = `https://space.bilibili.com/${BILI_OWNER}?spm_id_from=333.788.upinfo.detail.click`

interface FakePageOptions {
  responses?: CapturedPageResponse[]
  /** What a script returns; receives the script source and the address the page is on. */
  evaluate?: (script: string, url: string) => unknown
  /** Where an address lands (a redirect). */
  landing?: Record<string, string>
  failNavigation?: string
  /** Where the page is after a script was asked for (the platform sent it away meanwhile). */
  urlAfterEvaluate?: string
}

function fakePage(options: FakePageOptions = {}) {
  const navigations: string[] = []
  const scripts: string[] = []
  const evaluateTimeouts: Array<number | undefined> = []
  let url = ''
  let closed = 0
  let observe: unknown
  const page: BackgroundPageHandle = {
    async navigate(target) {
      navigations.push(target)
      if (options.failNavigation) throw new Error(options.failNavigation)
      url = options.landing?.[target] ?? target
    },
    async evaluate(script, evaluateOptions) {
      scripts.push(script)
      evaluateTimeouts.push(evaluateOptions?.timeoutMs)
      try {
        return options.evaluate?.(script, url) ?? {}
      } finally {
        if (options.urlAfterEvaluate) url = options.urlAfterEvaluate
      }
    },
    responses: () => options.responses ?? [],
    waitForResponses: async (predicate) => predicate(options.responses ?? []),
    currentUrl: () => url,
    async close() { closed += 1 },
  }
  const controller = {
    openBackgroundPage: async (opened?: { observe?: unknown }) => {
      observe = opened?.observe
      return page
    },
  }
  return { controller, navigations, scripts, evaluateTimeouts, closed: () => closed, observe: () => observe }
}

const noSettle = { settle: async () => undefined, dwell: async () => undefined }

function biliResponse(rows: unknown[]): CapturedPageResponse {
  return {
    url: `https://api.bilibili.com/x/space/wbi/arc/search?mid=${BILI_OWNER}&pn=1&ps=40`,
    status: 200,
    mimeType: 'application/json',
    body: JSON.stringify({ code: 0, data: { list: { vlist: rows } } }),
  }
}

function biliNav(isLogin: boolean): CapturedPageResponse {
  return {
    url: 'https://api.bilibili.com/x/web-interface/nav',
    status: 200,
    mimeType: 'application/json',
    body: JSON.stringify(isLogin ? { code: 0, data: { isLogin: true } } : { code: -101, data: { isLogin: false } }),
  }
}

async function runPageScriptInContext(
  platform: Parameters<typeof buildExtractionScriptForTest>[0],
  targetUrl: string,
  options: {
    bodyText?: string
    title?: string
    href?: string
    cookie?: string
    state?: unknown
    mode?: 'full' | 'incremental'
    /** What `a[href*="/user/profile/"]` finds on the page. */
    profileAnchors?: unknown[]
  } = {},
) {
  const script = buildExtractionScriptForTest(platform, targetUrl, options.mode)
  return vm.runInNewContext(script, {
    document: {
      title: options.title || '',
      cookie: options.cookie || '',
      body: { innerText: options.bodyText || '' },
      scripts: [],
      querySelectorAll: (selector: string) => (selector === 'a[href*="/user/profile/"]' ? options.profileAnchors ?? [] : []),
      querySelector: () => null,
    },
    location: { href: options.href || targetUrl },
    window: { __INITIAL_STATE__: options.state, scrollTo: () => undefined },
    setTimeout: (fn: () => void) => {
      fn()
      return 0
    },
    clearTimeout: () => undefined,
    URL,
  }) as Promise<unknown>
}

/** The script runs in its own context; its result is copied so it compares as plain data here. */
async function runPageScript(
  ...args: Parameters<typeof runPageScriptInContext>
): Promise<{ state?: string; via?: string; detail?: string; items: Array<Record<string, string>> }> {
  return JSON.parse(JSON.stringify(await runPageScriptInContext(...args)))
}

describe('session subscriptions: which platforms and which page', () => {
  it('reads Bilibili, Xiaohongshu, Weibo and Douyin through the browser session', () => {
    assert.equal(supportsBrowserSessionAcquisition('bilibili'), true)
    assert.equal(supportsBrowserSessionAcquisition('xiaohongshu'), true)
    assert.equal(supportsBrowserSessionAcquisition('weibo'), true)
    assert.equal(supportsBrowserSessionAcquisition('douyin'), true)
    assert.equal(supportsBrowserSessionAcquisition('youtube'), false)
    assert.equal(supportsBrowserSessionAcquisition('rss'), false)
  })

  it('opens the profile the address names and leaves any other address as it is', () => {
    assert.equal(normalizeBrowserAcquisitionUrl('bilibili', BILI_URL), `https://space.bilibili.com/${BILI_OWNER}/upload/video`)
    assert.equal(normalizeBrowserAcquisitionUrl('bilibili', 'https://b23.tv/abc'), 'https://b23.tv/abc')
    assert.equal(
      normalizeBrowserAcquisitionUrl('xiaohongshu', `${XHS_URL}?xsec_token=T&xsec_source=pc_note`),
      XHS_URL,
    )
    assert.equal(normalizeBrowserAcquisitionUrl('xiaohongshu', 'https://xhslink.com/demo'), 'https://xhslink.com/demo')
    assert.equal(
      normalizeBrowserAcquisitionUrl('xiaohongshu', `https://www.xiaohongshu.com/explore/${NOTE_A}`),
      `https://www.xiaohongshu.com/explore/${NOTE_A}`,
      'a note address is not mistaken for a profile',
    )
    assert.equal(normalizeBrowserAcquisitionUrl('weibo', 'https://m.weibo.cn/profile/6182606334'), 'https://weibo.com/u/6182606334')
    assert.equal(normalizeBrowserAcquisitionUrl('weibo', 'https://t.cn/abc'), 'https://t.cn/abc')
    assert.equal(
      normalizeBrowserAcquisitionUrl('douyin', 'https://www.iesdouyin.com/share/user/demo?sec_uid=MS4wLjABAAAATEST'),
      'https://www.iesdouyin.com/share/user/demo?sec_uid=MS4wLjABAAAATEST',
    )
  })
})

describe('where the page ended up', () => {
  it('knows the addresses that mean the profile was not shown', () => {
    assert.equal(classifySessionLanding('xiaohongshu', 'https://www.xiaohongshu.com/website-login/captcha?redirectPath=x'), 'anti_bot')
    assert.equal(classifySessionLanding('xiaohongshu', 'https://www.xiaohongshu.com/website-login/error?error_code=300012'), 'waf')
    assert.equal(classifySessionLanding('xiaohongshu', 'https://www.xiaohongshu.com/login?redirectPath=%2Fuser'), 'auth')
    assert.equal(classifySessionLanding('xiaohongshu', XHS_URL), null)
    assert.equal(classifySessionLanding('bilibili', 'https://passport.bilibili.com/login?from=space'), 'auth')
    assert.equal(classifySessionLanding('bilibili', `https://space.bilibili.com/${BILI_OWNER}/upload/video`), null)
    assert.equal(classifySessionLanding('weibo', 'https://passport.weibo.com/visitor/visitor?entry=miniblog'), 'auth')
    assert.equal(classifySessionLanding('weibo', 'https://weibo.com/u/6182606334'), null)
    assert.equal(classifySessionLanding('douyin', 'not a url'), null)
  })

  it('a page sent to a verification address is reported as such without being read', async () => {
    const fake = fakePage({ landing: { [XHS_URL]: 'https://www.xiaohongshu.com/website-login/captcha?redirectPath=%2Fuser' } })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'xiaohongshu', XHS_URL, noSettle)
    assert.equal(result.state, 'anti_bot')
    assert.match(result.error || '', /验证码|风控/)
    assert.deepEqual(fake.scripts, [], 'nothing is run on a verification page')
    assert.equal(fake.closed(), 1)
  })

  it('a page sent away while it was being read is reported by where it went, not as a reading error', async () => {
    const fake = fakePage({
      evaluate: () => { throw new Error('Execution context was destroyed') },
      urlAfterEvaluate: 'https://www.xiaohongshu.com/website-login/error?error_code=300012',
    })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'xiaohongshu', XHS_URL, noSettle)
    assert.equal(result.state, 'waf')
    assert.equal(fake.closed(), 1)
  })

  it('gives every page script a deadline', async () => {
    const xhs = fakePage({ evaluate: () => ({ state: 'empty', items: [] }) })
    await fetchFeedViaBrowserSession(xhs.controller, 'xiaohongshu', XHS_URL, noSettle)
    const weibo = fakePage({ evaluate: () => ({ state: 'empty', items: [] }) })
    await fetchFeedViaBrowserSession(weibo.controller, 'weibo', 'https://weibo.com/u/1', noSettle)
    for (const timeoutMs of [...xhs.evaluateTimeouts, ...weibo.evaluateTimeouts]) {
      assert.ok(typeof timeoutMs === 'number' && timeoutMs >= 10_000 && timeoutMs <= 40_000, `deadline ${timeoutMs}`)
    }
  })
})

describe('session subscriptions make no request of their own', () => {
  const originalFetch = globalThis.fetch
  let fetchCalls: string[] = []

  beforeEach(() => {
    fetchCalls = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls.push(String(input))
      throw new Error('the session path must not fetch')
    }) as typeof fetch
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('reads every session platform, short links included, without calling fetch', async () => {
    const cases: Array<[Parameters<typeof fetchFeedViaBrowserSession>[1], string, FakePageOptions]> = [
      ['bilibili', BILI_URL, { responses: [biliResponse([{ bvid: 'BV1bb411c7mE', title: '新视频', created: 1_794_000_000 }])] }],
      ['bilibili', 'https://b23.tv/short', {
        landing: { 'https://b23.tv/short': 'https://www.bilibili.com/video/BV1bb411c7mE' },
        evaluate: (script) => (script.includes('upData') ? { ownerId: BILI_OWNER } : {}),
        responses: [biliResponse([{ bvid: 'BV1bb411c7mE', title: '新视频', created: 1_794_000_000 }])],
      }],
      ['xiaohongshu', 'https://xhslink.com/demo', {
        landing: { 'https://xhslink.com/demo': `${XHS_URL}?xsec_token=T` },
        evaluate: () => ({ state: 'ready', via: 'state', items: [{ noteId: NOTE_A, link: `https://www.xiaohongshu.com/explore/${NOTE_A}`, title: '笔记' }] }),
      }],
      ['weibo', 'https://t.cn/abc', {
        landing: { 'https://t.cn/abc': 'https://weibo.com/u/6182606334' },
        evaluate: () => ({ state: 'ready', items: [{ title: '微博', link: 'https://weibo.com/detail/Pabc123' }] }),
      }],
      ['douyin', 'https://v.douyin.com/demo', {
        evaluate: () => ({ state: 'ready', items: [{ title: '作品', link: 'https://www.douyin.com/video/1' }] }),
      }],
    ]

    for (const [platform, url, options] of cases) {
      const fake = fakePage(options)
      const result = await fetchFeedViaBrowserSession(fake.controller, platform, url, noSettle)
      assert.equal(result.items.length, 1, `${platform} ${url}`)
      assert.equal(fake.closed(), 1, 'the hidden page is always closed')
    }
    assert.deepEqual(fetchCalls, [])
  })
})

describe('Bilibili through the browser session', () => {
  it('reads the uploads the space page requested: time, summary, cover and uploader, with no page script beyond its title', async () => {
    const fake = fakePage({
      responses: [
        biliNav(true),
        biliResponse([
          { bvid: 'BV1bb411c7mE', title: '新视频', description: '完整简介', pic: '//i0.hdslb.com/new.jpg', created: 1_794_000_000, author: '影视飓风', mid: 946974 },
        ]),
      ],
      evaluate: () => ({ title: '影视飓风投稿视频-哔哩哔哩视频', finalUrl: `https://space.bilibili.com/${BILI_OWNER}/upload/video` }),
    })

    const result = await fetchFeedViaBrowserSession(fake.controller, 'bilibili', BILI_URL, noSettle)

    assert.deepEqual(fake.navigations, [`https://space.bilibili.com/${BILI_OWNER}/upload/video`])
    assert.equal(result.state, 'ready')
    assert.equal(result.via, 'responses')
    assert.equal(result.error, undefined)
    assert.equal(result.feedTitle, '影视飓风投稿视频-哔哩哔哩视频')
    assert.deepEqual(result.items.map(({ itemId: _id, ...item }) => item), [{
      title: '新视频',
      description: '完整简介',
      link: 'https://www.bilibili.com/video/BV1bb411c7mE',
      pubDate: new Date(1_794_000_000 * 1000).toISOString(),
      author: '影视飓风',
      coverImage: 'https://i0.hdslb.com/new.jpg',
      metadata: {},
    }])
    assert.equal(fake.scripts.length, 1)
    assert.doesNotMatch(fake.scripts[0], /querySelectorAll/, 'the rendered list is not read when the responses were')
    assert.deepEqual((fake.observe() as { urlIncludes: string[] }).urlIncludes.every((part) => part.includes('api.bilibili.com')), true)
  })

  it('falls back to the rendered list when the page requests were not seen', async () => {
    const fake = fakePage({
      evaluate: (script) => (script.includes('querySelectorAll')
        ? {
            title: 'UP主空间',
            state: 'ready',
            via: 'dom',
            items: [{ title: '最新视频', link: 'https://www.bilibili.com/video/BV1fr421M7y7', description: '79.3万 4321 03-31 这是一段真正的简介，值得保留。' }],
          }
        : {}),
    })

    const result = await fetchFeedViaBrowserSession(fake.controller, 'bilibili', BILI_URL, noSettle)

    assert.equal(result.via, 'dom')
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].link, 'https://www.bilibili.com/video/BV1fr421M7y7')
    assert.equal(result.items[0].pubDate, '')
    assert.match(result.items[0].description, /真正的简介/)
    assert.doesNotMatch(result.items[0].description, /79\.3万/)
  })

  it('gives a video the same identity whether it was read from a response or from the page', async () => {
    const fromResponse = await fetchFeedViaBrowserSession(
      fakePage({ responses: [biliResponse([{ bvid: 'BV1fr421M7y7', title: '最新视频', created: 1_794_000_000 }])] }).controller,
      'bilibili', BILI_URL, noSettle,
    )
    const fromPage = await fetchFeedViaBrowserSession(
      fakePage({ evaluate: () => ({ state: 'ready', items: [{ title: '最新视频', link: 'https://www.bilibili.com/video/BV1fr421M7y7' }] }) }).controller,
      'bilibili', BILI_URL, noSettle,
    )
    // The stored identity is the canonical video link; both readings carry it unchanged.
    assert.equal(fromResponse.items[0].link, fromPage.items[0].link)
  })

  it('tells a signed-out visitor to sign in even when the platform answered with its risk code', async () => {
    const riskAnswer: CapturedPageResponse = {
      url: `https://api.bilibili.com/x/space/wbi/arc/search?mid=${BILI_OWNER}`,
      status: 200,
      mimeType: 'application/json',
      body: JSON.stringify({ code: -352, message: '风控校验失败' }),
    }

    const signedOut = await fetchFeedViaBrowserSession(
      fakePage({ responses: [biliNav(false), riskAnswer], evaluate: () => ({ state: 'empty', items: [] }) }).controller,
      'bilibili', BILI_URL, noSettle,
    )
    assert.equal(signedOut.state, 'auth')
    assert.match(signedOut.error || '', /未登录|登录页/)

    const signedIn = await fetchFeedViaBrowserSession(
      fakePage({ responses: [biliNav(true), riskAnswer], evaluate: () => ({ state: 'empty', items: [] }) }).controller,
      'bilibili', BILI_URL, noSettle,
    )
    assert.equal(signedIn.state, 'waf')
    assert.match(signedIn.error || '', /风控/)
  })

  it('a risk answer on another request of the page does not hide a list that arrives later', async () => {
    const accountRisk: CapturedPageResponse = {
      url: `https://api.bilibili.com/x/space/wbi/acc/info?mid=${BILI_OWNER}`,
      status: 200,
      mimeType: 'application/json',
      body: JSON.stringify({ code: -352, message: '风控校验失败' }),
    }
    const responses = [biliNav(true), accountRisk]
    const fake = fakePage({
      responses,
      evaluate: (script) => {
        if (!script.includes('querySelectorAll')) return { title: 'UP主空间' }
        // The uploads land while the rendered page is being read.
        responses.push(biliResponse([{ bvid: 'BV1bb411c7mE', title: '后到的列表', created: 1_794_000_000, description: '简介' }]))
        return { title: 'UP主空间', state: 'ready', via: 'dom', items: [{ title: '后到的列表', link: 'https://www.bilibili.com/video/BV1bb411c7mE' }] }
      },
    })

    const result = await fetchFeedViaBrowserSession(fake.controller, 'bilibili', BILI_URL, noSettle)

    assert.equal(result.state, 'ready')
    assert.equal(result.via, 'responses', 'the list with dates wins over the rendered cards')
    assert.equal(result.items[0].pubDate, new Date(1_794_000_000 * 1000).toISOString())
  })

  it('a risk answer elsewhere on a page that still shows its uploads is not a blocked page', async () => {
    const fake = fakePage({
      responses: [biliNav(true), {
        url: `https://api.bilibili.com/x/space/wbi/acc/info?mid=${BILI_OWNER}`,
        status: 200,
        mimeType: 'application/json',
        body: JSON.stringify({ code: -352, message: '风控校验失败' }),
      }],
      evaluate: () => ({ state: 'ready', via: 'dom', items: [{ title: '页面上的视频', link: 'https://www.bilibili.com/video/BV1fr421M7y7' }] }),
    })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'bilibili', BILI_URL, noSettle)
    assert.equal(result.state, 'ready')
    assert.equal(result.via, 'dom')
  })

  it('follows a short or video link to the uploader the way a person would, and remembers where it led', async () => {
    const shortLink = 'https://b23.tv/remember-me'
    const options: FakePageOptions = {
      landing: { [shortLink]: 'https://www.bilibili.com/video/BV1bb411c7mE' },
      evaluate: (script) => (script.includes('upData') ? { ownerId: '39627524' } : {}),
      responses: [{
        url: 'https://api.bilibili.com/x/space/wbi/arc/search?mid=39627524',
        status: 200,
        mimeType: 'application/json',
        body: JSON.stringify({ code: 0, data: { list: { vlist: [{ bvid: 'BV1bb411c7mE', title: '视频', created: 1_794_000_000 }] } } }),
      }],
    }
    assert.equal(knownBilibiliSpaceUrl(shortLink), null)

    const first = fakePage(options)
    const firstResult = await fetchFeedViaBrowserSession(first.controller, 'bilibili', shortLink, noSettle)
    assert.equal(firstResult.items.length, 1)
    assert.deepEqual(first.navigations, [shortLink, 'https://space.bilibili.com/39627524/upload/video'])
    assert.equal(knownBilibiliSpaceUrl(shortLink), 'https://space.bilibili.com/39627524')

    const second = fakePage(options)
    await fetchFeedViaBrowserSession(second.controller, 'bilibili', shortLink, noSettle)
    assert.deepEqual(second.navigations, ['https://space.bilibili.com/39627524/upload/video'])
  })

  it('says so when a link does not lead to an uploader', async () => {
    const fake = fakePage({ landing: { 'https://b23.tv/nowhere': 'https://www.bilibili.com/blackboard/activity.html' } })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'bilibili', 'https://b23.tv/nowhere', noSettle)
    assert.equal(result.items.length, 0)
    assert.equal(result.state, 'empty')
    assert.match(result.error || '', /空间页的链接/)
    assert.deepEqual(fake.navigations, ['https://b23.tv/nowhere'])
  })
})

describe('Xiaohongshu through the browser session', () => {
  const stateNote = (noteId: string, title: string, token: string) => ({
    noteId,
    xsecToken: token,
    title,
    link: `https://www.xiaohongshu.com/explore/${noteId}`,
    author: '广州潮会吃',
    coverImage: 'https://sns-img/a.jpg',
  })

  it('opens the profile once and reads its embedded notes; the link carries the access token the page gave', async () => {
    const fake = fakePage({
      evaluate: () => ({ title: '广州潮会吃 - 小红书', state: 'ready', via: 'state', items: [stateNote(NOTE_A, '第一篇', 'TOK EN/A=')] }),
    })

    const result = await fetchFeedViaBrowserSession(
      fake.controller, 'xiaohongshu', `${XHS_URL}?xsec_token=OLD&xsec_source=pc_note`, noSettle,
    )

    assert.deepEqual(fake.navigations, [XHS_URL])
    assert.equal(result.via, 'state')
    assert.equal(result.feedTitle, '广州潮会吃 - 小红书')
    assert.equal(result.items.length, 1)
    assert.equal(
      result.items[0].link,
      `https://www.xiaohongshu.com/explore/${NOTE_A}?xsec_token=${encodeURIComponent('TOK EN/A=')}&xsec_source=pc_user`,
    )
    assert.deepEqual(result.items[0].metadata, { rssGuid: `https://www.xiaohongshu.com/explore/${NOTE_A}` })
  })

  it('gives a note one identity however it was read and whatever token came with it', async () => {
    const viaState = await fetchFeedViaBrowserSession(
      fakePage({ evaluate: () => ({ state: 'ready', via: 'state', items: [stateNote(NOTE_A, '第一篇', 'T1')] }) }).controller,
      'xiaohongshu', XHS_URL, noSettle,
    )
    const viaPage = await fetchFeedViaBrowserSession(
      fakePage({
        evaluate: () => ({ state: 'ready', via: 'dom', items: [{ title: '另一种标题写法', link: `https://www.xiaohongshu.com/explore/${NOTE_A}`, fingerprint: 'x|y', xsecToken: 'T2' }] }),
      }).controller,
      'xiaohongshu', XHS_URL, noSettle,
    )
    const viaResponse = await fetchFeedViaBrowserSession(
      fakePage({
        evaluate: () => ({ state: 'empty', items: [] }),
        responses: [{
          url: `https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?user_id=${XHS_PROFILE}`,
          status: 200,
          mimeType: 'application/json',
          body: JSON.stringify({ code: 0, data: { notes: [{ note_id: NOTE_A, display_title: '第一篇', xsec_token: 'T3', user: { user_id: XHS_PROFILE } }] } }),
        }],
      }).controller,
      'xiaohongshu', XHS_URL, noSettle,
    )

    assert.equal(viaState.via, 'state')
    assert.equal(viaPage.via, 'dom')
    assert.equal(viaResponse.via, 'responses')
    assert.equal(viaState.items[0].itemId, viaPage.items[0].itemId)
    assert.equal(viaState.items[0].itemId, viaResponse.items[0].itemId)
  })

  it('prefers the notes the page requested over its rendered cards', async () => {
    const fake = fakePage({
      evaluate: () => ({ state: 'ready', via: 'dom', items: [{ title: '卡片标题', link: `https://www.xiaohongshu.com/explore/${NOTE_A}` }] }),
      responses: [{
        url: `https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?user_id=${XHS_PROFILE}`,
        status: 200,
        mimeType: 'application/json',
        body: JSON.stringify({ code: 0, data: { notes: [
          { note_id: NOTE_A, display_title: '接口标题', user: { user_id: XHS_PROFILE } },
          { note_id: NOTE_B, display_title: '第二篇', user: { user_id: XHS_PROFILE } },
        ] } }),
      }],
    })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'xiaohongshu', XHS_URL, noSettle)
    assert.equal(result.via, 'responses')
    assert.deepEqual(result.items.map((item) => item.title), ['接口标题', '第二篇'])
  })

  it('keeps cards that show no note id apart by what they show', async () => {
    const card = (title: string, fingerprint: string) => ({
      title,
      link: `https://www.xiaohongshu.com/user/profile/${XHS_PROFILE}#note-card-1`,
      fingerprint,
    })
    const first = await fetchFeedViaBrowserSession(
      fakePage({ evaluate: () => ({ state: 'ready', via: 'dom', items: [card('今日探店', '今日探店|封面一')] }) }).controller,
      'xiaohongshu', XHS_URL, noSettle,
    )
    const second = await fetchFeedViaBrowserSession(
      fakePage({ evaluate: () => ({ state: 'ready', via: 'dom', items: [card('周末探店', '周末探店|封面二')] }) }).controller,
      'xiaohongshu', XHS_URL, noSettle,
    )
    assert.equal(first.items.length, 1)
    assert.notEqual(first.items[0].itemId, second.items[0].itemId)
  })

  it('only reads a profile: a note link, or a visit that was sent to the feed, is refused before anything is read', async () => {
    const othersNotes = () => ({ state: 'ready', via: 'state', items: [stateNote(NOTE_A, '别人的笔记', 'T')] })

    const noteLink = fakePage({ evaluate: othersNotes })
    const fromNote = await fetchFeedViaBrowserSession(
      noteLink.controller, 'xiaohongshu', `https://www.xiaohongshu.com/explore/${NOTE_A}?xsec_token=T`, noSettle,
    )
    assert.equal(fromNote.items.length, 0)
    assert.match(fromNote.error || '', /作者主页的链接/)
    assert.deepEqual(noteLink.scripts, [])

    const sentToFeed = fakePage({ evaluate: othersNotes, landing: { [XHS_URL]: 'https://www.xiaohongshu.com/explore' } })
    const fromFeed = await fetchFeedViaBrowserSession(sentToFeed.controller, 'xiaohongshu', XHS_URL, noSettle)
    assert.equal(fromFeed.items.length, 0)
    assert.deepEqual(sentToFeed.scripts, [])
  })

  it('drops links that are not notes of the profile', async () => {
    const fake = fakePage({
      evaluate: () => ({ state: 'ready', via: 'dom', items: [{ title: '坏链接', link: 'https://www.xiaohongshu.com/explore/' }] }),
    })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'xiaohongshu', XHS_URL, noSettle)
    assert.equal(result.items.length, 0)
    assert.equal(result.state, 'empty')
    assert.match(result.error || '', /未提取到可用条目/)
  })

  it('reports a sign-in page as needing sign-in', async () => {
    const fake = fakePage({
      evaluate: () => ({ title: '小红书登录', finalUrl: 'https://www.xiaohongshu.com/login?redirectPath=%2Fuser%2Fprofile%2Fabc', state: 'auth', items: [] }),
    })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'xiaohongshu', XHS_URL, noSettle)
    assert.equal(result.state, 'auth')
    assert.match(result.error || '', /未登录|登录页/)
  })

  it('reports what the page own request said when the page shows nothing', async () => {
    const fake = fakePage({
      evaluate: () => ({ state: 'empty', items: [] }),
      responses: [{
        url: `https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?user_id=${XHS_PROFILE}`,
        status: 200,
        mimeType: 'application/json',
        body: JSON.stringify({ code: 300012, success: false, msg: '网络连接异常' }),
      }],
    })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'xiaohongshu', XHS_URL, noSettle)
    assert.equal(result.state, 'waf')
    assert.match(result.error || '', /风控|WAF/)
  })
})

describe('Weibo and Douyin through the browser session', () => {
  it('reads the profile in a hidden page of its own', async () => {
    const fake = fakePage({
      evaluate: () => ({ title: '微博主页', state: 'ready', items: [{ title: '微博内容一', link: 'https://weibo.com/detail/Pabc123', description: '内容一' }] }),
    })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'weibo', 'https://m.weibo.cn/profile/6182606334', noSettle)
    assert.deepEqual(fake.navigations, ['https://weibo.com/u/6182606334'])
    assert.equal(result.items[0].link, 'https://weibo.com/detail/Pabc123')
    assert.equal(result.via, 'dom')
    assert.equal(fake.observe(), undefined)
  })

  it('says what went wrong when the page loads but shows nothing, or asks for verification', async () => {
    const empty = await fetchFeedViaBrowserSession(
      fakePage({ evaluate: () => ({ title: '空白主页', items: [] }) }).controller, 'douyin', 'https://v.douyin.com/demo', noSettle,
    )
    assert.equal(empty.state, 'empty')
    assert.match(empty.error || '', /未提取到可用条目/)

    const challenged = await fetchFeedViaBrowserSession(
      fakePage({ evaluate: () => ({ state: 'anti_bot', textSnippet: '系统检测到异常行为，请先完成验证', items: [] }) }).controller,
      'douyin', 'https://v.douyin.com/demo', noSettle,
    )
    assert.equal(challenged.state, 'anti_bot')
    assert.match(challenged.error || '', /验证码|风控|验证/)
  })
})

describe('the hidden page', () => {
  it('stays open for a moment after it was read, and is closed only then', async () => {
    const events: string[] = []
    const fake = fakePage({
      evaluate: () => ({ state: 'ready', via: 'state', items: [{ noteId: NOTE_A, link: `https://www.xiaohongshu.com/explore/${NOTE_A}`, title: '笔记' }] }),
    })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'xiaohongshu', XHS_URL, {
      settle: async () => { events.push('settle') },
      dwell: async () => { events.push(`dwell:closed=${fake.closed()}`) },
    })
    assert.equal(result.items.length, 1)
    assert.deepEqual(events, ['settle', 'dwell:closed=0'])
    assert.equal(fake.closed(), 1)
  })

  it('does not linger on a page that showed nothing to read', async () => {
    let dwelled = 0
    const fake = fakePage({ evaluate: () => ({ state: 'auth', items: [] }) })
    await fetchFeedViaBrowserSession(fake.controller, 'xiaohongshu', XHS_URL, {
      settle: async () => undefined,
      dwell: async () => { dwelled += 1 },
    })
    assert.equal(dwelled, 0)
    assert.equal(fake.closed(), 1)
  })

  it('is closed and the failure reported when the page cannot be opened', async () => {
    const fake = fakePage({ failNavigation: 'net::ERR_INTERNET_DISCONNECTED (-106)' })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'xiaohongshu', XHS_URL, noSettle)
    assert.equal(result.state, 'error')
    assert.match(result.error || '', /抓取异常.*ERR_INTERNET_DISCONNECTED/)
    assert.equal(fake.closed(), 1)
  })

  it('reports a page script that threw', async () => {
    const fake = fakePage({ evaluate: () => ({ __readyCaptureError: 'TypeError: x is not a function' }) })
    const result = await fetchFeedViaBrowserSession(fake.controller, 'weibo', 'https://weibo.com/u/1', noSettle)
    assert.equal(result.state, 'error')
    assert.match(result.error || '', /提取脚本执行失败/)
  })
})

describe('what the page scripts read', () => {
  it('compile for every session platform', () => {
    for (const [platform, url] of [
      ['xiaohongshu', XHS_URL],
      ['bilibili', `https://space.bilibili.com/${BILI_OWNER}/upload/video`],
      ['weibo', 'https://weibo.com/u/6182606334'],
      ['douyin', 'https://www.douyin.com/user/demo'],
    ] as const) {
      assert.doesNotThrow(() => new vm.Script(buildExtractionScriptForTest(platform, url)), platform)
    }
  })

  it('the Bilibili and Xiaohongshu scripts neither scroll nor dispatch events', () => {
    for (const platform of ['bilibili', 'xiaohongshu'] as const) {
      const script = buildExtractionScriptForTest(platform, platform === 'bilibili' ? BILI_URL : XHS_URL)
      assert.doesNotMatch(script, /scrollTo|scrollBy|scrollIntoView/, platform)
      assert.doesNotMatch(script, /dispatchEvent|MouseEvent|\.click\(/, platform)
      assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest/, platform)
    }
  })

  it('reads the notes a Xiaohongshu profile holds in its own state, one list per tab', async () => {
    const card = (noteId: string, title: string, userId = XHS_PROFILE) => ({
      id: noteId,
      xsecToken: `token-${title}`,
      noteCard: { noteId, displayTitle: title, user: { userId, nickname: '广州潮会吃' }, cover: { urlDefault: 'https://sns-img/c.jpg' } },
    })
    const result = await runPageScript('xiaohongshu', XHS_URL, {
      state: {
        // The live state wraps values the way the page framework does.
        user: { _rawValue: { notes: { _rawValue: [[card(NOTE_A, '第一篇'), card(NOTE_B, '第二篇')], []] } } },
        feed: { feeds: [card('aaaaaaaaaaaaaaaaaaaaaaaa', '推荐里别人的笔记', 'someone-else')] },
      },
    })

    assert.equal(result.state, 'ready')
    assert.equal(result.via, 'state')
    assert.deepEqual(result.items.map((item) => [item.noteId, item.title, item.xsecToken]), [
      [NOTE_A, '第一篇', 'token-第一篇'],
      [NOTE_B, '第二篇', 'token-第二篇'],
    ])
    assert.equal(result.items[0].link, `https://www.xiaohongshu.com/explore/${NOTE_A}`)
    assert.equal(result.items[0].author, '广州潮会吃')
  })

  it('finds note cards anywhere in the state when its layout changed, and only the profile own', async () => {
    const result = await runPageScript('xiaohongshu', XHS_URL, {
      state: {
        profilePage: { tabs: [{ list: [
          { noteCard: { noteId: NOTE_A, displayTitle: '换了位置', user: { userId: XHS_PROFILE } } },
          { noteCard: { noteId: NOTE_B, displayTitle: '别人的', user: { userId: 'someone-else' } } },
        ] }] },
      },
    })
    assert.equal(result.via, 'state')
    assert.deepEqual(result.items.map((item) => item.noteId), [NOTE_A])
  })

  it('a note titled with the word 验证 is a note, not a verification page', async () => {
    const result = await runPageScript('xiaohongshu', XHS_URL, {
      bodyText: '如何通过小红书的验证 置顶 赞 1.2万',
      state: { user: { notes: [[{ noteCard: { noteId: NOTE_A, displayTitle: '如何通过小红书的验证', user: { userId: XHS_PROFILE } } }]] } },
    })
    assert.equal(result.state, 'ready')
    assert.equal(result.items.length, 1)
  })

  it('an empty Xiaohongshu page is checked for sign-in and security pages by address and whole phrases', async () => {
    const plain = await runPageScript('xiaohongshu', XHS_URL, { bodyText: '这位博主正在验证新的拍摄方案', mode: 'incremental' })
    assert.equal(plain.state, 'empty', 'a common word in the text does not make a verification page')

    const signIn = await runPageScript('xiaohongshu', XHS_URL, {
      href: 'https://www.xiaohongshu.com/login?redirectPath=%2Fuser%2Fprofile%2Fabc',
      mode: 'incremental',
    })
    assert.equal(signIn.state, 'auth')

    const restricted = await runPageScript('xiaohongshu', XHS_URL, {
      href: 'https://www.xiaohongshu.com/website-login/error?error_code=300012',
      bodyText: '安全限制 IP存在风险，请切换可靠网络环境后重试',
      mode: 'incremental',
    })
    assert.equal(restricted.state, 'waf')

    const captcha = await runPageScript('xiaohongshu', XHS_URL, {
      href: 'https://www.xiaohongshu.com/website-login/captcha?redirectPath=x',
      mode: 'incremental',
    })
    assert.equal(captcha.state, 'anti_bot')
  })

  it('one item per rendered card: the link to the author is not a second note', async () => {
    const card = { innerText: '周末探店合集\n广州潮会吃\n1.2万', querySelector: () => null }
    const anchor = (href: string) => ({
      getAttribute: (name: string) => (name === 'href' ? href : null),
      textContent: '周末探店合集',
      closest: () => card,
      parentElement: null,
    })
    const result = await runPageScript('xiaohongshu', XHS_URL, {
      profileAnchors: [
        anchor(`/user/profile/${XHS_PROFILE}?xsec_token=AUTHOR&xsec_source=pc_note`),
        anchor(`/user/profile/${XHS_PROFILE}/${NOTE_A}?xsec_token=NOTE&xsec_source=pc_user`),
      ],
    })
    assert.equal(result.via, 'dom')
    assert.deepEqual(result.items.map((item) => [item.noteId, item.link, item.xsecToken]), [
      [NOTE_A, `https://www.xiaohongshu.com/explore/${NOTE_A}`, 'NOTE'],
    ])
  })

  it('a Weibo or Douyin page that merely uses a common word is not a verification page', async () => {
    const weiboUrl = 'https://weibo.com/u/6182606334'
    assert.equal((await runPageScript('weibo', weiboUrl, { bodyText: '博主今天验证了一个想法，更新很频繁' })).state, 'empty')
    assert.equal((await runPageScript('weibo', weiboUrl, { bodyText: '访问过于频繁，请完成验证后继续' })).state, 'anti_bot')
    assert.equal((await runPageScript('weibo', weiboUrl, { href: 'https://passport.weibo.com/visitor/visitor?entry=miniblog' })).state, 'auth')

    const douyinUrl = 'https://www.douyin.com/user/demo'
    assert.equal((await runPageScript('douyin', douyinUrl, { bodyText: '账号数据异常波动的风险分析' })).state, 'empty')
    assert.equal((await runPageScript('douyin', douyinUrl, { bodyText: '安全验证 请完成验证后继续访问' })).state, 'anti_bot')
    assert.equal((await runPageScript('douyin', douyinUrl, { bodyText: '访问受限，请稍后再试' })).state, 'waf')
  })

  it('a signed-out Bilibili visitor is told to sign in before anything on the page is read', async () => {
    const result = await runPageScript('bilibili', `https://space.bilibili.com/1577804/upload/video`, {
      title: '某幻君投稿视频-某幻君视频分享-哔哩哔哩视频',
      bodyText: '登录后你可以 免费看高清视频 多端同步播放记录 立即登录 首次使用？ 点我注册 空间主人还没投过视频，这里什么也没有...',
    })
    assert.equal(result.state, 'auth')
    assert.equal(result.detail, 'browser_session_login_required')
  })

  it('a signed-in Bilibili page that merely mentions 验证 is not a verification page', async () => {
    const result = await runPageScript('bilibili', `https://space.bilibili.com/${BILI_OWNER}/upload/video`, {
      cookie: 'buvid3=x; DedeUserID=42; b_nut=1',
      bodyText: '影视飓风 关注 投稿 我们验证了三种拍摄方案 立即登录',
    })
    assert.equal(result.state, 'empty')

    const blocked = await runPageScript('bilibili', `https://space.bilibili.com/${BILI_OWNER}/upload/video`, {
      cookie: 'DedeUserID=42',
      bodyText: '访问异常，请稍后再试',
    })
    assert.equal(blocked.state, 'anti_bot')
  })
})
