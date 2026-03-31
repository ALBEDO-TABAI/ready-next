import type { PlatformType } from './scrapers'
import type { RouteFailureKind } from './source-diagnostics'

export interface RSSBrowserOpenAction {
  type: 'open_in_browser'
  label: string
  url: string
  platform: PlatformType
  reason: 'login' | 'verify' | 'inspect'
}

export function buildRSSBrowserOpenAction(
  platform: PlatformType,
  url: string,
  failureKind: RouteFailureKind | null | undefined,
): RSSBrowserOpenAction | null {
  if (!url) return null

  if (failureKind === 'auth') {
    return {
      type: 'open_in_browser',
      label: '去浏览器登录',
      url,
      platform,
      reason: 'login',
    }
  }

  if (failureKind === 'anti_bot' || failureKind === 'waf') {
    return {
      type: 'open_in_browser',
      label: '去浏览器继续验证',
      url,
      platform,
      reason: 'verify',
    }
  }

  return {
    type: 'open_in_browser',
    label: '去浏览器查看页面',
    url,
    platform,
    reason: 'inspect',
  }
}

export function shouldPauseSilentBrowserRetry(
  failureKind: RouteFailureKind | null | undefined,
  attemptedAt: string | null | undefined,
  hasReusablePage: boolean,
  now = Date.now(),
  cooldownMs = 10 * 60 * 1000,
): boolean {
  if (hasReusablePage) return false
  if (failureKind !== 'anti_bot' && failureKind !== 'waf') return false
  if (!attemptedAt) return false
  const attemptedAtMs = Date.parse(attemptedAt)
  if (!Number.isFinite(attemptedAtMs)) return false
  return now - attemptedAtMs < cooldownMs
}
