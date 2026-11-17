import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BackgroundPageHandle } from '../main/modules/browser-engine/background-capture-page'
import type { ScrapeResult } from '../main/modules/rss-engine/scrapers/base'
import {
  SESSION_PACING,
  SessionAcquisitionPacer,
  type SessionPlatform,
  type SessionRefreshTrigger,
} from '../main/modules/rss-engine/session-acquisition-pacer'
import { fetchSessionSource, type SessionSourceFetchDeps } from '../main/modules/rss-engine/session-source-fetch'

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0)
const HOUR = 60 * 60_000
const NOTE_A = '65f0a1b2c3d4e5f6a7b8c9d0'

type Snapshot = Record<string, unknown>

function createHarness(options: {
  /** What each page shows, by the order pages are opened. */
  pages?: Snapshot[]
  anonymous?: ScrapeResult | null
  stale?: boolean
  lastAttemptAt?: Record<string, number>
  idleMs?: number
  hasPageOpen?: boolean
  withoutController?: boolean
} = {}) {
  let now = T0
  let opened = 0
  let anonymousCalls = 0
  const logs: string[] = []
  const controller = {
    hasReusableCaptureTarget: () => options.hasPageOpen === true,
    openBackgroundPage: async (): Promise<BackgroundPageHandle> => {
      const snapshot = options.pages?.[opened] ?? { state: 'empty', items: [] }
      opened += 1
      let url = ''
      return {
        navigate: async (target) => { url = target; now += 1_500 },
        evaluate: async () => snapshot,
        responses: () => [],
        waitForResponses: async () => false,
        currentUrl: () => url,
        close: async () => undefined,
      }
    },
  }
  const deps: SessionSourceFetchDeps = {
    pacer: new SessionAcquisitionPacer({
      now: () => now,
      random: () => 0,
      sleep: async (ms) => { now += ms },
      readUserIdleMs: () => options.idleMs ?? 0,
    }),
    getController: () => (options.withoutController ? null : controller),
    readLastAttemptAt: (sourceId) => options.lastAttemptAt?.[sourceId] ?? null,
    countPlatformSources: () => 3,
    fetchSignedOutBilibili: async () => {
      anonymousCalls += 1
      return options.anonymous === undefined ? null : options.anonymous
    },
    isStaleBilibiliResult: () => options.stale === true,
    now: () => now,
    log: (line) => logs.push(line),
    settle: async () => undefined,
    dwell: async () => undefined,
  }
  const refresh = (sourceId: string, platform: SessionPlatform, trigger: SessionRefreshTrigger = 'auto') =>
    fetchSessionSource(
      deps,
      {
        id: sourceId,
        url: platform === 'bilibili'
          ? `https://space.bilibili.com/9469${sourceId.length}?secret=query`
          : `https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb0${sourceId.length}?xsec_token=SECRET`,
      },
      platform,
      trigger,
    )
  return { refresh, logs, opened: () => opened, anonymousCalls: () => anonymousCalls }
}

const signInPage: Snapshot = { state: 'auth', items: [] }
const notes: Snapshot = {
  state: 'ready',
  via: 'state',
  title: '广州潮会吃 - 小红书',
  items: [{ noteId: NOTE_A, link: `https://www.xiaohongshu.com/explore/${NOTE_A}`, title: '第一篇' }],
}
const anonymousVideos: ScrapeResult = {
  items: [{ itemId: 'bilibili_x', title: '匿名拿到的视频', description: '', link: 'https://www.bilibili.com/video/BV1bb411c7mE', pubDate: '', author: '', coverImage: null, metadata: {} }],
  feedTitle: 'UP 主',
  platform: 'bilibili',
}

describe('one refresh of a session source', () => {
  it('reads the page and reports the browser as the route', async () => {
    const harness = createHarness({ pages: [notes] })
    const outcome = await harness.refresh('x1', 'xiaohongshu')

    assert.equal(outcome.backendUsed, 'browser')
    assert.equal(outcome.deferred, undefined)
    assert.equal(outcome.result.items.length, 1)
    assert.equal(outcome.result.error, undefined)
    assert.deepEqual(Object.keys(outcome.result).sort(), ['feedTitle', 'items', 'platform'])
  })

  it('needs the in-app browser', async () => {
    const harness = createHarness({ withoutController: true })
    const outcome = await harness.refresh('x1', 'xiaohongshu')
    assert.equal(outcome.result.items.length, 0)
    assert.match(outcome.result.error || '', /应用内浏览器运行态/)
    assert.equal(outcome.deferred, undefined)
  })

  it('does not open the page before its turn and does not call that a failure', async () => {
    const harness = createHarness({ pages: [notes], lastAttemptAt: { x1: T0 - HOUR } })
    const outcome = await harness.refresh('x1', 'xiaohongshu')

    assert.equal(harness.opened(), 0)
    assert.equal(outcome.deferred?.reason, 'not_due')
    assert.ok((outcome.deferred?.retryAt ?? 0) > T0)
    assert.deepEqual(harness.logs, [], 'a source that is simply not due leaves no line')
  })

  it('waits for the person, and says why in the log', async () => {
    const harness = createHarness({ pages: [notes], idleMs: 60 * 60_000 })
    const outcome = await harness.refresh('x1', 'xiaohongshu')
    assert.equal(outcome.deferred?.reason, 'user_away')
    assert.equal(harness.opened(), 0)
    assert.equal(harness.logs.length, 1)
    assert.match(harness.logs[0], /platform=xiaohongshu source=x1 trigger=auto skipped=user_away/)
  })

  it('writes one line per page with counts and timing, never the address or its tokens', async () => {
    const harness = createHarness({ pages: [notes] })
    await harness.refresh('x1', 'xiaohongshu')
    assert.equal(harness.logs.length, 1)
    assert.match(harness.logs[0], /^\[rss-session\] platform=xiaohongshu source=x1 trigger=auto state=ready via=state items=1 ms=\d+$/)
    assert.doesNotMatch(harness.logs.join('\n'), /http|SECRET|xsec/)
  })
})

