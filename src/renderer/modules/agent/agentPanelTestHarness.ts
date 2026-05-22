import { isForegroundBusyScopeRunState } from './scopeRunState'
import { deriveTaskCardRuntimeState, type TaskCardAction } from './taskCardViewModel'
import type { TaskCardVisualState } from './task-status-vocabulary'
import type { TaskProjectionRecordData } from '../../types/electron'
import type {
  AgentArtifact,
  AgentMessage,
  ChatAttachment,
  ConversationScope,
  ScopeRunMemoryCapture,
  ScopeRunSkillProgress,
  ScopeRunState,
  ScopeRunTaskContinuation,
  ScopeRunTaskStep,
  ScopeRunWaitingFor,
  ToolTraceEvent,
} from './types'

type SendMessageResultLike = {
  success: boolean
  shouldClearInput?: boolean
  preserveInput?: boolean
  errorKind?: string | null
}

type StoreState = {
  agents?: Array<{ name: string; displayName?: string; status?: string; selected?: boolean }>
  messages: AgentMessage[]
  currentAgent: string
  inputValue: string
  currentScopeId: string | null
  currentScope: ConversationScope | null
  scopes: ConversationScope[]
  scopeRunStates: Record<string, ScopeRunState>
  toolTrace: ToolTraceEvent[]
  toolTraceStatus: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  attachments: ChatAttachment[]
  filePool: ChatAttachment[]
  isStreaming: boolean
  foregroundBusy: boolean
  composerLocked: boolean
  streamingMessageId: string | null
  streamingRequestId: string | null
  pendingSendCount: number
  pendingSendFlushAt: number | null
  sendCoalescingEnabled?: boolean
  sendCoalescingWindowMs?: number
  sendMessage: (content: string) => Promise<SendMessageResultLike>
  setInputValue: (value: string, options?: { preserveContinuationIntent?: boolean }) => void
  addAttachments?: (files: ChatAttachment[]) => void
  clearAttachments?: () => void
  newSession?: () => void
}

type StoreLike = {
  getState: () => StoreState
  setState?: (partial: Partial<StoreState>) => void
  subscribe?: (listener: (state: StoreState, previousState: StoreState) => void) => () => void
}

export type AgentPanelDiagnosticLayer =
  | 'input'
  | 'send'
  | 'runtime'
  | 'tool'
  | 'projection'
  | 'renderer'
  | 'unknown'

export type AgentPanelDiagnosticSeverity = 'info' | 'warning' | 'error'

export interface AgentPanelDiagnostic {
  id: string
  severity: AgentPanelDiagnosticSeverity
  layer: AgentPanelDiagnosticLayer
  message: string
  evidence: Record<string, unknown>
}

export interface AgentPanelMessageSnapshot {
  id: string
  type: AgentMessage['type']
  agent: string
  content: string
  timestamp: string
  attachmentNames: string[]
  metaKeys: string[]
}

export interface AgentPanelTaskCardSnapshot {
  source: 'scopeRunState' | 'messageMeta' | 'taskProjection'
  scopeId: string | null
  taskId: string | null
  title: string
  summary: string | null
  phase: ScopeRunState['phase'] | string | null
  status: string | null
  terminalReason: string | null
  waitingFor: ScopeRunWaitingFor | string | null
  canResume: boolean | null
  steps: ScopeRunTaskStep[]
  progress: ScopeRunSkillProgress | null
  recentArtifacts: AgentArtifact[]
  continuation: ScopeRunTaskContinuation | null
  error: string | null
  updatedAt: string | null
  // The user-visible task-card state, computed via the same priority rules
  // the real renderer uses (`deriveTaskCardRuntimeState`, CLAUDE §6.22):
  // `failed_no_background_alive > background_running > budget_paused >
  // waiting_handoff/input > done > running`. `null` for snapshots sourced
  // from message meta or remote task projections without a live run.
  visualState: TaskCardVisualState | null
  statusLabel: string | null
  actionSet: TaskCardAction[] | null
}

