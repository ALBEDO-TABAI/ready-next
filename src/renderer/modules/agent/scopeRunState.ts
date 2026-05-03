import type {
  AgentArtifact,
  AgentContextBudget,
  AgentMemoryRef,
  AgentModuleKind,
  AgentTriggerHit,
  ModuleExecutionKind,
  ScopeRunMemoryCapture,
  ScopeRunExecutionDiagnostics,
  ScopeRunResumableAction,
  ScopeRunState,
  ScopeRunTaskContinuation,
  ScopeRunTerminalReason,
  ScopeRunTaskStep,
  ScopeRunTaskStepStatus,
  ScopeRunWaitingFor,
  ToolTraceEvent
} from './types'

function generateArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function readHumanTakeoverSignal(text: string): Record<string, unknown> | null {
  // Narrow fallback: only used for `browser_ask_user_takeover` tool output.
  // Main process does not yet surface human_required / takeover_state through
  // ScopeRunEventPayload; once it does, this parser can be deleted entirely.
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (record.phase === 'human_required' || record.takeover_state === 'submitted') {
      return record
    }
  } catch {
    // ignore parse errors
  }
  return null
}

export function isActiveScopePhase(phase: ScopeRunState['phase'] | undefined): boolean {
  return (
    phase === 'queued' ||
    phase === 'planning' ||
    phase === 'tool_running' ||
    phase === 'checkpoint' ||
    phase === 'takeover' ||
    phase === 'resuming' ||
    phase === 'responding'
  )
}

export function isScopeRunPhase(value: unknown): value is ScopeRunState['phase'] {
  return (
    value === 'idle' ||
    value === 'queued' ||
    value === 'planning' ||
    value === 'tool_running' ||
    value === 'checkpoint' ||
    value === 'takeover' ||
    value === 'resuming' ||
    value === 'responding' ||
    value === 'done' ||
    value === 'error' ||
    value === 'cancelled'
  )
}

export function isStreamingScopeRunState(run: ScopeRunState | null | undefined): boolean {
  if (!run) return false
  if (run.terminalReason) return false
  if (
    run.module === 'skill' &&
    run.executionKind === 'job' &&
    typeof run.taskId === 'string' &&
    run.taskId.startsWith('detached:')
  ) {
    return false
  }
  return isActiveScopePhase(run.phase)
}

function normalizeTerminalReason(value: unknown): ScopeRunTerminalReason | null {
  const normalized = String(value || '').trim()
  if (
    normalized === 'done' ||
    normalized === 'checkpoint_budget' ||
    normalized === 'checkpoint_background' ||
    normalized === 'checkpoint_user_input' ||
    normalized === 'blocked_config' ||
    normalized === 'blocked_external' ||
    normalized === 'blocked_tool_error' ||
    normalized === 'failed_skill' ||
    normalized === 'resume_launch_failed' ||
    normalized === 'persistence_failed' ||
    normalized === 'cancelled_user' ||
    normalized === 'cancelled_runtime' ||
    normalized === 'infra_error'
  ) {
    return normalized
  }
  return null
}

export function phaseToToolTraceStatus(
  phase: ScopeRunState['phase'] | undefined
): 'idle' | 'running' | 'done' | 'error' | 'cancelled' {
  if (!phase || phase === 'idle') return 'idle'
  if (phase === 'error') return 'error'
  if (phase === 'cancelled') return 'cancelled'
  if (phase === 'done') return 'done'
  return 'running'
}

export function getActiveScopeRunState(
  scopeRunStates: Record<string, ScopeRunState>,
  scopeId: string | null
): ScopeRunState | null {
  if (!scopeId) return null
  return scopeRunStates[scopeId] || null
}

export function toAgentModule(value: unknown): AgentModuleKind | null {
  const normalized = String(value || '').trim()
  if (
    normalized === 'browser' ||
    normalized === 'document' ||
    normalized === 'design' ||
    normalized === 'skill' ||
    normalized === 'video' ||
    normalized === 'rss' ||
    normalized === 'calendar' ||
    normalized === 'feishu' ||
    normalized === 'system'
  ) {
    return normalized
  }
  return null
}

