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
  // B Phase 4: todo-anchored resumption. PR3 wires resumeRun /
  // respondToInteraction handlers to look up the todo via
  // `getSkillTaskTracker().findTodo(todoId)` when executionId is empty.
  todoId?: string
  todoTitle?: string
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
  if (!executionId) return null
  return {
    taskId: String(record.taskId || taskId || '').trim() || taskId,
    executionId,
    stepId: String(record.stepId || currentStepId || '').trim() || currentStepId || null,
    blockerType: typeof record.blockerType === 'string' ? record.blockerType : null,
    targetUrl: typeof record.targetUrl === 'string' ? record.targetUrl : null,
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
  return {
    taskId,
    executionId: normalizeOptionalContinuationText(value.executionId),
    stepId: normalizeOptionalContinuationText(value.stepId),
    blockedReason: normalizeOptionalContinuationText(value.blockedReason),
    responseText: normalizeOptionalContinuationText(value.responseText),
    // B Phase 4 PR3: tracker-anchored fields. `todoId` is the id assigned by
    // `SkillTaskTracker.startTodo()` (pattern `st-<8hex>`); `todoTitle` is
    // the human-readable line the renderer task card rendered. Both travel
    // through continuation state so `direct-chat.ts` can synthesize a
    // "请继续执行 todo「…」" / "请重新执行 todo「…」" user message
    // when no `executionId` is present.
    todoId: normalizeOptionalContinuationText(value.todoId),
    todoTitle: normalizeOptionalContinuationText(value.todoTitle),
  }
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
  const continuationRef = (baseState.continuationRef || normalizedIntent.executionId)
    ? normalizeContinuationRef({
      ...(baseState.continuationRef || {}),
      taskId: baseState.taskId,
      executionId: normalizedIntent.executionId || baseState.continuationRef?.executionId,
      stepId: normalizedIntent.stepId || baseState.continuationRef?.stepId || currentStepId,
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
    shouldResolveContinuation: Boolean(explicitTaskId) || /(继续|接着|恢复|上次|重试)/.test(sanitizedUserText),
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
    return sortedProjections.find((item) => item.taskId === explicitTaskId) || null
  }
  if (params.allowImplicitContinuation === false || !parsed.shouldResolveContinuation) {
    return null
  }
  return sortedProjections.find((item) => isContinuationProjectionCandidate(item)) || sortedProjections[0] || null
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
    executionId: overrides?.executionId || projection.continuationRef?.executionId || projection.runId,
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
