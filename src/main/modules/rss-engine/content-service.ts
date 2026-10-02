import type { RSSArticle } from '../../../shared/rss-workspace'
import type { RSSContentClaim, RSSContentResult, RSSContentStore } from '../database/rss-content-store'
import type { ExtractionAdapter } from '../clipping/extraction-adapter'
import type { ClipFetchResult } from '../clipping/clip-fetch'

export interface RSSContentServiceDeps {
  content: RSSContentStore
  fetchHtml(url: string, signal: AbortSignal): Promise<ClipFetchResult>
  extractor: ExtractionAdapter
}

/** Loading is an explicit action. Queries and reads never invoke this service. */
export class RSSContentService {
  private readonly inFlight = new Map<string, { itemId: string; revision: string; controller: AbortController; promise: Promise<RSSArticle> }>()
  private stopped = false

  constructor(private readonly deps: RSSContentServiceDeps) {}

  load(itemId: string, force = false): Promise<RSSArticle> {
    if (this.stopped) return Promise.reject(new Error('RSS content service stopped'))
    const article = this.deps.content.getArticle(itemId)
    if (!article) return Promise.reject(new Error('article_not_found'))
    const running = [...this.inFlight.values()].find((entry) => entry.itemId === itemId && entry.revision === article.revision)
    if (running) return running.promise
    if (!force && (article.body.status === 'ready' || article.body.status === 'partial')) return Promise.resolve(article)
    const claim = this.deps.content.beginLoad(itemId)
    if (!claim) return Promise.reject(new Error('article_load_in_progress'))
    for (const entry of this.inFlight.values()) if (entry.itemId === itemId) entry.controller.abort()
    const controller = new AbortController()
    const revision = this.deps.content.getArticle(itemId)!.revision
    const promise = this.fetch(claim, article.link, controller.signal).finally(() => {
      this.inFlight.delete(claim.requestId)
    })
    this.inFlight.set(claim.requestId, { itemId, revision, controller, promise })
    return promise
  }

  private async fetch(claim: RSSContentClaim, url: string, signal: AbortSignal): Promise<RSSArticle> {
    let result: RSSContentResult
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported article URL')
      const response = await this.deps.fetchHtml(url, signal)
      const extracted = await this.deps.extractor.extract({ html: response.html, url: response.finalUrl })
      const markdown = extracted.contentMarkdown
      result = {
        status: !markdown.trim() ? 'failed' : extracted.diagnostics.confidence >= 0.8 ? 'ready' : 'partial',
        markdown: markdown.trim() ? markdown : undefined,
        sourceUrl: response.finalUrl,
        error: !markdown.trim() ? 'No article body was found' : undefined,
      }
    } catch (error) {
      result = {
        status: (error as { kind?: string })?.kind === 'login_required' ? 'login_required' : 'failed',
        sourceUrl: url,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    let saved: boolean
    try { saved = this.deps.content.finishLoad(claim, result) }
    catch (error) {
      // A rolled-back publication still owns its fetch claim; settle it without discarding the saved body.
      this.deps.content.finishLoad(claim, { status: 'failed', sourceUrl: url, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    if (!saved) throw new Error('article_changed')
    const article = this.deps.content.getArticle(claim.itemId)
    if (!article) throw new Error('article_not_found')
    return article
  }

  async stop(): Promise<void> {
    this.stopped = true
    const pending = [...this.inFlight.values()]
    for (const entry of pending) entry.controller.abort()
    await Promise.allSettled(pending.map((entry) => entry.promise))
  }
}
