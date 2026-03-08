/**
 * Twitter/X scraper - uses Syndication API (__NEXT_DATA__ JSON)
 * Ported from lets-go-rss TwitterScraper
 */

import { BaseScraper, type ScrapeResult, type ScrapedItem } from './base'
import { NativeRSSScraper } from './native-rss'

export class TwitterScraper extends BaseScraper {
  private rsshubBase: string

  constructor(rsshubBase = 'http://localhost:1200') {
    super()
    this.rsshubBase = rsshubBase
  }

  get platform(): string {
    return 'twitter'
  }

  extractUsername(url: string): string | null {
    const m = url.match(/(?:x\.com|twitter\.com)\/(@?[\w]+)/)
    if (!m) return null
    const username = m[1].replace(/^@/, '')
    const reserved = ['home', 'explore', 'search', 'notifications', 'messages', 'settings', 'i', 'compose']
    if (reserved.includes(username.toLowerCase())) return null
    return username
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    const username = this.extractUsername(url)
    if (!username) {
      return { items: [], feedTitle: '', platform: this.platform, error: `Cannot extract Twitter username from ${url}` }
    }

    // Try Syndication API first
    const result = await this.fetchViaSyndication(username)
    if (result.items.length > 0) return result

    // Fallback: RSSHub
    return this.fetchViaRSSHub(username)
  }

  private async fetchViaSyndication(username: string): Promise<ScrapeResult> {
    const syndicationUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${username}`
    try {
      const { text: html } = await this.httpGet(syndicationUrl, { timeout: 15000 })

      const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">\s*({.+?})\s*<\/script>/s)
      if (!match) {
        return { items: [], feedTitle: '', platform: this.platform, error: 'No __NEXT_DATA__ in Syndication response' }
      }

      const data = JSON.parse(match[1])
      const timeline = data?.props?.pageProps?.timeline ?? {}
      const entries = timeline?.entries ?? []
      if (entries.length === 0) {
        return { items: [], feedTitle: '', platform: this.platform, error: 'Empty timeline' }
      }

      let channelTitle = ''
      const items: ScrapedItem[] = []

      for (const entry of entries.slice(0, 20)) {
        const content = entry.content ?? {}
        const tweet = content.tweet ?? content
        const tweetId = tweet.id_str
        if (!tweetId) continue

        const fullText = tweet.full_text ?? tweet.text ?? ''
        const createdAt = tweet.created_at ?? ''
        const screenName = tweet.user?.screen_name ?? username
        const displayName = tweet.user?.name ?? ''

        if (!channelTitle && displayName) channelTitle = displayName

        let pubDate = ''
        if (createdAt) {
          try {
            pubDate = new Date(createdAt).toISOString()
          } catch { /* ignore */ }
        }

        const cleanText = fullText.replace(/https?:\/\/t\.co\/\S+/g, '').trim()
        const title = cleanText.length > 120 ? cleanText.slice(0, 120) + '...' : cleanText || `Tweet by @${screenName}`

        items.push({
          itemId: this.generateItemId(tweetId),
          title,
          description: fullText.slice(0, 500),
          link: `https://x.com/${screenName}/status/${tweetId}`,
          pubDate,
          author: displayName || `@${screenName}`,
          coverImage: null,
          metadata: {
            _channelTitle: channelTitle || `@${screenName}`,
            tweetId,
            favoriteCount: tweet.favorite_count ?? 0,
            retweetCount: tweet.retweet_count ?? 0
          }
        })
      }

      return { items, feedTitle: channelTitle || `@${username}`, platform: this.platform }
    } catch {
      return { items: [], feedTitle: '', platform: this.platform }
    }
  }

  private async fetchViaRSSHub(username: string): Promise<ScrapeResult> {
    const rsshubUrl = `${this.rsshubBase}/twitter/user/${username}`
    try {
      const { text: xml } = await this.httpGet(rsshubUrl, { timeout: 10000 })
      const parser = new NativeRSSScraper()
      return parser.parseXML(xml, 'twitter')
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
