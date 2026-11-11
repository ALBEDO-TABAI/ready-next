import { z } from 'zod'
import { ReadyRefSchema, toReadyUri, type ReadyRef } from './ready-ref'

export const NavigationEntrySchema = z.object({
  mode: z.enum(['browser', 'document', 'rss', 'calendar']), ref: ReadyRefSchema,
  title: z.string().min(1), openedAt: z.number().int().nonnegative(),
  anchor: z.array(z.object({ selector: z.string(), top: z.number().finite(), left: z.number().finite() }).strict()),
}).strict()
export type NavigationEntry = z.infer<typeof NavigationEntrySchema>
export const NavigationStateSchema = z.object({
  entries: z.array(NavigationEntrySchema).max(50), cursor: z.number().int().min(-1), revision: z.number().int().nonnegative(),
}).strict().refine(state => state.entries.length ? state.cursor >= 0 && state.cursor < state.entries.length : state.cursor === -1, 'Invalid history cursor')
export type NavigationState = z.infer<typeof NavigationStateSchema>
export const emptyNavigation = (): NavigationState => ({ entries: [], cursor: -1, revision: 0 })
export const BrowserNavigationPositionSchema = z.object({ url: z.url(), top: z.number().finite().nonnegative(), left: z.number().finite().nonnegative() }).strict()
export type BrowserNavigationPosition = z.infer<typeof BrowserNavigationPositionSchema>
export interface NavigationHistoryAPI {
  browserPosition(): Promise<BrowserNavigationPosition | null>
  restoreBrowserPosition(position: BrowserNavigationPosition): Promise<void>
  read(): Promise<NavigationState>
  save(state: NavigationState): Promise<NavigationState>
}
/** Anchors are positions within an object, not separate entries in Recently opened. */
export function navigationObjectKey(ref: ReadyRef): string {
  switch (ref.kind) {
    case 'page': case 'file': case 'canvas': case 'rss-item': case 'rss-digest': case 'event': case 'conversation': case 'fastcard': case 'draft': return `${ref.kind}:${ref.id}`
    case 'book-location': return `book:${ref.book}`
    case 'day': return `day:${ref.date}`
    default: return toReadyUri(ref)
  }
}
export function recentNavigation(state: NavigationState, limit = 20): NavigationEntry[] {
  const seen = new Set<string>()
  return [...state.entries].reverse().filter(entry => {
    const key = navigationObjectKey(entry.ref)
    if (seen.has(key)) return false
    seen.add(key); return true
  }).slice(0, limit)
}
