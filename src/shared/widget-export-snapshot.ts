export interface WidgetExportSnapshot {
  kind: 'svg' | 'html'
  content: string
  fileExtension: '.svg' | '.html'
  mimeType: 'image/svg+xml' | 'text/html'
  titleHint?: string | null
}

export function resolveWidgetExportSuggestedName(
  titleHint?: string | null,
  fileExtension = '.png',
): string {
  const normalizedTitle = (titleHint || 'widget')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')

  return `${normalizedTitle || 'widget'}${fileExtension}`
}

const DANGEROUS_BLOCK_TAGS = /<(iframe|object|embed|form|meta|link|base)[\s>][\s\S]*?<\/\1>/gi
const DANGEROUS_VOID_TAGS = /<(iframe|object|embed|meta|link|base)\b[^>]*\/?>/gi
const SCRIPT_TAG_REGEX = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

function sanitizeDangerousUrls(html: string): string {
  return html.replace(
    /\s+(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*))/gi,
    (match, _attr: string, dq?: string, sq?: string, uq?: string) => {
      const url = (dq ?? sq ?? uq ?? '').trim()
      if (/^\s*javascript\s*:/i.test(url)) return ''
      return match
    },
  )
}

function sanitizeWidgetHtml(html: string): string {
  const withoutDangerousTags = html
    .replace(DANGEROUS_BLOCK_TAGS, '')
    .replace(DANGEROUS_VOID_TAGS, '')

  const safeScripts = withoutDangerousTags.replace(SCRIPT_TAG_REGEX, (_match, attrs: string, body: string) => {
    const srcMatch = attrs.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*))/i)
    const src = (srcMatch?.[1] || srcMatch?.[2] || srcMatch?.[3] || '').trim()

    if (src) {
      if (!/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|esm\.sh/.test(src)) return ''
      return `<script${attrs}></script>`
    }

    return `<script>${body}</script>`
  })

  return sanitizeDangerousUrls(safeScripts)
}

function stripWidgetScripts(html: string): string {
  return sanitizeDangerousUrls(html.replace(SCRIPT_TAG_REGEX, ''))
}

export function buildWidgetExportSnapshot(
  widgetCode: string,
  titleHint?: string | null,
): WidgetExportSnapshot | null {
  const sanitized = sanitizeWidgetHtml(widgetCode).trim()
  if (!sanitized) return null

  const svgMatch = sanitized.match(/<svg\b[\s\S]*<\/svg>/i)
  if (svgMatch && !/<script\b/i.test(svgMatch[0])) {
    return {
      kind: 'svg',
      content: svgMatch[0],
      fileExtension: '.svg',
      mimeType: 'image/svg+xml',
      titleHint: titleHint || null,
    }
  }

  const staticHtml = stripWidgetScripts(sanitized).trim() || sanitized
  return {
    kind: 'html',
    content: `<div class="widget-export-snapshot">${staticHtml}</div>`,
    fileExtension: '.html',
    mimeType: 'text/html',
    titleHint: titleHint || null,
  }
}
