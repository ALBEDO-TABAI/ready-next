/**
 * Stage V — V1.7 ChatPanel task-merge hook extraction.
 *
 * The pure four-pass merge that combines persisted scope runs, in-memory
 * task runs, active child-run debug rows, and cold-start projection
 * synthesis into the canonical `TaskCardRun[]` consumed by the task card
 * surface. Lifted verbatim from `ChatPanel.tsx` `mergedTaskRuns` useMemo
 * so the body stays under the Stage O §1.3 / §3.1 whitelist-only contract
 * enforced by `scripts/check-task-card-projection-only.cjs`.
 *
 * Pure hook — no `useAgent`, no IPC, no DOM. Inputs are the live
 * dependency set captured from the original useMemo dep array
 * (`activeChildRuns`, `currentScopeId`, `filteredScopes`,
 * `inMemoryTaskRuns`, `persistedScopeRuns`, `persistedTaskProjections`).
 * Output is identical shape and ordering to the original useMemo,
 * keeping the V6 fixture snapshot diff = 0.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md §2 V1.7
 */

import { useMemo } from 'react'
import type {
  ConversationScope,
  ScopeRunState,
} from '../../../../stores/useAgent'
import type { ActiveChildRunSummaryData } from '../../../../types/electron'
import type { TaskCardRun } from '../../task-card-from-projection'
import { taskProjectionToTaskCardRun } from '../../task-card-from-projection'
import {
  activeChildRunDebugRow,
  normalizeProjectionSteps,
  resolveProjectionProgress,
  resolveProjectionForTaskRun,
  resolveProjectionWaitingFor,
  type PersistedScopeRunSummary,
  type PersistedTaskProjection,
} from '../helpers/projection'

export interface UseTaskRunMergeParams {
  activeChildRuns: ActiveChildRunSummaryData[]
  currentScopeId: string | null
  filteredScopes: ConversationScope[]
  inMemoryTaskRuns: TaskCardRun[]
  persistedScopeRuns: PersistedScopeRunSummary[]
  persistedTaskProjections: Record<string, PersistedTaskProjection[]>
}

