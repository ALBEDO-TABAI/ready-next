import { createHash } from 'node:crypto'
import type {
  ProjectionTruthSnapshot,
  TaskInteractionState,
  TaskProjectionRecord,
  TaskProjectionStore,
  TaskStep,
} from './run-contracts'
import { isTaskType } from '../../../shared/task-types'
import { buildContinuationStateFromProjection } from './continuation-state'
import { clearContinuationState, rememberContinuationState } from './session-continuity'
import type { ScopeRunEventPayload, ScopeRunSummary } from './types'
import type { RecoveryRecord } from './run-contracts'

function toContinuationUpdatedAt(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function readProjectionTruthPatch(projectionTruth?: ProjectionTruthSnapshot | null): Record<string, unknown> | null {
  let patch: Record<string, unknown> | null = null
  for (const event of projectionTruth?.transcriptEvents || []) {
    if (event.kind !== 'structured_payload' || !event.projectionPatch) continue
    patch = {
      ...(patch || {}),
      ...event.projectionPatch,
    }
  }
  if (projectionTruth?.projectionPatch) {
    patch = {
      ...(patch || {}),
      ...projectionTruth.projectionPatch,
    }
  }
  return patch
}

function stringFromRecord(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function truthContinuation(truthPatch: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return recordFromUnknown(truthPatch?.taskContinuation)
}

function truthArtifacts(truthPatch: Record<string, unknown> | null | undefined): ScopeRunSummary['recentArtifacts'] | null {
  return Array.isArray(truthPatch?.recentArtifacts)
    ? truthPatch.recentArtifacts as ScopeRunSummary['recentArtifacts']
    : null
}

function firstArtifactMetaString(artifacts: ScopeRunSummary['recentArtifacts'] | undefined, key: string): string | null {
  for (const artifact of artifacts || []) {
    const value = stringFromRecord(artifact.meta, key)
    if (value) return value
  }
  return null
}

function artifactPathByOutputKey(
  artifacts: ScopeRunSummary['recentArtifacts'] | undefined,
  outputKey: string,
): string | null {
  for (const artifact of artifacts || []) {
    if (stringFromRecord(artifact.meta, 'outputKey') === outputKey && artifact.path) return artifact.path
  }
  return null
}

function artifactPathEnding(
  artifacts: ScopeRunSummary['recentArtifacts'] | undefined,
  filename: string,
): string | null {
  for (const artifact of artifacts || []) {
    const path = typeof artifact.path === 'string' ? artifact.path.trim() : ''
    if (path && path.split(/[\\/]/).pop() === filename) return path
  }
  return null
}

function stableProjectionHash(parts: string[]): string {
  return createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16)
}

/**
 * Stage F1 (Zeta) — extract the durable `runContract` snippet from a frame
 * snapshot. The contract is the highest-priority source of truth for
 * skill identity / handles / paths / status. Returns null when no
 * contract was emitted by the producer chain this turn.
 */
function readFrameContract(
  projectionTruth?: ProjectionTruthSnapshot | null,
): NonNullable<NonNullable<ProjectionTruthSnapshot['frameSnapshot']>['skill']>['runContract'] | null {
  return projectionTruth?.frameSnapshot?.skill?.runContract || null
}

function resolveStableSkillProjectionTaskId(
  summary: ScopeRunSummary,
  payload: ScopeRunEventPayload,
  truthPatch?: Record<string, unknown> | null,
  contract?: ReturnType<typeof readFrameContract>,
): string | null {
  if (summary.taskType !== 'short_task' || payload.module !== 'system') return null
  const continuation = truthContinuation(truthPatch)
  const artifacts = truthArtifacts(truthPatch) || summary.recentArtifacts
  // Phase 7 — child-run identity wins over every other key. When the
  // contract carries a `childRunId`, the projection primary key MUST be
  // `skill-child:<childRunId>` so two skills sharing one outputDir do not
  // alias. Look in contract first, then in continuation/artifact meta as
  // a fallback for callers that haven't migrated yet.
  const childRunId =
    (contract && typeof (contract as { childRunId?: unknown }).childRunId === 'string'
      ? ((contract as { childRunId?: string }).childRunId || '').trim() || null
      : null)
    || stringFromRecord(continuation, 'childRunId')
    || firstArtifactMetaString(artifacts, 'childRunId')
  if (childRunId) return `skill-child:${childRunId}`
  // Stage F1 — contract truth wins over summary/artifact heuristics for
  // stable identity. Fall back to existing sources when the producer chain
  // did not emit a contract this turn.
  const skillId =
    (contract?.skillId || null)
    || stringFromRecord(continuation, 'skillId')
    || summary.taskContinuation?.skillId
    || firstArtifactMetaString(artifacts, 'skillId')
  if (!skillId) return null
  const detachedTaskId =
    (contract?.detachedTaskId || null)
    || stringFromRecord(continuation, 'detachedTaskId')
    || summary.taskContinuation?.detachedTaskId
    || firstArtifactMetaString(artifacts, 'detachedTaskId')
  if (detachedTaskId) return `skill:detached:${detachedTaskId}`
  const runStatePath =
    (contract?.runStatePath || null)
    || stringFromRecord(continuation, 'runStatePath')
    || summary.taskContinuation?.runStatePath
    || artifactPathByOutputKey(artifacts, 'runStatePath')
    || artifactPathEnding(artifacts, 'run_state.json')
  if (runStatePath) return `skill:run_state:${stableProjectionHash([skillId, runStatePath])}`
  const outputDir =
    (contract?.outputDir || null)
    || stringFromRecord(continuation, 'outputDir')
    || summary.taskContinuation?.outputDir
    || artifactPathByOutputKey(artifacts, 'outputDir')
  const action =
    (contract?.action || null)
    || stringFromRecord(continuation, 'action')
    || summary.taskContinuation?.action
    || firstArtifactMetaString(artifacts, 'action')
    || summary.currentStepId
  if (outputDir && action) return `skill:output:${stableProjectionHash([skillId, action, outputDir])}`
  return null
}

function resolveTaskId(
  summary: ScopeRunSummary,
  payload: ScopeRunEventPayload,
  truthPatch?: Record<string, unknown> | null,
  contract?: ReturnType<typeof readFrameContract>,
): string | null {
  // Phase 7 — child-run identity wins over every other key, including the
  // contract's stableKey. This prevents `outputDir`-keyed identities from
  // aliasing across two child runs that happen to share an output path.
  const childRunIdFromContract =
    contract && typeof (contract as { childRunId?: unknown }).childRunId === 'string'
      ? ((contract as { childRunId?: string }).childRunId || '').trim() || null
      : null
  if (childRunIdFromContract) return `skill-child:${childRunIdFromContract}`
  // Stage F1 — when the contract carries a stable projection key (e.g.
  // VEA's typed action wrapper computed it from skillId+detachedTaskId),
  // prefer it directly over recomputing the same key from heuristics.
  const stableFromContract = contract?.projectionIdentity?.stableKey || null
  if (stableFromContract && stableFromContract.startsWith('skill:')) {
    return stableFromContract
  }
  return resolveStableSkillProjectionTaskId(summary, payload, truthPatch, contract)
    || summary.taskId
    || payload.taskId
    || summary.taskProjectionId
    || payload.taskProjectionId
    || payload.runId
    || null
}

function resolveSkillArtifactIdentity(
  summary: ScopeRunSummary,
  truthPatch?: Record<string, unknown> | null,
  contract?: ReturnType<typeof readFrameContract>,
): { skillId: string | null; outputDir: string | null; runStatePath: string | null } {
  const continuation = truthContinuation(truthPatch)
  const artifacts = truthArtifacts(truthPatch) || summary.recentArtifacts
  // Stage F1 — contract handles win over summary/artifact heuristics so
  // sibling lookup uses the durable cross-turn identity even when this
  // turn's summary is sparse.
  const skillId =
    (contract?.skillId || null)
    || stringFromRecord(continuation, 'skillId')
    || summary.taskContinuation?.skillId
    || firstArtifactMetaString(artifacts, 'skillId')
    || null
  const outputDir =
    (contract?.outputDir || null)
    || stringFromRecord(continuation, 'outputDir')
    || summary.taskContinuation?.outputDir
    || artifactPathByOutputKey(artifacts, 'outputDir')
    || firstArtifactMetaString(artifacts, 'outputDir')
    || null
  const runStatePath =
    (contract?.runStatePath || null)
    || stringFromRecord(continuation, 'runStatePath')
    || summary.taskContinuation?.runStatePath
    || artifactPathByOutputKey(artifacts, 'runStatePath')
    || artifactPathEnding(artifacts, 'run_state.json')
    || null
  return { skillId, outputDir, runStatePath }
}

async function supersedeLegacySiblings(
  store: TaskProjectionStore,
  next: TaskProjectionRecord,
  identity: { skillId: string | null; outputDir: string | null; runStatePath: string | null },
): Promise<void> {
  if (!next.taskId.startsWith('skill:')) return
  if (!identity.outputDir && !identity.runStatePath) return
  if (typeof store.findByArtifactSiblings !== 'function') return
  let siblings: TaskProjectionRecord[] = []
  try {
    siblings = await store.findByArtifactSiblings({
      scopeId: next.scopeId,
      skillId: identity.skillId,
      outputDir: identity.outputDir,
      runStatePath: identity.runStatePath,
    })
  } catch (error) {
    // Sibling lookup is advisory; never let it block the main commit.
    console.warn('[task-projection-sync] findByArtifactSiblings failed', error)
    return
  }
  for (const sibling of siblings) {
    if (sibling.taskId === next.taskId) continue
    if (sibling.status === 'cancelled' || sibling.status === 'done') continue
    try {
      await store.update(
        sibling.taskId,
        {
          status: 'cancelled',
          interactionState: 'suspended',
          waitingFor: 'none',
          blockedReason: null,
          continuationRef: {
            taskId: next.taskId,
            blockerType: 'superseded',
          },
          updatedAt: next.updatedAt,
        },
        { reasonHint: 'supersede' },
      )
    } catch (error) {
      // Race recovery — sibling may have been concurrently mutated/deleted.
      console.warn(
        `[task-projection-sync] supersede update failed for ${sibling.taskId}`,
        error,
      )
    }
  }
}

function isTaskProjectionUniqueRace(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown } | null | undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = typeof record?.message === 'string' ? record.message : ''
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || code === 'SQLITE_CONSTRAINT'
    || /UNIQUE constraint failed: task_projections\.task_id/.test(message)
}

