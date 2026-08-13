/**
 * Stage V — V1.1 ChatPanel pure helper extraction.
 *
 * Projection / artifact / scope helpers split out of `ChatPanel.tsx`.
 * Pure functions only — no React, no hooks, no IPC, no DOM.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md §2 V1.1
 */

import type {
  AgentArtifact,
  ConversationScope,
  ScopeRunState,
} from '../../../../modules/agent/types'
import type {
  ActiveChildRunSummaryData,
  TaskProjectionRecordData,
} from '../../../../types/electron'
import type { TaskCardRun } from '../../task-card-from-projection'
import { buildPlaceholderProjectionFromActiveChildRun } from '../../task-card-from-projection'
import {
  childRunToPhase as childRunPhase,
  childRunToProjectionStatus as childRunProjectionStatus,
  childRunToTaskActions as childRunActions,
  childRunToWaitingFor as childRunWaitingFor,
  DEBUG_PLACEHOLDER_TASK_SUMMARY,
} from '../../../../modules/agent/task-status-vocabulary'

/**
 * Renderer-side persisted scope-run summary, sourced from
 * `agent:listPersistedScopeRuns`. Kept here so the helper file can
 * compile in isolation; `ChatPanel.tsx` re-imports it for state typing.
 */
export interface PersistedScopeRunSummary {
  scopeId: string
  messageVisibilityEpoch: number
  agent: string
  title: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  channelKey: string
  threadKey: string
  phase: ScopeRunState['phase']
  // Stage O — `terminalReason` is on the main-side ScopeRunSummary
  // (`src/main/modules/agent-control/types.ts`); the persisted IPC
  // payload carries it forward, and `deriveTaskCardRuntimeState`
  // consumes it to decide background_running / budget_paused / waiting.
  // Mirrors `ScopeRunState.terminalReason` (renderer types.ts:363).
  terminalReason?: ScopeRunState['terminalReason']
  taskId?: string | null
  taskTitle?: string | null
  taskSummary?: string | null
  steps?: ScopeRunState['steps']
  currentStepId?: string | null
  waitingFor?: ScopeRunState['waitingFor']
  resumableActions?: ScopeRunState['resumableActions']
  recentArtifacts?: ScopeRunState['recentArtifacts']
  taskContinuation?: ScopeRunState['taskContinuation']
  progress?: ScopeRunState['progress']
  memoryCapture?: ScopeRunState['memoryCapture']
  blockedReason?: string | null
  error?: string | null
  updatedAt: string
}

export type PersistedTaskProjection = TaskProjectionRecordData

export function normalizeProjectionSteps(
  steps: TaskProjectionRecordData['steps'] | undefined,
): ScopeRunState['steps'] {
  return (steps || []).map((step) => ({
    id: step.id,
    title: step.title || step.description || step.id,
    status: step.status || 'pending',
    detail: step.detail,
    updatedAt: step.updatedAt || new Date(0).toISOString(),
  }))
}

export function resolveProjectionForTaskRun(
  projections: PersistedTaskProjection[] | undefined,
  run: Pick<TaskCardRun, 'taskId' | 'taskContinuation'>,
  persistedRun?: Pick<PersistedScopeRunSummary, 'taskId' | 'taskContinuation'> | null,
): PersistedTaskProjection | null {
  const items = projections || []
  const continuationCandidateIds = (continuation: ScopeRunState['taskContinuation'] | undefined) => {
    if (!continuation) return []
    return [
      continuation.taskId,
      continuation.childRunId ? `skill-child:${continuation.childRunId}` : null,
      continuation.detachedTaskId ? `detached:${continuation.detachedTaskId}` : null,
      continuation.taskRunId,
      continuation.jobId,
    ]
  }
  const candidateIds = [
    run.taskId,
    run.taskContinuation?.taskId,
    persistedRun?.taskId,
    ...continuationCandidateIds(run.taskContinuation),
    ...continuationCandidateIds(persistedRun?.taskContinuation),
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)

  for (const candidateId of candidateIds) {
    const matched = items.find((item) => item.taskId === candidateId)
    if (matched) return matched
  }

  // Exclude browser background-task projections (e.g. note_collect) from the
  // foreground fallback: they own their own card via the merge's pass-4
  // synthesis. Without this, a running note_collect projection gets grabbed as
  // the projection for an unrelated foreground card and the separate background
  // card is then deduped away (Codex result-review #B cross-talk).
  return selectFallbackProjection(items.filter((item) => item.module !== 'browser'))
}

