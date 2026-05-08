import type {
  ContinuationBudgetRestoreDiagnostics,
  TaskBudget,
  TaskBudgetRuntime,
  TaskInteractionState,
  TaskProjectionRecord,
  TaskStep,
  TaskType,
} from './run-contracts'
import { buildRequestEnvelope, type RequestEnvelope } from './request-envelope'
import { logAgentMetric } from './metrics'
import { matchesResumeIntent } from './resume-lexicon'
import type { ScopeRunResumableAction, ScopeRunTaskContinuation } from './types'

export interface ContinuationState {
  taskId: string
  scopeId: string
  runId: string
  module?: TaskProjectionRecord['module']
  taskType: TaskType
  interactionState: TaskInteractionState
  steps: TaskStep[]
  currentStepId?: string | null
  blockedReason?: string | null
  resumableActions: ScopeRunResumableAction[]
  continuationRef?: ScopeRunTaskContinuation | null
  budget?: TaskBudget | null
  budgetRuntime?: TaskBudgetRuntime | null
  restoreDiagnostics?: ContinuationBudgetRestoreDiagnostics | null
}

export interface ContinuationIntent {
  taskId: string
  executionId?: string
  stepId?: string
  blockedReason?: string
  responseText?: string
  todoId?: string
  todoTitle?: string
  pauseReason?: string
  detachedTaskId?: string
  taskRunId?: string
  jobId?: string
  skillId?: string
  action?: string
  runStatePath?: string
  outputDir?: string
  progressFingerprint?: string
  /**
   * Stage Q (Stage 11) — child run identifier. Required for Stage Q's
   * canResumeShape gate at `runtime.buildContinuationIntent` to reject
   * empty-shell intents. Without this field on the type, an incoming
   * intent's childRunId would be silently dropped by
   * `normalizeContinuationIntent`, leaving the resume gate blind.
   */
  childRunId?: string
}

export interface ParsedContinuationControlText {
  sanitizedUserText: string
  explicitTaskId: string | null
  executionId: string | null
  stepId: string | null
  blockedReason: string | null
  responseText: string | null
  hasControlLines: boolean
  shouldResolveContinuation: boolean
}

export interface SanitizedContinuationRequest {
  content: string
  requestEnvelope: RequestEnvelope
  parsedControl: ParsedContinuationControlText
  sanitizedRawUserText: string
}

function cloneTaskSteps(steps: TaskStep[] | null | undefined): TaskStep[] {
  return (steps || []).map((step) => ({
    ...step,
    childTasks: step.childTasks ? step.childTasks.map((child) => ({ ...child })) : undefined,
  }))
}

function cloneBudget(budget: TaskBudget | null | undefined): TaskBudget | null {
  if (!budget) return null
  return {
    ...budget,
    stepBudget: budget.stepBudget
      ? {
        stepId: budget.stepBudget.stepId || null,
        maxIterations: Number(budget.stepBudget.maxIterations || 0),
        remainingIterations: typeof budget.stepBudget.remainingIterations === 'number'
          ? Number(budget.stepBudget.remainingIterations)
          : undefined,
      }
      : null,
  }
}

function cloneBudgetRuntime(runtime: TaskBudgetRuntime | null | undefined): TaskBudgetRuntime | null {
  if (!runtime) return null
  return {
    ...runtime,
    budget: {
      ...runtime.budget,
      reservedToolCalls: Number(runtime.budget.reservedToolCalls || 0),
    },
    usage: {
      ...runtime.usage,
    },
    stepBudget: runtime.stepBudget
      ? {
        stepId: runtime.stepBudget.stepId || null,
        maxIterations: Number(runtime.stepBudget.maxIterations || 0),
        remainingIterations: Number(runtime.stepBudget.remainingIterations || 0),
      }
      : null,
  }
}

function normalizeTaskType(value: unknown): TaskType {
  if (
    value === 'direct_answer'
    || value === 'short_task'
    || value === 'multi_step_task'
    || value === 'media_task'
    || value === 'continuation'
  ) {
    return value
  }
  return 'short_task'
}

function normalizeInteractionState(value: unknown): TaskInteractionState {
  if (
    value === 'running'
    || value === 'awaiting_clarification'
    || value === 'awaiting_confirmation'
    || value === 'human_takeover'
    || value === 'suspended'
    || value === 'resuming'
  ) {
    return value
  }
  return 'running'
}