export interface AgentPanelInfoCardSnapshot {
  kind:
    | 'soft_error'
    | 'memory_capture'
    | 'recent_artifact'
    | 'attachment'
    | 'message_task_snapshot'
    | 'message_tool_trace_snapshot'
  title: string
  detail: string | null
  scopeId: string | null
  messageId?: string
  severity?: AgentPanelDiagnosticSeverity
}

export interface AgentPanelToolTraceSnapshot {
  id: string
  kind: ToolTraceEvent['kind'] | string
  text: string
  timestamp: string
  source: 'scopeRunState' | 'messageMeta'
}

export interface AgentPanelSnapshot {
  capturedAt: string
  currentAgent: string
  currentScopeId: string | null
  currentScopeTitle: string | null
  composer: {
    inputValue: string
    locked: boolean
    pendingSendCount: number
    pendingSendFlushAt: number | null
    attachmentNames: string[]
    filePoolNames: string[]
  }
  runtime: {
    isStreaming: boolean
    foregroundBusy: boolean
    toolTraceStatus: StoreState['toolTraceStatus']
    streamingMessageId: string | null
    streamingRequestId: string | null
    activeRun: AgentPanelRunSnapshot | null
  }
  messages: AgentPanelMessageSnapshot[]
  taskCards: AgentPanelTaskCardSnapshot[]
  infoCards: AgentPanelInfoCardSnapshot[]
  toolTrace: AgentPanelToolTraceSnapshot[]
  diagnostics: AgentPanelDiagnostic[]
}

export interface AgentPanelRunSnapshot {
  scopeId: string
  agent: string
  requestId: string | null
  taskId: string | null
  phase: ScopeRunState['phase']
  terminalReason: string | null
  taskTitle: string | null
  taskSummary: string | null
  waitingFor: ScopeRunWaitingFor | string | null
  module: string | null
  executionKind: string | null
  stepMetrics: {
    toolCalls: number
    toolResults: number
    lastToolAt: string | null
  }
  progress: ScopeRunSkillProgress | null
  softError: ScopeRunState['softError'] | null
  error: string | null
  blockedReason: string | null
  updatedAt: string | null
}

export interface AgentPanelHarnessEvent {
  seq: number
  kind: 'message_count' | 'phase' | 'tool_trace' | 'soft_error' | 'scope'
  capturedAt: string
  scopeId: string | null
  detail: Record<string, unknown>
}

export interface AgentPanelSubmitOptions {
  mode?: 'dom' | 'store'
  waitForIdle?: boolean
  timeoutMs?: number
  pollMs?: number
  attachments?: AgentPanelTestAttachmentInput[]
  expectedToolNames?: string[]
  forbiddenToolNames?: string[]
}

export interface AgentPanelSubmitResult {
  ok: boolean
  inputMode: 'dom' | 'store'
  sendResult: SendMessageResultLike | null
  before: AgentPanelSnapshot
  after: AgentPanelSnapshot
  diagnostics: AgentPanelDiagnostic[]
}

export interface AgentPanelTestAttachmentInput {
  path: string
  name?: string
  type?: ChatAttachment['type']
  size?: number
  ext?: string
  source?: ChatAttachment['source']
  isDirectory?: boolean
}

export interface AgentPanelTestWorkspaceResult {
  ok: boolean
  root: string
  reindex?: unknown
  error?: string
}

export interface AgentPanelTestHarness {
  snapshot: () => Promise<AgentPanelSnapshot>
  diagnose: () => Promise<AgentPanelDiagnostic[]>
  submit: (text: string, options?: AgentPanelSubmitOptions) => Promise<AgentPanelSubmitResult>
  attachFiles: (files: AgentPanelTestAttachmentInput[]) => Promise<ChatAttachment[]>
  clearAttachments: () => void
  newSession: () => Promise<AgentPanelSnapshot>
  prepareWorkspace: (root: string, options?: { reindex?: boolean }) => Promise<AgentPanelTestWorkspaceResult>
  waitForIdle: (options?: { timeoutMs?: number; pollMs?: number }) => Promise<AgentPanelSnapshot>
  events: () => AgentPanelHarnessEvent[]
  clearEvents: () => void
  dispose: () => void
}

