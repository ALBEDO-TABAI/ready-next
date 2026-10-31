import { z } from 'zod'

const page = z.number().int().min(1).max(100000)
const offset = z.number().int().nonnegative().safe()
const quote = z.object({ page, start: offset, end: offset, exact: z.string().min(1).max(24000),
  prefix: z.string().max(33), suffix: z.string().max(33) }).strict().refine(v => v.end > v.start)
export const PdfAnchorSchema = z.union([quote, z.object({ page }).strict()])
export type PdfAnchor = z.infer<typeof PdfAnchorSchema>
export const PdfSelectionSchema = z.object({ id: z.string().min(1), expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  page, text: z.string().min(1).max(2_000_000), start: offset, end: offset, exact: z.string().min(1).max(24000),
}).strict().refine(v => v.end > v.start && v.text.slice(v.start, v.end) === v.exact && !!v.exact.trim()
  && !/[\uD800-\uDFFF]/u.test(v.exact), 'PDF 选区已变化或超出文字范围')
export type PdfSelection = z.infer<typeof PdfSelectionSchema>
export function pdfAnchor(value: PdfAnchor): string { return 'pdf:' + JSON.stringify(PdfAnchorSchema.parse(value)) }
export function parsePdfAnchor(value: string): PdfAnchor {
  if (!value.startsWith('pdf:')) throw new Error('PDF 引用无效')
  return PdfAnchorSchema.parse(JSON.parse(value.slice(4)))
}
export function pdfQuote(text: string, page: number, start: number, end: number): PdfAnchor {
  // Avoid splitting a surrogate pair at the context boundary.
  let before = Math.max(0, start - 32), after = Math.min(text.length, end + 32)
  if (/[\uDC00-\uDFFF]/.test(text[before] ?? '')) before--
  if (/[\uDC00-\uDFFF]/.test(text[after] ?? '')) after++
  return { page, start, end, exact: text.slice(start, end), prefix: text.slice(before, start), suffix: text.slice(end, after) }
}
/** Returns a unique range on this page. Whitespace changes in PDF.js do not lose an otherwise exact quote. */
export function locatePdfQuote(text: string, anchor: PdfAnchor): { start: number; end: number } | null {
  if (!('exact' in anchor)) return null
  const positions: number[] = [], chars: string[] = []
  for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) { positions.push(i); chars.push(text[i]) }
  const clean = chars.join(''), exact = anchor.exact.replace(/\s/g, ''), prefix = anchor.prefix.replace(/\s/g, ''), suffix = anchor.suffix.replace(/\s/g, '')
  if (!exact) return null
  const matches: number[] = []
  for (let at = clean.indexOf(exact); at >= 0; at = clean.indexOf(exact, at + 1)) {
    if ((!prefix || clean.slice(0, at).endsWith(prefix)) && (!suffix || clean.slice(at + exact.length).startsWith(suffix))) matches.push(at)
  }
  if (matches.length !== 1) return null
  const start = positions[matches[0]], end = positions[matches[0] + exact.length - 1] + 1
  return { start, end }
}
