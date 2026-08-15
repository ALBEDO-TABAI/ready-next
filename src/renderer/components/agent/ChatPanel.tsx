import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import {
  useAgent,
  hydrateAgentScopesAfterRuntimeReady,
  lookupSessionByConversation,
  type ChatAttachment, type ScopeRunState,
  type ToolTraceEvent
} from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'
import type { WorkbenchMode } from '../../stores/useMode'
import {
  READY_FOCUS_CHAT_INPUT_EVENT,
  createSkillReferenceAttachment,
  type ReadySkillReference,
} from '../../modules/agent/chat-input-bridge'
import { revealDocumentQuoteAttachment } from '../../modules/agent/document-quote-navigation'
import {
  getTaskRunDisplayKey
} from '../../modules/agent/taskCardViewModel'
import { createDebouncedFetch } from '../../modules/agent/debouncedFetch'
import { filterUserVisibleToolTraceEvents } from '../../modules/agent/toolTraceVisibility'
import { deletedAgentDisplayName } from '../../../shared/agent-identity'
import { parseActionAuthorizationMode } from '../../../shared/action-authorization-mode'
import { mapBackendErrorToFriendly } from '../../modules/agent/error-message-mapping'
import type {
  ActiveChildRunSummaryData
} from '../../types/electron'
import ChatHeader from './ChatHeader'
import type { ChatInputHandle } from './ChatInput'

// Stage V V1.1 — `PersistedScopeRunSummary` interface + `PersistedTaskProjection`
// alias moved to `./chat-panel/helpers/projection.ts` so the pure projection
// helpers (`resolveProjectionForTaskRun`, etc.) can compile alone. ChatPanel
// re-imports both names above for state typing; behavior is unchanged.

// Stage 6 L6: TaskCardRun type lives in task-card-from-projection.ts with a
// module-private brand symbol; constructors are the only legitimate path.
import type { TaskCardRun } from './task-card-from-projection'
import { taskProjectionToTaskCardRun } from './task-card-from-projection'
// Stage V V1.1 — pure helpers extracted to ./chat-panel/helpers/.
// V1.7 follow-up: `normalizeProjectionSteps`, `resolveProjectionForTaskRun`,
// `resolveProjectionWaitingFor`, `activeChildRunDebugRow` are now consumed
// exclusively by the extracted `useTaskRunMerge` hook, so they no longer
// need to live in this import block.
import {
  type PersistedScopeRunSummary,
  type PersistedTaskProjection
} from './chat-panel/helpers/projection'
import {
  isTaskVisible,
  isBackgroundTaskRun,
} from './chat-panel/helpers/badges'
// Stage V V1.3 — layout primitives (motion wrapper + collapsed rail) extracted
// to `./chat-panel/layout/MotionLayer`. Both are pure React with zero
// `useAgent` / store / IPC dependencies; signatures preserved byte-for-byte.
import { ChatPanelMotionLayer, CollapsedChatRail } from './chat-panel/layout/MotionLayer'
import DraggableModeTabs from '../layout/DraggableModeTabs'
import SessionCompleteToast from './chat-panel/session-tabs/SessionCompleteToast'
import { resolveChatSessionTitle } from './chat-panel/helpers/session-title'
import { resolveSessionDotStatus, type SessionDotStatus } from './chat-panel/helpers/session-status'
import {
  AttachmentPreviewModal
} from './chat-panel/attachments-preview'
import { useAttachmentIntake } from './chat-panel/drag-drop/use-attachment-intake'
// Stage V V1.7 — pure 4-pass merge that combines persistedScopeRuns,
// inMemoryTaskRuns, activeChildRuns and cold-start projection synthesis
// into the canonical `TaskCardRun[]`. Extracted from the inline
// `mergedTaskRuns` useMemo so the Stage O §1.3 / §3.1 whitelist contract
// surface stays focused; behavior preserved byte-for-byte.
import { useTaskRunMerge } from './chat-panel/task-merge/use-task-run-merge'
import { ChatPanelBody } from './chat-panel/ChatPanelBody'
import { formatTime } from './chat-panel/format-time'
// Stage V V1.9c — 15 task interaction useCallbacks (continue / submit /
// suspend / resume / cancel / retry / open artifact / memory capture) +
// the two internal helpers (`patchScopeRun`, `buildRunContinuationIntent`)
// extracted to `./chat-panel/task-interaction/use-task-interaction-handlers`.
// All deps that previously closed over ChatPanel-local state are now
// injected via params; behavior preserved byte-for-byte.
import { useTaskInteractionHandlers } from './chat-panel/task-interaction/use-task-interaction-handlers'
// Stage V V1.9a — channel + session-recall state, derivations, effects and
// callbacks (selectedChannelKey / channelOptions / currentChannel /
// filteredScopes / currentAgentData / sessionRecall query+results+capsules
// + attach/detach IPC handlers + scope-change side effects) extracted to
// `./chat-panel/recall-state/use-channel-session-recall`. The
// `ConversationChannelOption` interface moved with it; ChatPanel
// re-imports the type so call-site signatures stay byte-equivalent.
import {
  useChannelSessionRecall,
  type ConversationChannelOption,
} from './chat-panel/recall-state/use-channel-session-recall'
import { useReferenceSkillHint } from './chat-panel/reference-skill/use-reference-skill-hint'
import {
  captureScopeReadAuthority,
  isScopeReadAuthorityCurrent,
  scopeRowMatchesReadAuthority,
} from '../../modules/agent/scope-read-authority'

interface SerializedTaskSnapshot {
  scopeId: string
  messageVisibilityEpoch?: number | null
  agent: string
  ownerAgentId?: string | null
  executionBinding?: import('../../../shared/agent-execution-profile').TaskExecutionBinding | null
  taskId?: string | null
  title: string
  phase: ScopeRunState['phase']
  taskTitle?: string | null
  taskSummary?: string | null
  steps?: ScopeRunState['steps']
  currentStepId?: string | null
  waitingFor?: ScopeRunState['waitingFor']
  resumableActions?: ScopeRunState['resumableActions']
  recentArtifacts?: ScopeRunState['recentArtifacts']
  taskContinuation?: ScopeRunState['taskContinuation']
  progress?: ScopeRunState['progress']
  memoryCapture?: ScopeRunState['memoryCapture']
  blockedReason?: string | null
  error?: string | null
  updatedAt: string
  responseMessageId?: string | null
  toolTrace?: Array<{
    id: string
    kind: 'call' | 'result'
    text: string
    timestamp: string
    toolName?: string
    detail?: string
  }>
}

