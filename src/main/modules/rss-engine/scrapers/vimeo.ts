/**
 * Vimeo scraper - uses native RSS feed at /{username}/videos/rss
 * Ported from lets-go-rss VimeoScraper
 */

import { BaseScraper, type ScrapeResult } from './base'
import { NativeRSSScraper } from './native-rss'

export class VimeoScraper extends BaseScraper {
  private rssParser = new NativeRSSScraper()

  get platform(): string {
    return 'vimeo'
  }

  extractUsername(url: string): string | null {
    const m = url.match(/vimeo\.com\/([^/?#]+)/)
    return m ? m[1] : null
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    const username = this.extractUsername(url)
    if (!username) {
      return { items: [], feedTitle: '', platform: this.platform, error: `Cannot extract Vimeo username from ${url}` }
    }

    const rssUrl = `https://vimeo.com/${username}/videos/rss`
    try {
      const { text: xml } = await this.httpGet(rssUrl)
      return this.rssParser.parseXML(xml, 'vimeo')
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