declare global {
  interface Window {
    __READY_AGENT_TEST__?: AgentPanelTestHarness
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function extractToolNameFromTraceText(text: string): string | null {
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

function serializeMessage(message: AgentMessage): AgentPanelMessageSnapshot {
  return {
    id: message.id,
    type: message.type,
    agent: message.agent,
    content: message.content,
    timestamp: toIso(message.timestamp),
    attachmentNames: (message.attachments || []).map((attachment) => attachment.name),
    metaKeys: Object.keys(message.meta || {}).sort(),
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
    softError: run.softError || null,
    error: run.error || null,
    blockedReason: run.blockedReason || null,
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
    memoryCapture: run.memoryCapture || null,
    executionDiagnostics: run.executionDiagnostics || null,
    blockedReason: run.blockedReason || null,
    error: run.error || null,
    updatedAt: run.updatedAt || new Date().toISOString(),
    toolTrace: run.toolTrace || [],
  })
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
    error: run.error || run.blockedReason || null,
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
  return {
    source: 'messageMeta',
    scopeId: readText(taskSnapshot.scopeId),
    taskId: readText(taskSnapshot.taskId),
    title: readText(taskSnapshot.taskTitle) || readText(taskSnapshot.title) || '消息任务快照',
    summary: readText(taskSnapshot.taskSummary),
    phase: readText(taskSnapshot.phase),
    status: readText(taskSnapshot.phase),
    terminalReason: readText(taskSnapshot.terminalReason),
    waitingFor: readText(taskSnapshot.waitingFor),
    canResume: null,
    steps: Array.isArray(taskSnapshot.steps) ? taskSnapshot.steps as ScopeRunTaskStep[] : [],
    progress: asRecord(taskSnapshot.progress) as ScopeRunSkillProgress | null,
    recentArtifacts: Array.isArray(taskSnapshot.recentArtifacts) ? taskSnapshot.recentArtifacts as AgentArtifact[] : [],
    continuation: asRecord(taskSnapshot.taskContinuation) as ScopeRunTaskContinuation | null,
    error: readText(taskSnapshot.error) || readText(taskSnapshot.blockedReason),
    updatedAt: readText(taskSnapshot.updatedAt),
    visualState: null,
    statusLabel: null,
    actionSet: null,
  }
}

function taskCardFromProjection(input: Record<string, unknown>): AgentPanelTaskCardSnapshot {
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
  const progress = asRecord(input.progress) as ScopeRunSkillProgress | null
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
    error,
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
  const memoryCapture: ScopeRunMemoryCapture | null = activeRun?.memoryCapture || null
  if (memoryCapture) {
    cards.push({
      kind: 'memory_capture',
      title: `记忆捕获：${memoryCapture.status}`,
      detail: memoryCapture.items.map((item) => item.title).join('、') || null,
      scopeId: activeRun?.scopeId || state.currentScopeId,
      severity: 'info',
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
  const activeRun = state.currentScopeId ? state.scopeRunStates[state.currentScopeId] || null : null
  const runCards = Object.values(state.scopeRunStates || {})
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
      pendingSendCount: state.pendingSendCount || 0,
      pendingSendFlushAt: state.pendingSendFlushAt || null,
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

export function diagnoseAgentPanelSnapshot(snapshot: AgentPanelSnapshot): AgentPanelDiagnostic[] {
  const diagnostics: AgentPanelDiagnostic[] = []
  const activeRun = snapshot.runtime.activeRun
  const lastMessage = snapshot.messages[snapshot.messages.length - 1] || null
  const lastUserIndex = [...snapshot.messages].reverse().findIndex((message) => message.type === 'user')
  const hasUserWithoutReply =
    lastMessage?.type === 'user' &&
    !snapshot.runtime.foregroundBusy &&
    !snapshot.composer.pendingSendCount

  if (!snapshot.currentScopeId) {
    diagnostics.push({
      id: 'scope_missing',
      severity: 'warning',
      layer: 'input',
      message: '当前没有会话 Scope，输入层需要先创建本地会话。',
      evidence: { currentAgent: snapshot.currentAgent },
    })
  }

  if (snapshot.composer.pendingSendCount > 0) {
    diagnostics.push({
      id: 'send_coalescing_pending',
      severity: 'info',
      layer: 'input',
      message: '输入已进入连续消息合并窗口，运行尚未真正开始。',
      evidence: { pendingSendCount: snapshot.composer.pendingSendCount, pendingSendFlushAt: snapshot.composer.pendingSendFlushAt },
    })
  }

  if (lastMessage?.type === 'system' && /发送失败|发送出错|send failed/i.test(lastMessage.content)) {
    diagnostics.push({
      id: 'send_failed_message',
      severity: 'error',
      layer: 'send',
      message: '面板出现发送失败消息，优先检查 sendScoped 返回值、会话持久化或供应商请求错误。',
      evidence: { messageId: lastMessage.id, content: lastMessage.content.slice(0, 240) },
    })
  }

  const leakedToolCallMessage = snapshot.messages.find((message) =>
    message.type === 'agent' && /<tool_call>|<function=|<parameter=|:::tool_call/i.test(message.content),
  )
  if (leakedToolCallMessage) {
    diagnostics.push({
      id: 'raw_tool_call_visible',
      severity: 'error',
      layer: 'renderer',
      message: 'Agent 回复中出现原始工具调用文本，说明文本工具桥没有正确隐藏工具协议。',
      evidence: {
        messageId: leakedToolCallMessage.id,
        content: leakedToolCallMessage.content.slice(0, 240),
      },
    })
  }

  if (activeRun?.softError) {
    diagnostics.push({
      id: 'soft_error_capsule',
      severity: 'warning',
      layer: 'tool',
      message: '当前运行有软失败胶囊，说明工具或外部依赖失败但运行未终止。',
      evidence: { ...activeRun.softError },
    })
  }

  const failedToolResult = snapshot.toolTrace.find((item) =>
    item.kind === 'result'
    && /(?:工具 .{0,60}失败|失败：|保存失败|Document action failed|failed|errorKind|escapes sandbox root|path_outside_outputs)/i.test(item.text),
  )
  if (failedToolResult) {
    diagnostics.push({
      id: 'tool_result_failure',
      severity: 'error',
      layer: 'tool',
      message: '工具结果里出现失败信息，不能只看最终回复判断为通过。',
      evidence: {
        traceId: failedToolResult.id,
        text: failedToolResult.text.slice(0, 300),
      },
    })
  }

  if (activeRun?.phase === 'error' || activeRun?.error) {
    const lastTrace = [...snapshot.toolTrace].reverse().find((item) => item.text)
    const layer: AgentPanelDiagnosticLayer =
      lastTrace && /工具执行失败|tool|file_|browser_|document_|skill_/i.test(lastTrace.text)
        ? 'tool'
        : 'runtime'
    diagnostics.push({
      id: 'active_run_error',
      severity: 'error',
      layer,
      message: activeRun.error || activeRun.blockedReason || '当前运行进入错误态。',
      evidence: {
        phase: activeRun.phase,
        terminalReason: activeRun.terminalReason,
        lastTrace: lastTrace?.text || null,
      },
    })
  }

  if (activeRun?.terminalReason && activeRun.terminalReason !== 'done') {
    const recoverableCheckpoint = activeRun.terminalReason === 'checkpoint_background'
      || activeRun.terminalReason === 'checkpoint_budget'
      || activeRun.terminalReason === 'checkpoint_user_input'
      || activeRun.phase === 'checkpoint'
      || (Boolean(activeRun.waitingFor) && activeRun.waitingFor !== 'none')
    diagnostics.push({
      id: 'non_done_terminal_reason',
      severity: recoverableCheckpoint ? 'info' : activeRun.phase === 'done' ? 'warning' : 'error',
      layer: activeRun.terminalReason.startsWith('blocked_') ? 'tool' : 'runtime',
      message: recoverableCheckpoint
        ? `运行以 ${activeRun.terminalReason} 暂停，已保留可继续状态。`
        : `运行以 ${activeRun.terminalReason} 结束，需要按终态原因继续定位。`,
      evidence: { phase: activeRun.phase, terminalReason: activeRun.terminalReason },
    })
  }

  const callCount = snapshot.toolTrace.filter((item) => item.kind === 'call').length
  const resultCount = snapshot.toolTrace.filter((item) => item.kind === 'result').length
  if (callCount > resultCount && !snapshot.runtime.foregroundBusy) {
    diagnostics.push({
      id: 'tool_call_without_result',
      severity: 'error',
      layer: 'tool',
      message: '存在没有结果的工具调用，工具回执或 renderer-mediated tool ack 可能断了。',
      evidence: { callCount, resultCount },
    })
  }

  if (hasUserWithoutReply) {
    diagnostics.push({
      id: 'user_message_without_reply',
      severity: 'error',
      layer: 'renderer',
      message: '最后一条用户消息后没有运行中状态，也没有 Agent 回复。',
      evidence: { lastUserFromEnd: lastUserIndex },
    })
  }

  if (snapshot.taskCards.length === 0 && activeRun && activeRun.phase !== 'idle') {
    diagnostics.push({
      id: 'task_card_missing',
      severity: 'warning',
      layer: 'projection',
      message: '运行态存在，但没有可读任务卡快照，投影或消息快照可能缺失。',
      evidence: { phase: activeRun.phase, taskTitle: activeRun.taskTitle },
    })
  }

  return diagnostics
}

function shouldEnableHarness(): boolean {
  if (typeof window === 'undefined') return false
  const meta = import.meta as unknown as { env?: { DEV?: boolean } }
  if (meta.env?.DEV) return true
  try {
    const params = new URLSearchParams(window.location.search || '')
    if (params.get('agentTest') === '1' || params.get('readyAgentTest') === '1') return true
  } catch {
    // silent-catch: URL parsing is only an optional harness enable signal.
  }
  try {
    return (
      window.localStorage?.getItem('ready.agentPanelTest') === '1' ||
      window.localStorage?.getItem('ready:agent:test') === '1'
    )
  } catch {
    // silent-catch: localStorage can be blocked; that just leaves the harness disabled.
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function basenameFromPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path
}

function extensionFromPath(path: string): string {
  const name = basenameFromPath(path)
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

function typeFromExtension(ext: string): ChatAttachment['type'] {
  const normalized = ext.toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.heic'].includes(normalized)) return 'image'
  if (['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'].includes(normalized)) return 'video'
  if (['.md', '.txt', '.json', '.csv', '.html', '.xml', '.yaml', '.yml'].includes(normalized)) return 'text'
  if (['.xls', '.xlsx', '.tsv'].includes(normalized)) return 'spreadsheet'
  return 'other'
}

async function hydrateAttachment(input: AgentPanelTestAttachmentInput): Promise<ChatAttachment> {
  const path = String(input.path || '').trim()
  if (!path) throw new Error('attachment path is required')
  const stat = await window.electronAPI?.document?.stat?.(path).catch(() => null)
  const data = stat && typeof stat === 'object' && 'success' in stat && stat.success ? stat.data : null
  const ext = input.ext || (typeof data?.extension === 'string' ? data.extension : extensionFromPath(path))
  return {
    id: `test-attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name || basenameFromPath(path),
    path,
    type: input.type || typeFromExtension(ext),
    size: typeof input.size === 'number' ? input.size : (typeof data?.size === 'number' ? data.size : 0),
    ext,
    source: input.source || 'file',
    isDirectory: typeof input.isDirectory === 'boolean' ? input.isDirectory : Boolean(data?.isDirectory),
  }
}

function buildTestAttachmentPathContext(attachments: ChatAttachment[]): string {
  const lines = attachments
    .filter((attachment) => typeof attachment.path === 'string' && attachment.path.trim())
    .map((attachment) => `- ${attachment.name || basenameFromPath(attachment.path)}: ${attachment.path}`)
  if (lines.length === 0) return ''
  return [
    '--- 测试模式附件路径 ---',
    '以下路径来自测试 harness 注入，等同于用户已附加的本地文件；需要处理附件时优先使用这些绝对路径。',
    ...lines,
  ].join('\n')
}

async function setDomTextareaValue(text: string): Promise<boolean> {
  if (typeof document === 'undefined') return false
  const textarea = document.querySelector('[data-ready-agent-input="true"]') as HTMLTextAreaElement | null
  if (!textarea) return false
  textarea.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  if (setter) {
    setter.call(textarea, text)
  } else {
    textarea.value = text
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await delay(0)
  return true
}

async function submitViaDom(text: string): Promise<boolean> {
  const changed = await setDomTextareaValue(text)
  if (!changed || typeof document === 'undefined') return false
  const sendButton = document.querySelector('[data-ready-agent-send="true"]') as HTMLButtonElement | null
  if (!sendButton || sendButton.disabled) return false
  sendButton.click()
  await delay(0)
  return true
}

function hasSubmittedUserMessage(
  messages: AgentMessage[],
  beforeMessageCount: number,
  normalizedText: string,
): boolean {
  return Boolean(
    messages
      .slice(beforeMessageCount)
      .find((message) => message.type === 'user' && message.content.trim() === normalizedText)
    || messages.find((message) => message.type === 'user' && message.content.trim() === normalizedText),
  )
}

async function waitForDomSubmitEvidence(
  store: StoreLike,
  beforeMessageCount: number,
  normalizedText: string,
): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1_500) {
    const state = store.getState()
    const currentRun = state.currentScopeId ? state.scopeRunStates[state.currentScopeId] || null : null
    if (
      hasSubmittedUserMessage(state.messages, beforeMessageCount, normalizedText)
      || state.pendingSendCount > 0
      || state.isStreaming
      || state.foregroundBusy
      || Boolean(currentRun?.requestId)
      || Boolean(currentRun?.taskId)
    ) {
      return true
    }
    await delay(50)
  }
  return false
}

async function loadProjectionCards(scopeId: string | null): Promise<AgentPanelTaskCardSnapshot[]> {
  if (!scopeId || typeof window === 'undefined') return []
  const listTaskProjections = window.electronAPI?.agent?.listTaskProjections
  if (!listTaskProjections) return []
  const result = await listTaskProjections(scopeId).catch(() => null)
  if (!result?.success || !Array.isArray(result.data)) return []
  return result.data
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map(taskCardFromProjection)
}

export function createAgentPanelTestHarness(store: StoreLike): AgentPanelTestHarness {
  let seq = 0
  const events: AgentPanelHarnessEvent[] = []
  const maxEvents = 300
  const pushEvent = (kind: AgentPanelHarnessEvent['kind'], state: StoreState, detail: Record<string, unknown>) => {
    events.push({
      seq: ++seq,
      kind,
      capturedAt: new Date().toISOString(),
      scopeId: state.currentScopeId || null,
      detail,
    })
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents)
  }

  const unsubscribe = store.subscribe?.((state, previous) => {
    if (state.currentScopeId !== previous.currentScopeId) {
      pushEvent('scope', state, { from: previous.currentScopeId, to: state.currentScopeId })
    }
    if (state.messages.length !== previous.messages.length) {
      pushEvent('message_count', state, { from: previous.messages.length, to: state.messages.length })
    }
    const run = state.currentScopeId ? state.scopeRunStates[state.currentScopeId] || null : null
    const previousRun = previous.currentScopeId ? previous.scopeRunStates[previous.currentScopeId] || null : null
    if (run?.phase !== previousRun?.phase || run?.terminalReason !== previousRun?.terminalReason) {
      pushEvent('phase', state, {
        phase: run?.phase || null,
        terminalReason: run?.terminalReason || null,
      })
    }
    if ((run?.toolTrace.length || 0) !== (previousRun?.toolTrace.length || 0)) {
      pushEvent('tool_trace', state, {
        from: previousRun?.toolTrace.length || 0,
        to: run?.toolTrace.length || 0,
      })
    }
    if (Boolean(run?.softError) !== Boolean(previousRun?.softError)) {
      pushEvent('soft_error', state, { present: Boolean(run?.softError) })
    }
  })

  const snapshot = async (): Promise<AgentPanelSnapshot> => {
    const state = store.getState()
    const projectionCards = await loadProjectionCards(state.currentScopeId)
    return createAgentPanelSnapshot(store.getState(), projectionCards)
  }

  const waitForIdle = async (options: { timeoutMs?: number; pollMs?: number } = {}) => {
    const timeoutMs = Math.max(500, options.timeoutMs || 45_000)
    const pollMs = Math.max(25, options.pollMs || 100)
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const current = createAgentPanelSnapshot(store.getState())
      if (
        !current.composer.locked &&
        !current.runtime.foregroundBusy &&
        current.composer.pendingSendCount === 0
      ) {
        return snapshot()
      }
      await delay(pollMs)
    }
    const timedOut = await snapshot()
    timedOut.diagnostics = [
      ...timedOut.diagnostics,
      {
        id: 'wait_for_idle_timeout',
        severity: 'error',
        layer: 'runtime',
        message: '等待 Agent 面板空闲超时。',
        evidence: { timeoutMs },
      },
    ]
    return timedOut
  }

  const submit = async (
    text: string,
    options: AgentPanelSubmitOptions = {},
  ): Promise<AgentPanelSubmitResult> => {
    const before = await snapshot()
    let attached: ChatAttachment[] = []
    if (options.attachments?.length) {
      attached = await attachFiles(options.attachments)
    }
    const attachmentContext = buildTestAttachmentPathContext(attached)
    const messageText = attachmentContext ? `${text.trim()}\n\n${attachmentContext}` : text
    const normalizedText = messageText.trim()
    const mode = options.mode || 'dom'
    let inputMode: 'dom' | 'store' = mode
    let sendResult: SendMessageResultLike | null = null
    let domSubmitted = false
    const coalescingState = store.getState()
    const canDisableCoalescing = typeof store.setState === 'function'
      && typeof coalescingState.sendCoalescingEnabled === 'boolean'
      && typeof coalescingState.sendCoalescingWindowMs === 'number'
    if (canDisableCoalescing) {
      store.setState?.({
        sendCoalescingEnabled: false,
        sendCoalescingWindowMs: 0,
      })
    }

    try {
      if (mode === 'dom') {
        domSubmitted = await submitViaDom(messageText)
        if (domSubmitted) {
          domSubmitted = await waitForDomSubmitEvidence(store, before.messages.length, normalizedText)
        }
      }

      if (!domSubmitted) {
        inputMode = 'store'
        const state = store.getState()
        state.setInputValue(messageText, { preserveContinuationIntent: true })
        sendResult = await state.sendMessage(messageText)
      }
    } finally {
      if (canDisableCoalescing) {
        store.setState?.({
          sendCoalescingEnabled: coalescingState.sendCoalescingEnabled,
          sendCoalescingWindowMs: coalescingState.sendCoalescingWindowMs,
        })
      }
    }

    const after = options.waitForIdle === false
      ? await snapshot()
      : await waitForIdle({ timeoutMs: options.timeoutMs, pollMs: options.pollMs })
    const diagnostics = diagnoseAgentPanelSnapshot(after)
    const submittedUserMessage = after.messages
      .slice(before.messages.length)
      .find((message) => message.type === 'user' && message.content.trim() === normalizedText)
      || after.messages.find((message) => message.type === 'user' && message.content.trim() === normalizedText)
    const hasRunEvidence = Boolean(
      after.runtime.activeRun?.requestId
      || after.runtime.activeRun?.taskId
      || after.toolTrace.length > before.toolTrace.length
      || after.messages.length > before.messages.length + (submittedUserMessage ? 1 : 0),
    )
    if (!submittedUserMessage) {
      diagnostics.push({
        id: 'send_returned_without_user_message',
        severity: 'error',
        layer: 'send',
        message: 'sendMessage 返回后面板没有出现对应用户消息，测试不能判定为通过。',
        evidence: {
          sendResult,
          beforeMessageCount: before.messages.length,
          afterMessageCount: after.messages.length,
          currentScopeId: after.currentScopeId,
        },
      })
    } else if (!hasRunEvidence) {
      diagnostics.push({
        id: 'send_returned_without_run_evidence',
        severity: 'error',
        layer: 'runtime',
        message: '用户消息已出现，但没有任务卡、运行态或工具记录，测试不能判定为通过。',
        evidence: {
          sendResult,
          currentScopeId: after.currentScopeId,
          activeRun: after.runtime.activeRun,
        },
      })
    }
    const observedToolNames = Array.from(new Set(after.toolTrace
      .filter((item) => item.kind === 'call')
      .map((item) => extractToolNameFromTraceText(item.text))
      .filter((name): name is string => Boolean(name))))
    for (const expectedToolName of options.expectedToolNames || []) {
      if (observedToolNames.includes(expectedToolName)) continue
      diagnostics.push({
        id: 'expected_tool_not_called',
        severity: 'error',
        layer: 'tool',
        message: `测试要求调用 ${expectedToolName}，但面板工具轨迹中没有出现。`,
        evidence: { expectedToolName, observedToolNames },
      })
    }
    for (const forbiddenToolName of options.forbiddenToolNames || []) {
      if (!observedToolNames.includes(forbiddenToolName)) continue
      diagnostics.push({
        id: 'forbidden_tool_called',
        severity: 'error',
        layer: 'tool',
        message: `测试禁止调用 ${forbiddenToolName}，但面板工具轨迹中出现了该工具。`,
        evidence: { forbiddenToolName, observedToolNames },
      })
    }
    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      inputMode,
      sendResult,
      before,
      after,
      diagnostics,
    }
  }

  const attachFiles = async (files: AgentPanelTestAttachmentInput[]): Promise<ChatAttachment[]> => {
    const state = store.getState()
    if (!state.addAttachments) throw new Error('agent store does not expose addAttachments')
    const attachments = await Promise.all(files.map(hydrateAttachment))
    state.addAttachments(attachments)
    return attachments
  }

  const clearAttachments = (): void => {
    store.getState().clearAttachments?.()
  }

  const newSession = async (): Promise<AgentPanelSnapshot> => {
    const beforeScopeId = store.getState().currentScopeId
    store.getState().newSession?.()
    const startedAt = Date.now()
    while (Date.now() - startedAt < 5_000) {
      const current = store.getState()
      if (current.currentScopeId && current.currentScopeId !== beforeScopeId) break
      await delay(50)
    }
    return snapshot()
  }

  const prepareWorkspace = async (
    root: string,
    options: { reindex?: boolean } = {},
  ): Promise<AgentPanelTestWorkspaceResult> => {
    const normalizedRoot = String(root || '').trim()
    if (!normalizedRoot) return { ok: false, root: normalizedRoot, error: 'workspace root is required' }
    try {
      window.localStorage?.setItem('ready-workspace-root', normalizedRoot)
    } catch {
      // silent-catch: the persisted workspace hint is optional for harness-driven tests;
      // localStorage may be unavailable in some renderer sandboxes and that just leaves the
      // hint unset for the next reload.
    }
    if (options.reindex === false) return { ok: true, root: normalizedRoot }
    const reindex = await window.electronAPI?.document?.reindexWorkspace?.(normalizedRoot)
    if (!reindex?.success) {
      return { ok: false, root: normalizedRoot, reindex, error: reindex?.error || 'reindex failed' }
    }
    return { ok: true, root: normalizedRoot, reindex }
  }

  return {
    snapshot,
    diagnose: async () => (await snapshot()).diagnostics,
    submit,
    attachFiles,
    clearAttachments,
    newSession,
    prepareWorkspace,
    waitForIdle,
    events: () => [...events],
    clearEvents: () => {
      events.splice(0, events.length)
    },
    dispose: () => {
      unsubscribe?.()
      if (typeof window !== 'undefined' && window.__READY_AGENT_TEST__) {
        delete window.__READY_AGENT_TEST__
      }
    },
  }
}

export function installAgentPanelTestHarness(
  store: StoreLike,
  options: { force?: boolean } = {},
): AgentPanelTestHarness | null {
  if (typeof window === 'undefined') return null
  if (!options.force && !shouldEnableHarness()) return null
  if (window.__READY_AGENT_TEST__) return window.__READY_AGENT_TEST__
  const harness = createAgentPanelTestHarness(store)
  window.__READY_AGENT_TEST__ = harness
  return harness
}
