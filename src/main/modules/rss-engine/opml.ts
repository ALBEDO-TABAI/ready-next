interface RSSSourceLike {
  id: string
  name: string
  url: string
  group_name?: string
  platform?: string
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function generateSubscriptionsOpml(sources: RSSSourceLike[]): string {
  const outlines = sources
    .map((source) => {
      const title = source.name?.trim() || source.url
      return `<outline text="${escapeXml(title)}" title="${escapeXml(title)}" type="rss" xmlUrl="${escapeXml(source.url)}" category="${escapeXml(source.group_name || source.platform || 'default')}" />`
    })
    .join('\n      ')

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head>
    <title>Ready RSS Subscriptions</title>
    <dateCreated>${escapeXml(new Date().toUTCString())}</dateCreated>
  </head>
  <body>
      ${outlines}
  </body>
</opml>`
}