function normalizeResumableActions(value: unknown): ScopeRunResumableAction[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ScopeRunResumableAction =>
    item === 'continue'
    || item === 'retry'
    || item === 'open_artifact'
    || item === 'cancel'
    || item === 'none',
  )
}

function normalizeContinuationRef(value: unknown, taskId: string, currentStepId?: string | null): ScopeRunTaskContinuation | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<ScopeRunTaskContinuation>
  const executionId = String(record.executionId || '').trim()
  const todoId = String(record.todoId || '').trim()
  const detachedTaskId = String(record.detachedTaskId || '').trim()
  const taskRunId = String(record.taskRunId || '').trim()
  const jobId = String(record.jobId || '').trim()
  const skillId = String(record.skillId || '').trim()
  const action = String(record.action || '').trim()
  const runStatePath = String(record.runStatePath || '').trim()
  const outputDir = String(record.outputDir || '').trim()
  const progressFingerprint = String(record.progressFingerprint || '').trim()
  // Stage Q (Stage 11) — childRunId is a real durable handle (Stage Q
  // contract). It must participate in non-empty detection so a
  // `childRunId`-only projection's continuationRef survives normalization.
  const childRunId = String(record.childRunId || '').trim()
  if (
    !executionId &&
    !todoId &&
    !detachedTaskId &&
    !taskRunId &&
    !jobId &&
    !skillId &&
    !action &&
    !runStatePath &&
    !outputDir &&
    !progressFingerprint &&
    !childRunId
  ) {
    return null
  }
  return {
    taskId: String(record.taskId || taskId || '').trim() || taskId,
    executionId: executionId || null,
    stepId: String(record.stepId || currentStepId || '').trim() || currentStepId || null,
    blockerType: typeof record.blockerType === 'string' ? record.blockerType : null,
    targetUrl: typeof record.targetUrl === 'string' ? record.targetUrl : null,
    todoId: todoId || null,
    todoTitle: typeof record.todoTitle === 'string' ? record.todoTitle : null,
    pauseReason: typeof record.pauseReason === 'string' ? record.pauseReason : null,
    detachedTaskId: detachedTaskId || null,
    taskRunId: taskRunId || null,
    jobId: jobId || null,
    skillId: skillId || null,
    action: action || null,
    runStatePath: runStatePath || null,
    outputDir: outputDir || null,
    progressFingerprint: progressFingerprint || null,
    childRunId: childRunId || null,
  }
}