describe('a sign-in page stops the sources behind it', () => {
  it('Xiaohongshu: the next source in the same round is left closed, and stays closed for the pause', async () => {
    const harness = createHarness({ pages: [signInPage, notes] })

    const first = await harness.refresh('x1', 'xiaohongshu')
    assert.equal(first.deferred, undefined)
    assert.match(first.result.error || '', /未登录|登录页/)

    const second = await harness.refresh('x22', 'xiaohongshu')
    assert.equal(second.deferred?.reason, 'platform_paused')
    assert.ok((second.deferred?.retryAt ?? 0) >= T0 + SESSION_PACING.xiaohongshu.authPauseMs)
    assert.match(second.result.error || '', /自动刷新已暂停/)
    assert.equal(harness.opened(), 1)
  })

  it('one source refreshed by hand may find out that signing in worked, which lifts the pause', async () => {
    const harness = createHarness({ pages: [signInPage, notes, notes] })
    await harness.refresh('x1', 'xiaohongshu')

    const byHand = await harness.refresh('x1', 'xiaohongshu', 'manual-source')
    assert.equal(byHand.result.items.length, 1)

    const next = await harness.refresh('x22', 'xiaohongshu')
    assert.equal(next.deferred, undefined)
    assert.equal(next.result.items.length, 1)
    assert.equal(harness.opened(), 3)
  })

  it('after a verification page a refresh by hand is held back unless the person has the page open', async () => {
    const blocked = createHarness({ pages: [{ state: 'anti_bot', items: [] }, notes] })
    await blocked.refresh('x1', 'xiaohongshu')
    const held = await blocked.refresh('x1', 'xiaohongshu', 'manual-source')
    assert.equal(held.deferred?.reason, 'platform_paused')
    assert.equal(blocked.opened(), 1)

    const open = createHarness({ pages: [{ state: 'anti_bot', items: [] }, notes], hasPageOpen: true })
    await open.refresh('x1', 'xiaohongshu')
    const retried = await open.refresh('x1', 'xiaohongshu', 'manual-source')
    assert.equal(retried.result.items.length, 1)
  })
})

describe('Bilibili when the person is not signed in', () => {
  it('uses the anonymous route and says so', async () => {
    const harness = createHarness({ pages: [signInPage], anonymous: anonymousVideos })
    const outcome = await harness.refresh('b1', 'bilibili')

    assert.equal(outcome.backendUsed, 'rsshub')
    assert.equal(outcome.result.items.length, 1)
    assert.match(outcome.result.error || '', /匿名通道/)
    assert.equal(outcome.deferred, undefined)
  })

  it('asks to sign in when the anonymous route is unavailable or answers with old content', async () => {
    const unavailable = await createHarness({ pages: [signInPage], anonymous: null }).refresh('b1', 'bilibili')
    assert.equal(unavailable.backendUsed, 'browser')
    assert.equal(unavailable.result.items.length, 0)
    assert.match(unavailable.result.error || '', /未登录|登录页/)

    const stale = await createHarness({ pages: [signInPage], anonymous: anonymousVideos, stale: true }).refresh('b1', 'bilibili')
    assert.equal(stale.result.items.length, 0)
    assert.match(stale.result.error || '', /未登录|登录页/)
  })

  it('the sources behind the sign-in page go straight to the anonymous route, without opening their pages', async () => {
    const harness = createHarness({ pages: [signInPage], anonymous: anonymousVideos })
    await harness.refresh('b1', 'bilibili')
    const second = await harness.refresh('b22', 'bilibili')
    const third = await harness.refresh('b333', 'bilibili', 'manual-all')

    assert.equal(harness.opened(), 1)
    assert.equal(harness.anonymousCalls(), 3)
    assert.equal(second.backendUsed, 'rsshub')
    assert.equal(second.deferred, undefined)
    assert.equal(third.backendUsed, 'rsshub')
  })

  it('a verification page is not answered by trying the anonymous route', async () => {
    const harness = createHarness({ pages: [{ state: 'waf', items: [] }], anonymous: anonymousVideos })
    const first = await harness.refresh('b1', 'bilibili')
    const second = await harness.refresh('b22', 'bilibili')

    assert.equal(first.backendUsed, 'browser')
    assert.equal(first.result.items.length, 0)
    assert.equal(second.deferred?.reason, 'platform_paused')
    assert.equal(harness.anonymousCalls(), 0)
  })
})
