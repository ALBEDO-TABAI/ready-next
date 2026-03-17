export interface DocumentWidgetData {
  id?: string
  title?: string
  widgetCode: string
  rawFence: string
}

export type DocumentWidgetSegment =
  | { type: 'text'; content: string }
  | { type: 'widget'; data: DocumentWidgetData }

const SHOW_WIDGET_FENCE_REGEX = /```show-widget\s*\n?([\s\S]*?)\n?\s*```/g

export function tryParseWidgetPayload(rawBody: string, rawFence: string): DocumentWidgetData | null {
  try {
    const parsed = JSON.parse(rawBody)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const widgetCode = typeof record.widget_code === 'string'
      ? record.widget_code
      : typeof record.widgetCode === 'string'
        ? record.widgetCode
        : null
    if (!widgetCode || widgetCode.trim().length === 0) return null
    const title = typeof record.title === 'string' && record.title.trim().length > 0
      ? record.title.trim()
      : undefined
    return {
      title,
      widgetCode,
      rawFence,
    }
  } catch {
    return null
  }
}

export function parseShowWidgetFences(text: string): DocumentWidgetSegment[] {
  if (!text) return []

  const segments: DocumentWidgetSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(SHOW_WIDGET_FENCE_REGEX)) {
    const fullMatch = match[0]
    const fenceBody = match[1] || ''
    const start = match.index ?? 0

    if (start > lastIndex) {
      segments.push({
        type: 'text',
        content: text.slice(lastIndex, start),
      })
    }

    const widget = tryParseWidgetPayload(fenceBody, fullMatch)
    if (widget) {
      segments.push({
        type: 'widget',
        data: widget,
      })
    } else {
      segments.push({
        type: 'text',
        content: fullMatch,
      })
    }

    lastIndex = start + fullMatch.length
  }

  if (lastIndex < text.length) {
    segments.push({
      type: 'text',
      content: text.slice(lastIndex),
    })
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: text }]
}

export function parseBareWidgetPayloadSegments(text: string): DocumentWidgetSegment[] {
  if (!text.trim()) return []

  const parts = text.split(/\n{2,}/)
  const segments: DocumentWidgetSegment[] = []

  parts.forEach((part, index) => {
    const trimmed = part.trim()
    const widget = trimmed.startsWith('{') && trimmed.endsWith('}')
      ? tryParseWidgetPayload(trimmed, trimmed)
      : null

    if (widget) {
      segments.push({ type: 'widget', data: widget })
    } else {
      const content = index < parts.length - 1 ? `${part}\n\n` : part
      if (content) {
        segments.push({ type: 'text', content })
      }
    }
  })

  return segments.length > 0 ? segments : [{ type: 'text', content: text }]
}