function resolveInteractionState(summary: ScopeRunSummary): TaskInteractionState {
  if (summary.interactionState) return summary.interactionState
  if (summary.phase === 'takeover') return 'human_takeover'
  if (summary.waitingFor === 'confirmation') return 'awaiting_confirmation'
  if (summary.waitingFor === 'input' || summary.waitingFor === 'clarification') return 'awaiting_clarification'
  if (summary.phase === 'resuming') return 'resuming'
  return 'running'
}

function resolveRecordInteractionState(
  summary: ScopeRunSummary,
  status: TaskProjectionRecord['status'],
): TaskInteractionState {
  const interactionState = resolveInteractionState(summary)
  // Terminal status must never persist with `running` or `resuming` interaction
  // state — both signal active work, which contradicts done/failed/cancelled.
  if (
    (interactionState === 'running' || interactionState === 'resuming')
    && (status === 'done' || status === 'failed' || status === 'cancelled')
  ) {
    return 'suspended'
  }
  return interactionState
}

function resolveWaitingFor(
  summary: ScopeRunSummary,
  previous?: TaskProjectionRecord | null,
): TaskProjectionRecord['waitingFor'] {
  if (summary.waitingFor) return summary.waitingFor
  return previous?.waitingFor || 'none'
}

function resolveStatus(summary: ScopeRunSummary): TaskProjectionRecord['status'] {
  const interactionState = resolveInteractionState(summary)
  const waitingForBlocker = Boolean(summary.waitingFor && summary.waitingFor !== 'none')
  if (summary.phase === 'queued') return 'queued'
  if (
    waitingForBlocker
    || summary.phase === 'takeover'
    || interactionState === 'awaiting_clarification'
    || interactionState === 'awaiting_confirmation'
    || interactionState === 'human_takeover'
    || interactionState === 'suspended'
  ) {
    return 'blocked'
  }
  if (summary.phase === 'error') return 'failed'
  if (summary.phase === 'cancelled') return 'cancelled'
  if (summary.blockedReason) return 'blocked'
  if (summary.phase === 'done') return 'done'
  if (interactionState !== 'running') return 'blocked'
  return 'running'
}

