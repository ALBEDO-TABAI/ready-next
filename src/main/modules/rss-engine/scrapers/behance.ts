/**
 * Behance scraper - uses native RSS feed at /feeds/user?username=
 * Ported from lets-go-rss BehanceScraper
 */

import { BaseScraper, type ScrapeResult } from './base'
import { NativeRSSScraper } from './native-rss'

export class BehanceScraper extends BaseScraper {
  private rssParser = new NativeRSSScraper()

  get platform(): string {
    return 'behance'
  }

  extractUsername(url: string): string | null {
    const m = url.match(/behance\.net\/([^/?#]+)/)
    return m ? m[1] : null
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    const username = this.extractUsername(url)
    if (!username) {
      return { items: [], feedTitle: '', platform: this.platform, error: `Cannot extract Behance username from ${url}` }
    }

    const rssUrl = `https://www.behance.net/feeds/user?username=${username}`
    try {
      const { text: xml } = await this.httpGet(rssUrl)
      return this.rssParser.parseXML(xml, 'behance')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      // Behance occasionally rate-limits with 403
      if (errMsg.includes('403')) {
        return { items: [], feedTitle: '', platform: this.platform, error: 'Behance rate-limited (403), try again later' }
      }
      return { items: [], feedTitle: '', platform: this.platform, error: errMsg }
    }
  }
}