function normalizeOptionalContinuationText(value: unknown): string | undefined {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

export function normalizeContinuationIntent(value: Partial<ContinuationIntent> | null | undefined): ContinuationIntent | null {
  if (!value) return null
  const taskId = String(value.taskId || '').trim()
  if (!taskId) return null
  const normalized: ContinuationIntent = { taskId }
  const copy = (key: Exclude<keyof ContinuationIntent, 'taskId'>): void => {
    const text = normalizeOptionalContinuationText(value[key])
    if (text) normalized[key] = text
  }
  copy('executionId')
  copy('stepId')
  copy('blockedReason')
  copy('responseText')
  copy('todoId')
  copy('todoTitle')
  copy('pauseReason')
  copy('detachedTaskId')
  copy('taskRunId')
  copy('jobId')
  copy('skillId')
  copy('action')
  copy('runStatePath')
  copy('outputDir')
  copy('progressFingerprint')
  // Stage Q (Stage 11) — preserve childRunId so canResumeShape can use it
  // at `runtime.buildContinuationIntent`.
  copy('childRunId')
  return normalized
}

export function applyContinuationIntentToState(
  baseState: ContinuationState,
  intent: Partial<ContinuationIntent> | null | undefined,
): ContinuationState {
  const normalizedIntent = normalizeContinuationIntent(intent)
  if (!normalizedIntent || normalizedIntent.taskId !== baseState.taskId) {
    return normalizeContinuationState(baseState) || baseState
  }

  const currentStepId = normalizedIntent.stepId || baseState.currentStepId || null
  const continuationRef = (
    baseState.continuationRef
    || normalizedIntent.executionId
    || normalizedIntent.todoId
    || normalizedIntent.detachedTaskId
    || normalizedIntent.taskRunId
    || normalizedIntent.jobId
    || normalizedIntent.skillId
    || normalizedIntent.runStatePath
    || normalizedIntent.outputDir
    // Stage Q (Stage 11) — childRunId triggers continuationRef construction.
    || normalizedIntent.childRunId
  )
    ? normalizeContinuationRef({
      ...(baseState.continuationRef || {}),
      taskId: baseState.taskId,
      executionId: normalizedIntent.executionId || baseState.continuationRef?.executionId,
      stepId: normalizedIntent.stepId || baseState.continuationRef?.stepId || currentStepId,
      todoId: normalizedIntent.todoId || baseState.continuationRef?.todoId,
      todoTitle: normalizedIntent.todoTitle || baseState.continuationRef?.todoTitle,
      pauseReason: normalizedIntent.pauseReason || baseState.continuationRef?.pauseReason,
      detachedTaskId: normalizedIntent.detachedTaskId || baseState.continuationRef?.detachedTaskId,
      taskRunId: normalizedIntent.taskRunId || baseState.continuationRef?.taskRunId,
      jobId: normalizedIntent.jobId || baseState.continuationRef?.jobId,
      skillId: normalizedIntent.skillId || baseState.continuationRef?.skillId,
      action: normalizedIntent.action || baseState.continuationRef?.action,
      runStatePath: normalizedIntent.runStatePath || baseState.continuationRef?.runStatePath,
      outputDir: normalizedIntent.outputDir || baseState.continuationRef?.outputDir,
      progressFingerprint: normalizedIntent.progressFingerprint || baseState.continuationRef?.progressFingerprint,
      // Stage Q (Stage 11) — propagate childRunId through the merge.
      childRunId: normalizedIntent.childRunId || baseState.continuationRef?.childRunId,
    }, baseState.taskId, currentStepId)
    : null

  return normalizeContinuationState({
    ...baseState,
    currentStepId,
    blockedReason: normalizedIntent.blockedReason ?? baseState.blockedReason ?? null,
    continuationRef,
  }) || baseState
}

export function parseContinuationControlText(raw: string): ParsedContinuationControlText {
  const lines = String(raw || '').split('\n')
  const contentLines: string[] = []
  let explicitTaskId: string | null = null
  let executionId: string | null = null
  let stepId: string | null = null
  let blockedReason: string | null = null
  let responseText: string | null = null
  let hasControlLines = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const taskIdMatch = trimmed.match(/^Task ID:\s*(.+)$/i)
    if (taskIdMatch?.[1]) {
      explicitTaskId = taskIdMatch[1].trim()
      hasControlLines = true
      continue
    }
    const executionIdMatch = trimmed.match(/^Execution ID:\s*(.+)$/i)
    if (executionIdMatch?.[1]) {
      executionId = executionIdMatch[1].trim()
      hasControlLines = true
      continue
    }
    const stepIdMatch = trimmed.match(/^Step ID:\s*(.+)$/i)
    if (stepIdMatch?.[1]) {
      stepId = stepIdMatch[1].trim()
      hasControlLines = true
      continue
    }
    const blockedReasonMatch = trimmed.match(/^继续前上下文[:：]\s*(.+)$/)
    if (blockedReasonMatch?.[1]) {
      blockedReason = blockedReasonMatch[1].trim()
      hasControlLines = true
      continue
    }
    const responseTextMatch = trimmed.match(/^我的回复[:：]\s*(.+)$/)
    if (responseTextMatch?.[1]) {
      responseText = responseTextMatch[1].trim()
      hasControlLines = true
      continue
    }
    contentLines.push(trimmed)
  }

  const sanitizedParts = contentLines.slice()
  if (responseText && !sanitizedParts.includes(responseText)) {
    sanitizedParts.push(responseText)
  }
  const sanitizedUserText = sanitizedParts.join('\n').trim() || '继续当前任务。'

  return {
    sanitizedUserText,
    explicitTaskId,
    executionId,
    stepId,
    blockedReason,
    responseText,
    hasControlLines,
    // Phase 2.4 — `shouldResolveContinuation` is the gate that asks the
    // continuation projection store "is the user trying to resume something?"
    // Previously the inline regex `/(继续|接着|恢复|上次|重试)/` missed natural
    // phrasings like "你需要从头跑一轮" / "重新跑一次" / "再跑一遍" — exactly
    // the cases Codex flagged as silently dropped. The unified `anywhere`
    // mode in resume-lexicon covers them and stays grep-able when adding new
    // tokens. False positives are cheap here: the lookup returns null when
    // no candidate exists, and `selectContinuationProjection` excludes
    // terminal-status tasks (Phase 2.5).
    shouldResolveContinuation: Boolean(explicitTaskId) || matchesResumeIntent(sanitizedUserText, 'anywhere'),
  }
}

