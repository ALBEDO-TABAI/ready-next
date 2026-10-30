import { assertBoundary, assertUnicode, DocumentBlockError } from './positions'

export interface ReplacementRange { start: number; end: number; expectedText: string; replacement: string }
/** Buffer revision, distinct from Main's disk content hash. No implicit revision is allowed. */
export interface ReplaceRangesOperation { type: 'replaceRanges'; expectedVersion: number; ranges: readonly ReplacementRange[] }

export function orderedRanges(source: string, ranges: readonly ReplacementRange[]): ReplacementRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 0; i < sorted.length; i++) {
    const range = sorted[i], previous = sorted[i - 1]
    assertBoundary(source, range.start); assertBoundary(source, range.end)
    if (range.end < range.start) throw new DocumentBlockError('invalid_range', 'Range ends before it starts')
    if (previous && (range.start < previous.end || range.start === previous.start)) {
      throw new DocumentBlockError('overlapping_ranges', 'Replacement ranges overlap or share an insertion point')
    }
    if (source.slice(range.start, range.end) !== range.expectedText) throw new DocumentBlockError('stale_range', 'Range expectedText no longer matches')
    assertUnicode(range.replacement)
  }
  return sorted
}

export function replaceRanges(content: string, operation: ReplaceRangesOperation, currentVersion?: number): string {
  if (!Number.isSafeInteger(currentVersion) || currentVersion! < 0 || operation.expectedVersion !== currentVersion) {
    throw new DocumentBlockError('version_conflict', 'Operation does not match the current buffer revision')
  }
  const ranges = orderedRanges(content, operation.ranges)
  let cursor = 0
  const parts: string[] = []
  for (const range of ranges) {
    parts.push(content.slice(cursor, range.start), range.replacement)
    cursor = range.end
  }
  parts.push(content.slice(cursor))
  return parts.join('')
}

/** Coalesce adjacent edits so adjacent deletions also have an unambiguous inverse insertion. */
export function invertRanges(source: string, ranges: readonly ReplacementRange[]): ReplacementRange[] {
  const joined: ReplacementRange[] = []
  for (const range of orderedRanges(source, ranges)) {
    const last = joined[joined.length - 1]
    if (last && last.end === range.start) {
      last.end = range.end; last.expectedText += range.expectedText; last.replacement += range.replacement
    } else joined.push({ ...range })
  }
  let delta = 0
  return joined.map(range => {
    const start = range.start + delta
    delta += range.replacement.length - (range.end - range.start)
    return { start, end: start + range.replacement.length, expectedText: range.replacement, replacement: range.expectedText }
  })
}
