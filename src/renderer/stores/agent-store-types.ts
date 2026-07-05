/**
 * agent-store-types.ts — useAgent 前置块纯移动拆分（2026-07-05 B8 式 P 级）。
 *
 * 本文件内容整块搬自 src/renderer/stores/useAgent.ts（字节原样，仅 import/export
 * 接线变动）。铁律：本文件不得 import ./useAgent 或 ./agent-store-helpers（防环）。
 */
import type {
  Agent,
  AgentMessage,
  AttachmentPreviewState,
  ChatAttachment,
  ChatConversation,
  ConversationScope,
  ScopeRunState,
  ToolTraceEvent,
} from '../modules/agent/types'
import type { TaskDisclosureState, TaskSectionKey } from '../modules/agent/taskCardViewModel'

export interface PendingContinuationIntent {
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
  childRunId?: string
}

export interface AgentSendResult {
  success: boolean
  error?: string | null
  errorKind?: string | null
  responseText?: string | null
  persistence?: {
    scope?: string | null
    message?: string | null
    attachments?: string | null
  } | null
}

export interface SendMessageResult {
  success: boolean
  shouldClearInput: boolean
  preserveInput: boolean
  errorKind?: string | null
}

/**
 * Stage V V3.3a bootstrap half-step (delivered alongside V3.3c).
 *
 * Per-session slice of state. V3.3b.1 moved the composer draft (`inputValue`),
 * V3.3b.2 moved visible messages, and the V3.3b.2 commit also landed the
 * mirror helpers `withSessionSliceAndActiveMirror` and `mirrorFromSessionSlice`
 * that project the streaming flags (`isStreaming` / `foregroundBusy` /
 * `composerLocked` / `streamingMessageId` / `streamingRequestId`),
 * `scopeRunStates`, and `taskDisclosureState` onto the active session's slice
 * and back out to the top-level fields. Top-level fields are kept as
 * read-through mirrors so existing ChatPanel/ChatInput selectors and the
 * agent-panel test harness keep working without per-consumer migration.
 *
 * Stage W W4.2-W4.4 (V3.3b.3-5) did NOT add new fields here — the slice
 * already owned them. Those commits added falsifiable behavior tests
 * (`useAgent-session-slice-migration.test.ts`) that pin the mirror invariant
 * so a future refactor cannot regress it silently. See
 * `docs/superpowers/audits/2026-05-22-w4-useagent-ownership-map/`.
 *
 * V3.3d adds `state` + `conversationId` so the listener-side direct-setState
 * routing path (`routeCardToSession`) can validate a pushed card's
 * `sessionId` is still live, and fall back via conversationId when the
 * push payload's sessionId is null / stale / unknown.
 */
export type SessionSliceState = 'live' | 'done' | 'error' | 'cancelled' | 'closed'

export interface SessionSlice {
  messages: AgentMessage[]
  pendingSendCount: number
  pendingSendFlushAt: number | null
  isStreaming: boolean
  foregroundBusy: boolean
  composerLocked: boolean
  streamingMessageId: string | null
  streamingRequestId: string | null
  scopeRunStates: Record<string, ScopeRunState>
  taskDisclosureState: Record<string, TaskDisclosureState>
  /** V3.3d — terminal exclusion set drives `isLiveSession`. */
  state: SessionSliceState
  /** V3.3d — backing field for `lookupSessionByConversation`. */
  conversationId: string | null
  /**
   * V3.3b.1 — per-session composer draft. The top-level `inputValue` field
   * is a read-through mirror of `sessions[activeSessionId].inputValue`.
   */
  inputValue: string
}

export interface AgentState {
  agents: Agent[]
  messages: AgentMessage[]
  /** EP2 P0-2 — per-scope live transient cache (scope-keyed, OUTSIDE session
   *  slices): in-flight assistant segments survive scope switches and merge
   *  back on loadScope instead of being DB-overwritten. */
  scopeLiveMessages: Record<string, AgentMessage[]>
  appendScopeLiveMessage: (scopeId: string, message: AgentMessage) => void
  appendToScopeLiveMessage: (scopeId: string, messageId: string, chunk: string) => void
  pruneScopeLiveMessages: (scopeId: string, persistedIds: ReadonlyArray<string>) => void
  currentAgent: string
  inputValue: string
  pendingContinuationIntent: PendingContinuationIntent | null
  pendingContinuationDraftAnchor: string | null
  isStreaming: boolean
  foregroundBusy: boolean
  composerLocked: boolean
  streamingMessageId: string | null
  streamingRequestId: string | null
  sessionId: string
  conversationId: string | null
  conversations: ChatConversation[]
  currentScopeId: string | null
  currentScope: ConversationScope | null
  scopes: ConversationScope[]
  scopeRunStates: Record<string, ScopeRunState>
  toolTrace: ToolTraceEvent[]
  toolTraceStatus: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  attachments: ChatAttachment[]
  filePool: ChatAttachment[]
  activeAttachmentPreview: AttachmentPreviewState | null
  sendCoalescingEnabled: boolean
  sendCoalescingWindowMs: number
  /**
   * V3.3c — top-level mirror of `sessions[activeSessionId].pendingSendCount`.
   * Source of truth lives in `sessions[id]`; the top-level value is rewritten
   * alongside every slice write so existing ChatPanel/ChatInput selectors and
   * the agent-panel test harness keep observing the active-session value.
   */
  pendingSendCount: number
  /** V3.3c — top-level mirror of `sessions[activeSessionId].pendingSendFlushAt`. */
  pendingSendFlushAt: number | null
  /** V3.3a bootstrap — per-sessionId slice store. */
  sessions: Record<string, SessionSlice>
  /** V3.3a bootstrap — active sessionId selector; nullable until first write. */
  activeSessionId: string | null
  /**
   * V3.4a — render-order list for session tabs. Source of truth for tab
   * ordering and the renderer-side ≤3 hard limit. Entries appear here in
   * the order they were created via `createNewSession`; `closeSession`
   * removes the matching id. The list is empty in the cold-start state so
   * the SessionTabs strip renders nothing (V6 fixture-compatible).
   */
  sessionOrder: string[]
  taskDisclosureState: Record<string, TaskDisclosureState>

