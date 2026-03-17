import { sanitizeWidgetHtml, stripWidgetScripts } from './widget-sanitizer'

export interface WidgetExportSnapshot {
  kind: 'svg' | 'html'
  content: string
  fileExtension: '.svg' | '.html'
  mimeType: 'image/svg+xml' | 'text/html'
  titleHint?: string | null
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
