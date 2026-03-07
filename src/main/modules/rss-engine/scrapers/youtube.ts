/**
 * YouTube scraper - uses Atom feed at youtube.com/feeds/videos.xml?channel_id=
 * Ported from lets-go-rss YouTubeScraper
 */

import { BaseScraper, type ScrapeResult } from './base'
import { NativeRSSScraper } from './native-rss'

export class YouTubeScraper extends BaseScraper {
  private rssParser = new NativeRSSScraper()

  get platform(): string {
    return 'youtube'
  }

  extractChannelRef(url: string): string | null {
    // @handle
    let m = url.match(/youtube\.com\/(@[\w-]+)/)
    if (m) return m[1]
    // /channel/ID
    m = url.match(/youtube\.com\/channel\/([\w-]+)/)
    if (m) return m[1]
    // /c/name
    m = url.match(/youtube\.com\/c\/([\w-]+)/)
    if (m) return m[1]
    return null
  }

  private async resolveChannelId(channelRef: string): Promise<string | null> {
    if (channelRef.startsWith('UC')) return channelRef

    const pageUrl = channelRef.startsWith('@')
      ? `https://www.youtube.com/${channelRef}/videos`
      : `https://www.youtube.com/channel/${channelRef}/videos`

    try {
      const { text } = await this.httpGet(pageUrl, { timeout: 12000, retries: 2 })
      let m = text.match(/"externalId":"([A-Za-z0-9_-]+)"/)
      if (!m) m = text.match(/"browseId":"(UC[A-Za-z0-9_-]+)"/)
      return m ? m[1] : null
    } catch {
      return null
    }
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    const channelRef = this.extractChannelRef(url)
    if (!channelRef) {
      return { items: [], feedTitle: '', platform: this.platform, error: `Cannot extract YouTube channel from ${url}` }
    }

    const channelId = await this.resolveChannelId(channelRef)
    if (!channelId) {
      return { items: [], feedTitle: '', platform: this.platform, error: `Cannot resolve channel ID for ${channelRef}` }
    }

    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
    try {
      const { text: xml } = await this.httpGet(feedUrl, { timeout: 12000, retries: 2 })
      return this.rssParser.parseXML(xml, 'youtube')
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
