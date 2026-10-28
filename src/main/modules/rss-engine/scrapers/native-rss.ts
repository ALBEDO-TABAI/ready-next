/**
 * NativeRSSScraper: Generic RSS 2.0 / Atom / RDF parser using fast-xml-parser.
 * Replaces the old regex-based parser.
 */

import { XMLParser } from 'fast-xml-parser'
import { BaseScraper, type ScrapeResult, type ScrapedItem } from './base'

/** Strip HTML tags */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim()
}

/** Extract cover image from item XML fields */
function extractCoverImage(item: Record<string, unknown>): string | null {
  // 1. enclosure with image type
  const enclosure = item['enclosure'] as Record<string, string> | undefined
  if (enclosure) {
    const attrs = enclosure['@_type'] ?? (enclosure as Record<string, string>)['@_type']
    const url = enclosure['@_url'] ?? (enclosure as Record<string, string>)['@_url']
    if (typeof attrs === 'string' && attrs.startsWith('image') && url) return url as string
    if (url && !attrs) return url as string
  }

  // 2. media:content or media:thumbnail
  const mediaContent = item['media:content'] as Record<string, string> | undefined
  if (mediaContent?.['@_url']) return mediaContent['@_url']
  const mediaThumbnail = item['media:thumbnail'] as Record<string, string> | undefined
  if (mediaThumbnail?.['@_url']) return mediaThumbnail['@_url']

  // 3. First <img> in description/content (usually CDATA, which the parser keeps as an object)
  const content = textOf(
    item['content:encoded'] ?? item['description'] ?? item['content'] ?? item['summary'] ?? ''
  )
  const imgMatch = content.match(/<img[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/i)
  if (imgMatch) return imgMatch[1]

  return null
}

/** Parse a date string into ISO string, or empty string */
function parseDate(dateStr: unknown): string {
  if (!dateStr || typeof dateStr !== 'string') return ''
  const d = new Date(dateStr.trim())
  if (isNaN(d.getTime())) return ''
  return d.toISOString()
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => ['item', 'entry'].includes(name),
  trimValues: true,
  cdataPropName: '__cdata'
})

/** Get text content from a possibly CDATA/object node */
function textOf(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (obj['__cdata']) return String(obj['__cdata'])
    if (obj['#text'] != null) return String(obj['#text'])
  }
  return String(node)
}

export class NativeRSSScraper extends BaseScraper {
  get platform(): string {
    return 'rss'
  }

  async fetchItems(url: string): Promise<ScrapeResult> {
    try {
      const { text: xml } = await this.httpGet(url, {
        headers: {
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
        }
      })
      return this.parseXML(xml)
    } catch (err) {
      return {
        items: [],
        feedTitle: '',
        platform: this.platform,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  parseXML(xml: string, platformOverride?: string): ScrapeResult {
    const plat = platformOverride ?? this.platform
    try {
      const parsed = xmlParser.parse(xml)

      // Atom feed
      const feed = parsed['feed']
      if (feed) {
        return this.parseAtomFeed(feed, plat)
      }

      // RSS 2.0
      const rss = parsed['rss']
      if (rss?.channel) {
        return this.parseRSS2Channel(rss.channel, plat)
      }

      // RDF (RSS 1.0)
      const rdf = parsed['rdf:RDF'] ?? parsed['RDF']
      if (rdf) {
        const items = rdf.item ?? []
        const channelTitle = textOf(rdf?.channel?.title ?? '')
        return {
          items: this.parseRSS2Items(items, plat),
          feedTitle: channelTitle,
          platform: plat
        }
      }

      return { items: [], feedTitle: '', platform: plat, error: 'Unrecognized feed format' }
    } catch (err) {
      return {
        items: [],
        feedTitle: '',
        platform: plat,
        error: `XML parse error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  private parseRSS2Channel(
    channel: Record<string, unknown>,
    plat: string
  ): ScrapeResult {
    const feedTitle = stripHtml(textOf(channel['title']))
    const items = (channel['item'] as Record<string, unknown>[]) ?? []
    return {
      items: this.parseRSS2Items(items, plat),
      feedTitle,
      platform: plat
    }
  }

  private parseRSS2Items(items: Record<string, unknown>[], plat: string): ScrapedItem[] {
    return items.slice(0, 50).map((item) => {
      const title = stripHtml(textOf(item['title'])) || '(Untitled)'
      const link = textOf(item['link']).trim()
      const guid = textOf(item['guid'] ?? item['link']).trim() || `${title}-${Date.now()}`
      const description =
        textOf(item['content:encoded'] ?? item['description']).trim()
      const author = stripHtml(textOf(item['author'] ?? item['dc:creator']))
      const pubDateStr =
        textOf(item['pubDate'] ?? item['dc:date'] ?? item['date'])

      return {
        itemId: this.generateItemId(guid),
        title,
        link,
        description: stripHtml(description).slice(0, 500),
        author,
        pubDate: parseDate(pubDateStr),
        coverImage: extractCoverImage(item),
        metadata: {}
      } satisfies ScrapedItem
    })
  }

  private parseAtomFeed(
    feed: Record<string, unknown>,
    plat: string
  ): ScrapeResult {
    const feedTitle = stripHtml(textOf(feed['title']))
    const entries = (feed['entry'] as Record<string, unknown>[]) ?? []

    const items: ScrapedItem[] = entries.slice(0, 50).map((entry) => {
      const title = stripHtml(textOf(entry['title'])) || '(Untitled)'

      // Atom link: could be object with @_href or array of link objects
      let link = ''
      const linkNode = entry['link']
      if (Array.isArray(linkNode)) {
        const alt =
          linkNode.find(
            (l: Record<string, string>) => !l['@_rel'] || l['@_rel'] === 'alternate'
          ) ?? linkNode[0]
        link = alt?.['@_href'] ?? ''
      } else if (typeof linkNode === 'object' && linkNode !== null) {
        link = (linkNode as Record<string, string>)['@_href'] ?? ''
      } else {
        link = textOf(linkNode)
      }

      const id = textOf(entry['id']) || link || `${title}-${Date.now()}`
      const summary = textOf(entry['summary'] ?? entry['content'])
      const authorNode = entry['author'] as Record<string, unknown> | undefined
      const author = authorNode ? stripHtml(textOf(authorNode['name'])) : ''
      const pubDateStr = textOf(entry['published'] ?? entry['updated'])

      // media:group > media:description (YouTube uses this)
      const mediaGroup = entry['media:group'] as Record<string, unknown> | undefined
      const mediaDesc = mediaGroup ? textOf(mediaGroup['media:description']) : ''

      // media:group > media:thumbnail
      let coverImage: string | null = null
      if (mediaGroup) {
        const thumb = mediaGroup['media:thumbnail'] as Record<string, string> | undefined
        if (thumb?.['@_url']) coverImage = thumb['@_url']
      }
      if (!coverImage) {
        coverImage = extractCoverImage(entry as Record<string, unknown>)
      }

      return {
        itemId: this.generateItemId(id),
        title,
        link: link.trim(),
        description: stripHtml(mediaDesc || summary).slice(0, 500),
        author,
        pubDate: parseDate(pubDateStr),
        coverImage,
        metadata: {}
      }
    })

    return { items, feedTitle, platform: plat }
  }
}