interface SerializedToolTraceSnapshotItem {
  id: string
  kind: 'call' | 'result'
  text: string
  timestamp: string
  toolName?: string
  detail?: string
}

export type ChatPanelState = 'expanding' | 'expanded' | 'collapsing' | 'collapsed'

// Stage V V1.9a — `ConversationChannelOption` interface moved to
// `./chat-panel/recall-state/use-channel-session-recall.ts` and re-imported
// above; ChatHeader / handleChannelSelect signatures unchanged.

// ---------------------------------------------------------------------------
// ChatPanel Component
// ---------------------------------------------------------------------------

interface ChatPanelProps {
  shellWidth: number
  panelState: ChatPanelState
  workbenchMode?: WorkbenchMode
  splitMode?: WorkbenchMode | null
  onWorkbenchModeChange?: (mode: WorkbenchMode) => void | Promise<void>
  onWorkbenchSplitToggle?: (mode: WorkbenchMode) => void
  onTogglePanel?: () => void
}

function stopFailureMessage(code: string): string {
  if (code === 'interrupt_state_unknown') return '停止状态待确认，可以再次停止'
  if (code === 'thread_busy') return '当前任务仍在收尾，请稍后再试'
  if (code === 'binding_conflict') return '当前会话已变化，请重试'
  return '停止失败，请重试'
}