function resolveResumableActions(
  summary: ScopeRunSummary,
  status: TaskProjectionRecord['status'],
  previous?: TaskProjectionRecord | null,
): ScopeRunSummary['resumableActions'] {
  if (summary.resumableActions && summary.resumableActions.length > 0) {
    if (
      status === 'blocked'
      && summary.resumableActions.length === 1
      && summary.resumableActions[0] === 'none'
      && (summary.waitingFor === 'background' || summary.taskContinuation || previous?.continuationRef)
    ) {
      return ['continue', 'cancel']
    }
    return summary.resumableActions
  }
  if (status === 'failed') return ['retry']
  if (status === 'blocked') {
    if (previous?.resumableActions && previous.resumableActions.length > 0) return previous.resumableActions
    if (summary.taskContinuation || previous?.continuationRef) return ['continue', 'cancel']
  }
  // Stage O §2.1 — when the renderer's TaskCardRun reads `resumableActions`
  // exclusively from projection (`?? []`), a running task with a known
  // continuation must surface a non-empty default; otherwise the
  // foreground card has zero actionable buttons. Failure / blocked /
  // queued branches above already produce sensible defaults.
  if (status === 'running' && (summary.taskContinuation || previous?.continuationRef)) {
    return ['cancel']
  }
  return []
}