export function useTaskRunMerge(params: UseTaskRunMergeParams): TaskCardRun[] {
  const {
    activeChildRuns,
    currentScopeId,
    filteredScopes,
    inMemoryTaskRuns,
    persistedScopeRuns,
    persistedTaskProjections,
  } = params

  return useMemo<TaskCardRun[]>(() => {
    // Stage O §1.3 — both `mappedPersisted` (first arm, persistedScopeRuns)
    // and the second-arm merge (inMemoryTaskRuns) explicitly enumerate
    // every TaskCardRun field. blacklist fields come from `projection.X`
    // (or the named helpers `resolveProjectionWaitingFor` /
    // `normalizeProjectionSteps`); whitelist fields come from
    // `run.X` / `persistedRun.X` / scope title. No `...run` spread —
    // gate `check-task-card-projection-only.cjs` rejects it.
    const persistedScopeRunByScopeId = new Map(
      persistedScopeRuns.map((persistedRun) => [persistedRun.scopeId, persistedRun] as const),
    )
    const mappedPersisted = persistedScopeRuns.map((run) => {
      const projection = resolveProjectionForTaskRun(
        persistedTaskProjections[run.scopeId],
        run,
        run,
      )
      return taskProjectionToTaskCardRun({
        // O1 whitelist fields (persisted scope-run runtime data)
        scopeId: run.scopeId,
        // taskId is whitelist — multi-source fallback is allowed
        taskId: projection?.taskId || run.taskId || run.taskContinuation?.taskId || null,
        phase: run.phase,
        terminalReason: run.terminalReason,
        title: run.title,
        toolTrace: [],
        memoryCapture: run.memoryCapture,
        error: run.error,
        updatedAt: run.updatedAt,
        // O1 blacklist fields — projection-only
        status: projection?.status,
        taskTitle: projection?.taskTitle ?? null,
        taskSummary: projection?.taskSummary ?? null,
        steps: normalizeProjectionSteps(projection?.steps) ?? [],
        currentStepId: projection?.currentStepId ?? null,
        waitingFor: resolveProjectionWaitingFor(projection),
        resumableActions: projection?.resumableActions ?? [],
        recentArtifacts: projection?.recentArtifacts ?? [],
        taskContinuation: projection?.continuationRef ?? null,
        progress: resolveProjectionProgress(projection),
        taskType: projection?.taskType,
        interactionState: projection?.interactionState,
        budgetUsagePercent: projection?.budgetUsagePercent,
        stepBudget: projection?.budget?.stepBudget,
        budgetWarningLevel: projection?.budgetWarningLevel,
        degradationReason: projection?.degradationReason,
        recoveryHistory: projection?.recoveryHistory,
        blockedReason: projection?.blockedReason ?? null,
        // Stage Q (Stage 11) — propagate main-derived canResume so the
        // mainline persisted-scope synthesis carries the same truth as
        // cold-start path. Audit §C-9 / contract C7.
        canResume: projection?.canResume,
      }, projection)
    })
    const merged = new Map<string, TaskCardRun>()
    for (const run of mappedPersisted) merged.set(run.scopeId, run)
    for (const run of inMemoryTaskRuns) {
      const persistedRun = persistedScopeRunByScopeId.get(run.scopeId) || null
      const projection = resolveProjectionForTaskRun(
        persistedTaskProjections[run.scopeId],
        run,
        persistedRun,
      )
      // Explicit field listing — no `...run` spread (Stage O §3.1 case 1).
      merged.set(run.scopeId, taskProjectionToTaskCardRun({
        // O1 whitelist fields copied from inMemoryTaskRuns shell
        scopeId: run.scopeId,
        taskId: projection?.taskId || run.taskId || persistedRun?.taskId || run.taskContinuation?.taskId || null,
        phase: run.phase,
        terminalReason: run.terminalReason,
        title: run.title,
        toolTrace: run.toolTrace,
        responseMessageId: run.responseMessageId,
        responseSegmentToolTraceStart: run.responseSegmentToolTraceStart,
        error: run.error,
        updatedAt: run.updatedAt,
        memoryCapture: run.memoryCapture,
        // O1 blacklist fields — projection-only
        status: projection?.status,
        taskTitle: projection?.taskTitle ?? null,
        taskSummary: projection?.taskSummary ?? null,
        steps: normalizeProjectionSteps(projection?.steps) ?? [],
        currentStepId: projection?.currentStepId ?? null,
        waitingFor: resolveProjectionWaitingFor(projection),
        resumableActions: projection?.resumableActions ?? [],
        recentArtifacts: projection?.recentArtifacts ?? [],
        taskContinuation: projection?.continuationRef ?? null,
        progress: resolveProjectionProgress(projection),
        taskType: projection?.taskType,
        interactionState: projection?.interactionState,
        budgetUsagePercent: projection?.budgetUsagePercent,
        stepBudget: projection?.budget?.stepBudget,
        budgetWarningLevel: projection?.budgetWarningLevel,
        degradationReason: projection?.degradationReason,
        recoveryHistory: projection?.recoveryHistory,
        blockedReason: projection?.blockedReason ?? null,
        // Stage Q (Stage 11) — propagate main-derived canResume.
        canResume: projection?.canResume,
      }, projection, persistedRun))
    }
    // Stage 6 L6: only inject synthesized active-child-run rows when the
    // persisted projection table has no record covering this child run yet
    // (boot-time fallback). Once the main-side ledger backfills a
    // projection for the same childRunId, we drop the synthesized row to
    // avoid double-rendering. The synthesis remains available for the
    // debug surface (`activeChildRunDebugRow`).
    // Stage 6 L6: a projection covers a child-run if either
    //   (a) the projection's `continuationRef.childRunId` matches, or
    //   (b) the projection's taskId follows the `skill-child:<id>` form
    //       (the reconciler at task-projection-reconciler.ts uses this shape).
    const projectionsCoverChildRunId = (childRunId: string): boolean => {
      const skillChildTaskId = `skill-child:${childRunId}`
      for (const list of Object.values(persistedTaskProjections)) {
        if (!Array.isArray(list)) continue
        for (const projection of list) {
          if (projection?.continuationRef?.childRunId === childRunId) return true
          if (projection?.taskId === skillChildTaskId) return true
        }
      }
      return false
    }
    for (const row of activeChildRuns) {
      if (projectionsCoverChildRunId(row.childRunId)) continue
      const childRun = activeChildRunDebugRow(row, currentScopeId)
      if (!childRun) continue
      merged.set(`${childRun.scopeId}:${childRun.taskId}`, childRun)
    }
    // Stage O cold-start fix — `persistedScopeRuns` is in-memory only
    // (`runtime.listScopeRuns` returns the cache map at runtime.ts:601),
    // so after Ready restart the cache is empty until the next user
    // turn refreshes it. `persistedTaskProjections` IS persisted to
    // SQLite, so projections can outlive the scope-run cache. Without
    // this 4th pass, a cold-started scope with a saved projection
    // would silently drop its task card. We synthesize a card directly
    // from the projection (with whitelist fields filled from the
    // matching scope's static title) for any scope already in
    // `filteredScopes` that doesn't yet have a card.
    for (const scope of filteredScopes) {
      if (merged.has(scope.id)) continue
      const list = persistedTaskProjections[scope.id]
      if (!Array.isArray(list) || list.length === 0) continue
      // Prefer the most "live" projection (running/blocked/resuming),
      // falling back to the most recent one (list is updated_at DESC).
      const projection = list.find((item) =>
        item?.status === 'running'
        || item?.status === 'blocked'
        || item?.interactionState === 'resuming',
      ) || list[0] || null
      if (!projection) continue
      // Map projection.status into a renderer phase. The mapping is
      // a one-way derivation; it doesn't try to recover the original
      // scope-run phase, which is fine for cold-start restoration.
      const phaseFromStatus: ScopeRunState['phase'] =
        projection.status === 'completed' ? 'done'
        : projection.status === 'failed' ? 'error'
        : projection.status === 'killed' ? 'cancelled'
        : projection.status === 'blocked' || projection.status === 'recoverable_paused' || projection.status === 'budget_paused' ? 'checkpoint'
        : projection.status === 'queued' ? 'queued'
        : 'tool_running'
      merged.set(scope.id, taskProjectionToTaskCardRun({
        // O1 whitelist
        scopeId: scope.id,
        taskId: projection.taskId,
        phase: phaseFromStatus,
        terminalReason: undefined,
        title: scope.title,
        toolTrace: [],
        memoryCapture: undefined,
        error: undefined,
        updatedAt: projection.updatedAt,
        // O1 blacklist — projection-only
        status: projection.status,
        taskTitle: projection.taskTitle ?? null,
        taskSummary: projection.taskSummary ?? null,
        steps: normalizeProjectionSteps(projection.steps) ?? [],
        currentStepId: projection.currentStepId ?? null,
        waitingFor: resolveProjectionWaitingFor(projection),
        resumableActions: projection.resumableActions ?? [],
        recentArtifacts: projection.recentArtifacts ?? [],
        taskContinuation: projection.continuationRef ?? null,
        progress: resolveProjectionProgress(projection),
        taskType: projection.taskType,
        interactionState: projection.interactionState,
        budgetUsagePercent: projection.budgetUsagePercent,
        stepBudget: projection.budget?.stepBudget,
        budgetWarningLevel: projection.budgetWarningLevel,
        degradationReason: projection.degradationReason,
        recoveryHistory: projection.recoveryHistory,
        blockedReason: projection.blockedReason ?? null,
        // Stage Q (Stage 11) — propagate main-derived canResume so cold-
        // start TaskCardRun synthesis carries the same truth as the live
        // scopeRunStates path.
        canResume: projection.canResume,
      }, projection))
    }
    return Array.from(merged.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  }, [activeChildRuns, currentScopeId, filteredScopes, inMemoryTaskRuns, persistedScopeRuns, persistedTaskProjections])
}
