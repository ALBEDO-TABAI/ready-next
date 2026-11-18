/**
 * RSSHub proxy base + Bilibili/Weibo/Douyin scrapers.
 * Bilibili uses it only as the signed-out route; Xiaohongshu is read through the person's browser session.
 */

import { BaseScraper, type ScrapeResult, type ScrapedItem } from './base'
import { NativeRSSScraper } from './native-rss'

interface RSSHubJSONItem {
  title?: string
  link?: string
  guid?: string
  id?: string
  description?: string
  pubDate?: string
  author?: string
  category?: string
  image?: string
  enclosure_url?: string
  enclosure_type?: string
  content_html?: string
}

interface RSSHubJSONFeed {
  title?: string
  item?: RSSHubJSONItem[]
  items?: RSSHubJSONItem[]
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function jsonCover(item: RSSHubJSONItem): string | null {
  const html = [item.description, item.content_html].filter(Boolean).join('\n')
  const image = html.match(/<img\b[^>]*?\s+src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
  for (const raw of [item.image, item.enclosure_type?.startsWith('image') ? item.enclosure_url : undefined, image?.[1] ?? image?.[2] ?? image?.[3]]) {
    if (!raw) continue
    try {
      const url = new URL(raw)
      if (['http:', 'https:'].includes(url.protocol)) return url.href
    } catch {
      // silent-catch: relative or malformed feed images do not provide a cover.
    }
  }
  return null
}

function isTransientBrowserRouteError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('targetcloseerror') ||
    lower.includes('request timed out') ||
    lower.includes('operation was aborted') ||
    lower.includes('aborterror') ||
    lower.includes('frame got detached') ||
    lower.includes('execution context was destroyed') ||
    lower.includes('session closed') ||
    lower.includes('browser has disconnected') ||
    lower.includes('http 500') ||
    lower.includes('http 502') ||
    lower.includes('http 503') ||
    lower.includes('http 504')
  )
}

function isChromiumDependencyError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('could not find chrome') ||
    lower.includes('chromium') ||
    lower.includes('playwright') ||
    lower.includes('browsertype.launch') ||
    lower.includes('browser executable') ||
    lower.includes("executable doesn't exist") ||
    lower.includes('browser platform') ||
    lower.includes('executable path') ||
    lower.includes('chrome path')
  )
}

function isLoginOrCookieError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('login') ||
    lower.includes('sign in') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('cookie') ||
    lower.includes('登录')
  )
}

function isWafRouteError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('empty post data') ||
    lower.includes('waf') ||
    lower.includes('risk control') ||
    lower.includes('-352') ||
    lower.includes('-799')
  )
}

export function isLikelyStaleBilibiliResult(
  result: Pick<ScrapeResult, 'items' | 'platform'>,
  now = Date.now(),
  maxAgeDays = 14,
): boolean {
  if (result.platform !== 'bilibili') return false
  if (!Array.isArray(result.items) || result.items.length === 0) return false
  const latestMs = Math.max(
    ...result.items.map((item) => {
      const value = item.pubDate ? Date.parse(item.pubDate) : NaN
      return Number.isFinite(value) ? value : 0
    }),
  )
  if (!latestMs) return false
  return now - latestMs > maxAgeDays * 24 * 60 * 60 * 1000
}

class RSSHubScraper extends BaseScraper {
  protected rsshubBase: string
  protected routeTemplate: string
  private rssParser = new NativeRSSScraper()

  constructor(routeTemplate: string, rsshubBase: string) {
    super()
    this.routeTemplate = routeTemplate
    this.rsshubBase = normalizeBaseUrl(rsshubBase)
  }

  get platform(): string {
    return 'rsshub'
  }

  extractUserId(_url: string): string | null {
    return null
  }

  protected parseJSONFeed(payload: RSSHubJSONFeed, platform: string): ScrapeResult {
    const items = (payload.items || payload.item || []).slice(0, 50)
    const mapped: ScrapedItem[] = items.map((item) => {
      const link = item.link?.trim() || ''
      const title = item.title?.trim() || '(Untitled)'
      const rssGuid = item.guid?.trim() || item.id?.trim() || ''
      const key = rssGuid || link || `${title}-${item.pubDate || ''}`
      return {
        itemId: this.generateItemId(key),
        title,
        description: item.description?.replace(/<[^>]+>/g, '').trim().slice(0, 500) || '',
        link,
        pubDate: item.pubDate || '',
        author: item.author || '',
        coverImage: jsonCover(item),
        metadata: rssGuid ? { rssGuid } : {},
      }
    })

    return {
      items: mapped,
      feedTitle: payload.title || '',
      platform,
    }
  }

