import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useAgent, type PendingContinuationIntent, type ScopeRunState } from '../../../../stores/useAgent'
import type { ActiveChildRunSummaryData } from '../../../../types/electron'
import type { TaskCardRun } from '../../task-card-from-projection'
import type { PersistedScopeRunSummary } from '../helpers/projection'

// Stage V V1.9c — Task interaction handlers extracted from ChatPanel.tsx
// (original L1188-1457 region after V1.7-V1.9b extractions). All 15
// useCallbacks below are pure delegates over store readers + window IPC
// adapters; ChatPanel re-injects the few cross-cutting deps via params so
// the hook keeps zero React tree assumptions.

export interface UseTaskInteractionHandlersParams {
  mergedTaskRuns: TaskCardRun[]
  currentScopeId: string | null
  setComposerDraft: ReturnType<typeof useAgent.getState>['setComposerDraft']
  setInputValue: ReturnType<typeof useAgent.getState>['setInputValue']
  loadConversation: ReturnType<typeof useAgent.getState>['loadConversation']
  setPersistedScopeRuns: Dispatch<SetStateAction<PersistedScopeRunSummary[]>>
  setActiveChildRuns: Dispatch<SetStateAction<ActiveChildRunSummaryData[]>>
  focusInputWithResize: () => void
  refreshPersistedScopeRuns: () => Promise<void>
  refreshPersistedTaskProjections: () => Promise<void>
}

type RunForContinuation = Pick<
  ScopeRunState,
  'taskId' | 'taskContinuation' | 'blockedReason'
>

export interface TaskInteractionHandlers {
  patchScopeRun: (
    scopeId: string,
    updater: (previous: ScopeRunState | null) => ScopeRunState | null,
  ) => void
  buildRunContinuationIntent: (
    run: RunForContinuation | null | undefined,
    responseText?: string,
  ) => PendingContinuationIntent | undefined
  handleContinueTaskInput: (scopeId: string) => Promise<void>
  handleSubmitTaskConfirmation: (scopeId: string, confirmed: boolean) => Promise<void>
  handleSubmitTaskAgentResult: (scopeId: string) => Promise<void>
  handleSuspendTask: (scopeId: string) => Promise<void>
  handleCancelDetachedTask: (scopeId: string, taskId?: string | null) => Promise<void>
  handleContinueDetachedTask: (scopeId: string, taskId?: string | null) => void
  handleCancelChildRun: (scopeId: string, childRunId: string) => Promise<void>
  handleContinueChildRun: (scopeId: string, childRunId: string) => Promise<void>
  handleResumeTask: (scopeId: string) => Promise<void>
  handleRetryTask: (scopeId: string) => Promise<void>
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
    currentScopeId,
    setComposerDraft,
    setInputValue,
    loadConversation,
    setPersistedScopeRuns,
    setActiveChildRuns,
    focusInputWithResize,
    refreshPersistedScopeRuns,
    refreshPersistedTaskProjections,
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

  // Phase 4: applySkillExecutionDetailToScope removed — the only caller was
  // handleRetryTask's restartFromStep branch, also retired.

  const buildRunContinuationIntent = useCallback(
    (
      run: RunForContinuation | null | undefined,
      responseText?: string,
    ) => {
      const taskId = run?.taskId || run?.taskContinuation?.taskId || null
      if (!taskId) return undefined
      return {
        taskId,
        executionId: run?.taskContinuation?.executionId || undefined,
        stepId: run?.taskContinuation?.stepId || undefined,
        blockedReason: run?.blockedReason || undefined,
        responseText: responseText || undefined,
        todoId: run?.taskContinuation?.todoId || undefined,
        todoTitle: run?.taskContinuation?.todoTitle || undefined,
        pauseReason: run?.taskContinuation?.pauseReason || undefined,
        childRunId: run?.taskContinuation?.childRunId || undefined,
        detachedTaskId: run?.taskContinuation?.detachedTaskId || undefined,
        taskRunId: run?.taskContinuation?.taskRunId || undefined,
        jobId: run?.taskContinuation?.jobId || undefined,
        skillId: run?.taskContinuation?.skillId || undefined,
        action: run?.taskContinuation?.action || undefined,
        runStatePath: run?.taskContinuation?.runStatePath || undefined,
        outputDir: run?.taskContinuation?.outputDir || undefined,
        progressFingerprint: run?.taskContinuation?.progressFingerprint || undefined,
      }
    },
    [],
  )