export function toModuleExecutionKind(value: unknown): ModuleExecutionKind | null {
  const normalized = String(value || '').trim()
  if (
    normalized === 'deterministic' ||
    normalized === 'interactive' ||
    normalized === 'job' ||
    normalized === 'pipeline'
  ) {
    return normalized
  }
  return null
}

export function createAgentArtifact(
  input: Record<string, unknown>,
  fallbackModule: AgentModuleKind,
  fallbackRunId: string | null
): AgentArtifact | null {
  const label = String(input.label || input.path || input.url || '').trim()
  if (!label) return null
  return {
    id: String(input.id || generateArtifactId()),
    module: toAgentModule(input.module) || fallbackModule,
    kind: String(input.kind || 'artifact').trim() || 'artifact',
    label,
    path: typeof input.path === 'string' ? input.path : null,
    url: typeof input.url === 'string' ? input.url : null,
    mimeType: typeof input.mimeType === 'string' ? input.mimeType : null,
    sourceRunId: typeof input.sourceRunId === 'string' ? input.sourceRunId : fallbackRunId,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    meta:
      input.meta && typeof input.meta === 'object'
        ? (input.meta as Record<string, unknown>)
        : undefined
  }
}

function mergeMemoryRefs(
  previous: AgentMemoryRef[] | undefined,
  nextRefs: AgentMemoryRef[] | undefined
): AgentMemoryRef[] {
  const merged = [...(previous || [])]
  for (const ref of nextRefs || []) {
    const duplicate = merged.find(
      (item) =>
        item.id === ref.id ||
        (item.path &&
          ref.path &&
          item.path === ref.path &&
          item.layer === ref.layer &&
          item.sourceType === ref.sourceType)
    )
    if (!duplicate) merged.push(ref)
  }
  return merged
}

function mergeTriggerHits(
  previous: AgentTriggerHit[] | undefined,
  nextHits: AgentTriggerHit[] | undefined
): AgentTriggerHit[] {
  const merged = [...(previous || [])]
  for (const hit of nextHits || []) {
    const duplicate = merged.find((item) => item.id === hit.id)
    if (!duplicate) merged.push(hit)
  }
  return merged
}

