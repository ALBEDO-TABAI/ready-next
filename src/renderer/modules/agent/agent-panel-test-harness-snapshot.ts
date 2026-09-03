import { isForegroundBusyScopeRunState } from './scopeRunState'
import { deriveTaskCardRuntimeState } from './taskCardViewModel'
import type { TaskProjectionRecordData } from '../../types/electron'
import type {
  AgentArtifact,
  AgentMessage,
  ScopeRunSkillProgress,
  ScopeRunState,
  ScopeRunTaskContinuation,
  ScopeRunTaskStep,
  ScopeRunWaitingFor,
  ToolTraceEvent,
} from './types'
import type {
  AgentPanelInfoCardSnapshot,
  AgentPanelMessageSnapshot,
  AgentPanelRunSnapshot,
  AgentPanelSnapshot,
  AgentPanelTaskCardSnapshot,
  AgentPanelToolTraceSnapshot,
  StoreState,
} from './agent-panel-test-harness-types'
import { diagnoseAgentPanelSnapshot } from './agent-panel-test-harness-diagnostics'

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function extractToolNameFromTraceText(text: string): string | null {
  const trimmed = String(text || '').trim()
  const match = trimmed.match(/^([a-zA-Z0-9_:-]+)\s*(?:\(|:)/)
  return match?.[1] || null
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const text = typeof value === 'string' ? value : ''
  if (text) return text
  return new Date().toISOString()
}

function readText(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

function isCompletedSnapshotState(
  phase: string | null | undefined,
  status?: string | null,
  terminalReason?: string | null,
): boolean {
  const normalizedPhase = String(phase || '').trim()
  const normalizedStatus = String(status || '').trim()
  const normalizedTerminal = String(terminalReason || '').trim()
  const done = normalizedPhase === 'done'
    || normalizedStatus === 'completed'
    || normalizedStatus === 'done'
  const cleanTerminal = !normalizedTerminal
    || normalizedTerminal === 'done'
    || normalizedTerminal === 'completed'
  return done && cleanTerminal
}

function serializeMessage(message: AgentMessage): AgentPanelMessageSnapshot {
  const meta = asRecord(message.meta)
  const askUserQuestionsMeta = asRecord(meta?.askUserQuestions)
  return {
    id: message.id,
    type: message.type,
    agent: message.agent,
    content: message.content,
    timestamp: toIso(message.timestamp),
    attachmentNames: (message.attachments || []).map((attachment) => attachment.name),
    metaKeys: Object.keys(message.meta || {}).sort(),
    runId: readText(meta?.runId),
    terminalReason: readText(meta?.terminalReason),
    askUserQuestionsStatus: message.askUserQuestions?.status || readText(askUserQuestionsMeta?.status),
  }
}

function serializeToolTrace(
  event: ToolTraceEvent | Record<string, unknown>,
  source: AgentPanelToolTraceSnapshot['source'],
): AgentPanelToolTraceSnapshot | null {
  const id = readText((event as Record<string, unknown>).id)
  const kind = readText((event as Record<string, unknown>).kind)
  const text = readText((event as Record<string, unknown>).text)
  if (!id || !kind || !text) return null
  return {
    id,
    kind,
    text,
    timestamp: toIso((event as Record<string, unknown>).timestamp),
    source,
  }
}

function serializeRun(run: ScopeRunState | null): AgentPanelRunSnapshot | null {
  if (!run) return null
  const completed = isCompletedSnapshotState(run.phase, null, run.terminalReason || null)
  return {
    scopeId: run.scopeId,
    agent: run.agent,
    requestId: run.requestId || null,
    taskId: run.taskId || run.taskContinuation?.taskId || null,
    phase: run.phase,
    terminalReason: run.terminalReason || null,
    taskTitle: run.taskTitle || null,
    taskSummary: run.taskSummary || null,
    waitingFor: run.waitingFor || 'none',
    module: run.module || null,
    executionKind: run.executionKind || null,
    stepMetrics: {
      toolCalls: run.stepMetrics?.toolCalls || 0,
      toolResults: run.stepMetrics?.toolResults || 0,
      lastToolAt: run.stepMetrics?.lastToolAt || null,
    },
    progress: run.progress || null,
    contextUsage: run.contextUsage || null,
    softError: run.softError || null,
    error: completed ? null : run.error || null,
    blockedReason: completed ? null : run.blockedReason || null,
    updatedAt: run.updatedAt || null,
  }
}

function taskCardFromRun(run: ScopeRunState): AgentPanelTaskCardSnapshot {
  const canResume = run.resumableActions
    ? run.resumableActions.some((item) => item === 'continue' || item === 'retry')
    : null
  // deriveTaskCardRuntimeState applies CLAUDE §6.22 priority — this is the
  // state the user actually sees in the task card, distinct from the raw
  // `run.phase` (which can be `'done'` even while a child task is alive).
  const runtimeState = deriveTaskCardRuntimeState({
    scopeId: run.scopeId,
    taskId: run.taskId || null,
    phase: run.phase,
    terminalReason: run.terminalReason || null,
    title: run.taskTitle || run.taskSummary || run.latestText || '当前运行',
    taskTitle: run.taskTitle || null,
    taskSummary: run.taskSummary || null,
    steps: run.steps || [],
    currentStepId: run.currentStepId || null,
    waitingFor: run.waitingFor || 'none',
    resumableActions: run.resumableActions || [],
    canResume: canResume === true,
    recentArtifacts: run.recentArtifacts || run.artifactRefs || [],
    taskContinuation: run.taskContinuation || null,
    progress: run.progress || null,
    executionDiagnostics: run.executionDiagnostics || null,
    blockedReason: run.blockedReason || null,
    error: run.error || null,
    updatedAt: run.updatedAt || new Date().toISOString(),
    toolTrace: run.toolTrace || [],
  })
  const completed = runtimeState.visualState === 'done'
  return {
    source: 'scopeRunState',
    scopeId: run.scopeId,
    taskId: run.taskId || run.taskContinuation?.taskId || null,
    title: run.taskTitle || run.taskSummary || run.latestText || '当前运行',
    summary: run.taskSummary || null,
    phase: run.phase,
    status: run.phase,
    terminalReason: run.terminalReason || null,
    waitingFor: run.waitingFor || 'none',
    canResume,
    steps: run.steps || [],
    progress: run.progress || null,
    recentArtifacts: run.recentArtifacts || run.artifactRefs || [],
    continuation: run.taskContinuation || null,
    error: completed ? null : run.error || run.blockedReason || null,
    updatedAt: run.updatedAt || null,
    visualState: runtimeState.visualState,
    statusLabel: runtimeState.statusLabel,
    actionSet: runtimeState.actionSet,
  }
}

function taskCardFromMeta(message: AgentMessage): AgentPanelTaskCardSnapshot | null {
  const meta = asRecord(message.meta)
  const taskSnapshot = asRecord(meta?.taskSnapshot)
  if (!taskSnapshot) return null
  const phase = readText(taskSnapshot.phase)
  const status = readText(taskSnapshot.status) || phase
  const terminalReason = readText(taskSnapshot.terminalReason)
  const completed = isCompletedSnapshotState(phase, status, terminalReason)
  return {
    source: 'messageMeta',
    scopeId: readText(taskSnapshot.scopeId),
    taskId: readText(taskSnapshot.taskId),
    title: readText(taskSnapshot.taskTitle) || readText(taskSnapshot.title) || '消息任务快照',
    summary: readText(taskSnapshot.taskSummary),
    phase,
    status,
    terminalReason,
    waitingFor: readText(taskSnapshot.waitingFor),
    canResume: null,
    steps: Array.isArray(taskSnapshot.steps) ? taskSnapshot.steps as ScopeRunTaskStep[] : [],
    progress: asRecord(taskSnapshot.progress) as ScopeRunSkillProgress | null,
    recentArtifacts: Array.isArray(taskSnapshot.recentArtifacts) ? taskSnapshot.recentArtifacts as AgentArtifact[] : [],
    continuation: asRecord(taskSnapshot.taskContinuation) as ScopeRunTaskContinuation | null,
    error: completed ? null : readText(taskSnapshot.error) || readText(taskSnapshot.blockedReason),
    updatedAt: readText(taskSnapshot.updatedAt),
    visualState: null,
    statusLabel: null,
    actionSet: null,
  }
}

export function taskCardFromProjection(input: Record<string, unknown>): AgentPanelTaskCardSnapshot {
  const scopeId = readText(input.scopeId)
  const taskId = readText(input.taskId)
  const status = readText(input.status) as TaskProjectionRecordData['status'] | null
  const phase: ScopeRunState['phase'] = (readText(input.phase) as ScopeRunState['phase'] | null)
    || phaseFromProjectionStatus(status)
  const title = readText(input.taskTitle) || readText(input.title) || '任务投影'
  const summary = readText(input.taskSummary)
  const waitingFor = readText(input.waitingFor) as ScopeRunWaitingFor | null
  const steps = Array.isArray(input.steps) ? input.steps as ScopeRunTaskStep[] : []
  const recentArtifacts = Array.isArray(input.recentArtifacts) ? input.recentArtifacts as AgentArtifact[] : []
  const continuation = asRecord(input.continuationRef) as ScopeRunTaskContinuation | null
  const progress = (asRecord(input.progress) || asRecord(continuation?.progress)) as ScopeRunSkillProgress | null
  const error = readText(input.error) || readText(input.blockedReason)
  const updatedAt = readText(input.updatedAt)
  const canResume = typeof input.canResume === 'boolean' ? input.canResume : null
  const runtimeState = deriveTaskCardRuntimeState({
    scopeId: scopeId || 'unknown-scope',
    taskId,
    phase,
    title,
    taskTitle: title,
    taskSummary: summary,
    status: status || undefined,
    waitingFor: waitingFor || 'none',
    resumableActions: Array.isArray(input.resumableActions) ? input.resumableActions as ScopeRunState['resumableActions'] : [],
    canResume: canResume === true,
    steps,
    recentArtifacts,
    taskContinuation: continuation,
    progress,
    blockedReason: readText(input.blockedReason),
    error,
    updatedAt: updatedAt || new Date().toISOString(),
  })
  const completed = runtimeState.visualState === 'done'
  return {
    source: 'taskProjection',
    scopeId,
    taskId,
    title,
    summary,
    phase,
    status,
    terminalReason: readText(input.terminalReason),
    waitingFor,
    canResume,
    steps,
    progress,
    recentArtifacts,
    continuation,
    error: completed ? null : error,
    updatedAt,
    visualState: runtimeState.visualState,
    statusLabel: runtimeState.statusLabel,
    actionSet: runtimeState.actionSet,
  }
}

function phaseFromProjectionStatus(status: TaskProjectionRecordData['status'] | null): ScopeRunState['phase'] {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  if (status === 'killed') return 'cancelled'
  if (status === 'running' || status === 'queued') return 'tool_running'
  return 'checkpoint'
}

function collectInfoCards(state: StoreState, activeRun: ScopeRunState | null): AgentPanelInfoCardSnapshot[] {
  const cards: AgentPanelInfoCardSnapshot[] = []
  if (activeRun?.softError) {
    cards.push({
      kind: 'soft_error',
      title: activeRun.softError.friendlyMessage || activeRun.softError.message,
      detail: activeRun.softError.technicalDetails || activeRun.softError.errorKind,
      scopeId: activeRun.scopeId,
      severity: 'warning',
    })
  }
  for (const artifact of activeRun?.recentArtifacts || []) {
    cards.push({
      kind: 'recent_artifact',
      title: artifact.label,
      detail: artifact.path || artifact.url || artifact.kind,
      scopeId: activeRun?.scopeId || state.currentScopeId,
      severity: 'info',
    })
  }
  for (const attachment of state.attachments || []) {
    cards.push({
      kind: 'attachment',
      title: attachment.name,
      detail: attachment.path,
      scopeId: state.currentScopeId,
      severity: 'info',
    })
  }
  for (const message of state.messages) {
    const meta = asRecord(message.meta)
    if (asRecord(meta?.taskSnapshot)) {
      cards.push({
        kind: 'message_task_snapshot',
        title: '消息内任务快照',
        detail: message.content.slice(0, 120) || null,
        scopeId: state.currentScopeId,
        messageId: message.id,
        severity: 'info',
      })
    }
    if (Array.isArray(meta?.toolTraceSnapshot) && meta.toolTraceSnapshot.length > 0) {
      cards.push({
        kind: 'message_tool_trace_snapshot',
        title: `消息内工具记录 ${meta.toolTraceSnapshot.length} 条`,
        detail: message.content.slice(0, 120) || null,
        scopeId: state.currentScopeId,
        messageId: message.id,
        severity: 'info',
      })
    }
  }
  return cards
}

function collectToolTrace(state: StoreState, activeRun: ScopeRunState | null): AgentPanelToolTraceSnapshot[] {
  const traces = (activeRun?.toolTrace || state.toolTrace || [])
    .map((event) => serializeToolTrace(event, 'scopeRunState'))
    .filter((event): event is AgentPanelToolTraceSnapshot => Boolean(event))

  for (const message of state.messages) {
    const meta = asRecord(message.meta)
    const snapshot = Array.isArray(meta?.toolTraceSnapshot) ? meta.toolTraceSnapshot : []
    for (const event of snapshot) {
      const serialized = serializeToolTrace(event as Record<string, unknown>, 'messageMeta')
      if (serialized) traces.push(serialized)
    }
  }
  return traces
}

export function createAgentPanelSnapshot(
  state: StoreState,
  projectionCards: AgentPanelTaskCardSnapshot[] = [],
): AgentPanelSnapshot {
  const visibleScopeRunStates = state.scopeRunStates || {}
  const activeRun = state.currentScopeId ? visibleScopeRunStates[state.currentScopeId] || null : null
  const runCards = Object.values(visibleScopeRunStates)
    .filter((run) => run.scopeId === state.currentScopeId || run.taskTitle || run.taskSummary || run.toolTrace.length > 0)
    .map(taskCardFromRun)
  const messageCards = state.messages
    .map(taskCardFromMeta)
    .filter((card): card is AgentPanelTaskCardSnapshot => Boolean(card))

  const snapshot: AgentPanelSnapshot = {
    capturedAt: new Date().toISOString(),
    currentAgent: state.currentAgent,
    currentScopeId: state.currentScopeId,
    currentScopeTitle: state.currentScope?.title || null,
    composer: {
      inputValue: state.inputValue,
      locked: Boolean(state.composerLocked || state.foregroundBusy || state.isStreaming),
      attachmentNames: (state.attachments || []).map((attachment) => attachment.name),
      filePoolNames: (state.filePool || []).map((attachment) => attachment.name),
    },
    runtime: {
      isStreaming: state.isStreaming,
      foregroundBusy: Boolean(activeRun ? isForegroundBusyScopeRunState(activeRun) : state.foregroundBusy),
      toolTraceStatus: state.toolTraceStatus,
      streamingMessageId: state.streamingMessageId,
      streamingRequestId: state.streamingRequestId,
      activeRun: serializeRun(activeRun),
    },
    messages: state.messages.map(serializeMessage),
    taskCards: [...projectionCards, ...runCards, ...messageCards],
    infoCards: collectInfoCards(state, activeRun),
    toolTrace: collectToolTrace(state, activeRun),
    diagnostics: [],
  }
  snapshot.diagnostics = diagnoseAgentPanelSnapshot(snapshot)
  return snapshot
}
