import type {
  AgentArtifact,
  AgentContextBudget,
  AgentMemoryRef,
  AgentModuleKind,
  AgentTriggerHit,
  ModuleExecutionKind,
  ScopeRunState,
  ToolTraceEvent,
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
  return phase === 'queued' || phase === 'planning' || phase === 'tool_running' || phase === 'checkpoint' || phase === 'takeover' || phase === 'resuming' || phase === 'responding'
}

export function phaseToToolTraceStatus(
  phase: ScopeRunState['phase'] | undefined,
): 'idle' | 'running' | 'done' | 'error' | 'cancelled' {
  if (!phase || phase === 'idle') return 'idle'
  if (phase === 'error') return 'error'
  if (phase === 'cancelled') return 'cancelled'
  if (phase === 'done') return 'done'
  return 'running'
}

export function getActiveScopeRunState(
  scopeRunStates: Record<string, ScopeRunState>,
  scopeId: string | null,
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
  fallbackRunId: string | null,
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
    meta: input.meta && typeof input.meta === 'object' ? input.meta as Record<string, unknown> : undefined,
  }
}

function createMemoryRef(input: Record<string, unknown>): AgentMemoryRef | null {
  const title = String(input.title || input.path || input.id || '').trim()
  const layer = String(input.layer || '').trim()
  if (!title || !['l0', 'l1', 'l2'].includes(layer)) return null
  return {
    id: String(input.id || generateMemoryRefId()),
    layer: layer as AgentMemoryRef['layer'],
    title,
    summary: typeof input.summary === 'string' ? input.summary : null,
    path: typeof input.path === 'string' ? input.path : null,
    triggerId: typeof input.triggerId === 'string' ? input.triggerId : null,
    sensitive: Boolean(input.sensitive),
    loadedAt: typeof input.loadedAt === 'string' ? input.loadedAt : new Date().toISOString(),
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
    refs: Array.isArray(input.refs) ? input.refs.map((item) => String(item || '').trim()).filter(Boolean) : [],
  }
}

function mergeMemoryRefs(previous: AgentMemoryRef[] | undefined, nextRefs: AgentMemoryRef[] | undefined): AgentMemoryRef[] {
  const merged = [...(previous || [])]
  for (const ref of nextRefs || []) {
    const duplicate = merged.find((item) => item.id === ref.id || (item.path && ref.path && item.path === ref.path && item.layer === ref.layer))
    if (!duplicate) merged.push(ref)
  }
  return merged
}

function mergeTriggerHits(previous: AgentTriggerHit[] | undefined, nextHits: AgentTriggerHit[] | undefined): AgentTriggerHit[] {
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
    droppedRefs: Array.isArray(record.droppedRefs) ? record.droppedRefs.map((item) => String(item || '').trim()).filter(Boolean) : [],
  }
}

export function mergeArtifacts(
  previous: AgentArtifact[] | undefined,
  nextArtifacts: AgentArtifact[] | undefined,
): AgentArtifact[] {
  const merged = [...(previous || [])]
  for (const artifact of nextArtifacts || []) {
    if (!artifact.path && !artifact.url) {
      if (!merged.some((item) => item.id === artifact.id)) {
        merged.push(artifact)
      }
      continue
    }
    const duplicate = merged.find((item) =>
      (artifact.path && item.path === artifact.path) ||
      (artifact.url && item.url === artifact.url) ||
      item.id === artifact.id,
    )
    if (!duplicate) {
      merged.push(artifact)
    }
  }
  return merged
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
    stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
    error: null,
  }
}

