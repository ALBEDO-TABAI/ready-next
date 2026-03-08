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
  ai_tags: string | null
}

const CATEGORY_TO_SLUG: Record<string, string> = {
  科技: 'tech',
  人文: 'humanities',
  设计: 'design',
  娱乐: 'entertainment',
  其他: 'others',
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
        `<category>${escapeXml(item.ai_tags || '其他')}</category>`,
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

export function generateCategoryFeeds(
  items: FeedItem[],
  sources: FeedSource[],
): Record<string, string> {
  const sourcesById = new Map(sources.map((source) => [source.id, source]))
  const grouped = new Map<string, FeedItem[]>()

  for (const item of items) {
    const tag = item.ai_tags || '其他'
    const slug = CATEGORY_TO_SLUG[tag] || 'others'
    const list = grouped.get(slug) ?? []
    list.push(item)
    grouped.set(slug, list)
  }

  const result: Record<string, string> = {}
  for (const [slug, list] of grouped.entries()) {
    result[slug] = renderFeedXml(
      `Ready RSS ${slug}`,
      `Category feed: ${slug}`,
      list,
      sourcesById,
    )
  }

  const allSlugs = ['tech', 'humanities', 'design', 'entertainment', 'others']
  for (const slug of allSlugs) {
    if (!result[slug]) {
      result[slug] = renderFeedXml(
        `Ready RSS ${slug}`,
        `Category feed: ${slug}`,
        [],
        sourcesById,
      )
    }
  }

  return result
}