export function isStalePausedProjection(item: PersistedTaskProjection): boolean {
  const actions = item.resumableActions || []
  return item.degradationReason === 'stale_paused'
    && item.canResume !== true
    && !actions.includes('continue')
    && !actions.includes('retry')
}

export function isLiveProjectionCandidate(item: PersistedTaskProjection): boolean {
  return item.status === 'running'
    || item.interactionState === 'resuming'
    || (item.status === 'blocked' && !isStalePausedProjection(item))
}

export function selectFallbackProjection(items: PersistedTaskProjection[]): PersistedTaskProjection | null {
  return items.find(isLiveProjectionCandidate)
    || items.find((item) => item.status === 'completed' && (item.recentArtifacts?.length || 0) > 0)
    || items.find((item) => item.status === 'completed')
    || items[0]
    || null
}

/**
 * Stage O §1.6 — kept (trimmed). Translates `projection.interactionState`
 * into `waitingFor` for callers that need the synthesised value when
 * the projection's own `waitingFor` is unset. The Stage O gate's
 * named-helper allowance (`scripts/check-task-card-projection-only.cjs`)
 * lists this helper by name; do not rename without updating the gate.
 *
 * Stage O removed the `fallback` parameter — `mergedTaskRuns` no longer
 * carries `run.waitingFor` into `TaskCardRun`, so a projection-empty
 * waiting state is `'none'`, not whatever transient phase the
 * scopeRunStates store happened to hold.
 */
export function resolveProjectionWaitingFor(
  projection: PersistedTaskProjection | null,
): ScopeRunState['waitingFor'] {
  if (!projection) return 'none'
  if (projection.waitingFor) return projection.waitingFor
  if (projection.interactionState === 'awaiting_confirmation') return 'confirmation'
  if (projection.interactionState === 'awaiting_clarification') return 'clarification'
  if (projection.interactionState === 'human_takeover') return 'agent_result'
  return 'none'
}

export function resolveProjectionProgress(
  projection: PersistedTaskProjection | null,
): ScopeRunState['progress'] {
  if (!projection) return null
  return (projection.progress || projection.continuationRef?.progress || null) as ScopeRunState['progress']
}

// Stage O §1.6 — `resolveProjectionBlockedReason`,
// `shouldPreferProjectionContinuation`, and `resolveTaskContinuationForProjection`
// are retired. With projection-only field sourcing
// (`projection?.blockedReason ?? null` / `projection?.continuationRef ?? null`),
// the helpers reduced to single-line nullish coalescing.

// Stage O §1.4 / §O5 — `childRunTaskSummary` is retired. It used to
// synthesize Chinese status sentences from per-child runtime fields,
// which is exactly the "UI guesses status from text" pattern Stage O
// bans. The only caller — `activeChildRunDebugRow` — now writes a
// fixed `DEBUG_PLACEHOLDER_TASK_SUMMARY` instead, and visualState /
// actions continue to come from `deriveTaskCardRuntimeState`.

export function artifactFromPath(kind: string, label: string, path: string | null | undefined, childRunId: string): AgentArtifact | null {
  if (!path) return null
  return {
    id: `child:${childRunId}:${kind}:${path}`,
    module: 'skill',
    kind,
    label,
    path,
    createdAt: new Date().toISOString(),
    meta: { childRunId },
  }
}

function activeChildRunTitle(row: ActiveChildRunSummaryData): string {
  const stage = String(row.progress?.stage || '').trim()
  const detail = String(row.progress?.detail || '').trim()
  if (detail && !/^[a-z_]+$/i.test(detail)) return detail
  if (stage === 'prepare') return '正在准备素材'
  if (stage === 'score_batches') return '正在分析素材'
  if (stage === 'merge_validate') return '正在整理分析结果'
  if (stage === 'finalize') return '正在生成报告'
  return '正在处理后台任务'
}

