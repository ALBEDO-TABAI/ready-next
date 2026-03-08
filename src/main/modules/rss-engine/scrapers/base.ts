/**
 * BaseScraper: HTTP fetch + retry + timeout for all scrapers.
 * Ported from lets-go-rss scrapers.py BaseScraper.
 */

import { createHash } from 'crypto'

export interface ScrapedItem {
  itemId: string
  title: string
  description: string
  link: string
  pubDate: string
  author: string
  coverImage: string | null
  metadata: Record<string, unknown>
}

export interface ScrapeResult {
  items: ScrapedItem[]
  feedTitle: string
  platform: string
  error?: string
}

export abstract class BaseScraper {
  protected headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    Connection: 'keep-alive'
  }
  protected timeout = 15000
  protected maxRetries = 2
  protected retryBackoff = 800

  abstract get platform(): string
  abstract fetchItems(url: string): Promise<ScrapeResult>

  protected async httpGet(
    url: string,
    options?: { headers?: Record<string, string>; timeout?: number; retries?: number }
  ): Promise<{ text: string; status: number; headers: Headers }> {
    const maxRetries = options?.retries ?? this.maxRetries
    const reqTimeout = options?.timeout ?? this.timeout
    const reqHeaders = { ...this.headers, ...(options?.headers ?? {}) }

    let lastError: Error | null = null
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), reqTimeout)
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: reqHeaders,
          redirect: 'follow'
        })
        clearTimeout(timer)
        if (!response.ok) {
          let detail = ''
          try {
            detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 320)
          } catch {
            // ignore body extraction failures
          }
          const message = detail
            ? `HTTP ${response.status}: ${response.statusText} | ${detail}`
            : `HTTP ${response.status}: ${response.statusText}`
          throw new Error(message)
        }
        const text = await response.text()
        return { text, status: response.status, headers: response.headers }
      } catch (err) {
        clearTimeout(timer)
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, this.retryBackoff * (attempt + 1)))
        }
      }
    }
    throw lastError ?? new Error('Request failed')
  }

  protected async resolveFinalUrl(url: string, timeout = 10000): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: this.headers,
        signal: controller.signal,
      })
      return response.url || url
    } finally {
      clearTimeout(timer)
    }
  }

  /** Generate a deterministic item_id: {platform}_{md5(key).slice(0,12)} */
  protected generateItemId(key: string): string {
    const hash = createHash('md5').update(key).digest('hex').slice(0, 12)
    return `${this.platform}_${hash}`
  }
}
