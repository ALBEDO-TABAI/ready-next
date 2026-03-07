/**
 * 知识星球 scraper - uses pub-api.zsxq.com/v2/groups/{id}
 * Ported from lets-go-rss ZsxqScraper
 */

import { BaseScraper, type ScrapeResult, type ScrapedItem } from './base'
import { NativeRSSScraper } from './native-rss'

export class ZsxqScraper extends BaseScraper {
  private rsshubBase: string

  constructor(rsshubBase = 'http://localhost:1200') {
    super()
    this.rsshubBase = rsshubBase
  }

  get platform(): string {
    return 'zsxq'
  }

  private async resolveShortLink(url: string): Promise<string | null> {
    try {
      const resolved = await this.resolveFinalUrl(url, 10000)
      const fromResolved = resolved.match(/zsxq\.com(?:\/dweb2\/index)?\/groups?\/([\d]+)/i)
      if (fromResolved) return fromResolved[1]
      const fromQuery = resolved.match(/group_id=([\d]+)/i)
      if (fromQuery) return fromQuery[1]
    } catch {
      // fall through
    }
    return null
  }

  async extractGroupId(url: string): Promise<string | null> {
    let m = url.match(/zsxq\.com(?:\/dweb2\/index)?\/groups?\/([\d]+)/)
    if (m) return m[1]
    m = url.match(/group_id=([\d]+)/)
    if (m) return m[1]

    if (url.includes('t.zsxq.com')) {
      return this.resolveShortLink(url)
    }

    return null
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    const groupId = await this.extractGroupId(url)
    if (!groupId) {
      return { items: [], feedTitle: '', platform: this.platform, error: `Cannot extract 知识星球 group_id from ${url}` }
    }

    // Try public API first
    const result = await this.fetchViaPubAPI(groupId)
    if (result.items.length > 0) return result

    // Fallback: RSSHub
    return this.fetchViaRSSHub(groupId)
  }

  private async fetchViaPubAPI(groupId: string): Promise<ScrapeResult> {
    const apiUrl = `https://pub-api.zsxq.com/v2/groups/${groupId}`
    try {
      const { text } = await this.httpGet(apiUrl, {
        timeout: 10000,
        headers: {
          Origin: 'https://wx.zsxq.com',
          Referer: 'https://wx.zsxq.com/'
        }
      })

      const data = JSON.parse(text)
      if (!data.succeeded) {
        return { items: [], feedTitle: '', platform: this.platform, error: data.info ?? 'API returned failure' }
      }

      const resp = data.resp_data ?? {}
      const group = resp.group ?? {}
      const groupName = group.name ?? ''
      const topics = resp.topics ?? []

      if (topics.length === 0) {
        return { items: [], feedTitle: groupName, platform: this.platform, error: 'No topics found' }
      }

      const items: ScrapedItem[] = []
      for (const topic of topics.slice(0, 20)) {
        const topicId = String(topic.topic_id ?? '')
        if (!topicId) continue

        const talk = topic.talk ?? {}
        const question = topic.question ?? {}
        const topicText = talk.text ?? question.text ?? ''

        let title = topic.title ?? topicText.slice(0, 120)
        if (!title) title = `知识星球主题 #${topicId.slice(-6)}`
        title = title.replace(/\n/g, ' ').trim()
        if (title.length > 120) title = title.slice(0, 120) + '...'

        let pubDate = ''
        if (topic.create_time) {
          try {
            pubDate = new Date(topic.create_time).toISOString()
          } catch { /* ignore */ }
        }

        const owner = (talk.owner ?? question.owner ?? {}) as Record<string, string>

        items.push({
          itemId: this.generateItemId(topicId),
          title,
          description: topicText.slice(0, 500),
          link: `https://wx.zsxq.com/topic/${topicId}`,
          pubDate,
          author: owner.name ?? '',
          coverImage: null,
          metadata: {
            _channelTitle: groupName,
            topicId,
            likesCount: topic.likes_count ?? 0
          }
        })
      }

      return { items, feedTitle: groupName, platform: this.platform }
    } catch (err) {
      return {
        items: [],
        feedTitle: '',
        platform: this.platform,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  private async fetchViaRSSHub(groupId: string): Promise<ScrapeResult> {
    const rsshubUrl = `${this.rsshubBase}/zsxq/group/${groupId}`
    try {
      const { text: xml } = await this.httpGet(rsshubUrl, { timeout: 10000 })
      const parser = new NativeRSSScraper()
      return parser.parseXML(xml, 'zsxq')
    } catch (err) {
      return {
        items: [],
        feedTitle: '',
        platform: this.platform,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
}
