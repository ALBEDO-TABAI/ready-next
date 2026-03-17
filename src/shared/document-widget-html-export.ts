import { buildWidgetExportSnapshot } from './widget-export-snapshot'

interface WidgetPayload {
  title?: string
  widget_code?: string
  widgetCode?: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function parseWidgetPayload(raw: string): { title: string | null; widgetCode: string | null } {
  try {
    const payload = JSON.parse(raw) as WidgetPayload
    const widgetCode = typeof payload.widget_code === 'string'
      ? payload.widget_code
      : typeof payload.widgetCode === 'string'
        ? payload.widgetCode
        : null
    const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : null
    return { title, widgetCode }
  } catch {
    return { title: null, widgetCode: null }
  }
}

export function buildDocumentHtmlSnapshotExport(content: string, documentTitle = 'Document'): string {
  const regex = /```show-widget\s*\n?([\s\S]*?)\n?\s*```/g
  const blocks: string[] = []
  let lastIndex = 0

  for (const match of content.matchAll(regex)) {
    const start = match.index ?? 0
    const before = content.slice(lastIndex, start).trim()
    if (before) {
      blocks.push(`<pre class="doc-export-text">${escapeHtml(before)}</pre>`)
    }

    const payload = parseWidgetPayload(match[1] || '')
    if (payload.widgetCode) {
      const snapshot = buildWidgetExportSnapshot(payload.widgetCode, payload.title)
      if (snapshot) {
        blocks.push([
          '<section class="doc-export-widget">',
          payload.title ? `<h2>${escapeHtml(payload.title)}</h2>` : '',
          snapshot.content,
          '</section>',
        ].filter(Boolean).join(''))
      }
    }

    lastIndex = start + match[0].length
  }

  const tail = content.slice(lastIndex).trim()
  if (tail) {
    blocks.push(`<pre class="doc-export-text">${escapeHtml(tail)}</pre>`)
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(documentTitle)}</title>
  <style>
    body {
      margin: 0;
      padding: 32px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      background: #f7f3eb;
      color: #1f2937;
    }
    .doc-export-text {
      white-space: pre-wrap;
      line-height: 1.7;
      background: #fff;
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 16px;
      padding: 20px;
      margin: 0 0 20px;
    }
    .doc-export-widget {
      background: #fff;
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 20px;
      padding: 20px;
      margin: 0 0 24px;
    }
    .doc-export-widget h2 {
      margin: 0 0 16px;
      font-size: 18px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
${blocks.join('\n')}
</body>
</html>`
}
