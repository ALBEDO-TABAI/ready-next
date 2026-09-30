import type { RSSMembership, RSSDefinition } from '../../../shared/rss-organization'
interface FeedSource {
  id: string
  name: string
  url: string
}

interface FeedItem {
  id: string
  source_id: string
  title: string
  link: string
  summary: string | null
  author: string | null
  published_at: number | null
  classifications: RSSMembership[]
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function toRfc2822(unixSeconds: number | null): string {
  if (!unixSeconds) return new Date().toUTCString()
  return new Date(unixSeconds * 1000).toUTCString()
}

function renderFeedXml(
  title: string,
  description: string,
  items: FeedItem[],
  sourcesById: Map<string, FeedSource>,
): string {
  const channelItems = items
    .map((item) => {
      const source = sourcesById.get(item.source_id)
      return [
        '<item>',
        `<guid>${escapeXml(item.id)}</guid>`,
        `<title>${escapeXml(item.title)}</title>`,
        `<link>${escapeXml(item.link)}</link>`,
        `<description>${escapeXml(item.summary || '')}</description>`,
        `<author>${escapeXml(item.author || source?.name || 'Ready RSS')}</author>`,
        `<pubDate>${escapeXml(toRfc2822(item.published_at))}</pubDate>`,
        ...item.classifications.filter((entry) => entry.included === true).map((entry) => `<category domain="urn:ready:${escapeXml(entry.definitionId)}">${escapeXml(entry.name + (entry.stale ? '（待更新）' : ''))}</category>`),
        '</item>',
      ].join('')
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <description>${escapeXml(description)}</description>
    <link>https://ready.local/rss</link>
    <generator>Ready RSS Engine</generator>
    <lastBuildDate>${escapeXml(new Date().toUTCString())}</lastBuildDate>
    ${channelItems}
  </channel>
</rss>`
}

export function generateMasterFeed(
  items: FeedItem[],
  sources: FeedSource[],
): string {
  return renderFeedXml(
    'Ready RSS Master Feed',
    'All RSS items from Ready',
    items,
    new Map(sources.map((source) => [source.id, source])),
  )
}

export function generateCategoryFeeds(items: FeedItem[], sources: FeedSource[], definitions: RSSDefinition[]): Record<string, string> {
  const sourcesById = new Map(sources.map((source) => [source.id, source]))
  return Object.fromEntries(definitions.filter((definition) => ['topic', 'curated'].includes(definition.kind)).map((definition) => [
    definition.id, renderFeedXml(`Ready RSS ${definition.name}`, definition.description,
      items.filter((item) => item.classifications.some((entry) => entry.definitionId === definition.id && entry.included === true)), sourcesById),
  ]))
}