function replaceTrailingUserText(content: string, rawUserText: string, sanitizedRawUserText: string): string {
  if (!rawUserText) return sanitizedRawUserText
  if (content === rawUserText) return sanitizedRawUserText

  const tailIndex = content.lastIndexOf(rawUserText)
  if (tailIndex >= 0 && tailIndex + rawUserText.length === content.length) {
    return `${content.slice(0, tailIndex)}${sanitizedRawUserText}`
  }

  const parsedContent = parseContinuationControlText(content)
  return parsedContent.hasControlLines ? parsedContent.sanitizedUserText : sanitizedRawUserText
}

export function sanitizeContinuationRequest(params: {
  content: string
  rawUserText?: string | null
  requestEnvelope?: RequestEnvelope | null
}): SanitizedContinuationRequest {
  const originalRawUserText = String(
    params.rawUserText
    ?? params.requestEnvelope?.rawUserText
    ?? params.content
    ?? '',
  )
  const parsedControl = parseContinuationControlText(originalRawUserText)
  const sanitizedRawUserText = parsedControl.hasControlLines
    ? parsedControl.sanitizedUserText
    : originalRawUserText

  return {
    content: parsedControl.hasControlLines
      ? replaceTrailingUserText(params.content, originalRawUserText, sanitizedRawUserText)
      : params.content,
    requestEnvelope: parsedControl.hasControlLines
      ? buildRequestEnvelope({ userText: sanitizedRawUserText })
      : (params.requestEnvelope || buildRequestEnvelope({ userText: originalRawUserText })),
    parsedControl,
    sanitizedRawUserText,
  }
}

export function isContinuationProjectionCandidate(projection: TaskProjectionRecord | null | undefined): boolean {
  if (!projection) return false
  return (
    projection.status === 'blocked'
    || projection.status === 'running'
    || projection.interactionState === 'resuming'
    || projection.taskType === 'continuation'
  )
}

/**
 * Screenshot-bug hotfix — Phase 2.5 originally filtered `done | failed |
 * cancelled` as "implicitly non-resumable", but a real user case proved
 * `failed` was the most natural resume target: "再从头重新跑一次" against
 * a previously-failed VEA pipeline. Filtering it out forced the turn into
 * fresh-task routing, the orchestrator never inlined the reference skill,
 * and the model emitted `<tool_call>` XML as visible chat text.
 *
 * New policy:
 *   - `cancelled` → stays excluded (user explicitly cancelled; auto-resume
 *      would override their intent).
 *   - `done` → stays excluded for IMPLICIT lookup (user typed "继续" without
 *      a Task ID is far more often referring to a live task than a
 *      finished one). Explicit Task ID still resolves done tasks.
 *   - `failed` → no longer excluded. Retry semantics make this the most
 *      common resume target; "再跑/重试/重新跑" all reasonably mean
 *      "resume the failed one".
 *
 * Audit Phase 2 §B4 (the "理解需求 shadowing" risk) is still mitigated:
 * the system's auto-classified "理解需求" task is created with status
 * `done` once it lands its result, so the original shadowing remains
 * blocked. Failed tasks were never the source of that bug.
 */
function isTerminalProjection(projection: TaskProjectionRecord | null | undefined): boolean {
  if (!projection) return true
  return (
    projection.status === 'done'
    || projection.status === 'cancelled'
  )
}