function parseExecutionDiagnostics(input: unknown): ScopeRunExecutionDiagnostics | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const compression =
    record.compression && typeof record.compression === 'object'
      ? {
          historyCompressed: Boolean(
            (record.compression as Record<string, unknown>).historyCompressed
          ),
          toolTraceCompressed: Boolean(
            (record.compression as Record<string, unknown>).toolTraceCompressed
          ),
          artifactSummaryUsed: Boolean(
            (record.compression as Record<string, unknown>).artifactSummaryUsed
          )
        }
      : null
  const budget =
    record.budget && typeof record.budget === 'object'
      ? {
          maxIterations:
            Number((record.budget as Record<string, unknown>).maxIterations || 0) || undefined,
          maxToolCalls:
            Number((record.budget as Record<string, unknown>).maxToolCalls || 0) || undefined,
          maxParallelToolGroups:
            Number((record.budget as Record<string, unknown>).maxParallelToolGroups || 0) ||
            undefined,
          iterationsUsed:
            Number((record.budget as Record<string, unknown>).iterationsUsed || 0) || undefined,
          toolCallsUsed:
            Number((record.budget as Record<string, unknown>).toolCallsUsed || 0) || undefined,
          parallelToolGroupsUsed:
            Number((record.budget as Record<string, unknown>).parallelToolGroupsUsed || 0) ||
            undefined
        }
      : null
  const fallback =
    record.fallback && typeof record.fallback === 'object'
      ? {
          happened:
            (record.fallback as Record<string, unknown>).happened === undefined
              ? String((record.fallback as Record<string, unknown>).kind || '').trim().length > 0
              : Boolean((record.fallback as Record<string, unknown>).happened),
          kind: String((record.fallback as Record<string, unknown>).kind || '').trim(),
          attempts: Number((record.fallback as Record<string, unknown>).attempts || 0)
        }
      : null
  const budgetLease =
    record.budgetLease && typeof record.budgetLease === 'object'
      ? {
          leaseId: String((record.budgetLease as Record<string, unknown>).leaseId || '').trim(),
          decision: String((record.budgetLease as Record<string, unknown>).decision || '').trim() as NonNullable<ScopeRunExecutionDiagnostics['budgetLease']>['decision'],
          reason:
            typeof (record.budgetLease as Record<string, unknown>).reason === 'string'
              ? String((record.budgetLease as Record<string, unknown>).reason)
              : null,
          renewalsUsed: Number((record.budgetLease as Record<string, unknown>).renewalsUsed || 0),
          progressScore: Number((record.budgetLease as Record<string, unknown>).progressScore || 0),
          wasteScore: Number((record.budgetLease as Record<string, unknown>).wasteScore || 0),
          lastFingerprint:
            typeof (record.budgetLease as Record<string, unknown>).lastFingerprint === 'string'
              ? String((record.budgetLease as Record<string, unknown>).lastFingerprint)
              : null,
          currentLeaseEndIteration: Number((record.budgetLease as Record<string, unknown>).currentLeaseEndIteration || 0),
        }
      : null
  const pipeline =
    record.pipeline && typeof record.pipeline === 'object'
      ? {
          document:
            (record.pipeline as Record<string, unknown>).document &&
            typeof (record.pipeline as Record<string, unknown>).document === 'object'
              ? {
                  phase: String((((record.pipeline as Record<string, unknown>).document as Record<string, unknown>).phase || '')).trim() || undefined,
                  chunkCount:
                    Number((((record.pipeline as Record<string, unknown>).document as Record<string, unknown>).chunkCount || 0)) || undefined,
                  selectedChunkCount:
                    Number((((record.pipeline as Record<string, unknown>).document as Record<string, unknown>).selectedChunkCount || 0)) || undefined,
                  promptChars:
                    Number((((record.pipeline as Record<string, unknown>).document as Record<string, unknown>).promptChars || 0)) || undefined,
                  cacheHit:
                    (((record.pipeline as Record<string, unknown>).document as Record<string, unknown>).cacheHit === undefined)
                      ? undefined
                      : Boolean((((record.pipeline as Record<string, unknown>).document as Record<string, unknown>).cacheHit)),
                  usedSectionAnchors:
                    (((record.pipeline as Record<string, unknown>).document as Record<string, unknown>).usedSectionAnchors === undefined)
                      ? undefined
                      : Boolean((((record.pipeline as Record<string, unknown>).document as Record<string, unknown>).usedSectionAnchors)),
                }
              : null,
        }
      : null

  if (!compression && !budget && !fallback && !pipeline && !budgetLease) return null
  return { compression, budget, fallback, pipeline, budgetLease }
}

export function mergeArtifacts(
  previous: AgentArtifact[] | undefined,
  nextArtifacts: AgentArtifact[] | undefined
): AgentArtifact[] {
  const merged = [...(previous || [])]
  for (const artifact of nextArtifacts || []) {
    if (!artifact.path && !artifact.url) {
      if (!merged.some((item) => item.id === artifact.id)) {
        merged.push(artifact)
      }
      continue
    }
    const duplicate = merged.find(
      (item) =>
        (artifact.path && item.path === artifact.path) ||
        (artifact.url && item.url === artifact.url) ||
        item.id === artifact.id
    )
    if (!duplicate) {
      merged.push(artifact)
    }
  }
  return merged
}

function toTaskStepStatus(value: string): ScopeRunTaskStepStatus {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (normalized === 'done' || normalized === 'completed' || normalized === 'success') return 'done'
  if (normalized === 'running' || normalized === 'in_progress' || normalized === 'active')
    return 'running'
  if (normalized === 'blocked' || normalized === 'waiting' || normalized === 'paused')
    return 'blocked'
  if (normalized === 'error' || normalized === 'failed' || normalized === 'cancelled')
    return 'error'
  return 'pending'
}

function normalizeWaitingFor(value: unknown): ScopeRunWaitingFor {
  const normalized = String(value || '').trim()
  if (
    normalized === 'input' ||
    normalized === 'confirmation' ||
    normalized === 'agent_result' ||
    normalized === 'clarification' ||
    normalized === 'background'
  ) {
    return normalized
  }
  return 'none'
}

function normalizeResumableActions(value: unknown): ScopeRunResumableAction[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').trim())
    .filter(
      (item): item is ScopeRunResumableAction =>
        item === 'continue' ||
        item === 'retry' ||
        item === 'open_artifact' ||
        item === 'cancel' ||
        item === 'none'
    )
}

