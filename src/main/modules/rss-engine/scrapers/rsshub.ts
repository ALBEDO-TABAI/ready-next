/**
 * RSSHub proxy base + Bilibili/Weibo/Douyin/Xiaohongshu scrapers.
 * These platforms depend on a self-hosted or embedded RSSHub instance.
 */

import { BaseScraper, type ScrapeResult, type ScrapedItem } from './base'
import { NativeRSSScraper } from './native-rss'
import { createHash } from 'crypto'

interface RSSHubJSONItem {
  title?: string
  link?: string
  description?: string
  pubDate?: string
  author?: string
  category?: string
}

interface RSSHubJSONFeed {
  title?: string
  item?: RSSHubJSONItem[]
  items?: RSSHubJSONItem[]
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function isTransientBrowserRouteError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('targetcloseerror') ||
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

export function resolveBilibiliStaleRouteResult(
  primary: ScrapeResult,
  browserResult: ScrapeResult | null,
  now = Date.now(),
): { result: ScrapeResult; backend: 'rsshub' | 'browser' } {
  if (!isLikelyStaleBilibiliResult(primary, now) || !browserResult) {
    return {
      result: primary,
      backend: 'rsshub',
    }
  }

  if (browserResult.items.length > 0) {
    return {
      result: {
        ...browserResult,
        error: 'Bilibili 上游接口返回内容偏旧，已改用浏览器页面兜底。',
      },
      backend: 'browser',
    }
  }

  const browserError =
    browserResult.error || 'Bilibili 应用内浏览器未提取到可用条目，请先在 Ready 浏览器中打开该 UP 主页后重试。'
  return {
    result: {
      items: [],
      feedTitle: browserResult.feedTitle || primary.feedTitle,
      platform: primary.platform,
      error: `Bilibili 上游接口返回内容偏旧。${browserError}`,
    },
    backend: 'browser',
  }
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
      const key = link || `${title}-${item.pubDate || ''}`
      return {
        itemId: this.generateItemId(key),
        title,
        description: item.description?.replace(/<[^>]+>/g, '').trim().slice(0, 500) || '',
        link,
        pubDate: item.pubDate || '',
        author: item.author || '',
        coverImage: null,
        metadata: {},
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

export class BilibiliScraper extends RSSHubScraper {
  private fallbackRoute: string
  private static readonly mixinKeyEncTab = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
  ]

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

  private async extractUserIdFromVideo(url: string): Promise<string | null> {
    const bvid = url.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1]
    const aid = url.match(/\/video\/av(\d+)/i)?.[1]
    if (!bvid && !aid) return null

    const apiUrl = bvid
      ? `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
      : `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(aid || '')}`

    try {
      const { text } = await this.httpGet(apiUrl, {
        headers: { Accept: 'application/json, text/plain, */*' },
      })
      const payload = JSON.parse(text) as {
        code?: number
        data?: { owner?: { mid?: number | string } }
      }
      const mid = payload?.data?.owner?.mid
      return mid ? String(mid) : null
    } catch {
      return null
    }
  }

  private async resolveUserId(url: string): Promise<string | null> {
    const spaceId = this.extractUserId(url)
    if (spaceId) return spaceId

    const lower = url.toLowerCase()
    if (lower.includes('b23.tv') || lower.includes('bili2233.cn')) {
      try {
        const resolved = await this.resolveFinalUrl(url)
        if (resolved && resolved !== url) {
          return this.resolveUserId(resolved)
        }
      } catch {
        return null
      }
    }

    return this.extractUserIdFromVideo(url)
  }

  private getMixinKey(imgKey: string, subKey: string): string {
    const orig = imgKey + subKey
    return BilibiliScraper.mixinKeyEncTab.map((index) => orig[index]).join('').slice(0, 32)
  }

  private encodeWbiParams(
    params: Record<string, string | number>,
    imgKey: string,
    subKey: string,
  ): string {
    const mixinKey = this.getMixinKey(imgKey, subKey)
    const chrFilter = /[!'()*]/g
    const wts = Math.round(Date.now() / 1000)
    const payload: Record<string, string | number> = { ...params, wts }

    const query = Object.keys(payload)
      .sort()
      .map((key) => {
        const value = String(payload[key]).replace(chrFilter, '')
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
      })
      .join('&')

    const wRid = createHash('md5').update(query + mixinKey).digest('hex')
    return `${query}&w_rid=${wRid}`
  }

  /**
   * Anti-risk fallback: uses Bilibili's polymer web-space API.
   * This endpoint often remains available when WBI API returns -352/-799.
   */
  private async fetchViaPolymerAPI(userId: string): Promise<ScrapeResult> {
    try {
      const apiUrl = `https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=${encodeURIComponent(userId)}&page_num=1&page_size=20`
      const response = await this.httpGet(apiUrl, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: `https://space.bilibili.com/${userId}`,
        },
      })

      const data = JSON.parse(response.text) as {
        code?: number
        message?: string
        data?: {
          items_lists?: {
            seasons_list?: Array<{
              meta?: { name?: string }
              archives?: Array<{
                bvid?: string
                aid?: number
                title?: string
                desc?: string
                pubdate?: number
                author?: string
                pic?: string
              }>
            }>
            series_list?: Array<{
              meta?: { name?: string }
              archives?: Array<{
                bvid?: string
                aid?: number
                title?: string
                desc?: string
                pubdate?: number
                author?: string
                pic?: string
              }>
            }>
          }
        }
      }

      if (data?.code !== 0) {
        return {
          items: [],
          feedTitle: '',
          platform: this.platform,
          error: `Bilibili polymer API error: ${data?.message || data?.code || 'unknown'}`,
        }
      }

      const seasons = data?.data?.items_lists?.seasons_list ?? []
      const series = data?.data?.items_lists?.series_list ?? []
      const groups = [...seasons, ...series]
      const seen = new Set<string>()
      const items: ScrapedItem[] = []
      let feedTitle = `Bilibili ${userId}`

      for (const group of groups) {
        if (group?.meta?.name && feedTitle.startsWith('Bilibili ')) {
          feedTitle = group.meta.name
        }
        for (const archive of group.archives ?? []) {
          const bvid = archive.bvid || ''
          const aid = archive.aid || 0
          const key = bvid || String(aid)
          if (!key || seen.has(key)) continue
          seen.add(key)

          const pic = archive.pic || ''
          const cover =
            pic.length > 0 ? (pic.startsWith('//') ? `https:${pic}` : pic) : null
          items.push({
            itemId: this.generateItemId(`bilibili:${userId}:polymer:${key}`),
            title: archive.title || '(Untitled)',
            description: (archive.desc || '').slice(0, 500),
            link: bvid
              ? `https://www.bilibili.com/video/${bvid}`
              : `https://www.bilibili.com/video/av${aid}`,
            pubDate: archive.pubdate ? new Date(archive.pubdate * 1000).toISOString() : '',
            author: archive.author || '',
            coverImage: cover,
            metadata: {},
          })
        }
      }

      items.sort((a, b) => {
        const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0
        const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0
        return tb - ta
      })

      return {
        items: items.slice(0, 50),
        feedTitle,
        platform: this.platform,
      }
    } catch (err) {
      return {
        items: [],
        feedTitle: '',
        platform: this.platform,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private async fetchViaOfficialAPI(userId: string): Promise<ScrapeResult> {
    try {
      const navResp = await this.httpGet('https://api.bilibili.com/x/web-interface/nav', {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://www.bilibili.com/',
        },
      })
      const nav = JSON.parse(navResp.text) as {
        code?: number
        data?: { wbi_img?: { img_url?: string; sub_url?: string } }
      }
      const imgUrl = nav?.data?.wbi_img?.img_url || ''
      const subUrl = nav?.data?.wbi_img?.sub_url || ''
      const imgKey = (imgUrl.split('/').pop() || '').split('.')[0]
      const subKey = (subUrl.split('/').pop() || '').split('.')[0]
      if (!imgKey || !subKey) {
        return {
          items: [],
          feedTitle: '',
          platform: this.platform,
          error: 'Bilibili API: failed to resolve WBI keys',
        }
      }

      const query = this.encodeWbiParams(
        { mid: userId, pn: 1, ps: 30, order: 'pubdate' },
        imgKey,
        subKey,
      )
      const apiUrl = `https://api.bilibili.com/x/space/wbi/arc/search?${query}`
      const arcResp = await this.httpGet(apiUrl, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: `https://space.bilibili.com/${userId}`,
        },
      })

      const data = JSON.parse(arcResp.text) as {
        code?: number
        message?: string
        data?: {
          list?: {
            vlist?: Array<{
              bvid?: string
              aid?: number
              title?: string
              description?: string
              pic?: string
              created?: number
              author?: string
            }>
          }
        }
      }

      if (data?.code !== 0) {
        return {
          items: [],
          feedTitle: '',
          platform: this.platform,
          error: `Bilibili API error: ${data?.message || data?.code || 'unknown'}`,
        }
      }

      const vlist = data?.data?.list?.vlist ?? []
      const items: ScrapedItem[] = vlist.map((video) => {
        const bvid = video.bvid || ''
        const aid = video.aid || 0
        const key = bvid || String(aid)
        return {
          itemId: this.generateItemId(`bilibili:${userId}:${key}`),
          title: video.title || '(Untitled)',
          description: (video.description || '').slice(0, 500),
          link: bvid
            ? `https://www.bilibili.com/video/${bvid}`
            : `https://www.bilibili.com/video/av${aid}`,
          pubDate: video.created ? new Date(video.created * 1000).toISOString() : '',
          author: video.author || '',
          coverImage: video.pic ? (video.pic.startsWith('//') ? `https:${video.pic}` : video.pic) : null,
          metadata: {},
        }
      })

      return {
        items,
        feedTitle: `Bilibili ${userId}`,
        platform: this.platform,
      }
    } catch (err) {
      return {
        items: [],
        feedTitle: '',
        platform: this.platform,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    const userId = await this.resolveUserId(url)
    if (!userId) {
      return {
        items: [],
        feedTitle: '',
        platform: this.platform,
        error:
          '无法识别 Bilibili 用户。支持链接：space.bilibili.com/<mid>、bilibili.com/video/BV...、bilibili.com/video/av...、b23 短链。',
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

    const official = await this.fetchViaOfficialAPI(userId)
    if (official.items.length > 0) {
      console.log(`[rss:bilibili] wbi api success user=${userId} items=${official.items.length}`)
      return official
    }

    const polymer = await this.fetchViaPolymerAPI(userId)
    if (polymer.items.length > 0) {
      console.log(`[rss:bilibili] polymer api success user=${userId} items=${polymer.items.length}`)
      return polymer
    }
    if (polymer.error) {
      console.warn(`[rss:bilibili] polymer api failed user=${userId}: ${polymer.error}`)
    }

    const errorParts = [primary.error, fallback.error, official.error, polymer.error].filter(Boolean)
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

export class XiaohongshuScraper extends RSSHubScraper {
  constructor(rsshubBase = 'http://localhost:1200') {
    super('/xiaohongshu/user/{id}/notes', rsshubBase)
  }

  get platform(): string {
    return 'xiaohongshu'
  }

  protected getRouteTimeoutMs(): number {
    return 35_000
  }

  extractUserId(url: string): string | null {
    let match = url.match(/user\/profile\/([a-zA-Z0-9_-]+)/i)
    if (match) return match[1]
    match = url.match(/xiaohongshu\.com\/([a-zA-Z0-9_-]+)/i)
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
      return `小红书抓取依赖 Chromium/session，可先修复 RSS 运行时后重试：${message}`
    }
    if (isLoginOrCookieError(message)) {
      return `小红书当前需要有效登录态或访客会话：${message}`
    }
    if (isTransientBrowserRouteError(message)) {
      return `小红书浏览器抓取链路不稳定，已自动重试一次：${message}`
    }
    if (message.includes('Cannot extract user ID')) {
      return `小红书当前仅支持用户主页订阅，请使用 /user/profile/{id} 链接：${url}`
    }
    return message
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    let normalizedUrl = url
    const lower = url.toLowerCase()
    const shouldResolve = lower.includes('xhslink.com') || lower.includes('xhsurl.cn') || !this.extractUserId(url)
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