function resolveContinuationRef(
  summary: ScopeRunSummary,
  status: TaskProjectionRecord['status'],
  previous?: TaskProjectionRecord | null,
): ScopeRunSummary['taskContinuation'] {
  if (summary.taskContinuation) return summary.taskContinuation
  if (status === 'blocked' || status === 'failed') return previous?.continuationRef || null
  return null
}

function mapSteps(summary: ScopeRunSummary, previous?: TaskProjectionRecord | null): TaskStep[] {
  const previousSteps = new Map((previous?.steps || []).map((step) => [step.id, step]))
  return (summary.steps || []).map((step) => {
    const prior = previousSteps.get(step.id)
    return {
      ...prior,
      id: step.id,
      title: step.title || prior?.title,
      description: step.detail || prior?.description || step.title,
      status: step.status ?? prior?.status,
      detail: step.detail ?? prior?.detail ?? null,
      updatedAt: step.updatedAt || prior?.updatedAt,
      childTasks: prior?.childTasks ? prior.childTasks.map((item) => ({ ...item })) : undefined,
    }
  })
}

function resolveStepBudget(summary: ScopeRunSummary) {
  const runtimeStepBudget = summary.executionDiagnostics?.taskBudgetRuntime?.stepBudget
  if (runtimeStepBudget && typeof runtimeStepBudget.maxIterations === 'number') {
    return {
      stepId: runtimeStepBudget.stepId || null,
      maxIterations: runtimeStepBudget.maxIterations,
      remainingIterations: runtimeStepBudget.remainingIterations,
    }
  }
  const candidate = summary.stepBudget || summary.executionDiagnostics?.stepBudget || null
  if (!candidate || typeof candidate.maxIterations !== 'number') return null
  return {
    stepId: candidate.stepId || null,
    maxIterations: candidate.maxIterations,
    remainingIterations: candidate.remainingIterations,
  }
}

function mapRecoveryHistory(summary: ScopeRunSummary): RecoveryRecord[] {
  const entries = summary.recoveryHistory || summary.executionDiagnostics?.recoveryHistory || []
  return entries
    .filter((entry): entry is RecoveryRecord =>
      entry != null
      && (
        entry.kind === 'rate_limit'
        || entry.kind === 'context_overflow'
        || entry.kind === 'timeout_model'
        || entry.kind === 'timeout_tool'
        || entry.kind === 'auth'
        || entry.kind === 'transient'
        || entry.kind === 'host_unavailable'
      )
      && (
        entry.source === 'model_request'
        || entry.source === 'tool_execution'
        || entry.source === 'runtime'
      ),
    )
}

