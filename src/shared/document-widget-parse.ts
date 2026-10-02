import { fromMarkdown } from 'mdast-util-from-markdown'

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

export interface DocumentWidgetSkeletonSpecSummary {
  skeleton: string
  size?: string
  background_mode?: 'opaque' | 'transparent'
  props?: Record<string, unknown>
}

export interface DocumentWidgetData {
  id?: string
  title?: string
  widgetCode: string
  rawFence: string
  widgetState?: DocumentWidgetPersistedState | null
  componentSpec?: DocumentWidgetComponentSpecSummary | null
  skeletonSpec?: DocumentWidgetSkeletonSpecSummary | null
}

export type DocumentWidgetSegment =
  | { type: 'text'; content: string }
  | { type: 'widget'; data: DocumentWidgetData }
  | { type: 'invalid-widget'; content: string; reason: string }

export type WidgetRenderMode = 'static-svg' | 'static-html' | 'scripted'

export interface DocumentWidgetRecord {
  id: string
  index: number
  title: string
  widgetCode: string
  rawFence: string
  start: number
  end: number
  mode: WidgetRenderMode
  componentSpec?: DocumentWidgetComponentSpecSummary | null
  skeletonSpec?: DocumentWidgetSkeletonSpecSummary | null
  widgetState?: DocumentWidgetPersistedState | null
}

export interface DocumentWidgetSummary {
  id: string
  index: number
  title: string
  mode: WidgetRenderMode
  componentHint: string | null
  preview: string
  hasState: boolean
  hasComponentSpec: boolean
  canPatch: boolean
  canReplace: boolean
}


interface MarkdownFenceRange {
  start: number
  end: number
}

function getMarkdownFenceOpening(line: string): { marker: '`' | '~'; length: number } | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/)
  if (!match) return null
  const fence = match[1]
  if (fence[0] === '`' && line.slice(match[0].length).includes('`')) return null
  return {
    marker: fence[0] as '`' | '~',
    length: fence.length,
  }
}

function isMarkdownFenceClosing(
  line: string,
  fence: { marker: '`' | '~'; length: number },
): boolean {
  const regex = fence.marker === '`'
    ? /^ {0,3}(`{3,})[ \t]*$/
    : /^ {0,3}(~{3,})[ \t]*$/
  const match = line.replace(/\r$/, '').match(regex)
  return Boolean(match && match[1].length >= fence.length)
}

function isDetailsOpeningLine(line: string): boolean {
  return /^<details(\s+open)?\s*>$/i.test(line.trim())
}

function isDetailsClosingLine(line: string): boolean {
  return /^<\/details>$/i.test(line.trim())
}

function collectMarkdownDetailsRanges(text: string): MarkdownFenceRange[] {
  const ranges: MarkdownFenceRange[] = []
  let activeFence: ({ marker: '`' | '~'; length: number }) | null = null
  let activeDetailsStart: number | null = null
  let offset = 0

  for (const line of text.split('\n')) {
    const lineStart = offset
    const lineEnd = lineStart + line.length

    if (activeFence) {
      if (isMarkdownFenceClosing(line, activeFence)) {
        activeFence = null
      }
      offset = lineEnd + 1
      continue
    }

    const openingFence = getMarkdownFenceOpening(line)
    if (openingFence) {
      activeFence = openingFence
      offset = lineEnd + 1
      continue
    }

    if (activeDetailsStart == null && isDetailsOpeningLine(line)) {
      activeDetailsStart = lineStart
    } else if (activeDetailsStart != null && isDetailsClosingLine(line)) {
      ranges.push({ start: activeDetailsStart, end: lineEnd })
      activeDetailsStart = null
    }

    offset = lineEnd + 1
  }

  if (activeDetailsStart != null) {
    ranges.push({ start: activeDetailsStart, end: text.length })
  }

  return ranges
}


function hashWidgetIdentity(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function ensureDocumentWidgetId(params: {
  id?: string | null
  title?: string | null
  widgetCode: string
  seed?: string | number | null
}): string {
  const explicit = typeof params.id === 'string' ? params.id.trim() : ''
  if (explicit) return explicit
  const title = typeof params.title === 'string' ? params.title.trim() : ''
  const seed = params.seed == null ? '' : String(params.seed)
  return `widget_${hashWidgetIdentity(`${title}\n${params.widgetCode}\n${seed}`)}`
}

export interface DocumentWidgetFenceBuildOptions {
  id?: string | null
  componentSpec?: DocumentWidgetComponentSpecSummary | null
  skeletonSpec?: DocumentWidgetSkeletonSpecSummary | null
  widgetState?: DocumentWidgetPersistedState | null
}

export function buildDocumentWidgetFenceSource(
  title: string,
  widgetCode: string,
  options?: DocumentWidgetFenceBuildOptions,
): string {
  const normalizedTitle = title.trim() || 'widget'
  const payload: Record<string, unknown> = {
    id: ensureDocumentWidgetId({
      id: options?.id,
      title: normalizedTitle,
      widgetCode,
    }),
    title: normalizedTitle,
    widget_code: widgetCode,
  }
  if (options?.componentSpec) {
    payload.component_spec = options.componentSpec
  }
  if (options?.skeletonSpec) {
    payload.skeleton_spec = options.skeletonSpec
  }
  if (options?.widgetState && typeof options.widgetState === 'object' && Object.keys(options.widgetState).length > 0) {
    payload.widget_state = options.widgetState
  }
  return [
    '```show-widget',
    JSON.stringify(payload),
    '```',
  ].join('\n')
}

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
    const id = typeof record.id === 'string' && record.id.trim().length > 0
      ? record.id.trim()
      : undefined
    const widgetState = record.widget_state && typeof record.widget_state === 'object'
      ? record.widget_state as DocumentWidgetPersistedState
      : null
    const rawComponentSpec = record.component_spec ?? record.componentSpec
    const componentSpec = rawComponentSpec && typeof rawComponentSpec === 'object' && !Array.isArray(rawComponentSpec)
      ? (rawComponentSpec as DocumentWidgetComponentSpecSummary)
      : null
    const componentSpecIsValid = componentSpec && typeof componentSpec.component === 'string' && componentSpec.component.trim().length > 0
    const rawSkeletonSpec = record.skeleton_spec ?? record.skeletonSpec
    const skeletonSpecCandidate = rawSkeletonSpec && typeof rawSkeletonSpec === 'object' && !Array.isArray(rawSkeletonSpec)
      ? (rawSkeletonSpec as DocumentWidgetSkeletonSpecSummary)
      : null
    const skeletonSpecIsValid = skeletonSpecCandidate && typeof skeletonSpecCandidate.skeleton === 'string' && skeletonSpecCandidate.skeleton.trim().length > 0
    return {
      id,
      title,
      widgetCode,
      rawFence,
      widgetState,
      componentSpec: componentSpecIsValid ? componentSpec : null,
      skeletonSpec: skeletonSpecIsValid ? skeletonSpecCandidate : null,
    }
  } catch {
    return null
  }
}

