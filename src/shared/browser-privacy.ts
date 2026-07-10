// Browser privacy wire contract — shared by main (privacy-service / ipc-privacy),
// preload, and the renderer settings panel.

export type BrowsingDataType = 'history' | 'downloads' | 'cookies' | 'cache' | 'siteStorage'

export const BROWSING_DATA_TYPES: readonly BrowsingDataType[] = [
  'history',
  'downloads',
  'cookies',
  'cache',
  'siteStorage',
]

export function isBrowsingDataType(value: unknown): value is BrowsingDataType {
  return typeof value === 'string' && (BROWSING_DATA_TYPES as readonly string[]).includes(value)
}

/**
 * sinceEpochSeconds bounds history/downloads only — Electron session APIs
 * cannot time-range cookies/cache/siteStorage, those always clear everything.
 */
export interface ClearBrowsingDataRequest {
  dataTypes: BrowsingDataType[]
  sinceEpochSeconds?: number
}

export interface ClearBrowsingDataResult {
  cleared: BrowsingDataType[]
  errors: { type: string; message: string }[]
}

export interface BrowserPrivacySummary {
  cacheBytes: number
  cookieCount: number
  cookieDomainCount: number
  historyCount: number
  downloadCount: number
}

export interface BrowserCookieRecord {
  /** Domain as stored by Chromium (may carry a leading dot). */
  domain: string
  /** Leading-dot-stripped lowercase domain used for grouping and removal. */
  hostDomain: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** True for session cookies (no persistent expiry). */
  session: boolean
  /** Seconds since epoch; absent for session cookies. */
  expirationDate?: number
  sameSite: string
}

export interface BrowserCookieDomainGroup {
  domain: string
  cookies: BrowserCookieRecord[]
}

export interface RemoveBrowserCookiePayload {
  domain: string
  path: string
  name: string
  secure: boolean
}
