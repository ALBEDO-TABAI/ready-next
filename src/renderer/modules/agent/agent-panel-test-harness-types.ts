import type { TaskCardAction } from './taskCardViewModel'
import type { TaskCardVisualState } from './task-status-vocabulary'
import type { CreateSessionResult, SendMessageResult } from '../../../shared/ipc-contracts/agent-runtime'
import type {
  AgentArtifact,
  AgentMessage,
  ChatAttachment,
  ConversationScope, ScopeRunSkillProgress,
  ScopeRunState,
  ScopeRunTaskContinuation,
  ScopeRunTaskStep,
  ScopeRunWaitingFor,
  ToolTraceEvent
} from './types'

export type SendMessageResultLike = SendMessageResult

export type StoreState = {
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
  activeSessionId?: string | null
  sessionOrder?: string[]
  sessions?: Record<string, {
    inputValue?: string
    messages?: AgentMessage[]
    conversationId?: string | null
    state?: string
  }>
  isStreaming: boolean
  foregroundBusy: boolean
  composerLocked: boolean
  streamingMessageId: string | null
  streamingRequestId: string | null
  sendMessage: (content: string, options?: {
    codexExternalReadSlice?: Record<string, unknown>
  }) => Promise<SendMessageResultLike>
  setInputValue: (value: string, options?: { preserveContinuationIntent?: boolean }) => void
  addAttachments?: (files: ChatAttachment[]) => void
  clearAttachments?: () => void
  createNewSession?: () => Promise<CreateSessionResult>
  setActiveSessionId?: (id: string) => void
}

export type StoreLike = {
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
  askUserQuestionsStatus: string | null
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
  kind: 'message_count' | 'phase' | 'tool_trace' | 'soft_error' | 'scope' | 'stream_done'
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
  requireAssistantMessage?: boolean
  allowStoreFallback?: boolean
  awaitStoreSend?: boolean
  codexExternalReadSlice?: Record<string, unknown>
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

export interface AgentPanelSessionSummary {
  activeSessionId: string | null
  sessionOrder: string[]
  currentScopeId: string | null
  sessions: Array<{
    id: string
    conversationId: string | null
    state: string | null
    inputValue: string
    messageCount: number
    pendingAskUserCount: number
  }>
}

export interface AgentPanelTestHarness {
  snapshot: () => Promise<AgentPanelSnapshot>
  diagnose: () => Promise<AgentPanelDiagnostic[]>
  submit: (text: string, options?: AgentPanelSubmitOptions) => Promise<AgentPanelSubmitResult>
  answerPendingAskUserQuestions: (options?: {
    strategy?: 'first'
    freeText?: string
  }) => Promise<{
    success: boolean
    cardId?: string
    answers?: Array<{ id: string; answer: string | string[] }>
    error?: string
  }>
  attachFiles: (files: AgentPanelTestAttachmentInput[]) => Promise<ChatAttachment[]>
  clearAttachments: () => void
  createSession: () => Promise<AgentPanelSnapshot>
  prepareWorkspace: (root: string, options?: { reindex?: boolean }) => Promise<AgentPanelTestWorkspaceResult>
  waitForIdle: (options?: { timeoutMs?: number; pollMs?: number }) => Promise<AgentPanelSnapshot>
  sessionSummary: () => AgentPanelSessionSummary
  createVisibleSession: () => Promise<{ ok: boolean; id?: string | null; summary: AgentPanelSessionSummary; error?: string }>
  activateSession: (id: string) => Promise<{
    ok: boolean
    id: string
    summary: AgentPanelSessionSummary
    snapshot: AgentPanelSnapshot
    error?: string
  }>
  setDocumentFixture: (input: {
    title: string
    content: string
    tabId?: string | null
  }) => Promise<{
    ok: boolean
    tabId?: string
    title?: string
    contentLength?: number
    error?: string
  }>
  events: () => AgentPanelHarnessEvent[]
  clearEvents: () => void
  dispose: () => void
}

declare global {
  interface Window {
    __READY_AGENT_TEST__?: AgentPanelTestHarness
  }
}
