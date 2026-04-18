export interface WidgetPersistedControlState {
  index: number
  tag: 'input' | 'textarea' | 'select'
  type?: string
  value?: string
  checked?: boolean
}

export interface WidgetPersistedActiveTargetState {
  attr: 'data-tab-target' | 'data-focus-target'
  value: string
}

export interface DocumentWidgetPersistedState {
  controls?: WidgetPersistedControlState[]
  activeTargets?: WidgetPersistedActiveTargetState[]
}

export interface DocumentWidgetComponentSpecSummary {
  component: string
  props?: Record<string, unknown>
  dataSource?: Record<string, unknown>
}

export interface DocumentWidgetData {
  id?: string
  title?: string
  widgetCode: string
  rawFence: string
  widgetState?: DocumentWidgetPersistedState | null
  componentSpec?: DocumentWidgetComponentSpecSummary | null
}

export type DocumentWidgetSegment =
  | { type: 'text'; content: string }
  | { type: 'widget'; data: DocumentWidgetData }

export type WidgetRenderMode = 'static-svg' | 'static-html' | 'scripted'

export interface DocumentWidgetRecord {
  index: number
  title: string
  widgetCode: string
  rawFence: string
  start: number
  end: number
  mode: WidgetRenderMode
  componentSpec?: DocumentWidgetComponentSpecSummary | null
  widgetState?: DocumentWidgetPersistedState | null
}

export interface DocumentWidgetSummary {
  index: number
  title: string
  mode: WidgetRenderMode
  componentHint: string | null
  preview: string
  hasState: boolean
}

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
    const widgetState = record.widget_state && typeof record.widget_state === 'object'
      ? record.widget_state as DocumentWidgetPersistedState
      : null
    const rawComponentSpec = record.component_spec ?? record.componentSpec
    const componentSpec = rawComponentSpec && typeof rawComponentSpec === 'object' && !Array.isArray(rawComponentSpec)
      ? (rawComponentSpec as DocumentWidgetComponentSpecSummary)
      : null
    const componentSpecIsValid = componentSpec && typeof componentSpec.component === 'string' && componentSpec.component.trim().length > 0
    return {
      title,
      widgetCode,
      rawFence,
      widgetState,
      componentSpec: componentSpecIsValid ? componentSpec : null,
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

export function getWidgetRenderMode(widgetCode: string): WidgetRenderMode {
  if (/<script\b/i.test(widgetCode)) return 'scripted'
  if (/<svg\b/i.test(widgetCode)) return 'static-svg'
  return 'static-html'
}

export function collectDocumentWidgets(source: string): DocumentWidgetRecord[] {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const regex = /```show-widget\s*\n?([\s\S]*?)\n?\s*```/g
  const widgets: DocumentWidgetRecord[] = []

  for (const match of normalizedSource.matchAll(regex)) {
    const fullMatch = match[0]
    const body = match[1] || ''
    const parsed = tryParseWidgetPayload(body, fullMatch)
    if (!parsed) continue

    const start = match.index ?? 0
    widgets.push({
      index: widgets.length + 1,
      title: parsed.title?.trim() || `widget_${widgets.length + 1}`,
      widgetCode: parsed.widgetCode,
      rawFence: fullMatch,
      start,
      end: start + fullMatch.length,
      mode: getWidgetRenderMode(parsed.widgetCode),
      componentSpec: parsed.componentSpec ?? null,
      widgetState: parsed.widgetState ?? null,
    })
  }

  return widgets
}

export function summarizeWidgetRecord(record: DocumentWidgetRecord): DocumentWidgetSummary {
  const stripped = record.widgetCode
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const preview = stripped.length > 120 ? `${stripped.slice(0, 120)}…` : stripped
  const componentHint = typeof record.componentSpec?.component === 'string' && record.componentSpec.component.trim().length > 0
    ? record.componentSpec.component.trim()
    : null
  return {
    index: record.index,
    title: record.title,
    mode: record.mode,
    componentHint,
    preview,
    hasState: Boolean(record.widgetState && typeof record.widgetState === 'object' && Object.keys(record.widgetState).length > 0),
  }
}

export function summarizeDocumentWidgets(source: string): DocumentWidgetSummary[] {
  return collectDocumentWidgets(source).map(summarizeWidgetRecord)
}
