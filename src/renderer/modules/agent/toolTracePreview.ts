export function formatSingleLinePreview(text?: string | null, options: { appendEllipsis?: boolean } = {}): string {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return ''
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const firstLine = lines[0]
  if (!firstLine) return ''
  const compact = firstLine.replace(/\s+/g, ' ')
  if (!options.appendEllipsis && lines.length <= 1) return compact
  return compact.endsWith('…') ? compact : `${compact}…`
}

export function formatToolTracePreview(text?: string | null): string {
  return formatSingleLinePreview(text, { appendEllipsis: true })
}
