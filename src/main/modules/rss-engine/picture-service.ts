import type { RSSPictureResult } from '../../../shared/rss-pictures'
import { RSS_PICTURE_MAX_ATTEMPTS, RSS_PICTURE_RETRY_AFTER_MS, type RSSPictureStore, type RSSPictureDescription } from '../database/rss-picture-store'
import { getLinkPreview } from '../link-preview'
import { publicURL } from '../link-preview/fetch-public'
import { detectPlatform } from './scrapers'
import { isSessionPlatform } from './session-acquisition-pacer'

export { RSS_PICTURE_MAX_ATTEMPTS, RSS_PICTURE_RETRY_AFTER_MS }
export const RSS_PICTURE_CONCURRENCY = 2
export const RSS_PICTURE_HOST_SPACING_MS = 1000
export const RSS_PICTURE_WARM_LIMIT = 24
/** A warm run reads this many times its limit of candidates to find the ones that are due. */
export const RSS_PICTURE_WARM_SCAN = 5
export const RSS_PICTURE_URL_MAX = 2000

interface RSSPictureServiceDeps {
  store: RSSPictureStore
  preview?: (url: string) => Promise<{ imageUrl?: string }>
  isSessionSource?: (source: { url: string; platform: string }) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  logger?: Pick<Console, 'warn'>
}

interface PendingPicture {
  itemId: string
  promise: Promise<RSSPictureResult>
  resolve: (result: RSSPictureResult) => void
  reject: (error: unknown) => void
  started: boolean
}

function sessionSource(source: { url: string; platform: string }): boolean {
  const stored = source.platform || 'rss', detected = detectPlatform(source.url)
  return isSessionPlatform(stored === 'rss' && detected !== 'rss' ? detected : stored)
}

function imageAddress(raw?: string): string | null {
  if (!raw || raw.length > RSS_PICTURE_URL_MAX) return null
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    url.protocol = 'https:'
    return url.href
  } catch {
    // silent-catch: malformed publisher image addresses count as no picture.
    return null
  }
}

/** Owns both visible-item requests and refresh warming so they share limits and retries. */
export class RSSPictureService {
  private readonly preview
  private readonly isSessionSource
  private readonly now
  private readonly sleep
  private readonly logger
  private readonly pending = new Map<string, PendingPicture>()
  private readonly queue: PendingPicture[] = []
  private readonly hosts = new Set<string>()
  private readonly lastStarted = new Map<string, number>()
  private readonly idleWaiters = new Set<() => void>()
  private active = 0
  private disposed = false
  private warm: Promise<void> | null = null
  private warmAgain = false

  constructor(private readonly deps: RSSPictureServiceDeps) {
    this.preview = deps.preview ?? getLinkPreview
    this.isSessionSource = deps.isSessionSource ?? sessionSource
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.logger = deps.logger ?? console
  }

  lookup(itemIds: string[]): Promise<RSSPictureResult[]> {
    const unique = new Map<string, Promise<RSSPictureResult>>()
    for (const itemId of itemIds) {
      if (unique.has(itemId)) continue
      if (this.disposed) { unique.set(itemId, Promise.resolve(this.result(itemId, 'failed'))); continue }
      let job = this.pending.get(itemId)
      if (!job) {
        let resolve!: PendingPicture['resolve'], reject!: PendingPicture['reject']
        const promise = new Promise<RSSPictureResult>((yes, no) => { resolve = yes; reject = no })
        job = { itemId, promise, resolve, reject, started: false }
        this.pending.set(itemId, job)
        this.queue.push(job)
      }
      unique.set(itemId, job.promise)
    }
    const result = Promise.all(itemIds.map(id => unique.get(id)!))
    this.pump()
    return result
  }

  private result(itemId: string, state: RSSPictureResult['state'], coverImage: string | null = null): RSSPictureResult {
    return { itemId, state, coverImage }
  }

  private inspect(itemId: string): { result: RSSPictureResult } | { item: RSSPictureDescription; host: string } {
    const item = this.deps.store.describe([itemId])[0]
    if (!item) return { result: this.result(itemId, 'unknown') }
    if (item.feedCover) return { result: this.result(itemId, 'feed', item.feedCover) }
    if (this.isSessionSource(item.source)) return { result: this.result(itemId, 'skipped') }
    let host: string
    try { host = publicURL(item.link).hostname }
    catch {
      // silent-catch: unsafe item links are skipped without recording a lookup.
      return { result: this.result(itemId, 'skipped') }
    }
    const stored = item.picture
    if (stored?.outcome === 'page') return { result: this.result(itemId, 'page', stored.pictureUrl) }
    if (stored?.outcome === 'none') return { result: this.result(itemId, 'none') }
    if (stored && (stored.attempts >= RSS_PICTURE_MAX_ATTEMPTS || stored.checkedAt > this.now() - RSS_PICTURE_RETRY_AFTER_MS)) return { result: this.result(itemId, 'failed') }
    return { item, host }
  }

