import { create } from 'zustand'

export type WorkbenchMode = 'browser' | 'document' | 'design' | 'video' | 'rss' | 'calendar'
export type AppMode = 'workbench' | 'ready'

interface ModeState {
  appMode: AppMode
  workbenchMode: WorkbenchMode
  splitMode: WorkbenchMode | null
  splitRatio: number
  readySubMode: WorkbenchMode
  setAppMode: (mode: AppMode) => void
  setWorkbenchMode: (mode: WorkbenchMode) => void
  setSplitMode: (mode: WorkbenchMode | null) => void
  setSplitRatio: (ratio: number) => void
  setReadySubMode: (mode: WorkbenchMode) => void
  toggleMode: () => void
}

export const useMode = create<ModeState>((set) => ({
  appMode: 'workbench',
  workbenchMode: 'browser',
  splitMode: null,
  splitRatio: 50,
  readySubMode: 'browser',
  setAppMode: (mode) => set({ appMode: mode }),
  setWorkbenchMode: (mode) => set({ workbenchMode: mode, splitMode: null }),
  setSplitMode: (mode) => set({ splitMode: mode }),
  setSplitRatio: (ratio) => set({ splitRatio: Math.max(20, Math.min(80, ratio)) }),
  setReadySubMode: (mode) => set({ readySubMode: mode }),
  toggleMode: () => set((state) => ({
    appMode: state.appMode === 'workbench' ? 'ready' : 'workbench'
  }))
}))
