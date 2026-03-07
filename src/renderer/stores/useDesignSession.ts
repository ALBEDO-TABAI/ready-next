import { create } from 'zustand'

export type DesignSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface DesignSessionState {
  activeFile: string | null
  isDirty: boolean
  saveStatus: DesignSaveStatus
  lastSavedAt: number | null
  lastError: string | null
  setActiveFile: (file: string | null) => void
  markDirty: () => void
  markSaving: () => void
  markSaved: () => void
  markError: (message: string) => void
  reset: () => void
}

export const useDesignSession = create<DesignSessionState>((set) => ({
  activeFile: null,
  isDirty: false,
  saveStatus: 'idle',
  lastSavedAt: null,
  lastError: null,
  setActiveFile: (file) => set((state) => {
    const hasChanged = state.activeFile !== file
    return {
      activeFile: file,
      saveStatus: hasChanged || !file ? 'idle' : state.saveStatus,
      lastError: hasChanged ? null : state.lastError,
      isDirty: hasChanged ? false : state.isDirty,
      lastSavedAt: hasChanged ? null : state.lastSavedAt,
    }
  }),
  markDirty: () => set((state) => ({
    isDirty: true,
    saveStatus: state.saveStatus === 'saving' ? 'saving' : 'idle',
  })),
  markSaving: () => set({ saveStatus: 'saving', lastError: null }),
  markSaved: () => set({ isDirty: false, saveStatus: 'saved', lastSavedAt: Date.now(), lastError: null }),
  markError: (message) => set({ saveStatus: 'error', lastError: message }),
  reset: () => set({
    activeFile: null,
    isDirty: false,
    saveStatus: 'idle',
    lastSavedAt: null,
    lastError: null,
  }),
}))
