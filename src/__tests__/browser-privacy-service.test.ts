import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  BrowserPrivacyService,
  cookieRemovalUrl,
  normalizeCookieDomain,
  type PrivacyCookieLike,
} from '../main/modules/browser-engine/privacy-service'
import type { DatabaseManager as DatabaseManagerInstance } from '../main/modules/database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

class FakeCookies {
  store: PrivacyCookieLike[]
  flushCount = 0
  removeCalls: { url: string; name: string }[] = []

  constructor(cookies: PrivacyCookieLike[]) {
    this.store = [...cookies]
  }

  async get(_filter: { domain?: string }): Promise<PrivacyCookieLike[]> {
    return [...this.store]
  }

  async remove(url: string, name: string): Promise<void> {
    this.removeCalls.push({ url, name })
    const host = new URL(url).hostname
    this.store = this.store.filter((cookie) => {
      const cookieHost = normalizeCookieDomain(cookie.domain)
      return !(cookie.name === name && cookieHost === host)
    })
  }

  async flushStore(): Promise<void> {
    this.flushCount += 1
  }
}

class FakeSession {
  cacheSize: number
  calls: { method: string; args?: unknown }[] = []
  cookies: FakeCookies
  clearCacheError: Error | null = null

  constructor(options: { cacheSize?: number; cookies?: PrivacyCookieLike[] } = {}) {
    this.cacheSize = options.cacheSize ?? 0
    this.cookies = new FakeCookies(options.cookies ?? [])
  }

  async getCacheSize(): Promise<number> {
    return this.cacheSize
  }

  async clearCache(): Promise<void> {
    if (this.clearCacheError) throw this.clearCacheError
    this.calls.push({ method: 'clearCache' })
  }

  async clearCodeCaches(options: { urls?: string[] }): Promise<void> {
    this.calls.push({ method: 'clearCodeCaches', args: options })
  }

  async clearStorageData(options?: { storages?: string[] }): Promise<void> {
    this.calls.push({ method: 'clearStorageData', args: options })
  }
}

class FakeDataStore {
  historyCount = 0
  downloadCount = 0
  calls: { method: string; since?: number }[] = []

  clearHistory(sinceEpochSeconds?: number): void {
    this.calls.push({ method: 'clearHistory', since: sinceEpochSeconds })
  }

  clearDownloads(sinceEpochSeconds?: number): void {
    this.calls.push({ method: 'clearDownloads', since: sinceEpochSeconds })
  }

  getHistoryCount(): number {
    return this.historyCount
  }

  getDownloadCount(): number {
    return this.downloadCount
  }
}

function makeService(session: FakeSession, data = new FakeDataStore()) {
  return {
    service: new BrowserPrivacyService({ getSession: () => session, data }),
    data,
  }
}

const SAMPLE_COOKIES: PrivacyCookieLike[] = [
  { name: 'sid', value: 'v1', domain: '.example.com', path: '/', secure: true, httpOnly: true, session: false, expirationDate: 1900000000, sameSite: 'lax' },
  { name: 'theme', value: 'dark', domain: 'example.com', path: '/', secure: false, httpOnly: false, session: true, sameSite: 'unspecified' },
  { name: 'tok', value: 'v3', domain: 'other.net', path: '/app', secure: false, httpOnly: false, session: false, expirationDate: 1900000000, sameSite: 'strict' },
]