  private finish(job: PendingPicture, result: RSSPictureResult): void {
    this.pending.delete(job.itemId)
    job.resolve(result)
    this.notifyIdle()
  }

  private pump(): void {
    for (let index = 0; !this.disposed && index < this.queue.length;) {
      const job = this.queue[index]
      try {
        const next = this.inspect(job.itemId)
        if ('result' in next) {
          this.queue.splice(index, 1); this.finish(job, next.result)
        } else if (this.active < RSS_PICTURE_CONCURRENCY && !this.hosts.has(next.host)) {
          this.queue.splice(index, 1); this.active++; this.hosts.add(next.host)
          // Each worker settles its owned lookup and releases its slot, including on failure.
          void this.run(job, next.host)
        } else index++
      } catch (error) {
        // silent-catch: storage and admission errors are returned through the owning lookup.
        this.queue.splice(index, 1); this.pending.delete(job.itemId); job.reject(error)
      }
    }
    this.notifyIdle()
  }

  private async run(job: PendingPicture, host: string): Promise<void> {
    try {
      const previous = this.lastStarted.get(host)
      if (previous !== undefined) {
        let delay = previous + RSS_PICTURE_HOST_SPACING_MS - this.now()
        while (delay > 0 && !this.disposed) { await this.sleep(delay); delay = previous + RSS_PICTURE_HOST_SPACING_MS - this.now() }
      }
      if (this.disposed) { this.finish(job, this.result(job.itemId, 'failed')); return }
      const next = this.inspect(job.itemId)
      if ('result' in next) { this.finish(job, next.result); return }
      if (next.host !== host) { this.queue.push(job); return }
      job.started = true
      this.lastStarted.set(host, this.now())
      let outcome: 'page' | 'none' | 'failed', pictureUrl: string | null = null
      try {
        pictureUrl = imageAddress((await this.preview(next.item.link)).imageUrl)
        outcome = pictureUrl ? 'page' : 'none'
      } catch {
        // silent-catch: page fetch failures are saved for one later retry.
        outcome = 'failed'
      }
      this.deps.store.save({ itemId: job.itemId, link: next.item.link, outcome, pictureUrl, now: this.now() })
      this.finish(job, this.result(job.itemId, outcome, pictureUrl))
    } catch (error) {
      // silent-catch: worker failures reach the caller through the owned lookup promise.
      this.pending.delete(job.itemId); job.reject(error)
    } finally {
      this.active--; this.hosts.delete(host); this.pump()
    }
  }

  scheduleWarm(): void {
    if (this.disposed) return
    if (this.warm) { this.warmAgain = true; return }
    this.warm = Promise.resolve().then(async () => {
      try {
        do {
          try {
            // Items that are never looked up (a session source, an address that is not public) keep no record, so
            // they stay candidates for good: read past them, or they would crowd out the items that are due.
            const due = this.deps.store.candidates(RSS_PICTURE_WARM_LIMIT * RSS_PICTURE_WARM_SCAN, this.now())
              .filter(itemId => !('result' in this.inspect(itemId))).slice(0, RSS_PICTURE_WARM_LIMIT)
            await this.lookup(due)
          }
          catch (error) {
            // silent-catch: refresh warming is background work owned and reported by this service.
            this.logger.warn('[rss-pictures] warm lookup failed', error)
          }
          if (!this.warmAgain) break
          this.warmAgain = false
        } while (!this.disposed)
      } finally { this.warm = null; this.notifyIdle() }
    })
  }

  idle(): Promise<void> {
    return !this.warm && !this.pending.size ? Promise.resolve() : new Promise(resolve => this.idleWaiters.add(resolve))
  }

  private notifyIdle(): void {
    if (this.warm || this.pending.size) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  dispose(): void {
    this.disposed = true; this.warmAgain = false; this.queue.length = 0
    for (const job of this.pending.values()) if (!job.started) this.finish(job, this.result(job.itemId, 'failed'))
    this.notifyIdle()
  }
}
