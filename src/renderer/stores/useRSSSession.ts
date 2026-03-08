import { create } from 'zustand'

interface RSSAnalysisSnapshot {
  jobId: string | null
  itemId: string | null
  status: string | null
  reportPath: string | null
  manifestPath: string | null
  updatedAt: number | null
}

interface RSSSessionState {
  selectedSourceId: string | null
  selectedItemId: string | null
  selectedItemTitle: string | null
  totalItems: number
  unreadItems: number
  lastFetchAt: number | null
  lastAnalysis: RSSAnalysisSnapshot
  setSelection: (payload: {
    selectedSourceId?: string | null
    selectedItemId?: string | null
    selectedItemTitle?: string | null
  }) => void
  setFeedSnapshot: (payload: {
    totalItems?: number
    unreadItems?: number
    lastFetchAt?: number | null
  }) => void
  setLastAnalysis: (payload: Partial<RSSAnalysisSnapshot>) => void
  reset: () => void
}

const INITIAL_ANALYSIS: RSSAnalysisSnapshot = {
  jobId: null,
  itemId: null,
  status: null,
  reportPath: null,
  manifestPath: null,
  updatedAt: null,
}

export const useRSSSession = create<RSSSessionState>((set) => ({
  selectedSourceId: null,
  selectedItemId: null,
  selectedItemTitle: null,
  totalItems: 0,
  unreadItems: 0,
  lastFetchAt: null,
  lastAnalysis: INITIAL_ANALYSIS,
  setSelection: (payload) => set((state) => ({
    selectedSourceId:
      Object.prototype.hasOwnProperty.call(payload, 'selectedSourceId')
        ? payload.selectedSourceId ?? null
        : state.selectedSourceId,
    selectedItemId:
      Object.prototype.hasOwnProperty.call(payload, 'selectedItemId')
        ? payload.selectedItemId ?? null
        : state.selectedItemId,
    selectedItemTitle:
      Object.prototype.hasOwnProperty.call(payload, 'selectedItemTitle')
        ? payload.selectedItemTitle ?? null
        : state.selectedItemTitle,
  })),
  setFeedSnapshot: (payload) => set((state) => ({
    totalItems:
      Object.prototype.hasOwnProperty.call(payload, 'totalItems')
        ? payload.totalItems ?? 0
        : state.totalItems,
    unreadItems:
      Object.prototype.hasOwnProperty.call(payload, 'unreadItems')
        ? payload.unreadItems ?? 0
        : state.unreadItems,
    lastFetchAt:
      Object.prototype.hasOwnProperty.call(payload, 'lastFetchAt')
        ? payload.lastFetchAt ?? null
        : state.lastFetchAt,
  })),
  setLastAnalysis: (payload) => set((state) => ({
    lastAnalysis: {
      ...state.lastAnalysis,
      ...payload,
      updatedAt: Date.now(),
    },
  })),
  reset: () => set({
    selectedSourceId: null,
    selectedItemId: null,
    selectedItemTitle: null,
    totalItems: 0,
    unreadItems: 0,
    lastFetchAt: null,
    lastAnalysis: INITIAL_ANALYSIS,
  }),
}))
