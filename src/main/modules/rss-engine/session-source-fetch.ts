/**
 * One refresh of a subscription that is read through the person's browser session: asks the pacer whether the
 * page may be opened now, opens it, and decides what an unreadable page means for this source.
 */
import {
  fetchFeedViaBrowserSession,
  type BrowserAcquisitionMode,
  type BrowserSessionScrapeResult,
  type SessionPageOpener,
} from './browser-acquisition'
import { platformLabel } from './scrapers'
import type { ScrapeResult } from './scrapers/base'
import {
  type SessionAcquisitionPacer,
  type SessionLoadOutcome,
  type SessionPlatform,
  type SessionRefreshTrigger,
  type SessionRunRequest,
  type SessionSkipReason,
} from './session-acquisition-pacer'
import type { SourceBackend } from './source-diagnostics'

export interface SessionSourceLike {
  id: string
  url: string
  draft_seeded?: number
}

export interface SessionSourceDeferral {
  reason: SessionSkipReason
  /** When the page may be opened again, if the pacer can tell. */
  retryAt: number | null
}

export interface SessionSourceFetchOutcome {
  result: ScrapeResult
  backendUsed: SourceBackend
  /** Set when the page was not opened at all. Such a round is neither a success nor a failure. */
  deferred?: SessionSourceDeferral
}

export interface SessionSourceFetchDeps {
  pacer: SessionAcquisitionPacer
  getController(): (SessionPageOpener & { hasReusableCaptureTarget?(url: string): boolean }) | null
  /** The last time this source's page was opened (epoch ms), whatever the result. */
  readLastAttemptAt(sourceId: string): number | null
  countPlatformSources(platform: SessionPlatform): number
  /** The anonymous Bilibili route. Resolves to null when it cannot be reached. */
  fetchSignedOutBilibili(url: string): Promise<ScrapeResult | null>
  isStaleBilibiliResult(result: ScrapeResult): boolean
  now(): number
  log(line: string): void
  /** The pauses around reading a page (before it is read, before it is closed). Tests replace them so they do not wait. */
  settle?: () => Promise<void>
  dwell?: () => Promise<void>
}

function resolveMode(source: SessionSourceLike, platform: SessionPlatform): BrowserAcquisitionMode {
  if (platform !== 'xiaohongshu') return 'full'
  return source.draft_seeded === 1 ? 'incremental' : 'full'
}

function describeDeferral(platform: SessionPlatform, reason: SessionSkipReason): string {
  const label = platformLabel(platform)
  if (reason === 'platform_paused') {
    return `${label} 最近遇到了登录页或验证页，自动刷新已暂停。请先在 Ready 浏览器中打开该主页处理好，再刷新。`
  }
  if (reason === 'user_away') return `${label} 的订阅等你回到电脑前再刷新。`
  if (reason === 'load_budget') return `${label} 刚打开过几个主页，这一个稍后再刷新。`
  if (reason === 'just_refreshed') return `${label} 的这个订阅刚刷新过。`
  return `${label} 的这个订阅还没到刷新时间。`
}

function toOutcome(result: BrowserSessionScrapeResult): SessionLoadOutcome {
  if (result.items.length > 0) return 'ok'
  if (result.state === 'auth' || result.state === 'anti_bot' || result.state === 'waf') return result.state
  return 'other'
}

function plain(result: BrowserSessionScrapeResult): ScrapeResult {
  const { state: _state, via: _via, ...rest } = result
  return rest
}

