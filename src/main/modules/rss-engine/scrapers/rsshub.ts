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
      const { text, headers } = await this.httpGet(url)
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

  async fetchItems(url: string): Promise<ScrapeResult> {
    const userId = this.extractUserId(url)
    if (!userId) {
      return {
        items: [],
        feedTitle: '',
        platform: this.platform,
        error: `Cannot extract user ID from ${url}`,
      }
    }

    const route = this.routeTemplate.replace('{id}', userId)
    return this.fetchRoute(route, this.platform)
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

    const polymer = await this.fetchViaPolymerAPI(userId)
    if (polymer.items.length > 0) {
      console.log(`[rss:bilibili] polymer api success user=${userId} items=${polymer.items.length}`)
      return polymer
    }
    if (polymer.error) {
      console.warn(`[rss:bilibili] polymer api failed user=${userId}: ${polymer.error}`)
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

    const errorParts = [polymer.error, primary.error, fallback.error, official.error].filter(Boolean)
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

  extractUserId(url: string): string | null {
    let match = url.match(/weibo\.com\/u\/(\d+)/i)
    if (match) return match[1]
    match = url.match(/weibo\.com\/(\d+)/i)
    return match ? match[1] : null
  }
}

export class DouyinScraper extends RSSHubScraper {
  constructor(rsshubBase = 'http://localhost:1200') {
    super('/douyin/user/{id}', rsshubBase)
  }

  get platform(): string {
    return 'douyin'
  }

  extractUserId(url: string): string | null {
    const match = url.match(/douyin\.com\/user\/([A-Za-z0-9_-]+)/i)
    return match ? match[1] : null
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    let normalizedUrl = url
    const lower = url.toLowerCase()
    const shouldResolve = lower.includes('v.douyin.com') || !this.extractUserId(url)
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

  extractUserId(url: string): string | null {
    let match = url.match(/user\/profile\/([a-zA-Z0-9]+)/i)
    if (match) return match[1]
    match = url.match(/xiaohongshu\.com\/([a-zA-Z0-9]+)/i)
    return match ? match[1] : null
  }
}
