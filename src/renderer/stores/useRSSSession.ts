import type { RSSReference } from '../../shared/rss-reference'
import { create } from 'zustand'
import { RSSQuerySchema, type RSSQuery, type RSSQueryInput, type RSSQueryResult } from '../../shared/rss-workspace'
import { readJsonStorage, writeJsonStorage } from '../utils/storage'

interface RSSSessionState {
  interactionRevision: number
  pendingReveal: { id: string; reference: RSSReference } | null
  cancelReveal(): void
  requestReveal(reference: RSSReference): void
  finishReveal(id: string): void
  query: RSSQuery
  digestVisible: boolean
  selectedDigestId: string | null
  setDigestView(visible: boolean, reportId?: string | null): void
  view: RSSQueryResult | null
  selectedExcerpt: import('../../shared/rss-reading').RSSReadingRange | null
  selectedItemExpectedRevision: string | null
  selectedItemId: string | null
  selectedItemTitle: string | null
  replaceQuery(query: RSSQuery, view: RSSQueryResult): void
  setQuery(patch: RSSQueryInput): void
  setView(view: RSSQueryResult): void
  setSelection(payload: { selectedExcerpt?: import('../../shared/rss-reading').RSSReadingRange | null; selectedItemExpectedRevision?: string | null; selectedItemId?: string | null; selectedItemTitle?: string | null }): void
  reset(): void
}
const KEY = 'ready-rss-workspace'
const saved = readJsonStorage<{ query?: RSSQueryInput }>(KEY, {})
const parsed = RSSQuerySchema.safeParse(saved?.query || {})

export const useRSSSession = create<RSSSessionState>((set, get) => ({
  interactionRevision: 0,
  pendingReveal: null,
  cancelReveal: () => set((state) => ({ pendingReveal: null, interactionRevision: state.interactionRevision + 1 })),
  requestReveal: (reference) => set((state) => ({ pendingReveal: { id: crypto.randomUUID(), reference }, interactionRevision: state.interactionRevision + 1 })),
  finishReveal: (id) => { if (get().pendingReveal?.id === id) set({ pendingReveal: null }) },
  query: parsed.success ? parsed.data : RSSQuerySchema.parse({}),
  view: null,
  digestVisible: false, selectedDigestId: null,
  setDigestView: (digestVisible, reportId) => set({ interactionRevision: get().interactionRevision + 1, digestVisible, ...(reportId !== undefined ? { selectedDigestId: reportId } : {}) }),
  selectedExcerpt: null, selectedItemExpectedRevision: null,
  selectedItemId: null,
  selectedItemTitle: null,
  replaceQuery: (input, view) => {
    const { cursor: _cursor, expectedRevision: _revision, ...query } = RSSQuerySchema.parse(input)
    set({ query, view, interactionRevision: get().interactionRevision + 1, digestVisible: false, selectedDigestId: null,
      selectedItemId: null, selectedItemTitle: null, selectedExcerpt: null, selectedItemExpectedRevision: null })
    writeJsonStorage(KEY, { query })
  },
  setQuery: (patch) => {
    const { cursor: _cursor, expectedRevision: _revision, ...query } = RSSQuerySchema.parse({ ...get().query, ...patch })
    set({ query, interactionRevision: get().interactionRevision + 1 })
    writeJsonStorage(KEY, { query })
  },
  setView: (view) => set({ view }),
  setSelection: (payload) => set({ interactionRevision: get().interactionRevision + 1, selectedExcerpt: null, selectedItemExpectedRevision: null, ...payload }),
  reset: () => set({ interactionRevision: get().interactionRevision + 1, pendingReveal: null, digestVisible: false, selectedDigestId: null, query: RSSQuerySchema.parse({}), view: null,
    selectedExcerpt: null, selectedItemExpectedRevision: null,
    selectedItemId: null, selectedItemTitle: null }),
}))