/**
 * Stage 6 L6 contract: this function synthesizes a `TaskCardRun` from the
 * `agent:listActiveChildRuns` polling feed and is the renderer's last-resort
 * fallback when the persisted `task_projections` table has not yet caught up.
 *
 * It must remain a debug/control-only path; do not promote it to the primary
 * task-card source. The canonical view truth is `taskProjectionsForScope(...)`,
 * fed by main-side projection write-back. When projections cover all
 * scopes/tasks, this synthesis can be removed entirely (Stage 7+ scope).
 *
 * The L6 CI gate (`scripts/check-task-card-single-source.cjs`) enforces:
 *  - The legacy synthesis name (the pre-Stage-6 form of this function) does
 *    not appear anywhere; only the debug-named form is allowed.
 *  - This function continues to live in `ChatPanel.tsx` (or `active-child-run-debug.ts`
 *    after the Stage 7 file split).
 */
export function activeChildRunDebugRow(row: ActiveChildRunSummaryData, fallbackScopeId: string | null): TaskCardRun | null {
  const scopeId = row.scopeId || fallbackScopeId
  if (!scopeId) return null
  const status = childRunProjectionStatus(row)
  const updatedAt = row.progress?.updatedAt || new Date().toISOString()
  const artifacts = [
    artifactFromPath('folder', '输出目录', row.outputDir, row.childRunId),
    artifactFromPath('run_state', 'run_state.json', row.runStatePath, row.childRunId),
  ].filter((value): value is NonNullable<ScopeRunState['recentArtifacts']>[number] => value !== null)
  return buildPlaceholderProjectionFromActiveChildRun({
    scopeId,
    messageVisibilityEpoch: row.messageVisibilityEpoch,
    taskId: `skill-child:${row.childRunId}`,
    phase: childRunPhase(row),
    status,
    title: '后台任务',
    taskTitle: activeChildRunTitle(row),
    // Stage O §1.4 — debug fallback rows must NOT translate runtime fields
    // into guessed completion sentences. Use the canonical placeholder during
    // the projection-write transient.
    taskSummary: DEBUG_PLACEHOLDER_TASK_SUMMARY,
    steps: [{
      id: `child_run:${row.childRunId}`,
      title: row.progress?.stage || '后台技能执行',
      status:
        status === 'completed'
          ? 'done'
          : status === 'failed'
            ? 'error'
            : status === 'blocked'
              ? 'blocked'
              : 'running',
      detail: DEBUG_PLACEHOLDER_TASK_SUMMARY,
      updatedAt,
    }],
    currentStepId: `child_run:${row.childRunId}`,
    waitingFor: childRunWaitingFor(row),
    resumableActions: childRunActions(row),
    recentArtifacts: artifacts,
    taskContinuation: {
      taskId: `skill-child:${row.childRunId}`,
      stepId: `child_run:${row.childRunId}`,
      blockerType: status === 'running' ? 'background_running' : status,
      pauseReason: status === 'running' ? 'background_running' : status,
      childRunId: row.childRunId,
      skillId: row.skillId,
      runStatePath: row.runStatePath,
      outputDir: row.outputDir,
      progressFingerprint: row.progress?.fingerprint || null,
    },
    progress: row.progress,
    blockedReason: row.blockedReason,
    updatedAt,
    toolTrace: [],
  }, row)
}

export function memoryCaptureSourceLabel(
  sourceType: 'resident_agent' | 'resident_user' | 'scope_memory' | 'trigger_rule' | undefined
): string {
  switch (sourceType) {
    case 'resident_agent':
      return '常驻记忆'
    case 'resident_user':
      return '用户偏好'
    case 'scope_memory':
      return '当前任务摘要'
    case 'trigger_rule':
      return '规则沉淀'
    default:
      return '记忆'
  }
}

export function mapScopeToConversation(scope: ConversationScope) {
  return {
    id: scope.id,
    agent: scope.agent,
    title: scope.title,
    created_at: scope.createdAt,
    updated_at: scope.updatedAt
  }
}

export function progressPercent(progress: ScopeRunState['progress'] | undefined | null): number | null {
  if (!progress) return null
  if (progress.overallCoverage != null) {
    return Math.max(0, Math.min(100, Math.round(progress.overallCoverage * 100)))
  }
  if (progress.total && progress.total > 0 && progress.completed != null) {
    return Math.max(0, Math.min(100, Math.round((progress.completed / progress.total) * 100)))
  }
  if (progress.coverage != null) return Math.max(0, Math.min(100, Math.round(progress.coverage * 100)))
  return null
}