export async function fetchSessionSource(
  deps: SessionSourceFetchDeps,
  source: SessionSourceLike,
  platform: SessionPlatform,
  trigger: SessionRefreshTrigger,
): Promise<SessionSourceFetchOutcome> {
  const controller = deps.getController()
  if (!controller) {
    return {
      result: {
        items: [],
        feedTitle: '',
        platform,
        error: `${platformLabel(platform)} 当前需要 Ready 应用内浏览器运行态，请稍后重试。`,
      },
      backendUsed: 'browser',
    }
  }

  const request: SessionRunRequest = {
    trigger,
    platform,
    sourceId: source.id,
    sourceCount: deps.countPlatformSources(platform),
    readLastAttemptAt: () => deps.readLastAttemptAt(source.id),
    readUserHasPageOpen: () => controller.hasReusableCaptureTarget?.(source.url) === true,
  }

  /** A signed-out Bilibili space still has an anonymous route; a stale answer from it means "sign in". */
  const fromAnonymousRoute = (anonymous: ScrapeResult | null, signInHint: ScrapeResult): SessionSourceFetchOutcome => {
    if (anonymous && anonymous.items.length > 0 && !deps.isStaleBilibiliResult(anonymous)) {
      return {
        result: { ...anonymous, error: '还没有在 Ready 浏览器登录 B 站，这次用的是匿名通道，内容可能不全。' },
        backendUsed: 'rsshub',
      }
    }
    return { result: signInHint, backendUsed: 'browser' }
  }

  const run = await deps.pacer.run(request, async () => {
    const startedAt = deps.now()
    const value = await fetchFeedViaBrowserSession(controller, platform, source.url, {
      mode: resolveMode(source, platform),
      settle: deps.settle,
      dwell: deps.dwell,
    })
    deps.log(
      `[rss-session] platform=${platform} source=${source.id} trigger=${trigger} state=${value.state}`
      + ` via=${value.via ?? 'none'} items=${value.items.length} ms=${deps.now() - startedAt}`,
    )
    return { value, outcome: toOutcome(value) }
  })

  if (!run.ran) {
    const waiting: ScrapeResult = {
      items: [],
      feedTitle: '',
      platform,
      error: describeDeferral(platform, run.reason),
    }
    if (
      platform === 'bilibili'
      && run.reason === 'platform_paused'
      && deps.pacer.snapshot('bilibili').lastChallenge?.kind === 'auth'
    ) {
      // Signed out: the page is left alone, and the anonymous route keeps the pace the page would have had —
      // one at a time, not before this source is due, not while nobody is there.
      const anonymous = await deps.pacer.run(
        request,
        async () => ({ value: await deps.fetchSignedOutBilibili(source.url), outcome: 'other' as const }),
        { ignorePause: true },
      )
      if (anonymous.ran) {
        deps.log(`[rss-session] platform=bilibili source=${source.id} trigger=${trigger} route=anonymous items=${anonymous.value?.items.length ?? 0}`)
        return fromAnonymousRoute(anonymous.value, {
          ...waiting,
          error: 'Bilibili 应用内浏览器会话当前未登录。请先在 Ready 浏览器中登录该站点后再刷新。',
        })
      }
      if (anonymous.reason !== 'not_due') {
        deps.log(`[rss-session] platform=bilibili source=${source.id} trigger=${trigger} route=anonymous skipped=${anonymous.reason}`)
      }
      return {
        result: { ...waiting, error: describeDeferral(platform, anonymous.reason) },
        backendUsed: 'browser',
        deferred: { reason: anonymous.reason, retryAt: anonymous.retryAt },
      }
    }
    if (run.reason !== 'not_due') {
      deps.log(`[rss-session] platform=${platform} source=${source.id} trigger=${trigger} skipped=${run.reason}`)
    }
    return {
      result: waiting,
      backendUsed: 'browser',
      deferred: { reason: run.reason, retryAt: run.retryAt },
    }
  }

  const sessionResult = run.value
  if (sessionResult.items.length === 0 && platform === 'bilibili' && sessionResult.state === 'auth') {
    // The page has just shown its sign-in prompt; this source gets its anonymous answer now, still in single file.
    const anonymous = await deps.pacer.serialize(() => deps.fetchSignedOutBilibili(source.url))
    return fromAnonymousRoute(anonymous, plain(sessionResult))
  }
  return { result: plain(sessionResult), backendUsed: 'browser' }
}
