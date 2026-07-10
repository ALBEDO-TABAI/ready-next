import {
  isBrowsingDataType,
  type BrowserCookieDomainGroup,
  type BrowserCookieRecord,
  type BrowserPrivacySummary,
  type BrowsingDataType,
  type ClearBrowsingDataRequest,
  type ClearBrowsingDataResult,
  type RemoveBrowserCookiePayload,
} from '../../../shared/browser-privacy'

// Narrow structural views over Electron.Session / Session.cookies so the
// service can be behavior-tested without an Electron runtime.
export interface PrivacyCookieLike {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  session?: boolean
  expirationDate?: number
  sameSite?: string
}

export interface PrivacyCookiesLike {
  get(filter: { domain?: string }): Promise<PrivacyCookieLike[]>
  remove(url: string, name: string): Promise<void>
  flushStore(): Promise<void>
}

export interface PrivacySessionLike {
  getCacheSize(): Promise<number>
  clearCache(): Promise<void>
  clearCodeCaches(options: { urls?: string[] }): Promise<void>
  clearStorageData(options?: { storages?: string[] }): Promise<void>
  cookies: PrivacyCookiesLike
}

export interface BrowserPrivacyDataStore {
  clearHistory(sinceEpochSeconds?: number): void
  clearDownloads(sinceEpochSeconds?: number): void
  getHistoryCount(): number
  getDownloadCount(): number
}

// clearStorageData storage buckets other than cookies; 'cookies' stays in its
// own BrowsingDataType so the two can be cleared independently.
const SITE_STORAGE_TYPES: readonly string[] = [
  'filesystem',
  'indexdb',
  'localstorage',
  'shadercache',
  'websql',
  'serviceworkers',
  'cachestorage',
]

export function normalizeCookieDomain(domain: string | undefined): string {
  return String(domain || '').trim().toLowerCase().replace(/^\.+/, '')
}

export function cookieRemovalUrl(cookie: { domain?: string; path?: string; secure?: boolean }): string {
  const host = normalizeCookieDomain(cookie.domain)
  const path = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/'
  return `${cookie.secure ? 'https' : 'http'}://${host}${path}`
}

export class BrowserPrivacyService {
  private readonly getSession: () => PrivacySessionLike
  private readonly data: BrowserPrivacyDataStore

  constructor(deps: { getSession: () => PrivacySessionLike; data: BrowserPrivacyDataStore }) {
    this.getSession = deps.getSession
    this.data = deps.data
  }

  async getSummary(): Promise<BrowserPrivacySummary> {
    const session = this.getSession()
    const [cacheBytes, cookies] = await Promise.all([
      session.getCacheSize(),
      session.cookies.get({}),
    ])
    const domains = new Set(
      cookies.map((cookie) => normalizeCookieDomain(cookie.domain)).filter(Boolean),
    )
    return {
      cacheBytes: Number.isFinite(cacheBytes) ? cacheBytes : 0,
      cookieCount: cookies.length,
      cookieDomainCount: domains.size,
      historyCount: this.data.getHistoryCount(),
      downloadCount: this.data.getDownloadCount(),
    }
  }

  async listCookies(): Promise<BrowserCookieDomainGroup[]> {
    const cookies = await this.getSession().cookies.get({})
    const groups = new Map<string, BrowserCookieRecord[]>()
    for (const cookie of cookies) {
      const hostDomain = normalizeCookieDomain(cookie.domain)
      const record: BrowserCookieRecord = {
        domain: String(cookie.domain || ''),
        hostDomain,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path && cookie.path.startsWith('/') ? cookie.path : '/',
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
        session: cookie.session === true,
        expirationDate: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : undefined,
        sameSite: String(cookie.sameSite || 'unspecified'),
      }
      const bucket = groups.get(hostDomain)
      if (bucket) {
        bucket.push(record)
      } else {
        groups.set(hostDomain, [record])
      }
    }
    return Array.from(groups.entries())
      .map(([domain, list]) => ({
        domain,
        cookies: list.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain))
  }

  async removeCookie(payload: RemoveBrowserCookiePayload): Promise<{ removed: number }> {
    const session = this.getSession()
    const url = cookieRemovalUrl({
      domain: payload.domain,
      path: payload.path,
      secure: payload.secure,
    })
    await session.cookies.remove(url, payload.name)
    await session.cookies.flushStore()
    return { removed: 1 }
  }

  async removeCookiesForDomain(domain: string): Promise<{ removed: number }> {
    const target = normalizeCookieDomain(domain)
    if (!target) return { removed: 0 }
    const session = this.getSession()
    const cookies = await session.cookies.get({})
    const matching = cookies.filter((cookie) => normalizeCookieDomain(cookie.domain) === target)
    for (const cookie of matching) {
      await session.cookies.remove(cookieRemovalUrl(cookie), cookie.name)
    }
    if (matching.length > 0) {
      await session.cookies.flushStore()
    }
    return { removed: matching.length }
  }

  async clearBrowsingData(request: ClearBrowsingDataRequest): Promise<ClearBrowsingDataResult> {
    const cleared: BrowsingDataType[] = []
    const errors: { type: string; message: string }[] = []
    const types: BrowsingDataType[] = []
    for (const raw of Array.isArray(request?.dataTypes) ? request.dataTypes : []) {
      if (!isBrowsingDataType(raw)) {
        errors.push({ type: String(raw), message: '未知的数据类型' })
        continue
      }
      if (!types.includes(raw)) types.push(raw)
    }
    const since =
      typeof request?.sinceEpochSeconds === 'number' &&
      Number.isFinite(request.sinceEpochSeconds) &&
      request.sinceEpochSeconds > 0
        ? Math.floor(request.sinceEpochSeconds)
        : undefined

    for (const type of types) {
      try {
        await this.clearOne(type, since)
        cleared.push(type)
      } catch (error) {
        errors.push({ type, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { cleared, errors }
  }

  private async clearOne(type: BrowsingDataType, sinceEpochSeconds?: number): Promise<void> {
    const session = this.getSession()
    switch (type) {
      case 'history':
        this.data.clearHistory(sinceEpochSeconds)
        return
      case 'downloads':
        this.data.clearDownloads(sinceEpochSeconds)
        return
      case 'cookies':
        // Electron cannot time-range cookie clearing — always a full wipe.
        await session.clearStorageData({ storages: ['cookies'] })
        await session.cookies.flushStore()
        return
      case 'cache':
        await session.clearCache()
        await session.clearCodeCaches({})
        return
      case 'siteStorage':
        await session.clearStorageData({ storages: [...SITE_STORAGE_TYPES] })
        return
    }
  }
}