export function deriveScopeRunStatePatch(
  event: {
    phase: ScopeRunState['phase']
    latestText?: string
    memoryRefs?: AgentMemoryRef[]
    triggerHits?: AgentTriggerHit[]
    contextBudget?: AgentContextBudget | null
    toolEvent?: { kind: ToolTraceEvent['kind']; text: string; timestamp: string }
    error?: string
    timestamp: string
  },
  previous: ScopeRunState | null,
): Partial<ScopeRunState> {
  const structuredPayload = event.toolEvent?.kind === 'result' && event.toolEvent.text
    ? parseStructuredToolPayload(event.toolEvent.text)
    : event.latestText
      ? parseStructuredToolPayload(event.latestText)
      : null
  const structuredModule = toAgentModule(structuredPayload?.module)
  const artifactInputs = Array.isArray(structuredPayload?.artifactRefs)
    ? structuredPayload.artifactRefs as Array<Record<string, unknown>>
    : []
  const structuredArtifacts = artifactInputs
    .map((item) => createAgentArtifact(item, structuredModule || previous?.module || 'system', previous?.requestId || null))
    .filter(Boolean) as AgentArtifact[]
  const memoryInputs = Array.isArray(structuredPayload?.memoryRefs)
    ? structuredPayload.memoryRefs as Array<Record<string, unknown>>
    : []
  const structuredMemoryRefs = memoryInputs.map(createMemoryRef).filter(Boolean) as AgentMemoryRef[]
  const triggerInputs = Array.isArray(structuredPayload?.triggerHits)
    ? structuredPayload.triggerHits as Array<Record<string, unknown>>
    : []
  const structuredTriggerHits = triggerInputs.map(createTriggerHit).filter(Boolean) as AgentTriggerHit[]
  const structuredBudget = parseContextBudget(structuredPayload?.contextBudget)
  const patch: Partial<ScopeRunState> = {
    phase: event.phase,
    latestText: (typeof structuredPayload?.message === 'string' ? structuredPayload.message : event.latestText) ?? previous?.latestText ?? null,
    module: structuredModule || previous?.module || null,
    intent: typeof structuredPayload?.intent === 'string' ? structuredPayload.intent : previous?.intent || null,
    executionKind: toModuleExecutionKind(structuredPayload?.executionKind) || previous?.executionKind || null,
    jobId: typeof structuredPayload?.jobId === 'string' ? structuredPayload.jobId : previous?.jobId || null,
    artifactRefs: mergeArtifacts(previous?.artifactRefs, structuredArtifacts),
    memoryRefs: mergeMemoryRefs(previous?.memoryRefs, structuredMemoryRefs.length > 0 ? structuredMemoryRefs : event.memoryRefs),
    triggerHits: mergeTriggerHits(previous?.triggerHits, structuredTriggerHits.length > 0 ? structuredTriggerHits : event.triggerHits),
    contextBudget: structuredBudget || event.contextBudget || previous?.contextBudget || null,
    ownerResourceId: typeof structuredPayload?.ownerResourceId === 'string'
      ? structuredPayload.ownerResourceId
      : previous?.ownerResourceId || null,
    lastEvidenceAt: structuredArtifacts.length > 0 || structuredPayload
      ? event.timestamp
      : previous?.lastEvidenceAt || null,
    blockedReason: previous?.blockedReason ?? null,
    controllerId: previous?.controllerId ?? null,
    ownerTabId: previous?.ownerTabId ?? null,
    checkpointExpiresAt: previous?.checkpointExpiresAt ?? null,
    responseMessageId: previous?.responseMessageId || null,
    responseBuffer: previous?.responseBuffer || '',
    stepMetrics: previous?.stepMetrics || {
      toolCalls: 0,
      toolResults: 0,
      lastToolAt: null,
    },
    error: event.error || previous?.error || null,
  }

  if (event.toolEvent) {
    const nextMetrics = {
      toolCalls: previous?.stepMetrics?.toolCalls || 0,
      toolResults: previous?.stepMetrics?.toolResults || 0,
      lastToolAt: event.toolEvent.timestamp,
    }
    if (event.toolEvent.kind === 'call') nextMetrics.toolCalls += 1
    if (event.toolEvent.kind === 'result') nextMetrics.toolResults += 1
    patch.stepMetrics = nextMetrics
  }

  if (structuredPayload?.phase === 'human_required' || structuredPayload?.takeover_state === 'submitted') {
    patch.phase = 'takeover'
    patch.blockedReason = [
      typeof structuredPayload.call_to_action === 'string' ? structuredPayload.call_to_action : '',
      typeof structuredPayload.details === 'string' ? structuredPayload.details : '',
    ].filter(Boolean).join(' · ') || '需要人工接管'
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

  return patch
}
