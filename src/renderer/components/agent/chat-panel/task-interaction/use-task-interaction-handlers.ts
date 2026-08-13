import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useAgent, type ScopeRunState } from '../../../../stores/useAgent'
import type { TaskCardRun } from '../../task-card-from-projection'
import type { PersistedScopeRunSummary } from '../helpers/projection'

// Stage V V1.9c — Task interaction handlers extracted from ChatPanel.tsx
// (original L1188-1457 region after V1.7-V1.9b extractions). All 15
// useCallbacks below are pure delegates over store readers + window IPC
// adapters; ChatPanel re-injects the few cross-cutting deps via params so
// the hook keeps zero React tree assumptions.

export interface UseTaskInteractionHandlersParams {
  mergedTaskRuns: TaskCardRun[]
  setInputValue: ReturnType<typeof useAgent.getState>['setInputValue']
  setPersistedScopeRuns: Dispatch<SetStateAction<PersistedScopeRunSummary[]>>
  focusInputWithResize: () => void
  refreshPersistedScopeRuns: () => Promise<void>
  refreshPersistedTaskProjections: () => Promise<void>
  refreshActiveChildRuns: () => Promise<void>
}

export interface TaskInteractionHandlers {
  patchScopeRun: (
    scopeId: string,
    updater: (previous: ScopeRunState | null) => ScopeRunState | null,
  ) => void
  handleCancelDetachedTask: (scopeId: string, taskId?: string | null) => Promise<void>
  handleCancelChildRun: (scopeId: string, childRunId: string) => Promise<void>
  handleOpenTaskArtifact: (path: string) => Promise<void>
  handleDismissMemoryCapture: (scopeId: string) => void
  handleUndoMemoryCapture: (scopeId: string) => Promise<void>
  handleSupplementMemoryCapture: (scopeId: string) => void
}

export function useTaskInteractionHandlers(
  params: UseTaskInteractionHandlersParams,
): TaskInteractionHandlers {
  const {
    mergedTaskRuns,
    setInputValue,
    setPersistedScopeRuns,
    focusInputWithResize,
    refreshPersistedScopeRuns,
    refreshPersistedTaskProjections,
    refreshActiveChildRuns,
  } = params

  const patchScopeRun = useCallback(
    (scopeId: string, updater: (previous: ScopeRunState | null) => ScopeRunState | null) => {
      useAgent.setState((state) => {
        const previous = state.scopeRunStates[scopeId] || null
        const next = updater(previous)
        if (!next) return state
        return {
          scopeRunStates: {
            ...state.scopeRunStates,
            [scopeId]: next
          }
        }
      })
    },
    []
  )

  const handleCancelDetachedTask = useCallback(async (_scopeId: string, taskId?: string | null) => {
    const detachedTaskId = typeof taskId === 'string' && taskId.startsWith('detached:')
      ? taskId.slice('detached:'.length)
      : ''
    if (!detachedTaskId || !window.electronAPI?.agent?.cancelDetachedSkillTask) return
    await window.electronAPI.agent.cancelDetachedSkillTask(detachedTaskId, _scopeId).catch(() => null)
    void refreshPersistedScopeRuns()
    void refreshPersistedTaskProjections()
  }, [refreshPersistedScopeRuns, refreshPersistedTaskProjections])

  const handleCancelChildRun = useCallback(async (_scopeId: string, childRunId: string) => {
    if (!childRunId || !window.electronAPI?.agent?.cancelChildRun) return
    await window.electronAPI.agent.cancelChildRun(childRunId).catch(() => null)
    void refreshActiveChildRuns()
    void refreshPersistedScopeRuns()
    void refreshPersistedTaskProjections()
  }, [refreshActiveChildRuns, refreshPersistedScopeRuns, refreshPersistedTaskProjections])

  const handleOpenTaskArtifact = useCallback(async (path: string) => {
    await window.electronAPI.document.openPath(path).catch(() => undefined)
  }, [])

  const handleDismissMemoryCapture = useCallback(
    (scopeId: string) => {
      patchScopeRun(scopeId, (previous) =>
        previous
          ? {
              ...previous,
              memoryCapture: previous.memoryCapture
                ? { ...previous.memoryCapture, status: 'dismissed' }
                : null
            }
          : null
      )
      setPersistedScopeRuns((current) =>
        current.map((item) =>
          item.scopeId === scopeId && item.memoryCapture
            ? { ...item, memoryCapture: { ...item.memoryCapture, status: 'dismissed' } }
            : item
        )
      )
    },
    [patchScopeRun, setPersistedScopeRuns]
  )

  const handleUndoMemoryCapture = useCallback(
    async (scopeId: string) => {
      const capture =
        useAgent.getState().scopeRunStates[scopeId]?.memoryCapture ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)?.memoryCapture
      if (!capture) return
      await Promise.all(
        capture.items.map((item) =>
          window.electronAPI.memory.delete(item.memoryId).catch(() => undefined)
        )
      )
      patchScopeRun(scopeId, (previous) =>
        previous
          ? {
              ...previous,
              memoryCapture: previous.memoryCapture
                ? { ...previous.memoryCapture, status: 'reverted' }
                : null
            }
          : null
      )
      setPersistedScopeRuns((current) =>
        current.map((item) =>
          item.scopeId === scopeId && item.memoryCapture
            ? { ...item, memoryCapture: { ...item.memoryCapture, status: 'reverted' } }
            : item
        )
      )
    },
    [mergedTaskRuns, patchScopeRun, setPersistedScopeRuns]
  )

  const handleSupplementMemoryCapture = useCallback(
    (scopeId: string) => {
      const capture =
        useAgent.getState().scopeRunStates[scopeId]?.memoryCapture ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)?.memoryCapture
      const draft = [
        '请记住以下长期偏好或经验：',
        ...(capture?.items.map(
          (item) => `- ${item.title}${item.summary ? `：${item.summary}` : ''}`
        ) || []),
        '',
        '我还想补充：'
      ].join('\n')
      setInputValue(draft)
      focusInputWithResize()
    },
    [focusInputWithResize, mergedTaskRuns, setInputValue]
  )

  return {
    patchScopeRun,
    handleCancelDetachedTask,
    handleCancelChildRun,
    handleOpenTaskArtifact,
    handleDismissMemoryCapture,
    handleUndoMemoryCapture,
    handleSupplementMemoryCapture,
  }
}
