/** A textarea exposes LF even for CRLF source. Map its changed span back to the
 * original string so merely touching the editor never rewrites other lines. */
export function textAreaOffset(source: string, offset: number): number {
  let raw = 0, displayed = 0
  while (raw < source.length && displayed < offset) {
    if (source[raw] === '\r' && source[raw + 1] === '\n') raw++
    raw++; displayed++
  }
  return raw
}
export function changedSpan(before: string, after: string) {
  let start = 0, end = before.length, nextEnd = after.length
  while (start < end && start < nextEnd && before[start] === after[start]) start++
  if (start && /[\uDC00-\uDFFF]/.test(before[start] ?? after[start] ?? '')) start--
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd-- }
  if (/[\uDC00-\uDFFF]/.test(before[end] ?? '') || /[\uDC00-\uDFFF]/.test(after[nextEnd] ?? '')) { end++; nextEnd++ }
  return { start, end, replacement: after.slice(start, nextEnd) }
}
export function textAreaContent(original: string, value: string): string {
  const normalized = original.replace(/\r\n?/g, '\n')
  if (normalized === value) return original
  const change = changedSpan(normalized, value)
  const start = textAreaOffset(original, change.start), end = textAreaOffset(original, change.end)
  const eol = /\r\n|\n|\r/.exec(original)?.[0] ?? '\n'
  return original.slice(0, start) + change.replacement.replace(/\n/g, eol) + original.slice(end)
}
