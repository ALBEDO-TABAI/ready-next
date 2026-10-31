import { useMode } from '../../stores/useMode'
import { codexHeadActionAdmissionRef, productTurnActionProjectionMatchesContext } from '../../modules/agent/productTurnReceipt'
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
// suspend / resume / cancel / retry / open artifact) +
// the two internal helpers (`patchScopeRun`, `buildRunContinuationIntent`)
// extracted to `./chat-panel/task-interaction/use-task-interaction-handlers`.
// All deps that previously closed over ChatPanel-local state are now
// injected via params; behavior preserved byte-for-byte.
import { useTaskInteractionHandlers } from './chat-panel/task-interaction/use-task-interaction-handlers'
// Stage V V1.9a — channel + session-recall state, derivations, effects and
// callbacks (selectedChannelKey / channelOptions / currentChannel /
// filteredScopes / sessionRecall query+results+capsules
// + attach/detach IPC handlers + scope-change side effects) extracted to
// `./chat-panel/recall-state/use-channel-session-recall`. The
// `ConversationChannelOption` interface moved with it; ChatPanel
// re-imports the type so call-site signatures stay byte-equivalent.
import {
  useChannelSessionRecall,
  type ConversationChannelOption,
} from './chat-panel/recall-state/use-channel-session-recall'
import { useReferenceSkillHint } from './chat-panel/reference-skill/use-reference-skill-hint'
import { compactionFailureMessage, isStandaloneCompactionRequest } from '../../modules/agent/standaloneCompaction'
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
    hideToolName?: boolean
    detail?: string
  }>
}