function resolveTaskBudget(summary: ScopeRunSummary) {
  const runtime = summary.executionDiagnostics?.taskBudgetRuntime
  if (runtime) {
    return {
      taskType: runtime.taskType,
      maxIterations: runtime.budget.maxIterations,
      maxToolCalls: runtime.budget.maxToolCalls,
      maxParallelToolGroups: runtime.budget.maxParallelToolGroups,
      reservedToolCalls: runtime.budget.reservedToolCalls || 0,
      iterationsUsed: runtime.usage.iterationsUsed,
      toolCallsUsed: runtime.usage.toolCallsUsed,
      parallelToolGroupsUsed: runtime.usage.parallelToolGroupsUsed,
      stepBudget: resolveStepBudget(summary),
      frozen: runtime.frozen,
      bootstrapBudget: runtime.bootstrapBudget,
    }
  }
  if (!summary.executionDiagnostics?.budget) return null
  return {
    taskType: summary.taskType || 'short_task',
    maxIterations: Number(summary.executionDiagnostics.budget.maxIterations || 0),
    maxToolCalls: Number(summary.executionDiagnostics.budget.maxToolCalls || 0),
    maxParallelToolGroups: Number(summary.executionDiagnostics.budget.maxParallelToolGroups || 0),
    reservedToolCalls: Number(summary.executionDiagnostics.budget.reservedToolCalls || 0),
    iterationsUsed: Number(summary.executionDiagnostics.budget.iterationsUsed || 0),
    toolCallsUsed: Number(summary.executionDiagnostics.budget.toolCallsUsed || 0),
    parallelToolGroupsUsed: Number(summary.executionDiagnostics.budget.parallelToolGroupsUsed || 0),
    stepBudget: resolveStepBudget(summary),
  }
}

function buildArtifactSummary(artifacts: ScopeRunSummary['recentArtifacts'] | undefined): string | null {
  const labels = (artifacts || [])
    .map((artifact) => String(artifact?.label || '').trim())
    .filter(Boolean)
    .slice(-3)
  if (labels.length === 0) return null
  return labels.join('、')
}

function formatChildTaskStatus(status: TaskProjectionRecord['status']): string {
  if (status === 'done') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'blocked') return '待继续'
  if (status === 'queued') return '排队中'
  return '进行中'
}

function stripChildTaskDetail(detail: string | null | undefined): string {
  const raw = String(detail || '').trim()
  if (!raw) return ''
  const marker = ' | 子任务 '
  const markerIndex = raw.indexOf(marker)
  return markerIndex === -1 ? raw : raw.slice(0, markerIndex).trim()
}

function mergeChildTaskIntoParentSteps(
  parent: TaskProjectionRecord,
  child: TaskProjectionRecord,
): TaskStep[] | null {
  if (!child.parentStepId) return null
  let changed = false
  const nextSteps = (parent.steps || []).map((step) => {
    if (step.id !== child.parentStepId) return step
    changed = true
    const childTasks = (step.childTasks || []).filter((item) => item.taskId !== child.taskId)
    const nextChildTasks = [
      ...childTasks,
      {
        taskId: child.taskId,
        taskType: child.taskType,
        status: child.status,
        summary: child.taskSummary || child.blockedReason || null,
        artifactSummary: buildArtifactSummary(child.recentArtifacts),
        updatedAt: child.updatedAt,
      },
    ].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    const baseDetail = stripChildTaskDetail(step.detail)
    const childDetail = nextChildTasks
      .map((item) => {
        const parts = [
          `子任务 ${item.taskId}（${formatChildTaskStatus(item.status)}）`,
          item.summary ? `：${item.summary}` : '',
          item.artifactSummary ? ` · 产物 ${item.artifactSummary}` : '',
        ]
        return parts.join('')
      })
      .join('；')
    return {
      ...step,
      childTasks: nextChildTasks,
      detail: [baseDetail, childDetail].filter(Boolean).join(' | ') || null,
      updatedAt: child.updatedAt || step.updatedAt,
    }
  })
  return changed ? nextSteps : null
}

async function syncParentProjectionFromChild(
  store: TaskProjectionStore,
  child: TaskProjectionRecord,
): Promise<void> {
  if (!child.parentTaskId) return
  const parent = await store.get(child.parentTaskId)
  if (!parent) return
  const nextSteps = mergeChildTaskIntoParentSteps(parent, child)
  if (!nextSteps) return
  const childKeepsParentOpen = child.status === 'running' || child.status === 'blocked'
  const parentHoldPatch = childKeepsParentOpen
    ? {
      status: 'blocked' as const,
      interactionState: 'suspended' as const,
      waitingFor: 'background' as const,
      blockedReason: child.blockedReason || child.taskSummary || '后台任务仍在运行',
      resumableActions: child.resumableActions?.length ? child.resumableActions : (['continue', 'cancel'] as TaskProjectionRecord['resumableActions']),
      continuationRef: child.continuationRef || parent.continuationRef || {
        taskId: child.taskId,
        blockerType: 'background_running',
      },
    }
    : {}
  await store.update(child.parentTaskId, {
    steps: nextSteps,
    ...parentHoldPatch,
    updatedAt: child.updatedAt,
  })
}

