import { create } from 'zustand'
import { RSSQuerySchema, type RSSQuery, type RSSQueryInput, type RSSQueryResult } from '../../shared/rss-workspace'
import { readJsonStorage, writeJsonStorage } from '../utils/storage'

interface RSSSessionState {
  query: RSSQuery
  view: RSSQueryResult | null
  navigationCollapsed: boolean
  selectedItemId: string | null
  selectedItemTitle: string | null
  setQuery(patch: RSSQueryInput): void
  setView(view: RSSQueryResult): void
  setNavigationCollapsed(value: boolean): void
  setSelection(payload: { selectedItemId?: string | null; selectedItemTitle?: string | null }): void
  reset(): void
}
const KEY = 'ready-rss-workspace'
const saved = readJsonStorage<{ query?: RSSQueryInput; navigationCollapsed?: boolean }>(KEY, {})
const parsed = RSSQuerySchema.safeParse(saved?.query || {})

export const useRSSSession = create<RSSSessionState>((set, get) => ({
  query: parsed.success ? parsed.data : RSSQuerySchema.parse({}),
  view: null,
  navigationCollapsed: saved?.navigationCollapsed === true,
  selectedItemId: null,
  selectedItemTitle: null,
  setQuery: (patch) => {
    const { cursor: _cursor, expectedRevision: _revision, ...query } = RSSQuerySchema.parse({ ...get().query, ...patch })
    set({ query })
    writeJsonStorage(KEY, { query, navigationCollapsed: get().navigationCollapsed })
  },
  setView: (view) => set({ view }),
  setNavigationCollapsed: (navigationCollapsed) => {
    set({ navigationCollapsed })
    writeJsonStorage(KEY, { query: get().query, navigationCollapsed })
  },
  setSelection: (payload) => set(payload),
  reset: () => set({ query: RSSQuerySchema.parse({}), view: null, navigationCollapsed: false,
    selectedItemId: null, selectedItemTitle: null }),
}))