function normalizeTaskSteps(input: unknown, timestamp: string): ScopeRunTaskStep[] {
  if (!Array.isArray(input)) return []
  return input
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const id = String(record.id || '').trim()
      const title = String(record.title || id || '').trim()
      if (!id || !title) return null
      return {
        id,
        title,
        status: toTaskStepStatus(String(record.status || 'pending')),
        detail: typeof record.detail === 'string' ? record.detail : null,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : timestamp
      } satisfies ScopeRunTaskStep
    })
    .filter(Boolean) as ScopeRunTaskStep[]
}

function mergeTaskSteps(
  previous: ScopeRunTaskStep[] | undefined,
  nextSteps: ScopeRunTaskStep[] | undefined
): ScopeRunTaskStep[] {
  if (!nextSteps || nextSteps.length === 0) return previous || []
  const merged = [...(previous || [])]
  for (const step of nextSteps) {
    const existingIndex = merged.findIndex((item) => item.id === step.id)
    if (existingIndex >= 0) {
      merged[existingIndex] = {
        ...merged[existingIndex],
        ...step
      }
    } else {
      merged.push(step)
    }
  }
  return merged
}

function buildRecentArtifacts(artifacts: AgentArtifact[] | undefined): AgentArtifact[] {
  return (artifacts || []).slice(-4)
}

function parseMemoryCapture(input: unknown): ScopeRunMemoryCapture | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const items = Array.isArray(record.items)
    ? (record.items
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const value = item as Record<string, unknown>
          const memoryId = String(value.memoryId || '').trim()
          const category = String(value.category || '').trim()
          const title = String(value.title || '').trim()
          if (!memoryId || !title || (category !== 'user_preference' && category !== 'summary'))
            return null
          return {
            memoryId,
            category,
            title,
            summary: typeof value.summary === 'string' ? value.summary : null
          }
        })
        .filter(Boolean) as ScopeRunMemoryCapture['items'])
    : []
  if (items.length === 0) return null
  return {
    status: record.status === 'dismissed' || record.status === 'reverted' ? record.status : 'ready',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    note: typeof record.note === 'string' ? record.note : null,
    items
  }
}

function parseTaskContinuation(input: unknown): ScopeRunTaskContinuation | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const continuation: ScopeRunTaskContinuation = {}
  const copyString = (key: keyof ScopeRunTaskContinuation): void => {
    if (typeof record[key] !== 'string') return
    const value = String(record[key]).trim()
    if (value) continuation[key] = value
  }
  copyString('executionId')
  copyString('taskId')
  copyString('stepId')
  copyString('blockerType')
  copyString('targetUrl')
  copyString('todoId')
  copyString('todoTitle')
  copyString('pauseReason')
  copyString('detachedTaskId')
  copyString('taskRunId')
  copyString('jobId')
  copyString('skillId')
  copyString('action')
  copyString('runStatePath')
  copyString('outputDir')
  copyString('progressFingerprint')
  return Object.keys(continuation).length > 0 ? continuation : null
}

function toSkillWaitingFor(blockerType: string | null): ScopeRunWaitingFor {
  if (blockerType === 'need_input') return 'input'
  if (blockerType === 'need_confirmation') return 'confirmation'
  if (blockerType === 'need_agent_result') return 'agent_result'
  // B Phase 1 PR2 T1-8: ephemeral ask_user questions map to the
  // clarification waiting-for so the renderer knows to mount the
  // SkillAskUserPrompt capsule instead of a generic input form.
  if (blockerType === 'primitive_ask_user') return 'clarification'
  return blockerType ? 'background' : 'none'
}

// Phase 4: createTaskPatchFromSkillExecutionDetail and its helpers were the
// renderer-side reducer for the retired skill_executions state machine. The
// new todo-based projection is built in main process
// (skills-tools.buildSkillProjectionPatch, rewritten in PR2); the renderer
// consumes the projection patch directly.