export function selectContinuationProjection(params: {
  projections: TaskProjectionRecord[]
  userText: string
  explicitTaskId?: string | null
  allowImplicitContinuation?: boolean
}): TaskProjectionRecord | null {
  const parsed = parseContinuationControlText(params.userText)
  const explicitTaskId = params.explicitTaskId ?? parsed.explicitTaskId
  const sortedProjections = params.projections
    .slice()
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
  if (explicitTaskId) {
    // Explicit Task ID is a deliberate user/runtime override — honor even
    // terminal status (the caller may want to inspect the closed task).
    return sortedProjections.find((item) => item.taskId === explicitTaskId) || null
  }
  if (params.allowImplicitContinuation === false || !parsed.shouldResolveContinuation) {
    return null
  }
  // Phase 2.5 — exclude terminal projections from BOTH the candidate find
  // and the fallback. Old behavior: if no blocked/running task existed, the
  // fallback `sortedProjections[0]` could return a recently-touched but
  // already-finished `done` task, leading to "理解需求" turns shadowing real
  // skill executions (audit Phase 2 §B4). New behavior: returning null when
  // no live candidate exists lets the upstream gate fall back to "fresh
  // task" routing instead of a stale resume.
  const liveProjections = sortedProjections.filter((item) => !isTerminalProjection(item))
  // Phase 5.4 — observability: count how often the terminal filter actually
  // saved us from picking a closed task. Emitted only when the filter
  // dropped at least one candidate so the metric stays signal-not-noise.
  const droppedCount = sortedProjections.length - liveProjections.length
  if (droppedCount > 0) {
    logAgentMetric('continuation_projection_terminal_skipped', {
      droppedCount,
      liveCount: liveProjections.length,
      droppedTaskIds: sortedProjections
        .filter((item) => isTerminalProjection(item))
        .slice(0, 5)
        .map((item) => item.taskId),
    })
  }
  return liveProjections.find((item) => isContinuationProjectionCandidate(item)) || liveProjections[0] || null
}

export function normalizeContinuationState(value: Partial<ContinuationState> | null | undefined): ContinuationState | null {
  if (!value) return null
  const taskId = String(value.taskId || '').trim()
  const scopeId = String(value.scopeId || '').trim()
  const runId = String(value.runId || '').trim()
  if (!taskId || !scopeId || !runId) return null
  const currentStepId = typeof value.currentStepId === 'string'
    ? value.currentStepId.trim() || null
    : value.currentStepId == null
      ? null
      : String(value.currentStepId)

  return {
    taskId,
    scopeId,
    runId,
    module: typeof value.module === 'string' ? value.module : undefined,
    taskType: normalizeTaskType(value.taskType),
    interactionState: normalizeInteractionState(value.interactionState),
    steps: cloneTaskSteps(value.steps),
    currentStepId,
    blockedReason: typeof value.blockedReason === 'string' ? value.blockedReason : null,
    resumableActions: normalizeResumableActions(value.resumableActions),
    continuationRef: normalizeContinuationRef(value.continuationRef, taskId, currentStepId),
    budget: cloneBudget(value.budget),
    budgetRuntime: cloneBudgetRuntime(value.budgetRuntime),
    restoreDiagnostics: value.restoreDiagnostics
      ? {
        inheritedBudget: Boolean(value.restoreDiagnostics.inheritedBudget),
        restoredUsage: Boolean(value.restoreDiagnostics.restoredUsage),
        grantedIterationSafetyFloor: Boolean(value.restoreDiagnostics.grantedIterationSafetyFloor),
        grantedToolCallSafetyFloor: Boolean(value.restoreDiagnostics.grantedToolCallSafetyFloor),
        grantedStepBudgetSafetyFloor: Boolean(value.restoreDiagnostics.grantedStepBudgetSafetyFloor),
      }
      : null,
  }
}

export function buildContinuationStateFromProjection(
  projection: TaskProjectionRecord,
  overrides?: {
    executionId?: string | null
    stepId?: string | null
    blockedReason?: string | null
    budgetRuntime?: TaskBudgetRuntime | null
    restoreDiagnostics?: ContinuationBudgetRestoreDiagnostics | null
  },
): ContinuationState {
  const currentStepId =
    String(overrides?.stepId || '').trim()
    || projection.currentStepId
    || projection.continuationRef?.stepId
    || projection.steps.find((step) => step.status === 'running' || step.status === 'blocked')?.id
    || projection.steps[0]?.id
    || null
  const continuationRef = normalizeContinuationRef({
    ...(projection.continuationRef || {}),
    taskId: projection.taskId,
    executionId: overrides?.executionId || projection.continuationRef?.executionId,
    stepId: overrides?.stepId || projection.continuationRef?.stepId || currentStepId,
  }, projection.taskId, currentStepId)

  return normalizeContinuationState({
    taskId: projection.taskId,
    scopeId: projection.scopeId,
    runId: projection.runId,
    module: projection.module,
    taskType: projection.taskType,
    interactionState: projection.interactionState,
    steps: projection.steps,
    currentStepId,
    blockedReason: overrides?.blockedReason ?? projection.blockedReason ?? null,
    resumableActions: projection.resumableActions || [],
    continuationRef,
    budget: projection.budget,
    budgetRuntime: overrides?.budgetRuntime || null,
    restoreDiagnostics: overrides?.restoreDiagnostics || null,
  })!
}
