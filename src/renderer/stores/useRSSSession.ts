import { create } from 'zustand'
import { RSSQuerySchema, type RSSQuery, type RSSQueryInput, type RSSQueryResult } from '../../shared/rss-workspace'
import { readJsonStorage, writeJsonStorage } from '../utils/storage'

interface RSSSessionState {
  query: RSSQuery
  digestVisible: boolean
  selectedDigestId: string | null
  setDigestView(visible: boolean, reportId?: string | null): void
  view: RSSQueryResult | null
  navigationCollapsed: boolean
  selectedItemExpectedRevision: string | null
  selectedItemId: string | null
  selectedItemTitle: string | null
  setQuery(patch: RSSQueryInput): void
  setView(view: RSSQueryResult): void
  setNavigationCollapsed(value: boolean): void
  setSelection(payload: { selectedItemExpectedRevision?: string | null; selectedItemId?: string | null; selectedItemTitle?: string | null }): void
  reset(): void
}
const KEY = 'ready-rss-workspace'
const saved = readJsonStorage<{ query?: RSSQueryInput; navigationCollapsed?: boolean }>(KEY, {})
const parsed = RSSQuerySchema.safeParse(saved?.query || {})

export const useRSSSession = create<RSSSessionState>((set, get) => ({
  query: parsed.success ? parsed.data : RSSQuerySchema.parse({}),
  view: null,
  digestVisible: false, selectedDigestId: null,
  setDigestView: (digestVisible, reportId) => set({ digestVisible, ...(reportId !== undefined ? { selectedDigestId: reportId } : {}) }),
  navigationCollapsed: saved?.navigationCollapsed === true,
  selectedItemExpectedRevision: null,
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
  reset: () => set({ digestVisible: false, selectedDigestId: null, query: RSSQuerySchema.parse({}), view: null, navigationCollapsed: false,
    selectedItemExpectedRevision: null,
  selectedItemId: null, selectedItemTitle: null }),
}))