function finalizeTaskState(
  phase: ScopeRunState['phase'],
  previous: ScopeRunState | null,
  patch: Partial<ScopeRunState>,
  timestamp: string
): void {
  const steps = patch.steps || previous?.steps || []
  if (steps.length === 0) return
  if (phase === 'done') {
    const hasBlocker = Boolean((patch.waitingFor && patch.waitingFor !== 'none') || patch.blockedReason)
    if (hasBlocker) {
      patch.steps = steps.map((step) => ({
        ...step,
        updatedAt: step.updatedAt || timestamp
      }))
      patch.resumableActions =
        patch.resumableActions && patch.resumableActions.length > 0
          ? patch.resumableActions
          : previous?.resumableActions || []
      patch.taskSummary = patch.taskSummary || previous?.taskSummary || patch.blockedReason || '等待补充后继续'
      return
    }
    patch.steps = steps.map((step) => ({
      ...step,
      status: step.status === 'error' ? step.status : 'done',
      updatedAt: timestamp
    }))
    patch.waitingFor = 'none'
    patch.resumableActions =
      (patch.recentArtifacts || previous?.recentArtifacts || []).length > 0
        ? ['open_artifact']
        : ['none']
    patch.taskSummary = patch.taskSummary || previous?.taskSummary || '任务已完成'
  } else if (phase === 'error' || phase === 'cancelled') {
    const currentStepId = patch.currentStepId || previous?.currentStepId
    patch.steps = steps.map((step) => ({
      ...step,
      status: step.id === currentStepId ? 'error' : step.status,
      updatedAt: step.id === currentStepId ? timestamp : step.updatedAt
    }))
    patch.waitingFor = 'none'
    patch.resumableActions = ['retry', 'cancel']
    patch.taskSummary =
      patch.taskSummary ||
      previous?.taskSummary ||
      (phase === 'error' ? '任务执行失败' : '任务已取消')
  }
}

export function createEmptyScopeRunState(params: {
  scopeId: string
  agent: string
  requestId?: string | null
  phase?: ScopeRunState['phase']
  responseMessageId?: string | null
}): ScopeRunState {
  return {
    scopeId: params.scopeId,
    agent: params.agent,
    requestId: params.requestId || null,
    phase: params.phase || 'idle',
    terminalReason: null,
    toolTrace: [],
    startedAt: null,
    updatedAt: null,
    latestText: null,
    module: null,
    intent: null,
    executionKind: null,
    jobId: null,
    artifactRefs: [],
    memoryRefs: [],
    triggerHits: [],
    contextBudget: null,
    ownerResourceId: null,
    lastEvidenceAt: null,
    blockedReason: null,
    controllerId: null,
    ownerTabId: null,
    checkpointExpiresAt: null,
    responseMessageId: params.responseMessageId || null,
    responseBuffer: '',
    responseSegmentBreakPending: false,
    responseSegmentToolTraceStart: 0,
    stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
    error: null,
    softError: null,
    designPhase: null,
    designTodo: [],
    designReviewSummary: null,
    ownedNodeIds: [],
    repairScope: null,
    scenePlanId: null,
    boardId: null,
    styleSystem: null,
    reviewFailures: [],
    lastAcceptedScreenshot: null,
    taskTitle: null,
    taskSummary: null,
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: [],
    recentArtifacts: [],
    taskContinuation: null,
    memoryCapture: null,
    executionDiagnostics: null
  }
}