function* showWidgetFences(source: string): Generator<{ start: number; end: number; raw: string; body: string }> {
  for (const node of fromMarkdown(source).children) {
    if (node.type !== 'code' || node.lang !== 'show-widget') continue
    const begin = node.position?.start.offset, finish = node.position?.end.offset
    if (begin === undefined || finish === undefined) continue
    const block = source.slice(begin, finish)
    const opening = block.match(/^( {0,3})(`{3,})show-widget[ \t]*\r?\n/)
    if (!opening) continue
    const closeStart = block.lastIndexOf('\n') + 1
    const closing = block.slice(closeStart).match(/^ {0,3}(`{3,})[ \t]*\r?$/)
    if (!closing || closing[1].length < opening[2].length || closeStart < opening[0].length) continue
    const start = begin + opening[1].length
    const end = begin + closeStart + closing[0].trimEnd().length
    yield { start, end, raw: source.slice(start, end), body: block.slice(opening[0].length, closeStart).trim() }
  }
}

export function parseShowWidgetFences(text: string): DocumentWidgetSegment[] {
  if (!text) return []

  const segments: DocumentWidgetSegment[] = []
  let lastIndex = 0

  for (const match of showWidgetFences(text)) {
    const fullMatch = match.raw
    const fenceBody = match.body
    const start = match.start

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
        data: {
          ...widget,
          id: ensureDocumentWidgetId({
            id: widget.id,
            title: widget.title,
            widgetCode: widget.widgetCode,
            seed: start,
          }),
        },
      })
    } else {
      segments.push({
        type: 'invalid-widget',
        content: fullMatch,
        reason: 'show-widget JSON 不完整或无法解析',
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
  const nodes = fromMarkdown(text).children
  const protectedRanges = [
    ...collectMarkdownDetailsRanges(text),
    ...nodes.filter((node) => node.type === 'code' || node.type === 'html').map((node) => ({
      start: node.position!.start.offset!, end: node.position!.end.offset!,
    })),
  ]
  const boundaries = [...text.matchAll(/\n{2,}/g)].filter((match) => !protectedRanges.some((range) => match.index! >= range.start && match.index! < range.end))
  const segments: DocumentWidgetSegment[] = []
  let start = 0
  for (const [index, boundary] of [...boundaries, null].entries()) {
    const end = boundary?.index ?? text.length
    const raw = text.slice(start, end)
    const trimmed = raw.trim()
    const paragraph = nodes.find((node) => node.type === 'paragraph' && node.position!.start.offset! >= start && node.position!.end.offset! <= end)
    const widget = paragraph && text.slice(paragraph.position!.start.offset!, paragraph.position!.end.offset!).trim() === trimmed && trimmed.startsWith('{') && trimmed.endsWith('}')
      ? tryParseWidgetPayload(trimmed, trimmed) : null
    if (widget) {
      segments.push({ type: 'widget', data: { ...widget, id: ensureDocumentWidgetId({ id: widget.id, title: widget.title, widgetCode: widget.widgetCode, seed: index }) } })
    } else {
      const content = boundary ? `${raw}\n\n` : raw
      if (content) segments.push({ type: 'text', content })
    }
    start = end + (boundary?.[0].length ?? 0)
  }
  return segments
}

export function getWidgetRenderMode(widgetCode: string): WidgetRenderMode {
  if (/<script\b/i.test(widgetCode)) return 'scripted'
  if (/<svg\b/i.test(widgetCode)) return 'static-svg'
  return 'static-html'
}

export function collectDocumentWidgets(source: string): DocumentWidgetRecord[] {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const widgets: DocumentWidgetRecord[] = []

  for (const match of showWidgetFences(normalizedSource)) {
    const fullMatch = match.raw
    const body = match.body
    const parsed = tryParseWidgetPayload(body, fullMatch)
    if (!parsed) continue

    const start = match.start
    widgets.push({
      id: ensureDocumentWidgetId({
        id: parsed.id,
        title: parsed.title,
        widgetCode: parsed.widgetCode,
        seed: start,
      }),
      index: widgets.length + 1,
      title: parsed.title?.trim() || `widget_${widgets.length + 1}`,
      widgetCode: parsed.widgetCode,
      rawFence: fullMatch,
      start,
      end: start + fullMatch.length,
      mode: getWidgetRenderMode(parsed.widgetCode),
      componentSpec: parsed.componentSpec ?? null,
      skeletonSpec: parsed.skeletonSpec ?? null,
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
  const hasComponentSpec = Boolean(componentHint)
  return {
    id: record.id,
    index: record.index,
    title: record.title,
    mode: record.mode,
    componentHint,
    preview,
    hasState: Boolean(record.widgetState && typeof record.widgetState === 'object' && Object.keys(record.widgetState).length > 0),
    hasComponentSpec,
    canPatch: hasComponentSpec,
    canReplace: true,
  }
}

export function summarizeDocumentWidgets(source: string): DocumentWidgetSummary[] {
  return collectDocumentWidgets(source).map(summarizeWidgetRecord)
}

export interface ListWidgetsUserFacingInput {
  summaries: DocumentWidgetSummary[]
  tabTitle?: string | null
}

export function buildListWidgetsUserFacingText(input: ListWidgetsUserFacingInput): string {
  const summaries = Array.isArray(input.summaries) ? input.summaries : []
  const rawTitle = typeof input.tabTitle === 'string' ? input.tabTitle.trim() : ''
  const docLabel = rawTitle ? `「${rawTitle}」` : '当前文档'
  const count = summaries.length

  if (count === 0) {
    return `${docLabel}暂无 widget。如需新增，请告诉我要插入的卡片内容。`
  }

  const previewTitles = summaries
    .slice(0, 3)
    .map((item) => {
      const title = typeof item?.title === 'string' ? item.title.trim() : ''
      return title.length > 0 ? `「${title}」` : '「未命名」'
    })

  const titlesText = previewTitles.join('、')

  if (count <= 3) {
    return `已查到${docLabel}中的 ${count} 个 widget：${titlesText}。如需编辑，请指出具体标题或序号。`
  }

  return `已查到${docLabel}中的 ${count} 个 widget，示例：${titlesText} 等。如需编辑，请指出具体标题或序号。`
}

const INSPECTION_FALLBACK_SENTENCE =
  '已查询当前文档的 widget 列表。请告诉我你想修改的 widget 标题或序号。'

const LIST_WIDGETS_HEADER_REGEX = /当前文档(?:共有\s*\d+\s*个|没有)\s*widget（([^）]+)）/
const LIST_WIDGETS_FENCE_REGEX = /```json\s*\n([\s\S]*?)\n?```/

export interface ListWidgetsToolOutputParsed {
  summaries: DocumentWidgetSummary[]
  tabTitle: string | null
}

export function parseListWidgetsToolOutput(raw: string): ListWidgetsToolOutputParsed {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { summaries: [], tabTitle: null }
  }
  const headerMatch = raw.match(LIST_WIDGETS_HEADER_REGEX)
  const tabTitle = headerMatch?.[1]?.trim() || null

  const fenceMatch = raw.match(LIST_WIDGETS_FENCE_REGEX)
  if (!fenceMatch) return { summaries: [], tabTitle }
  const jsonSource = fenceMatch[1]?.trim() || ''
  let parsed: unknown = null
  try {
    parsed = JSON.parse(jsonSource)
  } catch {
    return { summaries: [], tabTitle }
  }
  if (!Array.isArray(parsed)) return { summaries: [], tabTitle }
  const summaries = parsed.filter(
    (entry): entry is DocumentWidgetSummary =>
      !!entry && typeof entry === 'object' && typeof (entry as { title?: unknown }).title === 'string',
  )
  return { summaries, tabTitle }
}

export function buildUserFacingInspectionSummary(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return INSPECTION_FALLBACK_SENTENCE
  }
  const { summaries, tabTitle } = parseListWidgetsToolOutput(raw)
  if (summaries.length > 0) {
    return buildListWidgetsUserFacingText({ summaries, tabTitle })
  }
  if (/当前文档没有\s*widget/.test(raw)) {
    return buildListWidgetsUserFacingText({ summaries: [], tabTitle })
  }
  return INSPECTION_FALLBACK_SENTENCE
}
