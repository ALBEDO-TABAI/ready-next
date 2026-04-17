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
  ScopeRunTaskStep,
  ScopeRunTaskStepStatus,
  ScopeRunWaitingFor,
  ToolTraceEvent
} from './types'

function generateArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function generateMemoryRefId(): string {
  return `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function parseStructuredToolPayload(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
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

function createMemoryRef(input: Record<string, unknown>): AgentMemoryRef | null {
  const title = String(input.title || input.path || input.id || '').trim()
  const layer = String(input.layer || '').trim()
  const sourceType = String(input.sourceType || '').trim()
  if (!title || !['l0', 'l1', 'l2', 'recall'].includes(layer)) return null
  if (
    !['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule', 'session_recall'].includes(
      sourceType
    )
  )
    return null
  return {
    id: String(input.id || generateMemoryRefId()),
    layer: layer as AgentMemoryRef['layer'],
    sourceType: sourceType as AgentMemoryRef['sourceType'],
    title,
    summary: typeof input.summary === 'string' ? input.summary : null,
    path: typeof input.path === 'string' ? input.path : null,
    triggerId: typeof input.triggerId === 'string' ? input.triggerId : null,
    sensitive: Boolean(input.sensitive),
    loadedAt: typeof input.loadedAt === 'string' ? input.loadedAt : new Date().toISOString()
  }
}

function createTriggerHit(input: Record<string, unknown>): AgentTriggerHit | null {
  const id = String(input.id || '').trim()
  const label = String(input.label || '').trim()
  if (!id || !label) return null
  return {
    id,
    label,
    module: toAgentModule(input.module),
    blocking: input.blocking !== false,
    refs: Array.isArray(input.refs)
      ? input.refs.map((item) => String(item || '').trim()).filter(Boolean)
      : []
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

function parseContextBudget(input: unknown): AgentContextBudget | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  return {
    totalChars: Number(record.totalChars || 0),
    l0Chars: Number(record.l0Chars || 0),
    l1Chars: Number(record.l1Chars || 0),
    l2Chars: Number(record.l2Chars || 0),
    droppedRefs: Array.isArray(record.droppedRefs)
      ? record.droppedRefs.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  }
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

  if (!compression && !budget && !fallback && !pipeline) return null
  return { compression, budget, fallback, pipeline }
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

const BROWSER_STEP_TITLES: Record<string, string> = {
  resolve_target_page: '确认目标页',
  resolve_attachment: '确认附件',
  navigate_target: '进入目标页',
  ensure_upload: '上传附件',
  ensure_prompt: '填写提示词',
  submit: '提交执行',
  final_reconcile: '结果复核',
  recover: '恢复页面'
}

const BROWSER_STEP_IDS_BY_TITLE = Object.fromEntries(
  Object.entries(BROWSER_STEP_TITLES).map(([id, title]) => [title, id])
) as Record<string, string>

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
  const executionId = String(record.executionId || '').trim()
  if (!executionId) return null
  return {
    executionId,
    stepId: typeof record.stepId === 'string' ? record.stepId : null,
    blockerType: typeof record.blockerType === 'string' ? record.blockerType : null
  }
}

function parseBrowserWorkflowTask(
  text: string,
  previous: ScopeRunState | null,
  timestamp: string
): Partial<ScopeRunState> | null {
  const planTargetMatch = text.match(/\[计划\]\s*目标：([^\n]+)/)
  const planOrderMatch = text.match(/\[计划\]\s*顺序：([^\n]+)/)
  if (planTargetMatch && planOrderMatch) {
    const stepIds = planOrderMatch[1]
      .split('->')
      .map((item) => item.trim())
      .filter(Boolean)
    return {
      taskTitle: planTargetMatch[1].trim(),
      taskSummary: '准备开始浏览器任务',
      steps: stepIds.map((id) => ({
        id,
        title: BROWSER_STEP_TITLES[id] || id,
        status: 'pending' as const,
        updatedAt: timestamp
      })),
      currentStepId: null,
      waitingFor: 'none',
      resumableActions: ['cancel']
    }
  }

  const stageMatch = text.match(/\[阶段\]\s*步骤\s*(\d+)\/(\d+)\s*([^：:]+)[：:]\s*(.+)$/)
  if (!stageMatch) return null
  const currentIndex = Math.max(0, Number(stageMatch[1]) - 1)
  const title = stageMatch[3].trim()
  const detail = stageMatch[4].trim()
  const previousSteps = previous?.steps || []
  const nextSteps =
    previousSteps.length > 0
      ? previousSteps.map((step, index) => ({
          ...step,
          status: (index < currentIndex
            ? 'done'
            : index === currentIndex
              ? 'running'
              : 'pending') as ScopeRunTaskStepStatus,
          detail: index === currentIndex ? detail : step.detail || null,
          updatedAt: index <= currentIndex ? timestamp : step.updatedAt
        }))
      : Array.from({ length: Number(stageMatch[2]) || currentIndex + 1 }).map((_, index) => {
          const id =
            index === currentIndex
              ? BROWSER_STEP_IDS_BY_TITLE[title] || `step_${index + 1}`
              : `step_${index + 1}`
          return {
            id,
            title: index === currentIndex ? title : `步骤 ${index + 1}`,
            status: index < currentIndex ? 'done' : index === currentIndex ? 'running' : 'pending',
            detail: index === currentIndex ? detail : null,
            updatedAt: timestamp
          } satisfies ScopeRunTaskStep
        })

  return {
    taskTitle: previous?.taskTitle || '浏览器任务',
    taskSummary: `${title}：${detail}`,
    steps: nextSteps,
    currentStepId: nextSteps[currentIndex]?.id || null,
    waitingFor: 'none',
    resumableActions: ['cancel']
  }
}

function toSkillWaitingFor(blockerType: string | null): ScopeRunWaitingFor {
  if (blockerType === 'need_input') return 'input'
  if (blockerType === 'need_confirmation') return 'confirmation'
  if (blockerType === 'need_agent_result') return 'agent_result'
  return blockerType ? 'background' : 'none'
}

function createArtifactFromPath(
  pathOrLabel: string,
  fallbackRunId: string | null,
  timestamp: string
): AgentArtifact {
  return {
    id: generateArtifactId(),
    module: 'system',
    kind: 'artifact',
    label: pathOrLabel,
    path: pathOrLabel.startsWith('/') ? pathOrLabel : null,
    url: null,
    mimeType: null,
    sourceRunId: fallbackRunId,
    createdAt: timestamp
  }
}

interface SkillExecutionTaskInput {
  executionId: string
  skillId: string
  status: string
  currentStepId?: string | null
  blockerType?: string | null
  blockerMessage?: string | null
  steps: ScopeRunTaskStep[]
  artifacts: AgentArtifact[]
}

function buildTaskPatchFromSkillExecutionTask(
  input: SkillExecutionTaskInput
): Partial<ScopeRunState> {
  const waitingFor = toSkillWaitingFor(input.blockerType || null)
  const resumableActions: ScopeRunResumableAction[] = []
  if (waitingFor !== 'none') resumableActions.push('continue')
  if (input.artifacts.length > 0) resumableActions.push('open_artifact')
  if (input.status === 'failed' || input.status === 'cancelled') resumableActions.push('retry')
  resumableActions.push('cancel')

  return {
    taskTitle: `技能执行 · ${input.skillId}`,
    taskSummary: input.blockerMessage || `当前步骤：${input.currentStepId || '进行中'}`,
    steps: input.steps,
    currentStepId: input.currentStepId || null,
    waitingFor,
    resumableActions,
    taskContinuation: {
      executionId: input.executionId,
      stepId: input.currentStepId || null,
      blockerType: input.blockerType || null
    },
    recentArtifacts: buildRecentArtifacts(input.artifacts)
  }
}

export function createTaskPatchFromSkillExecutionDetail(
  detail: {
    id: string
    skillId: string
    status: string
    currentStepId?: string | null
    blocker?: { type: string; message: string } | null
    steps?: Array<{ stepId: string; status: string }>
    artifacts?: Array<{ id?: string; label?: string; path?: string | null }>
  },
  timestamp = new Date().toISOString()
): Partial<ScopeRunState> {
  return buildTaskPatchFromSkillExecutionTask({
    executionId: detail.id,
    skillId: detail.skillId,
    status: detail.status,
    currentStepId: detail.currentStepId || null,
    blockerType: detail.blocker?.type || null,
    blockerMessage: detail.blocker?.message || null,
    steps: (detail.steps || []).map((step) => ({
      id: step.stepId,
      title: step.stepId,
      status: toTaskStepStatus(step.status),
      updatedAt: timestamp
    })),
    artifacts: (detail.artifacts || []).map((artifact) => ({
      id: String(artifact.id || generateArtifactId()),
      module: 'system',
      kind: 'artifact',
      label: String(artifact.label || artifact.path || artifact.id || 'artifact'),
      path: typeof artifact.path === 'string' ? artifact.path : null,
      url: null,
      mimeType: null,
      sourceRunId: detail.id,
      createdAt: timestamp
    }))
  })
}

function parseSkillExecutionTaskFromText(
  text: string,
  previous: ScopeRunState | null,
  timestamp: string
): Partial<ScopeRunState> | null {
  if (!/Execution ID:\s*/.test(text) || !/Skill:\s*/.test(text)) return null
  const executionId = text.match(/^Execution ID:\s*(.+)$/m)?.[1]?.trim() || ''
  const skillId = text.match(/^Skill:\s*(.+)$/m)?.[1]?.trim() || ''
  if (!executionId || !skillId) return null
  const status = text.match(/^Status:\s*(.+)$/m)?.[1]?.trim() || 'running'
  const currentStepId =
    text.match(/^Current step:\s*(.+)$/m)?.[1]?.trim() || previous?.currentStepId || null
  const blockerMatch = text.match(/^Blocker:\s*([^-\n]+)-\s*(.+)$/m)
  const blockerType = blockerMatch?.[1]?.trim() || null
  const blockerMessage = blockerMatch?.[2]?.trim() || null
  const recentSteps = text.match(/^Recent steps:\s*(.+)$/m)?.[1]?.trim() || ''
  const steps = recentSteps
    ? recentSteps
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const match = part.match(/^(.+)\((.+)\)$/)
          const id = (match?.[1] || part).trim()
          return {
            id,
            title: id,
            status: toTaskStepStatus((match?.[2] || 'pending').trim()),
            updatedAt: timestamp
          } satisfies ScopeRunTaskStep
        })
    : previous?.steps || []
  const recentArtifactsLine = text.match(/^Recent artifacts:\s*(.+)$/m)?.[1]?.trim() || ''
  const artifacts = recentArtifactsLine
    ? recentArtifactsLine
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => createArtifactFromPath(item, previous?.requestId || null, timestamp))
    : previous?.recentArtifacts || []

  return buildTaskPatchFromSkillExecutionTask({
    executionId,
    skillId,
    status,
    currentStepId,
    blockerType,
    blockerMessage,
    steps,
    artifacts
  })
}

function finalizeTaskState(
  phase: ScopeRunState['phase'],
  previous: ScopeRunState | null,
  patch: Partial<ScopeRunState>,
  timestamp: string
): void {
  const steps = patch.steps || previous?.steps || []
  if (steps.length === 0) return
  if (phase === 'done') {
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
    phase: ScopeRunState['phase']
    module?: AgentModuleKind | string | null
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
    blockedReason?: string | null
    timestamp: string
  },
  previous: ScopeRunState | null
): Partial<ScopeRunState> {
  const structuredPayload =
    event.toolEvent?.kind === 'result' && event.toolEvent.text
      ? parseStructuredToolPayload(event.toolEvent.text)
      : event.latestText
        ? parseStructuredToolPayload(event.latestText)
        : null
  const structuredModule = toAgentModule(structuredPayload?.module)
  const artifactInputs = Array.isArray(event.recentArtifacts)
    ? event.recentArtifacts
    : []
  const structuredArtifacts = artifactInputs
    .map((item) =>
      createAgentArtifact(
        item,
        structuredModule || previous?.module || 'system',
        previous?.requestId || null
      )
    )
    .filter(Boolean) as AgentArtifact[]
  const memoryInputs = Array.isArray(structuredPayload?.memoryRefs)
    ? (structuredPayload.memoryRefs as Array<Record<string, unknown>>)
    : []
  const structuredMemoryRefs = memoryInputs.map(createMemoryRef).filter(Boolean) as AgentMemoryRef[]
  const triggerInputs = Array.isArray(structuredPayload?.triggerHits)
    ? (structuredPayload.triggerHits as Array<Record<string, unknown>>)
    : []
  const structuredTriggerHits = triggerInputs
    .map(createTriggerHit)
    .filter(Boolean) as AgentTriggerHit[]
  const structuredBudget = parseContextBudget(structuredPayload?.contextBudget)
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
  const structuredRecentArtifacts = structuredArtifacts
  const structuredContinuation = parseTaskContinuation(event.taskContinuation)
  const structuredMemoryCapture = parseMemoryCapture(event.memoryCapture)
  const structuredExecutionDiagnostics = parseExecutionDiagnostics(event.executionDiagnostics)
  const patch: Partial<ScopeRunState> = {
    phase: event.phase,
    latestText: event.latestText ?? previous?.latestText ?? null,
    module: toAgentModule(event.module) || structuredModule || previous?.module || null,
    intent:
      typeof structuredPayload?.intent === 'string'
        ? structuredPayload.intent
        : previous?.intent || null,
    executionKind:
      toModuleExecutionKind(structuredPayload?.executionKind) || previous?.executionKind || null,
    jobId:
      typeof structuredPayload?.jobId === 'string'
        ? structuredPayload.jobId
        : previous?.jobId || null,
    artifactRefs: mergeArtifacts(previous?.artifactRefs, structuredArtifacts),
    memoryRefs: mergeMemoryRefs(
      previous?.memoryRefs,
      structuredMemoryRefs.length > 0 ? structuredMemoryRefs : event.memoryRefs
    ),
    triggerHits: mergeTriggerHits(
      previous?.triggerHits,
      structuredTriggerHits.length > 0 ? structuredTriggerHits : event.triggerHits
    ),
    contextBudget: structuredBudget || event.contextBudget || previous?.contextBudget || null,
    ownerResourceId:
      typeof structuredPayload?.ownerResourceId === 'string'
        ? structuredPayload.ownerResourceId
        : previous?.ownerResourceId || null,
    lastEvidenceAt:
      structuredArtifacts.length > 0 || structuredPayload
        ? event.timestamp
        : previous?.lastEvidenceAt || null,
    blockedReason:
      event.blockedReason ?? previous?.blockedReason ?? null,
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
    designPhase:
      typeof structuredPayload?.designPhase === 'string'
        ? (structuredPayload.designPhase as ScopeRunState['designPhase'])
        : previous?.designPhase || null,
    designTodo: Array.isArray(structuredPayload?.designTodo)
      ? (structuredPayload.designTodo as ScopeRunState['designTodo'])
      : previous?.designTodo || [],
    designReviewSummary:
      typeof structuredPayload?.designReviewSummary === 'string'
        ? structuredPayload.designReviewSummary
        : previous?.designReviewSummary || null,
    ownedNodeIds: Array.isArray(structuredPayload?.ownedNodeIds)
      ? structuredPayload.ownedNodeIds.map((item) => String(item || '').trim()).filter(Boolean)
      : previous?.ownedNodeIds || [],
    repairScope:
      typeof structuredPayload?.repairScope === 'string'
        ? (structuredPayload.repairScope as ScopeRunState['repairScope'])
        : previous?.repairScope || null,
    scenePlanId:
      typeof structuredPayload?.scenePlanId === 'string'
        ? structuredPayload.scenePlanId
        : previous?.scenePlanId || null,
    boardId:
      typeof structuredPayload?.boardId === 'string'
        ? structuredPayload.boardId
        : previous?.boardId || null,
    styleSystem:
      structuredPayload?.styleSystem && typeof structuredPayload.styleSystem === 'object'
        ? (structuredPayload.styleSystem as ScopeRunState['styleSystem'])
        : previous?.styleSystem || null,
    reviewFailures: Array.isArray(structuredPayload?.reviewFailures)
      ? structuredPayload.reviewFailures.map((item) => String(item || '').trim()).filter(Boolean)
      : previous?.reviewFailures || [],
    lastAcceptedScreenshot:
      typeof structuredPayload?.lastAcceptedScreenshot === 'string'
        ? structuredPayload.lastAcceptedScreenshot
        : previous?.lastAcceptedScreenshot || null,
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
      mergeArtifacts(
        previous?.recentArtifacts,
        structuredRecentArtifacts.length > 0 ? structuredRecentArtifacts : structuredArtifacts
      )
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

  if (
    structuredPayload?.phase === 'human_required' ||
    structuredPayload?.takeover_state === 'submitted'
  ) {
    patch.phase = 'takeover'
    patch.blockedReason =
      [
        typeof structuredPayload.call_to_action === 'string'
          ? structuredPayload.call_to_action
          : '',
        typeof structuredPayload.details === 'string' ? structuredPayload.details : ''
      ]
        .filter(Boolean)
        .join(' · ') || '需要人工接管'
    if (Number.isFinite(Number(structuredPayload.timeout_sec || 0))) {
      patch.checkpointExpiresAt = Date.now() + Number(structuredPayload.timeout_sec || 0) * 1000
    }
  } else if (previous?.phase === 'takeover' && event.phase === 'tool_running') {
    patch.phase = 'resuming'
    patch.blockedReason = null
    patch.checkpointExpiresAt = null
  } else if (event.phase === 'done' || event.phase === 'error' || event.phase === 'cancelled') {
    patch.blockedReason = null
    patch.checkpointExpiresAt = null
  }

  if (event.phase === 'error' && event.error) {
    patch.blockedReason = event.error
  }

  if (typeof structuredPayload?.controllerId === 'string') {
    patch.controllerId = structuredPayload.controllerId
  }
  if (typeof structuredPayload?.ownerTabId === 'string') {
    patch.ownerTabId = structuredPayload.ownerTabId
  }

  finalizeTaskState(patch.phase || event.phase, previous, patch, event.timestamp)

  return patch
}
