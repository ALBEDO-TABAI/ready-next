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
    selectedSourceId: payload.selectedSourceId ?? state.selectedSourceId,
    selectedItemId: payload.selectedItemId ?? state.selectedItemId,
    selectedItemTitle: payload.selectedItemTitle ?? state.selectedItemTitle,
  })),
  setFeedSnapshot: (payload) => set((state) => ({
    totalItems: payload.totalItems ?? state.totalItems,
    unreadItems: payload.unreadItems ?? state.unreadItems,
    lastFetchAt: payload.lastFetchAt ?? state.lastFetchAt,
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