export function buildTaskProjectionRecord(
  summary: ScopeRunSummary,
  payload: ScopeRunEventPayload,
  previous?: TaskProjectionRecord | null,
  projectionTruth?: ProjectionTruthSnapshot | null,
): TaskProjectionRecord | null {
  const truthPatch = readProjectionTruthPatch(projectionTruth)
  const contract = readFrameContract(projectionTruth)
  const taskId = resolveTaskId(summary, payload, truthPatch, contract)
  if (!taskId) return null
  const effectiveSummary: ScopeRunSummary = {
    ...summary,
    taskType: (
      isTaskType(truthPatch?.taskType)
      ? truthPatch.taskType
      : summary.taskType
    ),
    taskTitle: typeof truthPatch?.taskTitle === 'string' ? truthPatch.taskTitle : summary.taskTitle,
    taskSummary: typeof truthPatch?.taskSummary === 'string' ? truthPatch.taskSummary : summary.taskSummary,
    interactionState: (
      truthPatch?.interactionState === 'running'
      || truthPatch?.interactionState === 'awaiting_clarification'
      || truthPatch?.interactionState === 'awaiting_confirmation'
      || truthPatch?.interactionState === 'human_takeover'
      || truthPatch?.interactionState === 'suspended'
      || truthPatch?.interactionState === 'resuming'
    )
      ? truthPatch.interactionState
      : summary.interactionState,
    steps: Array.isArray(truthPatch?.steps) ? truthPatch.steps as ScopeRunSummary['steps'] : summary.steps,
    currentStepId: typeof truthPatch?.currentStepId === 'string' ? truthPatch.currentStepId : summary.currentStepId,
    waitingFor: (
      truthPatch?.waitingFor === 'input'
      || truthPatch?.waitingFor === 'confirmation'
      || truthPatch?.waitingFor === 'agent_result'
      || truthPatch?.waitingFor === 'clarification'
      || truthPatch?.waitingFor === 'background'
      || truthPatch?.waitingFor === 'none'
    )
      ? truthPatch.waitingFor
      : summary.waitingFor,
    resumableActions: Array.isArray(truthPatch?.resumableActions)
      ? truthPatch.resumableActions as ScopeRunSummary['resumableActions']
      : summary.resumableActions,
    taskContinuation: truthPatch?.taskContinuation && typeof truthPatch.taskContinuation === 'object'
      ? truthPatch.taskContinuation as ScopeRunSummary['taskContinuation']
      : summary.taskContinuation,
    blockedReason: typeof truthPatch?.blockedReason === 'string'
      ? truthPatch.blockedReason
      : truthPatch?.blockedReason === null
        ? null
        : summary.blockedReason,
    recentArtifacts: Array.isArray(truthPatch?.recentArtifacts)
      ? truthPatch.recentArtifacts as ScopeRunSummary['recentArtifacts']
      : summary.recentArtifacts,
    progress: truthPatch?.progress && typeof truthPatch.progress === 'object'
      ? truthPatch.progress as ScopeRunSummary['progress']
      : summary.progress,
  }

  const status = resolveStatus(effectiveSummary)
  const blockedReasonWasCleared = truthPatch?.blockedReason === null || summary.blockedReason === null
  // Auto-clear stale blocker when frame explicitly says no stale blocker
  // exists for this skill — only when there is also no fresh blocker on
  // this commit. We don't drop a current blocker; we just refuse to carry
  // forward the previous row's blocker without a frame signal supporting it.
  const frameClearsStaleBlocker = (() => {
    const skillSnapshot = projectionTruth?.frameSnapshot?.skill
    if (!skillSnapshot) return false
    if (!('staleBlockerReason' in skillSnapshot)) return false
    return skillSnapshot.staleBlockerReason === null
  })()
  const blockedReason =
    effectiveSummary.blockedReason
    || (status === 'blocked' && !blockedReasonWasCleared && !frameClearsStaleBlocker ? previous?.blockedReason : null)
    || null

  return {
    taskId,
    scopeId: effectiveSummary.scopeId,
    runId: payload.runId || previous?.runId || taskId,
    parentTaskId: effectiveSummary.parentTaskId ?? payload.parentTaskId ?? previous?.parentTaskId ?? null,
    parentStepId: effectiveSummary.parentStepId ?? payload.parentStepId ?? previous?.parentStepId ?? null,
    taskType: effectiveSummary.taskType || 'short_task',
    module:
      (typeof truthPatch?.module === 'string' ? truthPatch.module : null)
      || payload.module
      || previous?.module
      || 'system',
    // Stage O §2.3 — projection is the only renderer source for taskTitle
    // (the renderer no longer falls back to `run.taskTitle`). When the
    // first event for a queued / running task arrives without any title,
    // ship a placeholder so the renderer's `isTaskVisible` doesn't filter
    // the card out and the foreground UI doesn't briefly go blank.
    // Subsequent writes with a real title overwrite this placeholder
    // (last-write-wins). Empty strings are treated as "no title yet" so
    // a truth patch carrying `''` still gets the placeholder applied —
    // `??` alone wouldn't replace an empty string.
    taskTitle: (() => {
      const effective = typeof effectiveSummary.taskTitle === 'string' && effectiveSummary.taskTitle.trim()
        ? effectiveSummary.taskTitle
        : null
      const prior = typeof previous?.taskTitle === 'string' && previous.taskTitle.trim()
        ? previous.taskTitle
        : null
      if (effective) return effective
      if (prior) return prior
      if (status === 'queued' || status === 'running') return '正在生成…'
      return null
    })(),
    taskSummary: effectiveSummary.taskSummary ?? previous?.taskSummary ?? null,
    status,
    interactionState: resolveRecordInteractionState(effectiveSummary, status),
    waitingFor: resolveWaitingFor(effectiveSummary, previous),
    steps: mapSteps(effectiveSummary, previous),
    currentStepId: effectiveSummary.currentStepId || null,
    budget: resolveTaskBudget(effectiveSummary),
    budgetUsagePercent: effectiveSummary.budgetUsagePercent ?? effectiveSummary.executionDiagnostics?.budgetUsagePercent ?? null,
    budgetWarningLevel: effectiveSummary.budgetWarningLevel ?? effectiveSummary.executionDiagnostics?.budgetWarningLevel ?? null,
    recoveryHistory: mapRecoveryHistory(effectiveSummary),
    degradationReason: effectiveSummary.degradationReason ?? effectiveSummary.executionDiagnostics?.degradationReason ?? null,
    blockedReason,
    resumableActions: resolveResumableActions(effectiveSummary, status, previous),
    continuationRef: resolveContinuationRef(effectiveSummary, status, previous),
    progress: effectiveSummary.progress ?? previous?.progress ?? null,
    recentArtifacts: effectiveSummary.recentArtifacts || previous?.recentArtifacts || [],
    createdAt: previous?.createdAt || payload.timestamp,
    updatedAt: effectiveSummary.updatedAt,
  }
}

