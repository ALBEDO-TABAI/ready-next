import { recordDocumentPerformanceCounter } from '../../../shared/document-performance-diagnostics'

const SHOW_WIDGET_MARKER = '```show-widget'
const SHOW_WIDGET_FENCE_PATTERN = /```show-widget\s*\n?[\s\S]*?\n?\s*```/g
const EDIT_CONTEXT_RADIUS = 24

export interface WidgetFenceRange {
  start: number
  end: number
}

export interface WidgetFenceSignatureSnapshot {
  signature: string
  contentLength: number
  ranges: WidgetFenceRange[]
}

export interface WidgetFenceTextEdit {
  start: number
  end: number
  insertedText: string
}

export function buildWidgetFenceSignatureSnapshot(content: string): WidgetFenceSignatureSnapshot {
  recordDocumentPerformanceCounter('widgetFenceScans')
  if (!content.includes(SHOW_WIDGET_MARKER)) {
    return { signature: '', contentLength: content.length, ranges: [] }
  }

  let hash = 2166136261
  const ranges: WidgetFenceRange[] = []
  for (const match of content.matchAll(SHOW_WIDGET_FENCE_PATTERN)) {
    const source = match[0]
    const start = match.index ?? 0
    ranges.push({ start, end: start + source.length })
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 0
    hash = Math.imul(hash, 16777619)
  }
  return {
    signature: `${ranges.length}:${(hash >>> 0).toString(36)}`,
    contentLength: content.length,
    ranges,
  }
}

function editIntersectsRange(edit: WidgetFenceTextEdit, range: WidgetFenceRange): boolean {
  if (edit.start === edit.end) return edit.start > range.start && edit.start < range.end
  return edit.start < range.end && edit.end > range.start
}

function countWidgetMarkers(content: string): number {
  let count = 0
  let offset = 0
  while (offset < content.length) {
    const markerIndex = content.indexOf(SHOW_WIDGET_MARKER, offset)
    if (markerIndex < 0) break
    count += 1
    offset = markerIndex + SHOW_WIDGET_MARKER.length
  }
  return count
}

export function advanceWidgetFenceSignatureForTextEdit(
  snapshot: WidgetFenceSignatureSnapshot,
  previousContent: string,
  edit: WidgetFenceTextEdit,
): WidgetFenceSignatureSnapshot | null {
  if (
    snapshot.contentLength !== previousContent.length
    || edit.start < 0
    || edit.end < edit.start
    || edit.end > previousContent.length
  ) return null

  const contextStart = Math.max(0, edit.start - EDIT_CONTEXT_RADIUS)
  const contextEnd = Math.min(previousContent.length, edit.end + EDIT_CONTEXT_RADIUS)
  const previousContext = previousContent.slice(contextStart, contextEnd)
  const nextContext = `${previousContent.slice(contextStart, edit.start)}${edit.insertedText}${previousContent.slice(edit.end, contextEnd)}`
  if (
    previousContent.slice(edit.start, edit.end).includes('`')
    || edit.insertedText.includes('`')
    || countWidgetMarkers(previousContext) !== countWidgetMarkers(nextContext)
    || snapshot.ranges.some((range) => editIntersectsRange(edit, range))
  ) return null

  const delta = edit.insertedText.length - (edit.end - edit.start)
  return {
    signature: snapshot.signature,
    contentLength: previousContent.length + delta,
    ranges: snapshot.ranges.map((range) => (
      range.start >= edit.end
        ? { start: range.start + delta, end: range.end + delta }
        : range
    )),
  }
}