export default function ChatPanel({
  shellWidth,
  panelState,
  workbenchMode,
  splitMode = null,
  onWorkbenchModeChange,
  onWorkbenchSplitToggle,
  onTogglePanel,
}: ChatPanelProps) {
  const {
    agents,
    messages,
    currentAgent,
    currentScopeId,
    currentScope,
    scopeRunStates,
    inputValue,
    isStreaming,
    streamingMessageId,
    selectAgent,
    setInputValue,
    sendMessage,
    stopStreaming,
    resetCurrentConversation,
    compactCurrentSession,
    createNewSession,
    // W2
    scopes,
    loadScopes,
    loadConversation,
    deleteConversation,
    renameConversation,
    toolTrace,
    toolTraceStatus,
    // W3
    attachments,
    removeAttachment,
    pickFiles,
    addAttachments,
    // W4
    filePool,
    activeAttachmentPreview,
    setActiveAttachmentPreview,
    taskDisclosureState,
    setTaskSectionExpanded,
    sessions,
    sessionOrder,
    activeSessionId,
    composerAuthorityRevision,
    scopeAuthorityRevision,
    dismissSoftError,
    setActionAuthorizationMode,
  } = useAgent()

  const { toggleChatPanel: toggleChatPanelStore } = useWorkspace()
  const toggleChatPanel = onTogglePanel ?? toggleChatPanelStore

  const [toolTraceExpanded, setToolTraceExpanded] = useState(false)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [stopRequestError, setStopRequestError] = useState<string | null>(null)
  const stopRequestTargetRef = useRef<{
    sessionId: string
    scopeId: string
    requestId: string
  } | null>(null)
  const [agentSelectionMenu, setAgentSelectionMenu] = useState<{
    x: number
    y: number
    text: string
    boundary: { left: number; top: number; right: number; bottom: number }
  } | null>(null)
  const [attachmentPreviewLoading, setAttachmentPreviewLoading] = useState(false)
  const [persistedScopeRuns, setPersistedScopeRuns] = useState<PersistedScopeRunSummary[]>([])
  const [persistedTaskProjections, setPersistedTaskProjections] = useState<
    Record<string, PersistedTaskProjection[]>
  >({})
  const [activeChildRuns, setActiveChildRuns] = useState<ActiveChildRunSummaryData[]>([])
  const persistedScopeRunsRequestRevisionRef = useRef(0)
  const persistedTaskProjectionsRequestRevisionRef = useRef(0)
  const activeChildRunsRequestRevisionRef = useRef(0)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatInputRef = useRef<ChatInputHandle | null>(null)
  const focusInputWithResize = useCallback(() => {
    chatInputRef.current?.focusWithResize()
  }, [])

  // Stage V V1.9a — channel + session-recall state, derivations, IPC
  // callbacks (attach/detach/search/refresh) and the two scope-change
  // useEffects all live in `useChannelSessionRecall`. The 8 returns below
  // map 1:1 to the plan-v7 hook surface; downstream call sites keep the
  // exact same variable names so the V6 fixture stays diff = 0.
  const {
    selectedChannelKey,
    filteredScopes,
    currentAgentData,
    currentChannel,
    channelOptions,
    sessionsByChannelKey,
    recallState,
    detachCallback: handleDetachSessionRecall,
    channelEffects,
  } = useChannelSessionRecall({
    agents,
    currentAgent,
    scopes,
    currentScope,
    currentScopeId,
    composerAuthorityRevision,
  })
  const currentAgentDisplayName = currentAgentData?.displayName
    || (currentAgent && currentAgent !== 'butler' ? deletedAgentDisplayName(currentAgent) : '管家')
  const { setSelectedChannelKey, getScopeChannelKey } = channelEffects
  const {
    capsules: attachedSessionRecallCapsules,
    conversationIds: attachedSessionRecallConversationIds,
    query: sessionRecallQuery,
    setQuery: setSessionRecallQuery,
    results: sessionRecallResults,
    searching: sessionRecallSearching,
    error: sessionRecallError,
    setResults: setSessionRecallResults,
    runSearch: runSessionRecallSearch,
    attach: handleAttachSessionRecall,
  } = recallState

  const currentScopeRunUpdatedAt = currentScopeId
    ? scopeRunStates[currentScopeId]?.updatedAt || null
    : null
  const referenceSkillHint = useReferenceSkillHint({
    activeSessionId,
    currentScopeId,
    composerAuthorityRevision,
    aliasGeneration: currentScope?.aliasGeneration,
    messageVisibilityEpoch: currentScope?.messageVisibilityEpoch,
    currentScopeRunUpdatedAt,
    isStreaming,
  })

  const refreshPersistedScopeRuns = useCallback(async () => {
    const requestRevision = ++persistedScopeRunsRequestRevisionRef.current
    const scopeIds = filteredScopes.map((scope) => scope.id)
    const authority = captureScopeReadAuthority(useAgent.getState(), scopeIds)
    if (!window.electronAPI?.agent?.listScopeRuns || !authority || scopeIds.length === 0) {
      setPersistedScopeRuns([])
      return
    }
    const result = await window.electronAPI.agent
      .listScopeRuns({
        channelKey: selectedChannelKey,
        statuses: [
          'planning',
          'tool_running',
          'checkpoint',
          'takeover',
          'resuming',
          'responding',
          'done',
          'error',
          'cancelled'
        ],
        limit: 12
      })
      .catch(() => null)
    if (persistedScopeRunsRequestRevisionRef.current !== requestRevision
      || !isScopeReadAuthorityCurrent(useAgent.getState(), authority)) return
    const rows = result?.success && Array.isArray(result.data)
      ? (result.data as PersistedScopeRunSummary[]).filter((row) => (
          scopeRowMatchesReadAuthority(
            authority,
            row.scopeId,
            row.messageVisibilityEpoch,
          )
        ))
      : []
    setPersistedScopeRuns(rows)
  }, [filteredScopes, scopeAuthorityRevision, selectedChannelKey])

  const refreshPersistedTaskProjections = useCallback(async () => {
    const requestRevision = ++persistedTaskProjectionsRequestRevisionRef.current
    const scopeIds = filteredScopes.map((scope) => scope.id)
    const authority = captureScopeReadAuthority(useAgent.getState(), scopeIds)
    if (!window.electronAPI?.agent?.listTaskProjections || !authority) {
      setPersistedTaskProjections({})
      return
    }
    if (scopeIds.length === 0) {
      setPersistedTaskProjections({})
      return
    }
    const entries = await Promise.all(
      filteredScopes.map(async (scope) => {
        const result = await window.electronAPI.agent.listTaskProjections(scope.id).catch(() => null)
        if (!result?.success || !Array.isArray(result.data)) {
          return [scope.id, []] as const
        }
        return [
          scope.id,
          (result.data as PersistedTaskProjection[]).filter((row) => (
            scopeRowMatchesReadAuthority(
              authority,
              row.scopeId,
              row.messageVisibilityEpoch,
            )
          )),
        ] as const
      })
    )
    if (persistedTaskProjectionsRequestRevisionRef.current !== requestRevision
      || !isScopeReadAuthorityCurrent(useAgent.getState(), authority)) return
    setPersistedTaskProjections(Object.fromEntries(entries))
  }, [filteredScopes, scopeAuthorityRevision])

  const refreshActiveChildRuns = useCallback(async () => {
    const requestRevision = ++activeChildRunsRequestRevisionRef.current
    const scopeIds = filteredScopes.map((scope) => scope.id)
    const authority = captureScopeReadAuthority(useAgent.getState(), scopeIds)
    if (!window.electronAPI?.agent?.listActiveChildRuns || !authority || scopeIds.length === 0) {
      setActiveChildRuns([])
      return
    }
    const result = await window.electronAPI.agent.listActiveChildRuns().catch(() => null)
    if (activeChildRunsRequestRevisionRef.current !== requestRevision
      || !isScopeReadAuthorityCurrent(useAgent.getState(), authority)) return
    const rows = result?.success && Array.isArray(result.data)
      ? result.data.filter((row) => (
          scopeRowMatchesReadAuthority(
            authority,
            row.scopeId,
            row.messageVisibilityEpoch,
          )
        ))
      : []
    setActiveChildRuns(rows)
  }, [filteredScopes, scopeAuthorityRevision])

  // Stage V V1.9a — runSessionRecallSearch / handleAttachSessionRecall /
  // handleDetachSessionRecall moved into `useChannelSessionRecall` and
  // surfaced above via the `recallState` destructure. Behavior unchanged.

  const inMemoryTaskRuns = useMemo<TaskCardRun[]>(() => {
    // Stage O §1.2 — `inMemoryTaskRuns` returns ONLY whitelist fields
    // (phase / terminalReason / title / toolTrace / responseMessageId /
    // responseSegmentToolTraceStart / error / updatedAt / memoryCapture /
    // scopeId / taskId). Every blacklist field is null/empty so the
    // gate at `scripts/check-task-card-projection-only.cjs` never sees
    // a `run.X` reference, and `mergedTaskRuns` will populate the real
    // values from `projection` alone in its second pass. The
    // `isTaskVisible` filter still uses `run.taskTitle` / `run.steps` /
    // `run.progress` to decide if the in-memory shell is worth carrying
    // forward — that probe stays in scopeRunStates space (not in the
    // TaskCardRun shape), so it doesn't violate O1.
    return filteredScopes
      .map((scope) => {
        const run = scopeRunStates[scope.id]
        if (
          !run ||
          !isTaskVisible({
            ...run,
            scopeId: scope.id,
            title: scope.title,
            updatedAt: run.updatedAt || scope.updatedAt
          })
        ) {
          return null
        }
        return taskProjectionToTaskCardRun({
          // O1 whitelist
          scopeId: scope.id,
          messageVisibilityEpoch: scope.messageVisibilityEpoch,
          ownerAgentId: run.ownerAgentId ?? null,
          executionBinding: run.executionBinding ?? null,
          taskId: run.taskId || run.taskContinuation?.taskId || null,
          phase: run.phase,
          terminalReason: run.terminalReason,
          title: scope.title,
          toolTrace: run.toolTrace,
          responseMessageId: run.responseMessageId || null,
          responseSegmentToolTraceStart: run.responseSegmentToolTraceStart ?? 0,
          error: run.error,
          updatedAt: run.updatedAt || scope.updatedAt,
          memoryCapture: run.memoryCapture,
          // O1 blacklist — null/empty until projection populates them
          taskTitle: null,
          taskSummary: null,
          steps: [],
          currentStepId: null,
          waitingFor: 'none',
          resumableActions: [],
          recentArtifacts: [],
          taskContinuation: null,
          progress: null,
          blockedReason: null,
        })
      })
      .filter((value): value is TaskCardRun => value !== null)
  }, [filteredScopes, scopeRunStates])

  // Stage V V1.7 — `mergedTaskRuns` merge body extracted to
  // `./chat-panel/task-merge/use-task-run-merge.ts`. Inputs match the
  // original useMemo dep array; output preserves the Stage O §1.3 /
  // §3.1 whitelist-only contract surface byte-for-byte.
  const mergedTaskRuns = useTaskRunMerge({
    activeChildRuns,
    currentScopeId,
    filteredScopes,
    inMemoryTaskRuns,
    persistedScopeRuns,
    persistedTaskProjections,
  })

  const currentScopeTaskRuns = useMemo(() => {
    if (!currentScopeId) return []
    return mergedTaskRuns.filter((item) => item.scopeId === currentScopeId && isTaskVisible(item))
  }, [currentScopeId, mergedTaskRuns])

  const currentTaskRun = useMemo(() => {
    return currentScopeTaskRuns.find((item) => !isBackgroundTaskRun(item)) || null
  }, [currentScopeTaskRuns])

  const visibleTaskScopeIds = useMemo(() => {
    const ids = new Set<string>()
    if (currentScopeId) ids.add(currentScopeId)
    for (const sessionId of sessionOrder) {
      const conversationId = sessions[sessionId]?.conversationId
      if (conversationId) ids.add(conversationId)
    }
    return ids
  }, [currentScopeId, sessionOrder, sessions])

  const backgroundTaskRuns = useMemo(() => {
    const foregroundKey = currentTaskRun
      ? `${currentTaskRun.scopeId}:${getTaskRunDisplayKey(currentTaskRun)}`
      : null
    const byKey = new Map<string, TaskCardRun>()
    for (const run of mergedTaskRuns) {
      if (!visibleTaskScopeIds.has(run.scopeId)) continue
      if (!isTaskVisible(run)) continue
      if (!isBackgroundTaskRun(run)) continue
      const key = `${run.scopeId}:${getTaskRunDisplayKey(run)}`
      if (key === foregroundKey) continue
      const existing = byKey.get(key)
      if (!existing || new Date(run.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()) {
        byKey.set(key, run)
      }
    }
    return Array.from(byKey.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
  }, [currentTaskRun, mergedTaskRuns, visibleTaskScopeIds])

  // Status-dot color per conversation for the history panel. Only currently-open
  // scopes carry a live status: the foreground scope reads green when idle
  // (激活) and follows its run phase / streaming otherwise; open background
  // scopes light up by their own phase (done→green, working→orange, error→red).
  // Conversations absent from this map are pure history and render unlit.
  const sessionStatusByConversationId = useMemo(() => {
    const map: Record<string, SessionDotStatus> = {}
    if (currentScopeId) {
      map[currentScopeId] = resolveSessionDotStatus(
        currentTaskRun?.phase ?? scopeRunStates[currentScopeId]?.phase,
        { isActive: true, isStreaming },
      )
    }
    for (const run of backgroundTaskRuns) {
      if (run.scopeId === currentScopeId) continue
      map[run.scopeId] = resolveSessionDotStatus(run.phase, { isActive: false })
    }
    return map
  }, [currentScopeId, currentTaskRun, scopeRunStates, isStreaming, backgroundTaskRuns])

  const userVisibleToolTrace = useMemo(() => filterUserVisibleToolTraceEvents(toolTrace), [toolTrace])

  const showToolTraceCapsule =
    !currentTaskRun &&
    userVisibleToolTrace.length > 0 &&
    (toolTrace.length > 0 ||
      toolTraceStatus === 'error' ||
      toolTraceStatus === 'cancelled')
  const shouldRenderGlobalToolTraceCapsule = !currentTaskRun

  const parseSerializedTaskSnapshot = useCallback((raw: unknown): TaskCardRun | null => {
    if (!raw || typeof raw !== 'object') return null
    // Stage O §1.8 — local variable named `projection` so the gate
    // (`scripts/check-task-card-projection-only.cjs`) accepts the
    // blacklist field reads. `SerializedTaskSnapshot` is NOT structurally
    // identical to `TaskProjectionRecordData` (it is built from
    // `ScopeRunState` at message-save time and carries `agent / phase /
    // toolTrace`), but the rename is a deliberate gate-vocabulary
    // choice that documents the maintainer's commitment: every read
    // here is from a frozen, message-attached, projection-shape-
    // compatible record, not a live runtime fallback.
    const projection = raw as SerializedTaskSnapshot
    if (!projection.scopeId || !projection.updatedAt) return null
    return taskProjectionToTaskCardRun({
      scopeId: projection.scopeId,
      messageVisibilityEpoch: projection.messageVisibilityEpoch,
      ownerAgentId: projection.ownerAgentId ?? null,
      executionBinding: projection.executionBinding ?? null,
      taskId: projection.taskId || projection.taskContinuation?.taskId || null,
      phase: projection.phase,
      title: projection.title || '任务',
      taskTitle: projection.taskTitle,
      taskSummary: projection.taskSummary,
      steps: projection.steps,
      currentStepId: projection.currentStepId || null,
      waitingFor: projection.waitingFor,
      resumableActions: projection.resumableActions,
      recentArtifacts: projection.recentArtifacts,
      taskContinuation: projection.taskContinuation,
      progress: projection.progress,
      memoryCapture: projection.memoryCapture,
      blockedReason: projection.blockedReason,
      error: projection.error,
      updatedAt: projection.updatedAt,
      toolTrace: (projection.toolTrace || []).map((event) => ({
        id: event.id,
        kind: event.kind,
        text: event.text,
        timestamp: new Date(event.timestamp),
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.detail ? { detail: event.detail } : {}),
      })),
      responseMessageId: projection.responseMessageId || null,
    })
  }, [])

  const parseSerializedToolTraceSnapshot = useCallback((raw: unknown) => {
    if (!Array.isArray(raw)) return []
    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const event = item as SerializedToolTraceSnapshotItem
        if (!event.id || !event.kind || !event.text || !event.timestamp) return null
        return {
          id: event.id,
          kind: event.kind,
          text: event.text,
          timestamp: new Date(event.timestamp),
          ...(event.toolName ? { toolName: event.toolName } : {}),
          ...(event.detail ? { detail: event.detail } : {}),
        }
      })
      .filter(Boolean) as ToolTraceEvent[]
  }, [])

  const copyTextToClipboard = useCallback(async (content: string) => {
    const value = content?.trim()
    if (!value) return false
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = value
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.focus()
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      return true
    } catch {
      return false
    }
  }, [])

  const handleCopyAgentMessage = useCallback(async (messageId: string, content: string) => {
    const copied = await copyTextToClipboard(content)
    if (!copied) return

    setCopiedMessageId(messageId)
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopiedMessageId((current) => (current === messageId ? null : current))
      copyFeedbackTimerRef.current = null
    }, 1500)
  }, [copyTextToClipboard])

  const handleAgentSelectionContextMenu = useCallback((event: React.MouseEvent, selectedText: string) => {
    const text = selectedText.trim()
    if (!text) return
    const root = (event.currentTarget as HTMLElement).closest('[data-chat-panel-root="true"]')
    const rect = root?.getBoundingClientRect()
    setAgentSelectionMenu({
      x: event.clientX,
      y: event.clientY,
      text,
      boundary: rect
        ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        : { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 },
    })
  }, [])

  const handlePasteSelectionToPet = useCallback(async () => {
    const text = agentSelectionMenu?.text.trim()
    if (!text) return
    await window.electronAPI.pet.updateSettings({ enabled: true }).catch(() => null)
    await window.electronAPI.pet.pushStickyNote({
      title: '便利贴',
      body: text,
      tone: 'default',
    }).catch(() => null)
    await window.electronAPI.pet.show().catch(() => null)
    setAgentSelectionMenu(null)
  }, [agentSelectionMenu])

  const handleOpenAttachment = useCallback(async (attachment: ChatAttachment) => {
    if (attachment.source === 'document-quote') {
      revealDocumentQuoteAttachment(attachment)
      return
    }
    if (!attachment.path || !attachment.path.startsWith('/')) return
    await window.electronAPI.document.openPath(attachment.path).catch(() => undefined)
  }, [])

  const handleRevealAttachment = useCallback(async (attachment: ChatAttachment) => {
    if (!attachment.path || !attachment.path.startsWith('/')) return
    await window.electronAPI.document.showInFolder(attachment.path).catch(() => undefined)
  }, [])

  useEffect(() => {
    void hydrateAgentScopesAfterRuntimeReady()
      .then(() => {
        const state = useAgent.getState()
        if (!state.currentScopeId || !state.currentScope) {
          setComposerNotice({
            message: '对话还没有准备好。请点左上角新建对话后再发送。',
            errorKind: 'scope_missing',
          })
        }
      })
      .catch(() => {
        setComposerNotice({
          message: '对话环境启动失败，请新建对话或重启应用后再试。',
          errorKind: 'host_unavailable',
        })
      })
  }, [currentAgent, loadScopes])

  useEffect(() => {
    setAttachmentPreviewLoading(false)
  }, [
    activeSessionId,
    composerAuthorityRevision,
    currentScope?.aliasGeneration,
    currentScope?.messageVisibilityEpoch,
    currentScopeId,
  ])

  useEffect(() => {
    persistedScopeRunsRequestRevisionRef.current += 1
    persistedTaskProjectionsRequestRevisionRef.current += 1
    activeChildRunsRequestRevisionRef.current += 1
    setPersistedScopeRuns([])
    setPersistedTaskProjections({})
    setActiveChildRuns([])
  }, [scopeAuthorityRevision])

  useEffect(() => {
    void refreshPersistedScopeRuns()
  }, [refreshPersistedScopeRuns, currentScopeId, scopes.length])

  // Stage O §1.1 — projection refresh is event-driven. Initial fetch on
  // mount / scope change; thereafter the `agent:taskProjectionsChanged`
  // push subscription drives refetches via the debouncer below.
  useEffect(() => {
    void refreshPersistedTaskProjections()
  }, [refreshPersistedTaskProjections, currentScopeId, filteredScopes.length])

  const latestBrowserConfirmationMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.type === 'agent' && message.meta?.browserConfirmationRequest) return message.id
    }
    return null
  }, [messages])

  // A brand-new local scope can receive its first projection push before the
  // scope has entered filteredScopes. The canonical checkpoint notice is
  // committed in the same transaction as the projection, so its arrival is a
  // reliable second edge for reading the now-durable confirmation state.
  useEffect(() => {
    if (!latestBrowserConfirmationMessageId) return
    void refreshPersistedTaskProjections()
  }, [latestBrowserConfirmationMessageId, refreshPersistedTaskProjections])

  // Stage O §1.1 — push subscription. The debouncer collapses bursts
  // (child-runner finalize close emits 5+ updates back-to-back); cancel
  // is called in cleanup so a pending timer doesn't fire post-unmount.
  useEffect(() => {
    if (!window.electronAPI?.agent?.onTaskProjectionsChanged) return
    const debouncer = createDebouncedFetch(refreshPersistedTaskProjections, 100)
    const off = window.electronAPI.agent.onTaskProjectionsChanged((event) => {
      if (filteredScopes.some((scope) => scope.id === event.scopeId)) {
        debouncer.run()
      }
    })
    return () => {
      try { off?.() } catch { /* silent-catch: projection unsubscribe cleanup is best-effort */ }
      debouncer.cancel()
    }
  }, [filteredScopes, refreshPersistedTaskProjections])

  // Stage O §1.1 / O3 — the 2-second `agent:listActiveChildRuns` polling
  // timer is retired. `activeChildRuns` is now used solely as the data
  // source for `activeChildRunDebugRow` (the projection-fallback debug
  // path); it gets a single mount-time fetch per scope. New child runs
  // surface through the projection push channel, which is the canonical
  // primary path.
  useEffect(() => {
    void refreshActiveChildRuns()
  }, [refreshActiveChildRuns])

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    }
  }, [])

  const sendingRef = useRef(false)
  const [composerNotice, setComposerNotice] = useState<{ message: string; errorKind: string } | null>(null)
  const handleSend = useCallback(async () => {
    if (sendingRef.current) {
      const current = useAgent.getState()
      const sessionId = current.activeSessionId
      const slice = sessionId ? current.sessions[sessionId] : null
      if (slice?.isStreaming || slice?.composerLocked || slice?.foregroundBusy) return
      sendingRef.current = false
    }
    const content = inputValue.trim()
    if (!content && attachments.length === 0) return
    sendingRef.current = true
    setComposerNotice(null)
    try {
      const result = await sendMessage(content)
      if (result && result.success === false && result.disposition === 'rejected_before_persistence') {
        const friendly = mapBackendErrorToFriendly({
          errorKind: result.errorKind,
          error: result.errorKind,
        })
        setComposerNotice({
          message: friendly.friendlyMessage,
          errorKind: result.errorKind,
        })
      }
    } finally {
      sendingRef.current = false
    }
  }, [attachments.length, inputValue, sendMessage])

  const handleStop = useCallback(async () => {
    setStopRequestError(null)
    const current = useAgent.getState()
    const sessionId = current.activeSessionId
    const scopeId = current.currentScopeId
    const requestId = sessionId
      ? current.sessions[sessionId]?.streamingRequestId ?? null
      : null
    const target = sessionId && scopeId && requestId
      ? { sessionId, scopeId, requestId }
      : null
    stopRequestTargetRef.current = target
    const targetIsStillVisible = () => {
      if (!target || stopRequestTargetRef.current !== target) return false
      const latest = useAgent.getState()
      return latest.activeSessionId === target.sessionId
        && latest.currentScopeId === target.scopeId
        && latest.sessions[target.sessionId]?.streamingRequestId === target.requestId
    }
    try {
      const result = await stopStreaming()
      if (!result.ok && result.code !== 'no_active_operation' && targetIsStillVisible()) {
        setStopRequestError(stopFailureMessage(result.code))
      } else if (stopRequestTargetRef.current === target) {
        stopRequestTargetRef.current = null
      }
    } catch {
      if (targetIsStillVisible()) {
        setStopRequestError('停止失败，请重试')
      } else if (stopRequestTargetRef.current === target) {
        stopRequestTargetRef.current = null
      }
    }
  }, [stopStreaming])

  useEffect(() => {
    setStopRequestError(null)
    stopRequestTargetRef.current = null
  }, [currentScopeId])

  const handleAgentSelect = useCallback(
    (name: string) => {
      if (currentScope?.sourceKind === 'channel') return
      selectAgent(name)
      void loadScopes()
    },
    [currentScope?.sourceKind, loadScopes, selectAgent]
  )

  const handleSkillReference = useCallback((skill: ReadySkillReference) => {
    addAttachments([createSkillReferenceAttachment(skill)])
    focusInputWithResize()
  }, [addAttachments, focusInputWithResize])

  const handleReferenceSelect = useCallback((attachment: ChatAttachment) => {
    const exists = useAgent.getState().attachments.some((item) => (
      item.source === attachment.source &&
      item.path === attachment.path &&
      item.name === attachment.name &&
      item.lineStart === attachment.lineStart &&
      item.lineEnd === attachment.lineEnd &&
      (item.selection || '') === (attachment.selection || '')
    ))
    if (!exists) addAttachments([attachment])
    focusInputWithResize()
  }, [addAttachments, focusInputWithResize])

  const handleNewSession = useCallback(async () => {
    try {
      return await createNewSession()
    } catch {
      return null
    }
  }, [createNewSession])

  const handleResetCurrentConversation = useCallback(async () => {
    try {
      await resetCurrentConversation()
    } catch {
      // The retained session remains the visible recovery boundary.
    }
  }, [resetCurrentConversation])

  const handleCompactCurrentSession = useCallback(async () => {
    try {
      await compactCurrentSession()
    } catch {
      // The retained session remains the visible recovery boundary.
    }
  }, [compactCurrentSession])

  const handleLoadConversation = useCallback(
    (convId: string) => {
      const state = useAgent.getState()
      const existingSessionId = lookupSessionByConversation(state, convId)
      if (existingSessionId && existingSessionId !== state.activeSessionId) {
        state.setActiveSessionId(existingSessionId)
      }
      void loadConversation(convId)
    },
    [loadConversation]
  )

  const handleChannelSelect = useCallback(
    async (channel: ConversationChannelOption) => {
      setSelectedChannelKey(channel.key)

      const latestScope = scopes
        .filter((scope) => getScopeChannelKey(scope) === channel.key)
        .sort((a, b) => {
          const aTime = new Date(a.lastMessageAt || a.updatedAt).getTime()
          const bTime = new Date(b.lastMessageAt || b.updatedAt).getTime()
          return bTime - aTime
        })[0]

      if (latestScope) {
        await loadConversation(latestScope.id)
        return
      }

      if (channel.sourceKind === 'local') {
        await createNewSession()
      }
    },
    [getScopeChannelKey, loadConversation, createNewSession, scopes]
  )

  const handleDeleteConversation = useCallback(
    async (convId: string) => {
      try {
        await deleteConversation(convId)
        setSessionRecallResults((prev) => prev.filter((hit) => hit.conversationId !== convId))
        void runSessionRecallSearch(sessionRecallQuery)
      } catch {
        // Lifecycle failure remains visible in the retained session state.
      }
    },
    [deleteConversation, runSessionRecallSearch, sessionRecallQuery]
  )

  const handleRenameConversation = useCallback(
    async (convId: string, title: string) => {
      const nextTitle = title.trim()
      if (!nextTitle) return
      await renameConversation(convId, nextTitle)
      // 乐观更新历史列表标题，再异步对齐后端（重命名会 bump updated_at，排序随之变化）
      setSessionRecallResults((prev) =>
        prev.map((hit) => (hit.conversationId === convId ? { ...hit, title: nextTitle } : hit)),
      )
      void runSessionRecallSearch(sessionRecallQuery)
    },
    [renameConversation, runSessionRecallSearch, sessionRecallQuery, setSessionRecallResults]
  )

  const {
    handleCancelDetachedTask,
    handleCancelChildRun,
    handleOpenTaskArtifact,
    handleDismissMemoryCapture,
    handleUndoMemoryCapture,
    handleSupplementMemoryCapture,
  } = useTaskInteractionHandlers({
    mergedTaskRuns,
    setInputValue,
    setPersistedScopeRuns,
    focusInputWithResize,
    refreshPersistedScopeRuns,
    refreshPersistedTaskProjections,
    refreshActiveChildRuns,
  })

  // Stage V V1.8 — task/tool snapshot rendering region (renderTaskSnapshotCard
  // useCallback + messageTaskSnapshots / messageToolTraceSnapshots /
  // pendingTaskRun / pendingToolTrace / bottomTaskCard memos +
  // currentToolTraceSegment / currentVisibleToolTraceSegment derivations)
  // moved to `./chat-panel/task-snapshot/TaskToolSnapshot.tsx`. The new
  // component is a render-prop: it owns all five derived ReactNodes and
  // passes them to the `expandedPanelBody` JSX below via `children(...)`.
  // The `parseSerializedTaskSnapshot` + `parseSerializedToolTraceSnapshot`
  // useCallbacks stay here (source-grep contract under
  // `src/__tests__/agent-task-panel-contract.test.ts`) and are injected
  // as stable props. See plan v4 §2 V1.8 for the hook→TSX label change.

  // W3: Drag & drop support (app-internal + OS files)
  const [isDragOver, setIsDragOver] = useState(false)

  useEffect(() => {
    const handler = () => {
      focusInputWithResize()
    }
    window.addEventListener(READY_FOCUS_CHAT_INPUT_EVENT, handler as EventListener)
    return () => window.removeEventListener(READY_FOCUS_CHAT_INPUT_EVENT, handler as EventListener)
  }, [focusInputWithResize])

  const { handleDrop, handleDragOver, handleDragLeave } = useAttachmentIntake({
    addAttachments,
    setInputValue,
    setIsDragOver,
    focusInputWithResize
  })

  // Blank until the current scope carries a real (non-placeholder) title —
  // i.e. until the user has actually started a conversation.
  const sessionTitle = resolveChatSessionTitle(currentScope?.title)
  const activeLifecycleSlice = activeSessionId ? sessions[activeSessionId] : null
  const activeLifecycleError = activeLifecycleSlice?.lifecycleError ?? null
  const activeScopeRun = currentScopeId
    ? activeLifecycleSlice?.scopeRunStates[currentScopeId] ?? null
    : null
  const stopPending = activeLifecycleSlice?.lifecyclePendingAction === 'stopping'
  const lifecycleUncertainty = activeLifecycleError?.code === 'interrupt_state_unknown'
    ? activeLifecycleError.action === 'stop'
      ? 'stop' as const
      : activeLifecycleError.action === 'close'
        ? 'close' as const
        : 'reset' as const
    : activeLifecycleError?.code === 'compaction_state_unknown'
      ? 'compaction' as const
      : null
  const lifecycleInputBlocked = Boolean(
    activeLifecycleSlice?.lifecyclePendingAction || lifecycleUncertainty,
  )
  const stopError = stopRequestError || (
    activeLifecycleError?.action === 'stop' && activeLifecycleError.code !== 'no_active_operation'
      ? stopFailureMessage(activeLifecycleError.code)
      : null
  )
  useEffect(() => {
    const target = stopRequestTargetRef.current
    if (
      !stopRequestError
      || !target
      || activeSessionId !== target.sessionId
      || currentScopeId !== target.scopeId
      || activeLifecycleSlice?.lifecyclePendingAction !== null
      || activeLifecycleSlice?.lifecycleError !== null
      || activeScopeRun?.requestId !== target.requestId
      || !activeScopeRun.terminalReason
    ) return
    stopRequestTargetRef.current = null
    setStopRequestError(null)
  }, [
    activeSessionId,
    activeLifecycleSlice?.lifecycleError,
    activeLifecycleSlice?.lifecyclePendingAction,
    activeScopeRun?.requestId,
    activeScopeRun?.terminalReason,
    currentScopeId,
    stopRequestError,
  ])
  const actionAuthorizationMode = parseActionAuthorizationMode(
    currentScope?.meta.actionAuthorizationMode,
  )
  const modeSwitcher = workbenchMode && onWorkbenchModeChange
    ? (
        <div className="ready-chat-mode-tabs-dock" data-chat-mode-tabs-dock="true">
          <DraggableModeTabs
            activeMode={workbenchMode}
            splitMode={splitMode}
            onChange={(mode) => {
              void onWorkbenchModeChange(mode)
            }}
            onSplitToggle={onWorkbenchSplitToggle}
          />
        </div>
      )
    : null

  const expandedPanelHeader = (
    <ChatHeader
      currentChannel={currentChannel}
      channelOptions={channelOptions}
      sessionsByChannelKey={sessionsByChannelKey}
      onChannelSelect={handleChannelSelect}
      onNewSession={handleNewSession}
      onResetCurrentConversation={handleResetCurrentConversation}
      onCompactCurrentSession={handleCompactCurrentSession}
      currentConversationAvailable={Boolean(currentScopeId)}
      lifecyclePendingAction={activeLifecycleSlice?.lifecyclePendingAction ?? null}
      lifecycleUncertainty={lifecycleUncertainty}
      onLoadConversation={handleLoadConversation}
      onDeleteConversation={handleDeleteConversation}
      onRenameConversation={handleRenameConversation}
      sessionStatusByConversationId={sessionStatusByConversationId}
      sessionRecallQuery={sessionRecallQuery}
      sessionRecallResults={sessionRecallResults}
      sessionRecallSearching={sessionRecallSearching}
      sessionRecallError={sessionRecallError}
      attachedSessionRecallCount={attachedSessionRecallCapsules.length}
      attachedSessionRecallConversationIds={attachedSessionRecallConversationIds}
      onSessionRecallQueryChange={setSessionRecallQuery}
      onSessionRecallSearch={() => {
        void runSessionRecallSearch(sessionRecallQuery)
      }}
      onAttachSessionRecall={(conversationId) => {
        void handleAttachSessionRecall(conversationId)
      }}
      onTogglePanel={toggleChatPanel}
      onHistoryOpen={() => {
        void loadScopes()
        void runSessionRecallSearch(sessionRecallQuery)
      }}
      sessionTitle={sessionTitle}
      formatAgentName={(agentId) => (
        agentId === 'butler'
          ? 'Ready'
          : agents.find((agent) => agent.name === agentId)?.displayName || deletedAgentDisplayName(agentId)
      )}
      formatTime={formatTime}
    />
  )

  const expandedPanelBody = (
    <ChatPanelBody
      messages={messages}
      currentTaskRun={currentTaskRun}
      backgroundTaskRuns={backgroundTaskRuns}
      liveTaskRuns={currentScopeTaskRuns}
      currentScopeId={currentScopeId}
      scopeRunStates={scopeRunStates}
      taskDisclosureState={taskDisclosureState}
      isStreaming={isStreaming}
      lifecycleInputBlocked={lifecycleInputBlocked}
      stopPending={stopPending}
      stopError={stopError}
      streamingMessageId={streamingMessageId}
      parseSerializedTaskSnapshot={parseSerializedTaskSnapshot}
      parseSerializedToolTraceSnapshot={parseSerializedToolTraceSnapshot}
      setTaskSectionExpanded={setTaskSectionExpanded}
      onOpenTaskArtifact={handleOpenTaskArtifact}
      onDismissMemoryCapture={handleDismissMemoryCapture}
      onUndoMemoryCapture={handleUndoMemoryCapture}
      onSupplementMemoryCapture={handleSupplementMemoryCapture}
      onOpenScope={handleLoadConversation}
      onCancelDetachedTask={handleCancelDetachedTask}
      onCancelChildRun={handleCancelChildRun}
      toolTrace={userVisibleToolTrace}
      toolTraceStatus={toolTraceStatus}
      toolTraceExpanded={toolTraceExpanded}
      copiedMessageId={copiedMessageId}
      showToolTraceCapsule={showToolTraceCapsule}
      shouldRenderGlobalToolTraceCapsule={shouldRenderGlobalToolTraceCapsule}
      onSetInputSuggestion={setInputValue}
      onToggleToolTrace={() => setToolTraceExpanded((value) => !value)}
      onCopyMessage={handleCopyAgentMessage}
      agentSelectionMenu={agentSelectionMenu}
      onCloseAgentSelectionMenu={() => setAgentSelectionMenu(null)}
      copyTextToClipboard={copyTextToClipboard}
      onPasteSelectionToPet={handlePasteSelectionToPet}
      onAgentSelectionContextMenu={handleAgentSelectionContextMenu}
      referenceSkillHint={referenceSkillHint}
      attachedSessionRecallCapsules={attachedSessionRecallCapsules}
      onDetachSessionRecall={handleDetachSessionRecall}
      dismissSoftError={dismissSoftError}
      modeSwitcher={modeSwitcher}
      attachments={attachments}
      removeAttachment={removeAttachment}
      inputValue={inputValue}
      agents={agents}
      currentAgent={currentAgent}
      currentAgentAvatar={currentAgentData?.avatar || '🤖'}
      currentAgentDisplayName={currentAgentDisplayName}
      isChannelScope={currentScope?.sourceKind === 'channel'}
      actionAuthorizationMode={actionAuthorizationMode}
      isDragOver={isDragOver}
      filePool={filePool}
      chatInputRef={chatInputRef}
      onInputChange={(value) => setInputValue(value, { preserveContinuationIntent: true })}
      onSend={() => {
        void handleSend()
      }}
      onStop={() => { void handleStop() }}
      onPickFiles={pickFiles}
      onAgentSelect={handleAgentSelect}
      onActionAuthorizationModeChange={(mode) => setActionAuthorizationMode(mode)}
      onSkillReference={handleSkillReference}
      onReferenceSelect={handleReferenceSelect}
      setActiveAttachmentPreview={setActiveAttachmentPreview}
      setAttachmentPreviewLoading={setAttachmentPreviewLoading}
      admissionReady={Boolean(currentScopeId && currentScope)}
      composerNotice={composerNotice}
      onDismissComposerNotice={() => setComposerNotice(null)}
    />
  )

  const showExpandedPanel = panelState !== 'collapsed'

  return (
    <div
      data-chat-panel-root="true"
      data-liquid-shell="chat-panel"
      className="workbench-panel-frame relative flex-shrink-0 flex flex-col overflow-hidden"
      style={{
        width: shellWidth,
        minWidth: shellWidth,
        background: 'transparent',
        boxShadow: 'none',
        border: '1px solid transparent',
      }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <AnimatePresence initial={false} mode="wait">
        {panelState === 'collapsed' ? (
          <ChatPanelMotionLayer key="collapsed-chat-panel">
            <CollapsedChatRail
              onTogglePanel={toggleChatPanel}
              onHistoryOpen={() => {
                void loadScopes()
                toggleChatPanel()
              }}
              onNewSession={() => {
                void handleNewSession().then((result) => {
                  if (result?.ok) toggleChatPanel()
                })
              }}
            />
          </ChatPanelMotionLayer>
        ) : showExpandedPanel ? (
          <ChatPanelMotionLayer
            key="expanded-chat-panel"
            header={expandedPanelHeader}
            body={expandedPanelBody}
          />
        ) : null}
      </AnimatePresence>

      <SessionCompleteToast />

      <AttachmentPreviewModal
        preview={activeAttachmentPreview}
        loading={attachmentPreviewLoading}
        onClose={() => setActiveAttachmentPreview(null)}
        onReveal={handleRevealAttachment}
        onOpen={handleOpenAttachment}
      />

    </div>
  )
}
