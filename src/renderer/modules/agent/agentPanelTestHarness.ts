import { isForegroundBusyScopeRunState } from './scopeRunState'
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
  sendMessage: (content: string) => Promise<SendMessageResultLike>
  setInputValue: (value: string, options?: { preserveContinuationIntent?: boolean }) => void
}

type StoreLike = {
  getState: () => StoreState
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
}

export interface AgentPanelSubmitResult {
  ok: boolean
  inputMode: 'dom' | 'store'
  sendResult: SendMessageResultLike | null
  before: AgentPanelSnapshot
  after: AgentPanelSnapshot
  diagnostics: AgentPanelDiagnostic[]
}

export interface AgentPanelTestHarness {
  snapshot: () => Promise<AgentPanelSnapshot>
  diagnose: () => Promise<AgentPanelDiagnostic[]>
  submit: (text: string, options?: AgentPanelSubmitOptions) => Promise<AgentPanelSubmitResult>
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
    canResume: run.resumableActions ? run.resumableActions.some((item) => item === 'continue' || item === 'retry') : null,
    steps: run.steps || [],
    progress: run.progress || null,
    recentArtifacts: run.recentArtifacts || run.artifactRefs || [],
    continuation: run.taskContinuation || null,
    error: run.error || run.blockedReason || null,
    updatedAt: run.updatedAt || null,
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
  }
}

function taskCardFromProjection(input: Record<string, unknown>): AgentPanelTaskCardSnapshot {
  return {
    source: 'taskProjection',
    scopeId: readText(input.scopeId),
    taskId: readText(input.taskId),
    title: readText(input.taskTitle) || readText(input.title) || '任务投影',
    summary: readText(input.taskSummary),
    phase: readText(input.phase),
    status: readText(input.status),
    terminalReason: readText(input.terminalReason),
    waitingFor: readText(input.waitingFor),
    canResume: typeof input.canResume === 'boolean' ? input.canResume : null,
    steps: Array.isArray(input.steps) ? input.steps as ScopeRunTaskStep[] : [],
    progress: asRecord(input.progress) as ScopeRunSkillProgress | null,
    recentArtifacts: Array.isArray(input.recentArtifacts) ? input.recentArtifacts as AgentArtifact[] : [],
    continuation: asRecord(input.continuationRef) as ScopeRunTaskContinuation | null,
    error: readText(input.error) || readText(input.blockedReason),
    updatedAt: readText(input.updatedAt),
  }
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

  if (activeRun?.softError) {
    diagnostics.push({
      id: 'soft_error_capsule',
      severity: 'warning',
      layer: 'tool',
      message: '当前运行有软失败胶囊，说明工具或外部依赖失败但运行未终止。',
      evidence: { ...activeRun.softError },
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
    diagnostics.push({
      id: 'non_done_terminal_reason',
      severity: activeRun.phase === 'done' ? 'warning' : 'error',
      layer: activeRun.terminalReason.startsWith('blocked_') ? 'tool' : 'runtime',
      message: `运行以 ${activeRun.terminalReason} 结束，需要按终态原因继续定位。`,
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
    const mode = options.mode || 'dom'
    let inputMode: 'dom' | 'store' = mode
    let sendResult: SendMessageResultLike | null = null
    let domSubmitted = false

    if (mode === 'dom') {
      domSubmitted = await submitViaDom(text)
    }

    if (!domSubmitted) {
      inputMode = 'store'
      const state = store.getState()
      state.setInputValue(text, { preserveContinuationIntent: true })
      sendResult = await state.sendMessage(text)
    }

    const after = options.waitForIdle === false
      ? await snapshot()
      : await waitForIdle({ timeoutMs: options.timeoutMs, pollMs: options.pollMs })
    const diagnostics = diagnoseAgentPanelSnapshot(after)
    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      inputMode,
      sendResult,
      before,
      after,
      diagnostics,
    }
  }

  return {
    snapshot,
    diagnose: async () => (await snapshot()).diagnostics,
    submit,
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