export function deriveScopeRunStatePatch(
  event: {
    runId?: string | null
    phase: ScopeRunState['phase']
    module?: AgentModuleKind | string | null
    intent?: string | null
    executionKind?: ModuleExecutionKind | string | null
    jobId?: string | null
    ownerResourceId?: string | null
    controllerId?: string | null
    ownerTabId?: string | null
    latestText?: string
    taskTitle?: string | null
    taskSummary?: string | null
    steps?: Array<Record<string, unknown>>
    currentStepId?: string | null
    waitingFor?: ScopeRunWaitingFor
    resumableActions?: ScopeRunResumableAction[]
    recentArtifacts?: Array<Record<string, unknown>>
    taskContinuation?: ScopeRunTaskContinuation | Record<string, unknown> | null
    memoryCapture?: ScopeRunMemoryCapture | Record<string, unknown> | null
    executionDiagnostics?: ScopeRunExecutionDiagnostics | Record<string, unknown> | null
    memoryRefs?: AgentMemoryRef[]
    triggerHits?: AgentTriggerHit[]
    contextBudget?: AgentContextBudget | null
    toolEvent?: { kind: ToolTraceEvent['kind']; text: string; timestamp: string }
    error?: string
    errorKind?: string
    recoverable?: boolean
    toolName?: string
    terminalReason?: ScopeRunTerminalReason | string | null
    blockedReason?: string | null
    timestamp: string
  },
  previous: ScopeRunState | null
): Partial<ScopeRunState> {
  const takeoverSignal =
    event.toolEvent?.kind === 'result' && event.toolEvent.text
      ? readHumanTakeoverSignal(event.toolEvent.text)
      : event.latestText
        ? readHumanTakeoverSignal(event.latestText)
        : null
  const eventModule = toAgentModule(event.module)
  const artifactInputs = Array.isArray(event.recentArtifacts)
    ? event.recentArtifacts
    : []
  const structuredArtifacts = artifactInputs
    .map((item) =>
      createAgentArtifact(
        item,
        eventModule || previous?.module || 'system',
        previous?.requestId || null
      )
    )
    .filter(Boolean) as AgentArtifact[]
  const structuredTaskTitle =
    typeof event.taskTitle === 'string'
      ? event.taskTitle
      : null
  const structuredTaskSummary =
    typeof event.taskSummary === 'string'
      ? event.taskSummary
      : null
  const structuredSteps = normalizeTaskSteps(
    event.steps,
    event.timestamp
  )
  const structuredWaitingFor = event.waitingFor ? normalizeWaitingFor(event.waitingFor) : null
  const structuredResumableActions = event.resumableActions
    ? normalizeResumableActions(event.resumableActions)
    : []
  const structuredContinuation = parseTaskContinuation(event.taskContinuation)
  const structuredMemoryCapture = parseMemoryCapture(event.memoryCapture)
  const structuredExecutionDiagnostics = parseExecutionDiagnostics(event.executionDiagnostics)
  const terminalReason = 'terminalReason' in event
    ? normalizeTerminalReason(event.terminalReason)
    : null
  const eventRunId = typeof event.runId === 'string' && event.runId.trim()
    ? event.runId.trim()
    : null
  const isNewRun = Boolean(previous?.requestId && eventRunId && previous.requestId !== eventRunId)
  const patch: Partial<ScopeRunState> = {
    phase: event.phase,
    terminalReason: terminalReason || (isNewRun ? null : previous?.terminalReason || null),
    latestText: event.latestText ?? previous?.latestText ?? null,
    module: eventModule || previous?.module || null,
    intent: typeof event.intent === 'string' ? event.intent : previous?.intent || null,
    executionKind: toModuleExecutionKind(event.executionKind) || previous?.executionKind || null,
    jobId: typeof event.jobId === 'string' ? event.jobId : previous?.jobId || null,
    artifactRefs: mergeArtifacts(previous?.artifactRefs, structuredArtifacts),
    memoryRefs: mergeMemoryRefs(previous?.memoryRefs, event.memoryRefs),
    triggerHits: mergeTriggerHits(previous?.triggerHits, event.triggerHits),
    contextBudget: event.contextBudget || previous?.contextBudget || null,
    ownerResourceId:
      typeof event.ownerResourceId === 'string'
        ? event.ownerResourceId
        : previous?.ownerResourceId || null,
    lastEvidenceAt:
      structuredArtifacts.length > 0
        ? event.timestamp
        : previous?.lastEvidenceAt || null,
    blockedReason:
      'blockedReason' in event
        ? event.blockedReason ?? null
        : previous?.blockedReason ?? null,
    controllerId: previous?.controllerId ?? null,
    ownerTabId: previous?.ownerTabId ?? null,
    checkpointExpiresAt: previous?.checkpointExpiresAt ?? null,
    responseMessageId: previous?.responseMessageId || null,
    responseBuffer: previous?.responseBuffer || '',
    stepMetrics: previous?.stepMetrics || {
      toolCalls: 0,
      toolResults: 0,
      lastToolAt: null
    },
    error: event.error || previous?.error || null,
    designPhase: previous?.designPhase || null,
    designTodo: previous?.designTodo || [],
    designReviewSummary: previous?.designReviewSummary || null,
    ownedNodeIds: previous?.ownedNodeIds || [],
    repairScope: previous?.repairScope || null,
    scenePlanId: previous?.scenePlanId || null,
    boardId: previous?.boardId || null,
    styleSystem: previous?.styleSystem || null,
    reviewFailures: previous?.reviewFailures || [],
    lastAcceptedScreenshot: previous?.lastAcceptedScreenshot || null,
    taskTitle:
      structuredTaskTitle ?? null,
    taskSummary:
      structuredTaskSummary ?? null,
    steps: mergeTaskSteps(
      previous?.steps,
      structuredSteps.length > 0
        ? structuredSteps
        : undefined
    ),
    currentStepId:
      (typeof event.currentStepId === 'string'
        ? event.currentStepId
        : null) ||
      previous?.currentStepId ||
      null,
    waitingFor: structuredWaitingFor || previous?.waitingFor || 'none',
    resumableActions:
      structuredResumableActions.length > 0
        ? structuredResumableActions
        : previous?.resumableActions ||
          [],
    recentArtifacts: buildRecentArtifacts(
      mergeArtifacts(previous?.recentArtifacts, structuredArtifacts)
    ),
    taskContinuation:
      structuredContinuation ||
      previous?.taskContinuation ||
      null,
    memoryCapture: structuredMemoryCapture || previous?.memoryCapture || null,
    executionDiagnostics: structuredExecutionDiagnostics || previous?.executionDiagnostics || null
  }

  if (event.toolEvent) {
    const nextMetrics = {
      toolCalls: previous?.stepMetrics?.toolCalls || 0,
      toolResults: previous?.stepMetrics?.toolResults || 0,
      lastToolAt: event.toolEvent.timestamp
    }
    if (event.toolEvent.kind === 'call') nextMetrics.toolCalls += 1
    if (event.toolEvent.kind === 'result') nextMetrics.toolResults += 1
    patch.stepMetrics = nextMetrics
  }

  if (takeoverSignal) {
    patch.phase = 'takeover'
    patch.blockedReason =
      [
        typeof takeoverSignal.call_to_action === 'string' ? takeoverSignal.call_to_action : '',
        typeof takeoverSignal.details === 'string' ? takeoverSignal.details : ''
      ]
        .filter(Boolean)
        .join(' · ') || '需要人工接管'
    if (Number.isFinite(Number(takeoverSignal.timeout_sec || 0))) {
      patch.checkpointExpiresAt = Date.now() + Number(takeoverSignal.timeout_sec || 0) * 1000
    }
  } else if (previous?.phase === 'takeover' && event.phase === 'tool_running') {
    patch.phase = 'resuming'
    patch.blockedReason = null
    patch.checkpointExpiresAt = null
  }

  if (patch.phase === 'done' && Boolean((patch.waitingFor && patch.waitingFor !== 'none') || patch.blockedReason)) {
    patch.phase = 'checkpoint'
  }

  if (patch.phase === 'done' || patch.phase === 'error' || patch.phase === 'cancelled') {
    const hasDoneBlocker = patch.phase === 'done' && Boolean(
      (patch.waitingFor && patch.waitingFor !== 'none') || patch.blockedReason
    )
    if (!hasDoneBlocker) patch.blockedReason = null
    patch.checkpointExpiresAt = null
  }
  if (patch.terminalReason) {
    patch.checkpointExpiresAt = null
  }

  if (event.phase === 'error' && event.error) {
    patch.blockedReason = event.error
  }

  // Phase 3: derive the soft-failure capsule slot from the event payload.
  // recoverable=true → surface as soft error (capsule), leave phase/error alone
  // for downstream consumers. Terminal / legacy events clear the capsule.
  if (event.phase === 'error' && event.recoverable === true && event.error) {
    patch.softError = {
      message: event.error,
      errorKind: event.errorKind || 'unknown',
      toolName: event.toolName || null,
      receivedAt: event.timestamp,
    }
  } else if (event.phase === 'error') {
    patch.softError = null
  }

  if (typeof event.controllerId === 'string') {
    patch.controllerId = event.controllerId
  }
  if (typeof event.ownerTabId === 'string') {
    patch.ownerTabId = event.ownerTabId
  }

  finalizeTaskState(patch.phase || event.phase, previous, patch, event.timestamp)

  return patch
}