  protected async fetchRoute(routePath: string, platform: string): Promise<ScrapeResult> {
    const route = routePath.startsWith('/') ? routePath : `/${routePath}`
    const url = `${this.rsshubBase}${route}`
    try {
      const { text, headers } = await this.httpGet(url, {
        timeout: this.getRouteTimeoutMs(),
        retries: this.getRouteRequestRetries(),
      })
      const contentType = (headers.get('content-type') || '').toLowerCase()

      if (contentType.includes('json')) {
        const parsed = JSON.parse(text) as RSSHubJSONFeed
        return this.parseJSONFeed(parsed, platform)
      }

      return this.rssParser.parseXML(text, platform)
    } catch (err) {
      return {
        items: [],
        feedTitle: '',
        platform,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  protected getRouteTimeoutMs(): number {
    return this.timeout
  }

  protected getRouteRequestRetries(): number {
    return 1
  }

  protected shouldRetryRouteError(_message: string): boolean {
    return false
  }

  protected normalizeRouteError(message: string, _url: string): string {
    return message
  }

  protected async fetchRouteWithRecovery(routePath: string, platform: string): Promise<ScrapeResult> {
    const first = await this.fetchRoute(routePath, platform)
    if (!first.error || first.items.length > 0 || !this.shouldRetryRouteError(first.error)) {
      return first
    }

    await new Promise((resolve) => setTimeout(resolve, this.retryBackoff))
    return this.fetchRoute(routePath, platform)
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    const userId = this.extractUserId(url)
    if (!userId) {
      return {
        items: [],
        feedTitle: '',
        platform: this.platform,
        error: this.normalizeRouteError(`Cannot extract user ID from ${url}`, url),
      }
    }

    const route = this.routeTemplate.replace('{id}', userId)
    const result = await this.fetchRouteWithRecovery(route, this.platform)
    if (!result.error) return result
    return {
      ...result,
      error: this.normalizeRouteError(result.error, url),
    }
  }
}

/**
 * The anonymous route for a Bilibili space, used only when the person is not signed in to Bilibili in Ready's
 * browser. It asks RSSHub and nothing else: no request is signed or sent to Bilibili from here.
 */
export class BilibiliScraper extends RSSHubScraper {
  private fallbackRoute: string

  constructor(rsshubBase = 'http://localhost:1200') {
    super('/bilibili/user/video/{id}', rsshubBase)
    this.fallbackRoute = '/bilibili/user/dynamic/{id}'
  }

  get platform(): string {
    return 'bilibili'
  }

  extractUserId(url: string): string | null {
    const space = url.match(/space\.bilibili\.com\/(\d+)/i)
    if (space) return space[1]
    return null
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    const userId = this.extractUserId(url)
    if (!userId) {
      return {
        items: [],
        feedTitle: '',
        platform: this.platform,
        error: '无法识别 Bilibili 用户。请使用 UP 主空间页的链接（space.bilibili.com/<mid>）。',
      }
    }

    const primary = await this.fetchRoute(this.routeTemplate.replace('{id}', userId), this.platform)
    if (primary.items.length > 0) {
      console.log(`[rss:bilibili] rsshub video success user=${userId} items=${primary.items.length}`)
      return primary
    }

    const fallback = await this.fetchRoute(this.fallbackRoute.replace('{id}', userId), this.platform)
    if (fallback.items.length > 0) {
      console.log(`[rss:bilibili] rsshub dynamic success user=${userId} items=${fallback.items.length}`)
      return fallback
    }

    const errorParts = [primary.error, fallback.error].filter(Boolean)
    return {
      items: [],
      feedTitle: '',
      platform: this.platform,
      error: errorParts.length > 0 ? errorParts.join(' | ') : 'No items from both video and dynamic route',
    }
  }
}

export class WeiboScraper extends RSSHubScraper {
  constructor(rsshubBase = 'http://localhost:1200') {
    super('/weibo/user/{id}', rsshubBase)
  }

  get platform(): string {
    return 'weibo'
  }

  protected getRouteTimeoutMs(): number {
    return 35_000
  }

  extractUserId(url: string): string | null {
    let match = url.match(/weibo\.com\/u\/(\d+)/i)
    if (match) return match[1]
    match = url.match(/m\.weibo\.cn\/u\/(\d+)/i)
    if (match) return match[1]
    match = url.match(/m\.weibo\.cn\/profile\/(\d+)/i)
    if (match) return match[1]
    match = url.match(/[?&]containerid=100505(\d+)/i)
    if (match) return match[1]
    match = url.match(/weibo\.com\/(\d+)/i)
    return match ? match[1] : null
  }

  protected shouldRetryRouteError(message: string): boolean {
    return (
      isTransientBrowserRouteError(message) &&
      !isChromiumDependencyError(message) &&
      !isLoginOrCookieError(message)
    )
  }

  protected normalizeRouteError(message: string, url: string): string {
    if (isChromiumDependencyError(message)) {
      return `微博抓取依赖 Chromium/session，可先修复 RSS 运行时后重试：${message}`
    }
    if (isLoginOrCookieError(message)) {
      return `微博当前需要有效登录态或访客会话：${message}`
    }
    if (isTransientBrowserRouteError(message)) {
      return `微博浏览器抓取链路出现瞬时错误，已自动重试一次：${message}`
    }
    if (message.includes('Cannot extract user ID')) {
      return `微博链接未解析到用户主页 ID，请优先使用 /u/{id} 或 mobile profile 链接：${url}`
    }
    return message
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    let normalizedUrl = url
    const lower = url.toLowerCase()
    const shouldResolve = lower.includes('t.cn/') || lower.includes('m.weibo.cn') || !this.extractUserId(url)
    if (shouldResolve) {
      try {
        const resolved = await this.resolveFinalUrl(url)
        if (resolved) normalizedUrl = resolved
      } catch {
        // Keep original URL and surface a normalized scraper error later.
      }
    }
    return super.fetchItems(normalizedUrl)
  }
}

export class DouyinScraper extends RSSHubScraper {
  constructor(rsshubBase = 'http://localhost:1200') {
    super('/douyin/user/{id}', rsshubBase)
  }

  get platform(): string {
    return 'douyin'
  }

  protected getRouteTimeoutMs(): number {
    return 35_000
  }

  extractUserId(url: string): string | null {
    let match = url.match(/douyin\.com\/user\/([A-Za-z0-9_-]+)/i)
    if (match) return match[1]

    match = url.match(/iesdouyin\.com\/share\/user\/([A-Za-z0-9._-]+)/i)
    if (match) return match[1]

    match = url.match(/[?&]sec_uid=([A-Za-z0-9._%-]+)/i)
    if (match) {
      try {
        return decodeURIComponent(match[1])
      } catch {
        return match[1]
      }
    }

    return null
  }

  protected shouldRetryRouteError(message: string): boolean {
    return (
      isTransientBrowserRouteError(message) &&
      !isWafRouteError(message) &&
      !isChromiumDependencyError(message)
    )
  }

  protected normalizeRouteError(message: string, url: string): string {
    if (isWafRouteError(message)) {
      return `抖音当前被上游风控/WAF 拦截，现有浏览器链路暂不可稳定获取：${message}`
    }
    if (isChromiumDependencyError(message)) {
      return `抖音抓取依赖 Chromium/session，可先修复 RSS 运行时后重试：${message}`
    }
    if (isTransientBrowserRouteError(message)) {
      return `抖音浏览器抓取链路出现瞬时错误，已自动重试一次：${message}`
    }
    if (message.includes('Cannot extract user ID')) {
      return `抖音链接未解析到 sec_uid/用户 ID，请优先使用用户主页或 share user 链接：${url}`
    }
    return message
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    let normalizedUrl = url
    const lower = url.toLowerCase()
    const shouldResolve =
      lower.includes('v.douyin.com') ||
      lower.includes('iesdouyin.com/share/') ||
      !this.extractUserId(url)
    if (shouldResolve && lower.includes('douyin.com')) {
      try {
        const resolved = await this.resolveFinalUrl(url)
        if (resolved) normalizedUrl = resolved
      } catch {
        // Keep original URL and let normal extraction report a proper error.
      }
    }
    return super.fetchItems(normalizedUrl)
  }
}