  setAgents: (agents: Agent[]) => void
  reloadAgents: () => Promise<void>
  selectAgent: (name: string) => void
  toggleAgentSelection: (name: string) => void
  addMessage: (message: AgentMessage) => void
  appendToMessage: (id: string, chunk: string) => void
  setInputValue: (value: string, options?: { preserveContinuationIntent?: boolean }) => void
  setComposerDraft: (value: string, continuationIntent?: PendingContinuationIntent | null) => void
  clearPendingContinuationIntent: () => void
  setIsStreaming: (streaming: boolean) => void
  sendMessage: (content: string) => Promise<SendMessageResult>
  stopStreaming: () => void
  undoLastMessage: () => void
  /**
   * Stage X2.3 contract (b) — INTERNAL bootstrap path. Creates a fresh
   * local conversation scope and swaps the currently-active session
   * slice IN PLACE without growing `sessionOrder`. Used by:
   *   - `deleteConversation` (post-delete recovery for the active scope)
   *   - the `sendMessage` no-scope bootstrap (synchronizing a scope
   *     before the first IPC).
   *   - `undoLastMessage` (resets the active scope after undo).
   *
   * NOT to be called from UI controls — those go through
   * `createNewSession()` (the visible tab API). Wiring UI to this method
   * leaves the user with an "invisible" session (no chip in
   * `SessionTabs`), which is exactly the W5 item 3 failure mode.
   */
  newSession: () => void
  loadScopes: () => Promise<void>
  loadScope: (scopeId: string) => Promise<void>
  setCurrentScope: (scopeId: string) => Promise<void>
  sendMessageToScope: (scopeId: string, content: string) => Promise<void>
  clearToolTrace: () => void
  /** Phase 3: dismiss the soft-failure capsule for a given scope. */
  dismissSoftError: (scopeId: string) => void
  loadConversations: () => Promise<void>
  loadConversation: (convId: string) => Promise<void>
  deleteConversation: (convId: string) => Promise<void>
  /**
   * Rename a conversation. Awaits the persisting IPC (so a failure leaves the
   * old title visibly intact rather than silently diverging), then mirrors the
   * new title onto any open scope. Trims input; a blank title is a no-op.
   */
  renameConversation: (convId: string, title: string) => Promise<void>
  addAttachments: (files: ChatAttachment[]) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  setActiveAttachmentPreview: (preview: AttachmentPreviewState | null) => void
  loadSendPreferences: () => Promise<void>
  setSendCoalescingEnabled: (enabled: boolean) => Promise<void>
  setSendCoalescingWindowMs: (windowMs: number) => Promise<void>
  pickFiles: () => Promise<void>
  setTaskSectionExpanded: (taskKey: string, sectionKey: TaskSectionKey, expanded: boolean) => void
  toggleTaskSection: (taskKey: string, sectionKey: TaskSectionKey) => void
  /**
   * V3.4a — set the active session and mirror the per-session draft
   * (`inputValue`) onto the top-level field so existing ChatInput selectors
   * keep observing the active session's value. No-op if `id` is not present
   * in `sessionOrder` (defensive: prevents activating a closed session).
   */
  setActiveSessionId: (id: string) => void
  /**
   * V3.4a — create a fresh session slice, append its id to `sessionOrder`,
   * and switch the active session to it. Rejected (no-op) when the
   * renderer-side cap is reached (MAX_AGENT_SESSIONS *live* sessions; terminal
   * ones are pruned and never count); the caller surfaces this as a disabled
   * "+" by re-reading the live-session count.
   * Returns the newly created session id, or `null` if rejected.
   *
   * Stage X2.3 contract (b) — VISIBLE TAB API. ALL UI-reachable session
   * creation paths route through this method:
   *   - SessionTabs "+ 新建" button.
   *   - ChatPanel header `handleNewSession`.
   *   - ChatPanel `handleChannelSelect` when landing on an empty local
   *     channel.
   *   - ChatPanel boot effect when `scopes.length === 0`.
   *
   * Two notes vs the legacy `newSession()`:
   *   1. This appends to `sessionOrder` — the new tab is immediately
   *      visible in `SessionTabs` (whereas `newSession()` swaps in place).
   *   2. This respects the shared MAX_AGENT_SESSIONS cap (live sessions only);
   *      `newSession()` does not.
   */
  createNewSession: () => string | null
  /**
   * V3.4a — drop a session from the tab strip. Removes the entry from
   * `sessions` and `sessionOrder`; when `id === activeSessionId`, switches
   * the active session to the first remaining tab (or `null` if none).
   * No-op if `id` is not present.
   */
  closeSession: (id: string) => void
}