export async function syncTaskProjection(
  store: TaskProjectionStore,
  summary: ScopeRunSummary,
  payload: ScopeRunEventPayload,
  projectionTruth?: ProjectionTruthSnapshot | null,
): Promise<TaskProjectionRecord | null> {
  const truthPatch = readProjectionTruthPatch(projectionTruth)
  const contract = readFrameContract(projectionTruth)
  const taskId = resolveTaskId(summary, payload, truthPatch, contract)
  if (!taskId) return null
  const previous = await store.get(taskId)
  let next = buildTaskProjectionRecord(summary, payload, previous, projectionTruth)
  if (!next) return null

  if (previous) {
    await store.update(taskId, next)
  } else {
    try {
      await store.create(next)
    } catch (error) {
      if (!isTaskProjectionUniqueRace(error)) throw error
      const concurrentPrevious = await store.get(taskId)
      if (!concurrentPrevious) throw error
      next = buildTaskProjectionRecord(summary, payload, concurrentPrevious, projectionTruth)
      if (!next) return null
      await store.update(taskId, next)
    }
  }
  if (
    next.status === 'blocked'
    || next.status === 'running'
    || next.interactionState === 'resuming'
    || next.taskType === 'continuation'
  ) {
    rememberContinuationState(next.scopeId, buildContinuationStateFromProjection(next), {
      updatedAt: toContinuationUpdatedAt(next.updatedAt),
    })
  } else {
    clearContinuationState(next.scopeId, next.taskId)
  }
  await syncParentProjectionFromChild(store, next)
  await supersedeLegacySiblings(store, next, resolveSkillArtifactIdentity(summary, truthPatch, contract))
  return next
}