describe('browser-privacy-service', () => {
  it('getSummary aggregates cache size, cookies, and local record counts', async () => {
    const session = new FakeSession({ cacheSize: 2048, cookies: SAMPLE_COOKIES })
    const { service, data } = makeService(session)
    data.historyCount = 5
    data.downloadCount = 2

    const summary = await service.getSummary()

    assert.deepEqual(summary, {
      cacheBytes: 2048,
      cookieCount: 3,
      cookieDomainCount: 2,
      historyCount: 5,
      downloadCount: 2,
    })
  })

  it('listCookies groups by normalized domain (dot-prefix merged) and sorts groups and names', async () => {
    const session = new FakeSession({ cookies: SAMPLE_COOKIES })
    const { service } = makeService(session)

    const groups = await service.listCookies()

    assert.equal(groups.length, 2)
    assert.deepEqual(groups.map((g) => g.domain), ['example.com', 'other.net'])
    const example = groups[0]
    assert.deepEqual(example.cookies.map((c) => c.name), ['sid', 'theme'])
    assert.equal(example.cookies[0].hostDomain, 'example.com')
    assert.equal(example.cookies[0].domain, '.example.com')
    assert.equal(groups[1].cookies[0].path, '/app')
  })

  it('removeCookie removes exactly the target cookie via a scheme-correct URL and flushes the store', async () => {
    const session = new FakeSession({ cookies: SAMPLE_COOKIES })
    const { service } = makeService(session)

    const result = await service.removeCookie({ domain: 'example.com', path: '/', name: 'sid', secure: true })

    assert.equal(result.removed, 1)
    assert.deepEqual(session.cookies.removeCalls, [{ url: 'https://example.com/', name: 'sid' }])
    assert.deepEqual(session.cookies.store.map((c) => c.name).sort(), ['theme', 'tok'])
    assert.equal(session.cookies.flushCount, 1)
  })

  it('removeCookie refuses ambiguous same-name cookies instead of deleting siblings', async () => {
    const session = new FakeSession({
      cookies: [
        { name: 'sid', value: 'root', domain: 'example.com', path: '/', secure: true },
        { name: 'sid', value: 'app', domain: '.example.com', path: '/app', secure: true },
      ],
    })
    const { service } = makeService(session)

    await assert.rejects(
      service.removeCookie({ domain: 'example.com', path: '/app', name: 'sid', secure: true }),
      /同名 Cookie/,
    )
    assert.deepEqual(session.cookies.removeCalls, [])
    assert.equal(session.cookies.flushCount, 0)
    assert.equal(session.cookies.store.length, 2)
  })

  it('removeCookiesForDomain removes only that domain (including dot-prefixed variants)', async () => {
    const session = new FakeSession({ cookies: SAMPLE_COOKIES })
    const { service } = makeService(session)

    const result = await service.removeCookiesForDomain('example.com')

    assert.equal(result.removed, 2)
    assert.deepEqual(session.cookies.store.map((c) => c.name), ['tok'])
    assert.equal(session.cookies.flushCount, 1)

    const noop = await service.removeCookiesForDomain('missing.dev')
    assert.equal(noop.removed, 0)
  })

  it('clearBrowsingData routes history/downloads to the local store with the since bound', async () => {
    const session = new FakeSession()
    const { service, data } = makeService(session)

    const result = await service.clearBrowsingData({
      dataTypes: ['history', 'downloads'],
      sinceEpochSeconds: 1234.9,
    })

    assert.deepEqual(result.cleared, ['history', 'downloads'])
    assert.deepEqual(result.errors, [])
    assert.deepEqual(data.calls, [
      { method: 'clearHistory', since: 1234 },
      { method: 'clearDownloads', since: 1234 },
    ])
    assert.deepEqual(session.calls, [])
  })

  it('clearBrowsingData clears cookies/cache/siteStorage through the session and ignores since there', async () => {
    const session = new FakeSession({ cookies: SAMPLE_COOKIES })
    const { service, data } = makeService(session)

    const result = await service.clearBrowsingData({
      dataTypes: ['cookies', 'cache', 'siteStorage'],
      sinceEpochSeconds: 999,
    })

    assert.deepEqual(result.cleared, ['cookies', 'cache', 'siteStorage'])
    assert.deepEqual(result.errors, [])
    assert.deepEqual(data.calls, [])

    const storageCalls = session.calls.filter((c) => c.method === 'clearStorageData')
    assert.equal(storageCalls.length, 2)
    assert.deepEqual(storageCalls[0].args, { storages: ['cookies'] })
    const siteStorages = (storageCalls[1].args as { storages: string[] }).storages
    assert.ok(!siteStorages.includes('cookies'))
    assert.ok(siteStorages.includes('localstorage'))
    assert.ok(siteStorages.includes('indexdb'))
    assert.ok(siteStorages.includes('serviceworkers'))

    assert.ok(session.calls.some((c) => c.method === 'clearCache'))
    assert.ok(session.calls.some((c) => c.method === 'clearCodeCaches'))
    assert.equal(session.cookies.flushCount, 1)
  })

  it('clearBrowsingData isolates per-type failures instead of aborting the batch', async () => {
    const session = new FakeSession()
    session.clearCacheError = new Error('cache backend gone')
    const { service, data } = makeService(session)

    const result = await service.clearBrowsingData({ dataTypes: ['cache', 'history'] })

    assert.deepEqual(result.cleared, ['history'])
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].type, 'cache')
    assert.match(result.errors[0].message, /cache backend gone/)
    assert.deepEqual(data.calls, [{ method: 'clearHistory', since: undefined }])
  })

  it('clearBrowsingData reports unknown data types and dedupes repeats', async () => {
    const session = new FakeSession()
    const { service, data } = makeService(session)

    const result = await service.clearBrowsingData({
      dataTypes: ['history', 'history', 'passwords' as never],
    })

    assert.deepEqual(result.cleared, ['history'])
    assert.equal(data.calls.filter((c) => c.method === 'clearHistory').length, 1)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].type, 'passwords')
  })

  it('cookieRemovalUrl builds scheme/host/path from the stored cookie shape', () => {
    assert.equal(cookieRemovalUrl({ domain: '.Example.com', path: '/a', secure: true }), 'https://example.com/a')
    assert.equal(cookieRemovalUrl({ domain: 'plain.dev', secure: false }), 'http://plain.dev/')
    assert.equal(cookieRemovalUrl({ domain: 'x.io', path: 'broken' }), 'http://x.io/')
  })

  it('clearHistory honors the since boundary against real sqlite rows', async (t) => {
    if (skipIfSqliteUnavailable(t, 'browser-privacy: clearHistory since boundary')) return
    const { DatabaseManager, DatabaseUnavailableError } = await import('../main/modules/database')
    let db: DatabaseManagerInstance | null = null
    try {
      db = new DatabaseManager(true)
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) {
        t.skip('better-sqlite3 native binding unavailable in this Node runtime')
        return
      }
      throw error
    }

    try {
      const oldId = db.addHistoryEntry('https://old.example/x', 'Old')
      db.addHistoryEntry('https://new.example/y', 'New')
      assert.equal(db.getHistoryCount(), 2)

      const cutoff = Math.floor(Date.now() / 1000) - 3600
      db.getRawDb()!
        .prepare('UPDATE browser_history SET visited_at = ? WHERE id = ?')
        .run(cutoff - 7200, oldId)

      db.clearHistory(cutoff)
      assert.equal(db.getHistoryCount(), 1)
      assert.equal(db.getHistory()[0].url, 'https://old.example/x')

      db.clearHistory()
      assert.equal(db.getHistoryCount(), 0)
    } finally {
      db.close()
    }
  })

  it('clearDownloads honors the since boundary against real sqlite rows', async (t) => {
    if (skipIfSqliteUnavailable(t, 'browser-privacy: clearDownloads since boundary')) return
    const { DatabaseManager, DatabaseUnavailableError } = await import('../main/modules/database')
    let db: DatabaseManagerInstance | null = null
    try {
      db = new DatabaseManager(true)
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) {
        t.skip('better-sqlite3 native binding unavailable in this Node runtime')
        return
      }
      throw error
    }

    try {
      db.addDownload({ id: 'dl-old', url: 'https://a/1', filename: 'a.bin', total_bytes: 10 })
      db.addDownload({ id: 'dl-new', url: 'https://a/2', filename: 'b.bin', total_bytes: 10 })
      assert.equal(db.getDownloadCount(), 2)

      const cutoff = Math.floor(Date.now() / 1000) - 3600
      db.getRawDb()!
        .prepare('UPDATE browser_downloads SET created_at = ? WHERE id = ?')
        .run(cutoff - 7200, 'dl-old')

      db.clearDownloads(cutoff)
      assert.equal(db.getDownloadCount(), 1)
      assert.equal(db.getDownloads()[0].id, 'dl-old')

      db.clearDownloads()
      assert.equal(db.getDownloadCount(), 0)
    } finally {
      db.close()
    }
  })
})
