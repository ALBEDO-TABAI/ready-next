import { shouldPauseSilentBrowserRetry } from './browser-handoff'
import { classifyRouteFailure } from './source-diagnostics'
import type { RSSArticle } from '../../../shared/rss-workspace'
import type { RSSContentClaim, RSSContentResult, RSSContentStore } from '../database/rss-content-store'
import type { ExtractionAdapter } from '../clipping/extraction-adapter'
import type { ClipFetchResult } from '../clipping/clip-fetch'

export interface RSSContentServiceDeps {
  content: RSSContentStore
  fetchHtml(url: string, signal: AbortSignal, credentials: 'include'): Promise<ClipFetchResult>
  extractor: ExtractionAdapter
}

/**
 * A link that names no article of its own. RSSHub's anonymous Xiaohongshu route has no note ids, so every note
 * links to the author's profile, whose page would otherwise be saved as each note's body.
 */
export function rssLinkWithoutArticleBody(link: string): string | null {
  try {
    const url = new URL(link)
    if (url.hostname.replace(/^www\./, '') === 'xiaohongshu.com' && /^\/user\/profile\/[^/]+\/?$/.test(url.pathname)) {
      return '小红书订阅只提供笔记的标题和封面，这条链接指向作者主页而不是笔记；完整笔记请打开原文查看。'
    }
  } catch {
    return null
  }
  return null
}

/**
 * A page that is opened only when the person asks to read it. A Xiaohongshu note is never fetched in the
 * background: subscriptions read the profile at a person's pace, and opening every new note behind their back
 * would be the opposite.
 */
export function rssLinkWithoutBackgroundPrefetch(link: string): boolean {
  try {
    const url = new URL(link)
    return url.hostname.replace(/^www\./, '') === 'xiaohongshu.com' && /^\/(?:explore|discovery\/item)\//.test(url.pathname)
  } catch {
    return false
  }
}

/** Reader actions and bounded judgment prefetch own loads. Queries never fetch. */
export class RSSContentService {
  private readonly inFlight = new Map<symbol, { itemId: string; revision: string; controller: AbortController; promise: Promise<RSSArticle> }>()
  private stopped = false
  private judgmentTail: Promise<unknown> = Promise.resolve()
  private nextJudgmentFetch = 0
  private readonly pausedOrigins = new Map<string, { kind: 'anti_bot' | 'waf'; at: string }>()

  constructor(private readonly deps: RSSContentServiceDeps) {}

  /** One background fetch at a time, at least two seconds apart; readers share its authenticated load. */
  loadForJudgment(itemId: string): Promise<RSSArticle> {
    const work = this.judgmentTail.then(async () => {
      const original = this.deps.content.getArticle(itemId)
      if (!original) throw new Error('article_not_found')
      try {
        if (original.summary.length >= 800 || ['ready','partial','failed','login_required'].includes(original.body.status)) return original
        if (rssLinkWithoutBackgroundPrefetch(original.link)) return original
        const origin = new URL(original.link).origin, paused = this.pausedOrigins.get(origin)
        if (paused && shouldPauseSilentBrowserRetry(paused.kind, paused.at, false)) return original
        const delay = this.nextJudgmentFetch - Date.now()
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        if (this.stopped) return original
        this.nextJudgmentFetch = Date.now() + 2000
        return await this.loadShared(itemId, false, 'judgment')
      } catch (error) {
        console.warn('[rss-content] judgment prefetch unavailable; using summary', error)
        return original
      }
    })
    this.judgmentTail = work.then(() => undefined, () => undefined)
    return work
  }

  load(itemId: string, force = false): Promise<RSSArticle> {
    return this.loadShared(itemId, force, 'reader')
  }

  private loadShared(itemId: string, force: boolean, purpose: 'reader' | 'judgment'): Promise<RSSArticle> {
    if (this.stopped) return Promise.reject(new Error('RSS content service stopped'))
    const article = this.deps.content.getArticle(itemId)
    if (!article) return Promise.reject(new Error('article_not_found'))
    const running = [...this.inFlight.values()].find((entry) => entry.itemId === itemId && entry.revision === article.revision)
    if (running) return running.promise
    if (!force && (article.body.status === 'ready' || article.body.status === 'partial')) return Promise.resolve(article)
    const claim = purpose === 'reader' ? this.deps.content.beginLoad(itemId) : null
    if (purpose === 'reader' && !claim) return Promise.reject(new Error('article_load_in_progress'))
    for (const entry of this.inFlight.values()) if (entry.itemId === itemId) entry.controller.abort()
    const controller = new AbortController()
    const revision = this.deps.content.getArticle(itemId)!.revision
    const request = Symbol(itemId)
    const promise = this.fetch(claim, article, controller.signal, purpose).finally(() => {
      this.inFlight.delete(request)
    })
    this.inFlight.set(request, { itemId, revision, controller, promise })
    return promise
  }

  private async fetchResult(url: string, signal: AbortSignal): Promise<RSSContentResult> {
    let result: RSSContentResult
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported article URL')
      const withoutBody = rssLinkWithoutArticleBody(url)
      if (withoutBody) throw new Error(withoutBody)
      const response = await this.deps.fetchHtml(url, signal, 'include')
      const extracted = await this.deps.extractor.extract({ html: response.html, url: response.finalUrl })
      const markdown = extracted.contentMarkdown
      const title = response.html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? ''
      if (markdown.trim().length < 120
        && /^(安全验证|验证码|访问受限|Just a moment\.{0,3}|Attention Required!?(?: \| Cloudflare)?|Verify you are human|Security Verification)$/i.test(title)) {
        throw new Error('captcha: 正文页面需要验证，暂停后台获取')
      }
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
    return result
  }

  private async fetch(claim: RSSContentClaim | null, original: RSSArticle, signal: AbortSignal, purpose: 'reader' | 'judgment'): Promise<RSSArticle> {
    const url = original.link
    const result = await this.fetchResult(url, signal)
    if (result.error) {
      const kind = /\bHTTP (403|429|503)\b/i.test(result.error) ? 'anti_bot' : classifyRouteFailure(result.error).kind
      if (kind === 'anti_bot' || kind === 'waf') this.pausedOrigins.set(new URL(url).origin, { kind, at: new Date().toISOString() })
      if (purpose === 'judgment') return original
    }
    if (purpose === 'judgment') {
      // Failed background loads never acquire a persistent claim or alter the reader's state.
      if (signal.aborted || this.deps.content.getArticle(original.id)?.revision !== original.revision) throw new Error('article_changed')
      claim = this.deps.content.beginLoad(original.id)
    }
    if (!claim) throw new Error('article_load_in_progress')
    let saved: boolean
    try { saved = this.deps.content.finishLoad(claim, result, purpose) }
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
    await Promise.allSettled([...pending.map((entry) => entry.promise), this.judgmentTail])
  }
}
