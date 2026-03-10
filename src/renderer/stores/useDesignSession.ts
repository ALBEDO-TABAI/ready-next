import { create } from 'zustand'
import type { DesignLayoutBounds, DesignLayoutDigest, DesignRepairScope, DesignStyleSystem } from '../../shared/design-agent'

export type DesignSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface DesignSessionState {
  activeFile: string | null
  isDirty: boolean
  saveStatus: DesignSaveStatus
  lastSavedAt: number | null
  lastError: string | null
  snapshotHash: string | null
  selectionSummary: string | null
  selectedElementCount: number
  selectionBounds: DesignLayoutBounds | null
  layoutDigest: DesignLayoutDigest | null
  lastExportArtifactPath: string | null
  currentToolContext: string | null
  latestReviewSummary: string | null
  repairScope: DesignRepairScope
  scenePlanId: string | null
  boardId: string | null
  styleSystem: DesignStyleSystem | null
  reviewFailures: string[]
  lastAcceptedScreenshot: string | null
  setActiveFile: (file: string | null) => void
  markDirty: () => void
  markSaving: () => void
  markSaved: () => void
  markError: (message: string) => void
  setSnapshotMeta: (payload: {
    snapshotHash?: string | null
    selectionSummary?: string | null
    selectedElementCount?: number
    selectionBounds?: DesignLayoutBounds | null
    layoutDigest?: DesignLayoutDigest | null
    currentToolContext?: string | null
    latestReviewSummary?: string | null
    repairScope?: DesignRepairScope
    scenePlanId?: string | null
    boardId?: string | null
    styleSystem?: DesignStyleSystem | null
    reviewFailures?: string[]
    lastAcceptedScreenshot?: string | null
  }) => void
  setLastExportArtifactPath: (path: string | null) => void
  reset: () => void
}

export const useDesignSession = create<DesignSessionState>((set) => ({
  activeFile: null,
  isDirty: false,
  saveStatus: 'idle',
  lastSavedAt: null,
  lastError: null,
  snapshotHash: null,
  selectionSummary: null,
  selectedElementCount: 0,
  selectionBounds: null,
  layoutDigest: null,
  lastExportArtifactPath: null,
  currentToolContext: null,
  latestReviewSummary: null,
  repairScope: 'selected',
  scenePlanId: null,
  boardId: null,
  styleSystem: null,
  reviewFailures: [],
  lastAcceptedScreenshot: null,
  setActiveFile: (file) => set((state) => {
    const hasChanged = state.activeFile !== file
    return {
      activeFile: file,
      saveStatus: hasChanged || !file ? 'idle' : state.saveStatus,
      lastError: hasChanged ? null : state.lastError,
      isDirty: hasChanged ? false : state.isDirty,
      lastSavedAt: hasChanged ? null : state.lastSavedAt,
      snapshotHash: hasChanged ? null : state.snapshotHash,
      selectionSummary: hasChanged ? null : state.selectionSummary,
      selectedElementCount: hasChanged ? 0 : state.selectedElementCount,
      selectionBounds: hasChanged ? null : state.selectionBounds,
      layoutDigest: hasChanged ? null : state.layoutDigest,
      lastExportArtifactPath: hasChanged ? null : state.lastExportArtifactPath,
      currentToolContext: hasChanged ? null : state.currentToolContext,
      latestReviewSummary: hasChanged ? null : state.latestReviewSummary,
      repairScope: hasChanged ? 'selected' : state.repairScope,
      scenePlanId: hasChanged ? null : state.scenePlanId,
      boardId: hasChanged ? null : state.boardId,
      styleSystem: hasChanged ? null : state.styleSystem,
      reviewFailures: hasChanged ? [] : state.reviewFailures,
      lastAcceptedScreenshot: hasChanged ? null : state.lastAcceptedScreenshot,
    }
  }),
  markDirty: () => set((state) => ({
    isDirty: true,
    saveStatus: state.saveStatus === 'saving' ? 'saving' : 'idle',
  })),
  markSaving: () => set({ saveStatus: 'saving', lastError: null }),
  markSaved: () => set({ isDirty: false, saveStatus: 'saved', lastSavedAt: Date.now(), lastError: null }),
  markError: (message) => set({ saveStatus: 'error', lastError: message }),
  setSnapshotMeta: (payload) => set((state) => ({
    snapshotHash: payload.snapshotHash ?? state.snapshotHash,
    selectionSummary: payload.selectionSummary ?? state.selectionSummary,
    selectedElementCount: payload.selectedElementCount ?? state.selectedElementCount,
    selectionBounds: payload.selectionBounds ?? state.selectionBounds,
    layoutDigest: payload.layoutDigest ?? state.layoutDigest,
    currentToolContext: payload.currentToolContext ?? state.currentToolContext,
    latestReviewSummary: payload.latestReviewSummary ?? state.latestReviewSummary,
    repairScope: payload.repairScope ?? state.repairScope,
    scenePlanId: payload.scenePlanId ?? state.scenePlanId,
    boardId: payload.boardId ?? state.boardId,
    styleSystem: payload.styleSystem ?? state.styleSystem,
    reviewFailures: payload.reviewFailures ?? state.reviewFailures,
    lastAcceptedScreenshot: payload.lastAcceptedScreenshot ?? state.lastAcceptedScreenshot,
  })),
  setLastExportArtifactPath: (path) => set({ lastExportArtifactPath: path }),
  reset: () => set({
    activeFile: null,
    isDirty: false,
    saveStatus: 'idle',
    lastSavedAt: null,
    lastError: null,
    snapshotHash: null,
    selectionSummary: null,
    selectedElementCount: 0,
    selectionBounds: null,
    layoutDigest: null,
    lastExportArtifactPath: null,
    currentToolContext: null,
    latestReviewSummary: null,
    repairScope: 'selected',
    scenePlanId: null,
    boardId: null,
    styleSystem: null,
    reviewFailures: [],
    lastAcceptedScreenshot: null,
  }),
}))
