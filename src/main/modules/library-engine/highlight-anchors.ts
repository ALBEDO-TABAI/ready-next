import { z } from 'zod'
import type { LibraryHighlightContext, LibraryHighlightLocation } from '../../../shared/library'

export const colorSchema = z.enum(['yellow', 'green', 'blue', 'pink', 'pen'])
export const offsetSchema = z.number().int().nonnegative().safe()
export const anchorSchema = z.object({
  chapter: offsetSchema, from: offsetSchema, to: offsetSchema,
  quote: z.object({ exact: z.string().min(1), prefix: z.string(), suffix: z.string() }),
  color: colorSchema, createdAt: offsetSchema, updatedAt: offsetSchema,
}).refine(a => a.to > a.from)
export const anchorFileSchema = z.object({ version: z.literal(1), highlights: z.record(z.string().regex(/^hl-[\w-]+$/), anchorSchema) })
export type HighlightAnchor = z.infer<typeof anchorSchema>
export type AnchorFile = z.infer<typeof anchorFileSchema>
export const compact = (s: string) => s.replace(/\s/g, '')

export function sliceText(text: string, from: number, to: number): string {
  let count = 0, start = -1, end = text.length
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    if (count === from) start = i
    count++
    if (count === to) { end = i + 1; break }
  }
  return start < 0 ? '' : text.slice(start, end)
}

export function quoteAt(text: string, from: number, to: number) {
  const clean = compact(text)
  return { exact: sliceText(text, from, to), prefix: clean.slice(Math.max(0, from - 32), from), suffix: clean.slice(to, to + 32) }
}

/** Never pick the first of repeated passages. Context must uniquely identify one. */
export function relocate(anchor: HighlightAnchor, chapters: LibraryHighlightContext['chapters']): LibraryHighlightLocation {
  const exact = compact(anchor.quote.exact)
  const matches = (chapter: number) => {
    const text = compact(chapters[chapter]?.text ?? ''), found: number[] = []
    if (!exact) return found
    for (let at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) found.push(at)
    return found
  }
  const contextual = (chapter: number, from: number) => {
    const text = compact(chapters[chapter].text)
    const { prefix, suffix } = anchor.quote
    return (!prefix || text.slice(0, from).endsWith(compact(prefix))) && (!suffix || text.slice(from + exact.length).startsWith(compact(suffix)))
  }
  const located = (chapter: number, from: number): LibraryHighlightLocation => ({ status: 'located', chapter, from, to: from + exact.length })
  const hasContext = !!(anchor.quote.prefix || anchor.quote.suffix)
  const local = matches(anchor.chapter)
  const narrowed = local.filter(from => contextual(anchor.chapter, from))
  // Direct position is accepted only when its quote is unique or its context disambiguates it.
  if (local.includes(anchor.from) && ((!hasContext && local.length === 1) || (narrowed.length === 1 && narrowed[0] === anchor.from))) return located(anchor.chapter, anchor.from)
  if (narrowed.length === 1) return located(anchor.chapter, narrowed[0])
  if (!hasContext && local.length === 1) return located(anchor.chapter, local[0])
  const all = chapters.flatMap((_, chapter) => matches(chapter).map(from => ({ chapter, from })))
  const context = all.filter(p => contextual(p.chapter, p.from))
  const unique = context.length === 1 ? context[0] : !hasContext && all.length === 1 ? all[0] : null
  return unique ? located(unique.chapter, unique.from) : { status: 'unlocated', reason: all.length ? '原文有多处相同文字，无法唯一定位' : '书中找不到这段原文' }
}