  const handleContinueTaskInput = useCallback(
    async (scopeId: string) => {
      const run =
        useAgent.getState().scopeRunStates[scopeId] ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)
      const responseText = window.prompt('补充后继续', run?.taskSummary || '请继续，补充信息如下：')
      if (responseText == null) return
      const trimmed = responseText.trim()
      if (!trimmed) return
      await window.electronAPI.agent.respondToInteraction({
        scopeId,
        taskId: run?.taskId || undefined,
        responseText: trimmed,
        continuationIntent: buildRunContinuationIntent(run, trimmed),
      })
    },
    [buildRunContinuationIntent, mergedTaskRuns]
  )

  const handleSubmitTaskConfirmation = useCallback(
    async (scopeId: string, confirmed: boolean) => {
      const run =
        useAgent.getState().scopeRunStates[scopeId] ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)
      await window.electronAPI.agent.respondToInteraction({
        scopeId,
        taskId: run?.taskId || undefined,
        responseText: confirmed ? '确认继续。' : '暂不继续，请先停止。',
        continuationIntent: buildRunContinuationIntent(
          run,
          confirmed ? '确认继续。' : '暂不继续，请先停止。',
        ),
      })
    },
    [buildRunContinuationIntent, mergedTaskRuns]
  )

  const handleSubmitTaskAgentResult = useCallback(
    async (scopeId: string) => {
      const run =
        useAgent.getState().scopeRunStates[scopeId] ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)
      const responseText = window.prompt('补交结果', run?.taskSummary || '人工步骤已完成，请继续。')
      if (responseText == null) return
      const trimmed = responseText.trim()
      if (!trimmed) return
      await window.electronAPI.agent.respondToInteraction({
        scopeId,
        taskId: run?.taskId || undefined,
        responseText: trimmed,
        continuationIntent: buildRunContinuationIntent(run, trimmed),
      })
    },
    [buildRunContinuationIntent, mergedTaskRuns]
  )

  const handleSuspendTask = useCallback(async (scopeId: string) => {
    const run =
      useAgent.getState().scopeRunStates[scopeId] ||
      mergedTaskRuns.find((item) => item.scopeId === scopeId)
    await window.electronAPI.agent.suspendRun({
      scopeId,
      taskId: run?.taskId || undefined,
    })
    void refreshPersistedScopeRuns()
    void refreshPersistedTaskProjections()
  }, [mergedTaskRuns, refreshPersistedScopeRuns, refreshPersistedTaskProjections])

  const handleCancelDetachedTask = useCallback(async (_scopeId: string, taskId?: string | null) => {
    const detachedTaskId = typeof taskId === 'string' && taskId.startsWith('detached:')
      ? taskId.slice('detached:'.length)
      : ''
    if (!detachedTaskId || !window.electronAPI?.agent?.cancelDetachedSkillTask) return
    await window.electronAPI.agent.cancelDetachedSkillTask(detachedTaskId, _scopeId).catch(() => null)
    void refreshPersistedScopeRuns()
    void refreshPersistedTaskProjections()
  }, [refreshPersistedScopeRuns, refreshPersistedTaskProjections])

  const handleContinueDetachedTask = useCallback((scopeId: string, taskId?: string | null) => {
    const detachedTaskId = typeof taskId === 'string' && taskId.startsWith('detached:')
      ? taskId.slice('detached:'.length)
      : ''
    if (!detachedTaskId) return
    if (currentScopeId !== scopeId) {
      void loadConversation(scopeId)
    }
    const run =
      useAgent.getState().scopeRunStates[scopeId] ||
      mergedTaskRuns.find((item) => item.scopeId === scopeId && (
        item.taskId === taskId ||
        item.taskId === detachedTaskId ||
        item.taskContinuation?.detachedTaskId === detachedTaskId ||
        item.taskContinuation?.taskId === detachedTaskId
      )) ||
      mergedTaskRuns.find((item) => item.scopeId === scopeId)
    const continuationRun: Pick<ScopeRunState, 'taskId' | 'taskContinuation' | 'blockedReason'> = run || {
      taskId: detachedTaskId,
      blockedReason: '后台任务仍在运行',
      taskContinuation: {
        taskId: detachedTaskId,
        detachedTaskId,
        pauseReason: 'background_running',
        blockerType: 'background_running',
      },
    }
    setComposerDraft(`继续后台任务 ${detachedTaskId}`, buildRunContinuationIntent(continuationRun) || null)
    focusInputWithResize()
  }, [buildRunContinuationIntent, currentScopeId, focusInputWithResize, loadConversation, mergedTaskRuns, setComposerDraft])

  const handleCancelChildRun = useCallback(async (_scopeId: string, childRunId: string) => {
    if (!childRunId || !window.electronAPI?.agent?.cancelChildRun) return
    await window.electronAPI.agent.cancelChildRun(childRunId).catch(() => null)
    const result = await window.electronAPI.agent.listActiveChildRuns?.().catch(() => null)
    if (result?.success && Array.isArray(result.data)) setActiveChildRuns(result.data)
    void refreshPersistedScopeRuns()
    void refreshPersistedTaskProjections()
  }, [refreshPersistedScopeRuns, refreshPersistedTaskProjections, setActiveChildRuns])

  const handleContinueChildRun = useCallback(async (scopeId: string, childRunId: string) => {
    if (currentScopeId !== scopeId) {
      void loadConversation(scopeId)
    }
    const run =
      mergedTaskRuns.find((item) => item.scopeId === scopeId && item.taskContinuation?.childRunId === childRunId) ||
      mergedTaskRuns.find((item) => item.scopeId === scopeId && item.taskId === `skill-child:${childRunId}`)
    const continuationRun: Pick<ScopeRunState, 'taskId' | 'taskContinuation' | 'blockedReason'> = run || {
      taskId: `skill-child:${childRunId}`,
      blockedReason: '后台任务仍在运行',
      taskContinuation: {
        taskId: `skill-child:${childRunId}`,
        childRunId,
        pauseReason: 'background_running',
        blockerType: 'background_running',
      },
    }
    await window.electronAPI.agent.resumeRun({
      scopeId,
      taskId: continuationRun.taskId || undefined,
      continuationIntent: buildRunContinuationIntent(continuationRun),
    })
    void refreshPersistedScopeRuns()
    void refreshPersistedTaskProjections()
  }, [buildRunContinuationIntent, currentScopeId, loadConversation, mergedTaskRuns, refreshPersistedScopeRuns, refreshPersistedTaskProjections])

  const handleResumeTask = useCallback(async (scopeId: string) => {
    const run =
      useAgent.getState().scopeRunStates[scopeId] ||
      mergedTaskRuns.find((item) => item.scopeId === scopeId)
    await window.electronAPI.agent.resumeRun({
      scopeId,
      taskId: run?.taskId || undefined,
      continuationIntent: buildRunContinuationIntent(run),
    })
    void refreshPersistedScopeRuns()
    void refreshPersistedTaskProjections()
  }, [buildRunContinuationIntent, mergedTaskRuns, refreshPersistedScopeRuns, refreshPersistedTaskProjections])

  const handleRetryTask = useCallback(
    async (scopeId: string) => {
      const run =
        useAgent.getState().scopeRunStates[scopeId] ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)
      // Phase 4: skill_executions state machine retired — the legacy
      // `restartFromStep` IPC bridge is gone. Retry now always goes through
      // the composer draft path; the LLM re-plans from the current state.
      setComposerDraft(
        '请重试刚才的任务，并在开始前先说明你准备怎么继续。',
        buildRunContinuationIntent(run) || null,
      )
      focusInputWithResize()
    },
    [buildRunContinuationIntent, focusInputWithResize, mergedTaskRuns, setComposerDraft]
  )

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
    buildRunContinuationIntent,
    handleContinueTaskInput,
    handleSubmitTaskConfirmation,
    handleSubmitTaskAgentResult,
    handleSuspendTask,
    handleCancelDetachedTask,
    handleContinueDetachedTask,
    handleCancelChildRun,
    handleContinueChildRun,
    handleResumeTask,
    handleRetryTask,
    handleOpenTaskArtifact,
    handleDismissMemoryCapture,
    handleUndoMemoryCapture,
    handleSupplementMemoryCapture,
  }
}