interface SerializedToolTraceSnapshotItem {
  id: string
  kind: 'call' | 'result'
  text: string
  timestamp: string
  toolName?: string
  hideToolName?: boolean
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
    messages,
    currentScopeId,
    currentScope,
    scopeRunStates,
    inputValue,
    isStreaming,
    streamingMessageId,
    setInputValue,
    sendMessage,
    stopStreaming,
    resetCurrentConversation,
    compactCurrentSession,
    beginNewContext,
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
    clearAttachments,
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
    currentChannel,
    channelOptions,
    sessionsByChannelKey,
    recallState,
    detachCallback: handleDetachSessionRecall,
    channelEffects,
  } = useChannelSessionRecall({
    scopes,
    currentScope,
    currentScopeId,
    composerAuthorityRevision,
  })
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeAuthorityRevision is a deliberate cache-busting dependency: a new callback identity re-runs the refresh effects when scope read authority changes
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeAuthorityRevision is a deliberate cache-busting dependency: a new callback identity re-runs the refresh effects when scope read authority changes
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeAuthorityRevision is a deliberate cache-busting dependency: a new callback identity re-runs the refresh effects when scope read authority changes
  }, [filteredScopes, scopeAuthorityRevision])

  // Stage V V1.9a — runSessionRecallSearch / handleAttachSessionRecall /
  // handleDetachSessionRecall moved into `useChannelSessionRecall` and
  // surfaced above via the `recallState` destructure. Behavior unchanged.

  const inMemoryTaskRuns = useMemo<TaskCardRun[]>(() => {
    // Stage O §1.2 — `inMemoryTaskRuns` returns ONLY whitelist fields
    // (phase / terminalReason / title / toolTrace / responseMessageId /
    // responseSegmentToolTraceStart / error / updatedAt /
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
      blockedReason: projection.blockedReason,
      error: projection.error,
      updatedAt: projection.updatedAt,
      toolTrace: (projection.toolTrace || []).map((event) => ({
        id: event.id,
        kind: event.kind,
        text: event.text,
        timestamp: new Date(event.timestamp),
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.hideToolName ? { hideToolName: true } : {}),
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
          ...(event.hideToolName ? { hideToolName: true } : {}),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setComposerNotice is a stable useCallback (its only dependency is the []-memoized setComposerNoticeFor) declared further down, so listing it here would read it in the temporal dead zone during render
  }, [loadScopes])

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

  const activeLifecycleSlice = activeSessionId ? sessions[activeSessionId] : null
  const headProjection = activeLifecycleSlice?.scopeHeadActionProjection ?? null
  const sendingSessionsRef = useRef(new Set<string>())
  type ComposerNotice = {
    message: string
    errorKind: string
    recoveryActionRef?: import('../../../shared/ipc-contracts/agent-runtime').CodexBeginNewContextActionRef
  }
  const [composerNotices, setComposerNotices] = useState<Record<string, ComposerNotice>>({})
  const setComposerNoticeFor = useCallback((
    sessionId: string | null,
    notice: ComposerNotice | null,
  ) => {
    if (!sessionId) return
    setComposerNotices((current) => {
      if (notice) return { ...current, [sessionId]: notice }
      if (!(sessionId in current)) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [])
  const setComposerNotice = useCallback((notice: ComposerNotice | null) => {
    setComposerNoticeFor(useAgent.getState().activeSessionId, notice)
  }, [setComposerNoticeFor])
  const composerNotice = activeSessionId ? composerNotices[activeSessionId] ?? null : null

  // The chat menu's “压缩上下文” and sending the context-compact skill on its own share one result: a failure is
  // explained above the composer and keeps the draft.
  const runCompaction = useCallback(async (sessionId: string): Promise<boolean> => {
    setComposerNoticeFor(sessionId, null)
    let code: string
    try {
      const result = await compactCurrentSession()
      if (result.ok) return true
      code = result.code
    } catch (error) {
      // silent-catch: the failure code becomes the composer notice below
      code = error instanceof Error ? error.message : 'compaction_failed'
    }
    setComposerNoticeFor(sessionId, { message: compactionFailureMessage(code), errorKind: code })
    return false
  }, [compactCurrentSession, setComposerNoticeFor])

  const handleSend = useCallback(async () => {
    const sendSessionId = activeSessionId
    if (!sendSessionId) return
    // Sending the context-compact skill on its own is the compaction itself, not an Agent turn that could not compact.
    if (isStandaloneCompactionRequest(inputValue, attachments)) {
      if (sendingSessionsRef.current.has(sendSessionId)) return
      sendingSessionsRef.current.add(sendSessionId)
      try {
        if (await runCompaction(sendSessionId)) {
          setInputValue('')
          clearAttachments()
        }
      } finally {
        sendingSessionsRef.current.delete(sendSessionId)
      }
      return
    }
    const sendGate = headProjection?.actions.send_new_message
    if (!sendGate || sendGate.availability !== 'ready') {
      const blocker = !sendGate ? 'head_unavailable' : sendGate.blockers[0] || 'conversation_reset_required'
      const friendly = mapBackendErrorToFriendly({ errorKind: blocker, error: blocker })
      setComposerNoticeFor(sendSessionId, {
        message: friendly.friendlyMessage,
        errorKind: blocker,
        ...(activeLifecycleSlice?.beginNewContextActionRef
          ? { recoveryActionRef: activeLifecycleSlice.beginNewContextActionRef }
          : {}),
      })
      return
    }
    if (sendingSessionsRef.current.has(sendSessionId)) return
    const content = inputValue.trim()
    if (!content && attachments.length === 0) return
    sendingSessionsRef.current.add(sendSessionId)
    setComposerNoticeFor(sendSessionId, null)
    try {
      const result = await sendMessage(content, { actionAdmissionRef: codexHeadActionAdmissionRef(headProjection) })
      if (result && result.success === false && result.disposition === 'rejected_before_persistence') {
        const friendly = mapBackendErrorToFriendly({
          errorKind: result.errorKind,
          error: result.errorKind,
        })
        setComposerNoticeFor(sendSessionId, {
          message: friendly.friendlyMessage,
          errorKind: result.errorKind,
          ...(result.recoveryActionRef ? { recoveryActionRef: result.recoveryActionRef } : {}),
        })
      }
    } catch (error) {
      const friendly = mapBackendErrorToFriendly({ errorKind: 'attachment_unavailable', error: String(error) })
      setComposerNoticeFor(sendSessionId, { message: friendly.friendlyMessage, errorKind: 'attachment_unavailable' })
    } finally {
      sendingSessionsRef.current.delete(sendSessionId)
    }
  }, [activeLifecycleSlice?.beginNewContextActionRef, activeSessionId, attachments,
    inputValue, sendMessage, headProjection, setComposerNoticeFor, runCompaction, setInputValue, clearAttachments])

  const handleRetryProductTurn = useCallback(async (predecessorRunId: string) => {
    const sendSessionId = activeSessionId
    if (!sendSessionId || sendingSessionsRef.current.has(sendSessionId)) return
    setComposerNoticeFor(sendSessionId, null)
    if (inputValue.trim() || attachments.length > 0) {
      setComposerNoticeFor(sendSessionId, {
        message: '当前输入或引用不会被清空。请把目标完整写清楚后作为普通消息发送。',
        errorKind: 'explicit_retry_control_invalid',
      })
      return
    }
    const api = window.electronAPI?.agent
    if (!api?.readProductTurnPresentation) {
      setComposerNoticeFor(sendSessionId, {
        message: '暂时无法读取上一次结果，请稍后再试。', errorKind: 'host_unavailable',
      })
      return
    }
    const receipt = await api.readProductTurnPresentation(
      predecessorRunId,
      workbenchMode || 'browser',
    )
    if (
      !receipt.success
      || !receipt.data?.failure
      || receipt.data.actionProjection.retry_failed_task.availability !== 'ready'
    ) {
      setComposerNoticeFor(sendSessionId, {
        message: '这条记录已无法安全重试，请重新说明需求。', errorKind: 'conversation_reset_required',
      })
      return
    }
    const current = useAgent.getState()
    const currentSlice = current.activeSessionId ? current.sessions[current.activeSessionId] : null
    const head = currentSlice?.scopeHeadActionProjection
    const projection = receipt.data.actionProjection
    if (projection.retryEvidenceKind !== 'complete'
      || !productTurnActionProjectionMatchesContext(projection, head ?? null, useMode.getState().workbenchMode)) {
      setComposerNoticeFor(sendSessionId, {
        message: '当前会话已变化，请重新说明需求。', errorKind: 'conversation_reset_required',
      })
      return
    }
    sendingSessionsRef.current.add(sendSessionId)
    try {
      const result = await sendMessage('再试一次', {
        explicitRetry: {
          predecessorRunId,
          predecessorPresentationDigest: receipt.data.presentationDigest,
        },
      })
      if (result.success === false && result.disposition === 'rejected_before_persistence') {
        const friendly = mapBackendErrorToFriendly({
          errorKind: result.errorKind,
          error: result.errorKind,
        })
        setComposerNoticeFor(sendSessionId, {
          message: friendly.friendlyMessage, errorKind: result.errorKind,
        })
      }
    } finally {
      sendingSessionsRef.current.delete(sendSessionId)
    }
  }, [activeSessionId, attachments.length, inputValue, sendMessage,
    setComposerNoticeFor, workbenchMode])

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
      // silent-catch: a failed create yields no session, so the caller keeps the panel as it is
      return null
    }
  }, [createNewSession])

  const handleResetCurrentConversation = useCallback(async () => {
    try {
      await resetCurrentConversation()
    } catch {
      // silent-catch: the retained session remains the visible recovery boundary.
    }
  }, [resetCurrentConversation])

  const handleCompactCurrentSession = useCallback(async () => {
    if (activeSessionId) await runCompaction(activeSessionId)
  }, [activeSessionId, runCompaction])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setSelectedChannelKey is the raw useState setter passed through by useChannelSessionRecall, so it never changes identity
    [getScopeChannelKey, loadConversation, createNewSession, scopes]
  )

  const handleDeleteConversation = useCallback(
    async (convId: string) => {
      try {
        await deleteConversation(convId)
        setSessionRecallResults((prev) => prev.filter((hit) => hit.conversationId !== convId))
        void runSessionRecallSearch(sessionRecallQuery)
      } catch {
        // silent-catch: lifecycle failure remains visible in the retained session state.
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setSessionRecallResults is the raw useState setter passed through by useChannelSessionRecall, so it never changes identity
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
  } = useTaskInteractionHandlers({
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
  const activeLifecycleError = activeLifecycleSlice?.lifecycleError ?? null
  const lifecycleProjection = activeLifecycleSlice?.lifecycleOperationProjection ?? null
  const lifecycleActions = lifecycleProjection && headProjection
    && lifecycleProjection.scopeEpoch === headProjection.actionProjectionVersion.scopeEpoch
    && lifecycleProjection.headProjectionRef.digest === headProjection.evidenceDigest
    && JSON.stringify(lifecycleProjection.headProjectionRef.version)
      === JSON.stringify(headProjection.actionProjectionVersion)
    ? lifecycleProjection.actions
    : null
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
  const lifecycleInputBlocked = headProjection?.actions.send_new_message.availability !== 'ready'
  const sendBlocker = headProjection?.actions.send_new_message.blockers[0] ?? null
  const destructiveOperationPending = activeLifecycleSlice?.lifecyclePendingAction === 'resetting'
    || activeLifecycleSlice?.lifecyclePendingAction === 'closing'
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
      lifecycleActions={lifecycleActions}
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
      formatAgentName={() => 'Ready'}
      formatTime={formatTime}
    />
  )

  const expandedPanelBody = (
    <ChatPanelBody
      messages={messages}
      contextBoundaries={activeLifecycleSlice?.contextBoundaries ?? []}
      currentTaskRun={currentTaskRun}
      backgroundTaskRuns={backgroundTaskRuns}
      liveTaskRuns={currentScopeTaskRuns}
      currentScopeId={currentScopeId}
      scopeRunStates={scopeRunStates}
      taskDisclosureState={taskDisclosureState}
      isStreaming={isStreaming}
      lifecycleInputBlocked={lifecycleInputBlocked}
      sendBlocker={sendBlocker}
      destructiveOperationPending={destructiveOperationPending}
      stopAvailable={lifecycleActions?.stop.availability === 'ready'
        || stopPending
        || Boolean(activeLifecycleSlice?.streamingRequestId)}
      stopPending={stopPending}
      stopError={stopError}
      streamingMessageId={streamingMessageId}
      parseSerializedTaskSnapshot={parseSerializedTaskSnapshot}
      parseSerializedToolTraceSnapshot={parseSerializedToolTraceSnapshot}
      setTaskSectionExpanded={setTaskSectionExpanded}
      onOpenTaskArtifact={handleOpenTaskArtifact}
      onOpenScope={handleLoadConversation}
      onCancelDetachedTask={handleCancelDetachedTask}
      onCancelChildRun={handleCancelChildRun}
      toolTrace={userVisibleToolTrace}
      toolTraceStatus={toolTraceStatus}
      toolTraceExpanded={toolTraceExpanded}
      copiedMessageId={copiedMessageId}
      productTurnActionProjectionByRunId={activeLifecycleSlice?.productTurnActionProjectionByRunId ?? {}}
      showToolTraceCapsule={showToolTraceCapsule}
      shouldRenderGlobalToolTraceCapsule={shouldRenderGlobalToolTraceCapsule}
      onSetInputSuggestion={setInputValue}
      onToggleToolTrace={() => setToolTraceExpanded((value) => !value)}
      onCopyMessage={handleCopyAgentMessage}
      onRetryProductTurn={handleRetryProductTurn}
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
      onActionAuthorizationModeChange={(mode) => setActionAuthorizationMode(mode)}
      onSkillReference={handleSkillReference}
      onReferenceSelect={handleReferenceSelect}
      setActiveAttachmentPreview={setActiveAttachmentPreview}
      setAttachmentPreviewLoading={setAttachmentPreviewLoading}
      admissionReady={Boolean(currentScopeId && currentScope)}
      composerNotice={composerNotice}
      beginNewContextAvailable={Boolean(
        composerNotice?.recoveryActionRef || activeLifecycleSlice?.beginNewContextActionRef,
      )}
      onBeginNewContext={() => {
        const actionRef = composerNotice?.recoveryActionRef
          || activeLifecycleSlice?.beginNewContextActionRef
        if (!actionRef) return
        void beginNewContext(actionRef)
          .then(() => setComposerNotice(null))
          .catch(() => setComposerNotice({
            message: '会话状态已经变化，草稿仍已保留。请重新读取后再试。',
            errorKind: 'action_projection_confirmation_required',
          }))
      }}
      sendConsequence={headProjection?.actions.send_new_message.consequence ?? null}
      headUnavailable={Boolean(currentScopeId && currentScope && !headProjection)}
      onRefreshActionSurface={() => {
        if (currentScopeId) void useAgent.getState().refreshCodexActionSurface(currentScopeId)
      }}
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
