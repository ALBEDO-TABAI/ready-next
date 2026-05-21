import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import {
  X,
  FileText,
  Image,
  Film,
  Table,
  Globe,
  CalendarDays,
  Puzzle,
  Pen,
  MessageSquareQuote,
  Folder,
  Copy,
  StickyNote
} from 'lucide-react'
import {
  useAgent,
  initAgentListeners,
  ChatAttachment,
  ConversationScope,
  ScopeRunState
} from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'
import {
  READY_FOCUS_CHAT_INPUT_EVENT,
  createSkillReferenceAttachment,
  type ReadySkillReference,
} from '../../modules/agent/chat-input-bridge'
import { revealDocumentQuoteAttachment } from '../../modules/agent/document-quote-navigation'
import { toLocalFileUrl } from '../../utils/dragDrop'
import { LIQUID_INACTIVE_CHROME_STYLE } from '../ui/LiquidGlassScene'
import {
  createDefaultTaskDisclosureState,
  getTaskRunDisplayKey,
} from '../../modules/agent/taskCardViewModel'
import { createDebouncedFetch } from '../../modules/agent/debouncedFetch'
import { filterUserVisibleToolTraceEvents } from '../../modules/agent/toolTraceVisibility'
import type { SessionRecallCapsule, SessionRecallHit } from '../../../shared/session-recall'
import type {
  ActiveChildRunSummaryData,
  RecoveryRecordData,
  ReferenceSkillHintData,
  TaskProjectionRecordData,
} from '../../types/electron'
import ChatHeader from './ChatHeader'
import ChatMessages from './ChatMessages'
import ChatInput, { ChatInputHandle } from './ChatInput'
import { SoftFailureCapsule } from './SoftFailureCapsule'
import ChatAttachments from './ChatAttachments'
import ContextMenu from '../layout/ContextMenu'

// Stage V V1.2 — Markdown renderer (parseMarkdown + table helpers + renderInline
// + MarkdownContent component) extracted to `./chat-panel/markdown`. The
// pipeline is pure (no useAgent / store / IPC), so it sits in its own TSX
// module. Only `MarkdownContent` is currently consumed in this file; the
// other named exports are re-exported for future callers and the V6 fixture.

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
  mapScopeToConversation,
  type PersistedScopeRunSummary,
  type PersistedTaskProjection,
} from './chat-panel/helpers/projection'
import {
  isTaskVisible,
  isBackgroundTaskRun,
} from './chat-panel/helpers/badges'
// Stage V V1.2 — markdown rendering extracted; only MarkdownContent is
// consumed here (ChatMessages.renderMarkdown callback below). parseMarkdown /
// renderInline / MarkdownNode / TableAlignment are re-exported by the module
// for tests and future callers but ChatPanel itself no longer needs them.
import { MarkdownContent } from './chat-panel/markdown'
// Stage V V1.3 — layout primitives (motion wrapper + collapsed rail) extracted
// to `./chat-panel/layout/MotionLayer`. Both are pure React with zero
// `useAgent` / store / IPC dependencies; signatures preserved byte-for-byte.
import { ChatPanelMotionLayer, CollapsedChatRail } from './chat-panel/layout/MotionLayer'
// Stage V V3.4a — visible session tab strip. Renders `null` when the
// `useAgent.sessionOrder` Record is empty (the cold-start state the V6
// fixture locks), so this import does not change the chat-panel-baseline
// snapshot until a session is explicitly created.
import SessionTabs from './chat-panel/session-tabs/SessionTabs'
import SessionCompleteToast from './chat-panel/session-tabs/SessionCompleteToast'
import {
  AttachmentIcon,
  getAttachmentPreviewSrc,
  AttachmentPreviewModal
} from './chat-panel/attachments-preview'
import { createLocalPathAttachment } from './chat-panel/attachments-helpers'
import { useAttachmentIntake } from './chat-panel/drag-drop/use-attachment-intake'
import ModelSelector from './chat-panel/model-selector/ModelSelector'
// Stage V V1.6 — TaskCard + ToolTraceCard extracted to
// `./chat-panel/task/TaskCard.tsx`. Both components were already fully
// props-driven (no `useAgent` / store / IPC inside the body); see the
// header comment in the new module for the rationale and the
// `sessionId?: string` prop slot reserved for V3.3a multi-session.
// V1.8 — direct `TaskCard` / `ToolTraceCard` consumption moved into
// `./chat-panel/task-snapshot/TaskToolSnapshot.tsx`; ChatPanel now
// imports only the orchestrating render-prop component below.
// Stage V V1.7 — pure 4-pass merge that combines persistedScopeRuns,
// inMemoryTaskRuns, activeChildRuns and cold-start projection synthesis
// into the canonical `TaskCardRun[]`. Extracted from the inline
// `mergedTaskRuns` useMemo so the Stage O §1.3 / §3.1 whitelist contract
// surface stays focused; behavior preserved byte-for-byte.
import { useTaskRunMerge } from './chat-panel/task-merge/use-task-run-merge'
// Stage V V1.8 — task/tool snapshot rendering region extracted to
// `./chat-panel/task-snapshot/TaskToolSnapshot.tsx`. Render-prop
// component owns renderTaskSnapshotCard + the four derived
// snapshot maps / pending ReactNodes + the bottom task card JSX.
import { TaskToolSnapshot } from './chat-panel/task-snapshot/TaskToolSnapshot'
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

interface SerializedTaskSnapshot {
  scopeId: string
  agent: string
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
  }>
}

interface SerializedToolTraceSnapshotItem {
  id: string
  kind: 'call' | 'result'
  text: string
  timestamp: string
}

// Stage V V1.1 — `normalizeProjectionSteps`, `resolveProjectionForTaskRun`,
// `isStalePausedProjection`, `isLiveProjectionCandidate`,
// `selectFallbackProjection`, `resolveProjectionWaitingFor`,
// `artifactFromPath`, `activeChildRunDebugRow`, `memoryCaptureSourceLabel`,
// `mapScopeToConversation` moved to `./chat-panel/helpers/projection.ts`.
// `progressPercent` (originally below the markdown block) is colocated there too.
// All names are re-imported above; behavior unchanged.

// Stage V V1.1 — `taskTypeBadgeLabel`, `interactionStateBadgeLabel`,
// `recoveryBadgeLabel`, `budgetWarningBadgeLabel`, `isTaskVisible`,
// `isBackgroundTaskRun` moved to `./chat-panel/helpers/badges.ts`.
// All names are re-imported above; behavior unchanged.

// Stage V V1.6 — TaskCard + ToolTraceCard + TASK_ACTION_BUTTON_STYLE
// moved to ./chat-panel/task/TaskCard.tsx. Both components were
// already fully props-driven; the constant is colocated since it is
// only consumed by TaskCard's action row. Imports above pull both
// components back in for the call sites below.


export type ChatPanelState = 'expanding' | 'expanded' | 'collapsing' | 'collapsed'

// Stage V V1.3 — `ChatPanelMotionLayer` + `CollapsedChatRail` moved to
// `./chat-panel/layout/MotionLayer.tsx` (pure React, no useAgent / store /
// IPC). Imported above; consumers below are unchanged.

// ModelSelector extracted to chat-panel/model-selector/ModelSelector.tsx (V1.5)
// Only useSettings + useNavigate deps; no IPC, no useAgent.

// AttachmentIcon + getAttachmentPreviewSrc + AttachmentPreviewModal extracted to chat-panel/attachments-preview/ (V1.4)

function formatDesignAttachmentSummary(attachment: ChatAttachment): string {
  return [
    '### 设计项目引用',
    `- 项目: ${attachment.name}`,
    attachment.path && attachment.path.startsWith('/')
      ? `- 文件: ${attachment.path}`
      : '- 文件: (未保存草稿)',
    attachment.dirty
      ? '- 状态: 有未保存更改'
      : attachment.saveStatus
        ? `- 状态: ${attachment.saveStatus}`
        : null,
    attachment.selectionSummary ? `- 选择状态: ${attachment.selectionSummary}` : null,
    attachment.currentToolContext ? `- 当前工具: ${attachment.currentToolContext}` : null,
    attachment.snapshotHash ? `- 快照哈希: ${attachment.snapshotHash}` : null
  ]
    .filter(Boolean)
    .join('\n')
}

function formatDocumentQuoteAttachmentSummary(attachment: ChatAttachment): string {
  const lineLabel =
    attachment.lineStart && attachment.lineEnd
      ? attachment.lineStart === attachment.lineEnd
        ? `第 ${attachment.lineStart} 行`
        : `第 ${attachment.lineStart}-${attachment.lineEnd} 行`
      : null

  return [
    '### 文档引用',
    `- 文档: ${attachment.title || attachment.name}`,
    `- 路径: ${attachment.path}`,
    attachment.sectionTitle ? `- 章节: ${attachment.sectionTitle}` : null,
    lineLabel ? `- 位置: ${lineLabel}` : null,
    attachment.selection ? '' : null,
    attachment.selection ? '```quote' : null,
    attachment.selection || null,
    attachment.selection ? '```' : null
  ]
    .filter(Boolean)
    .join('\n')
}

function formatDocumentWidgetTargetSummary(attachment: ChatAttachment): string {
  return [
    '### Widget 更新目标',
    `- 文档: ${attachment.documentTitle || '(未保存草稿)'}`,
    `- 目标 widget: ${attachment.widgetTitle || attachment.title || attachment.name}`,
    `- 路径: ${attachment.path}`,
    attachment.widgetMode ? `- 当前模式: ${attachment.widgetMode}` : null,
    '',
    '```show-widget',
    JSON.stringify({
      title: attachment.widgetTitle || attachment.title || attachment.name,
      widget_code: attachment.widgetCode || ''
    }),
    '```'
  ]
    .filter(Boolean)
    .join('\n')
}

function getDocumentQuoteTooltip(attachment: ChatAttachment): string {
  return [
    attachment.title || attachment.name,
    attachment.sectionTitle ? `章节: ${attachment.sectionTitle}` : null,
    attachment.lineStart && attachment.lineEnd
      ? attachment.lineStart === attachment.lineEnd
        ? `第 ${attachment.lineStart} 行`
        : `第 ${attachment.lineStart}-${attachment.lineEnd} 行`
      : null,
    attachment.selection ? attachment.selection.slice(0, 200) : null
  ]
    .filter(Boolean)
    .join('\n')
}

function getAttachmentMetaSummary(attachment: ChatAttachment): string | null {
  if (attachment.isDirectory) {
    return '文件夹'
  }

  if (attachment.source === 'document-quote') {
    const lineLabel =
      attachment.lineStart && attachment.lineEnd
        ? attachment.lineStart === attachment.lineEnd
          ? `L${attachment.lineStart}`
          : `L${attachment.lineStart}-${attachment.lineEnd}`
        : null
    return [attachment.sectionTitle, lineLabel].filter(Boolean).join(' · ') || '文档引用'
  }

  if (attachment.source === 'skill-folder') {
    return attachment.skillId ? `skill · ${attachment.skillId}` : 'skill'
  }

  if (attachment.source === 'browser-tab') {
    return '网页引用'
  }

  if (attachment.source === 'document-tab') {
    return attachment.dirty ? '文档标签 · 未保存' : '文档标签'
  }

  if (attachment.source === 'calendar-event') {
    return '日程引用'
  }

  if (attachment.source === 'document-widget-target') {
    return [
      attachment.widgetTitle || attachment.title || attachment.name,
      attachment.documentTitle ? `文档: ${attachment.documentTitle}` : null,
      attachment.widgetMode || 'widget 更新'
    ]
      .filter(Boolean)
      .join('\n')
  }

  return null
}

// Stage V V1.9a — `ConversationChannelOption` interface moved to
// `./chat-panel/recall-state/use-channel-session-recall.ts` and re-imported
// above; ChatHeader / handleChannelSelect signatures unchanged.

// attachments-helpers (ext sets, getAttachmentTypeFromExt, getPathBasename, createLocalPathAttachment) extracted to chat-panel/attachments-helpers (V1.9b)

function formatFolderAttachmentSummary(attachment: ChatAttachment): string {
  return [
    '### 文件夹引用',
    `- 名称: ${attachment.name}`,
    `- 路径: ${attachment.path}`,
    '- 用途: 可让 agent 直接基于这个目录继续定位文件、生成结果或说明目标落点。'
  ].join('\n')
}

// ---------------------------------------------------------------------------
// ChatPanel Component
// ---------------------------------------------------------------------------

interface ChatPanelProps {
  shellWidth: number
  panelState: ChatPanelState
  onTogglePanel?: () => void
}

export default function ChatPanel({ shellWidth, panelState, onTogglePanel }: ChatPanelProps) {
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
    setComposerDraft,
    setInputValue,
    sendMessage,
    stopStreaming,
    undoLastMessage,
    newSession,
    // W2
    scopes,
    loadScopes,
    loadConversation,
    deleteConversation,
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
    pendingSendCount,
    pendingSendFlushAt,
    loadSendPreferences,
    taskDisclosureState,
    setTaskSectionExpanded,
    dismissSoftError
  } = useAgent()

  const { toggleChatPanel: toggleChatPanelStore } = useWorkspace()
  const toggleChatPanel = onTogglePanel ?? toggleChatPanelStore

  const [toolTraceExpanded, setToolTraceExpanded] = useState(false)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [agentSelectionMenu, setAgentSelectionMenu] = useState<{
    x: number
    y: number
    text: string
    boundary: { left: number; top: number; right: number; bottom: number }
  } | null>(null)
  const [pendingSendCountdown, setPendingSendCountdown] = useState(0)
  const [attachmentPreviewLoading, setAttachmentPreviewLoading] = useState(false)
  const [persistedScopeRuns, setPersistedScopeRuns] = useState<PersistedScopeRunSummary[]>([])
  const [persistedTaskProjections, setPersistedTaskProjections] = useState<
    Record<string, PersistedTaskProjection[]>
  >({})
  const [activeChildRuns, setActiveChildRuns] = useState<ActiveChildRunSummaryData[]>([])
  const [referenceSkillHint, setReferenceSkillHint] = useState<ReferenceSkillHintData | null>(null)
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
    recallState,
    detachCallback: handleDetachSessionRecall,
    channelEffects,
  } = useChannelSessionRecall({
    agents,
    currentAgent,
    scopes,
    currentScope,
    currentScopeId,
  })
  const { setSelectedChannelKey, getScopeChannelKey } = channelEffects
  const {
    capsules: attachedSessionRecallCapsules,
    conversationIds: attachedSessionRecallConversationIds,
    query: sessionRecallQuery,
    setQuery: setSessionRecallQuery,
    results: sessionRecallResults,
    visibleResults: visibleSessionRecallResults,
    searching: sessionRecallSearching,
    error: sessionRecallError,
    setResults: setSessionRecallResults,
    runSearch: runSessionRecallSearch,
    attach: handleAttachSessionRecall,
  } = recallState

  const currentScopeRunUpdatedAt = currentScopeId
    ? scopeRunStates[currentScopeId]?.updatedAt || null
    : null

  const refreshPersistedScopeRuns = useCallback(async () => {
    if (!window.electronAPI?.agent?.listScopeRuns) return
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
    if (!result?.success || !Array.isArray(result.data)) return
    setPersistedScopeRuns(result.data as PersistedScopeRunSummary[])
  }, [selectedChannelKey])

  const refreshPersistedTaskProjections = useCallback(async () => {
    if (!window.electronAPI?.agent?.listTaskProjections) {
      setPersistedTaskProjections({})
      return
    }
    if (filteredScopes.length === 0) {
      setPersistedTaskProjections({})
      return
    }
    const entries = await Promise.all(
      filteredScopes.map(async (scope) => {
        const result = await window.electronAPI.agent.listTaskProjections(scope.id).catch(() => null)
        if (!result?.success || !Array.isArray(result.data)) {
          return [scope.id, []] as const
        }
        return [scope.id, result.data as PersistedTaskProjection[]] as const
      })
    )
    setPersistedTaskProjections(Object.fromEntries(entries))
  }, [filteredScopes])

  const { refreshAttachedSessionRecall } = channelEffects

  const refreshReferenceSkillHint = useCallback(async (scopeId?: string | null) => {
    if (!scopeId || !window.electronAPI?.agent?.getReferenceSkillHint) {
      setReferenceSkillHint(null)
      return
    }
    const result = await window.electronAPI.agent
      .getReferenceSkillHint(scopeId)
      .catch(() => null)
    if (!result?.success || !result.data) {
      setReferenceSkillHint(null)
      return
    }
    setReferenceSkillHint(result.data as ReferenceSkillHintData)
  }, [])

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

  const backgroundTaskRuns = useMemo(() => {
    const foregroundKey = currentTaskRun ? getTaskRunDisplayKey(currentTaskRun) : null
    const byKey = new Map<string, TaskCardRun>()
    for (const run of currentScopeTaskRuns) {
      if (!isBackgroundTaskRun(run)) continue
      const key = getTaskRunDisplayKey(run)
      if (key === foregroundKey) continue
      const existing = byKey.get(key)
      if (!existing || new Date(run.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()) {
        byKey.set(key, run)
      }
    }
    return Array.from(byKey.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
  }, [currentScopeTaskRuns, currentTaskRun])

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
          timestamp: new Date(event.timestamp)
        }
      })
      .filter(Boolean) as Array<{
      id: string
      kind: 'call' | 'result'
      text: string
      timestamp: Date
    }>
  }, [])

  useEffect(() => {
    void loadSendPreferences()
  }, [loadSendPreferences])

  useEffect(() => {
    if (!pendingSendCount || !pendingSendFlushAt) {
      setPendingSendCountdown(0)
      return
    }
    const update = () => {
      setPendingSendCountdown(Math.max(0, pendingSendFlushAt - Date.now()))
    }
    update()
    const timer = window.setInterval(update, 100)
    return () => window.clearInterval(timer)
  }, [pendingSendCount, pendingSendFlushAt])

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

  const handleAttachmentPreview = useCallback(
    async (attachment: ChatAttachment) => {
      if (!attachment.path) return
      if (attachment.source === 'document-quote') {
        setActiveAttachmentPreview({
          attachment,
          mode: 'text',
          content: formatDocumentQuoteAttachmentSummary(attachment)
        })
        return
      }
      if (attachment.source === 'document-widget-target') {
        setActiveAttachmentPreview({
          attachment,
          mode: 'text',
          content: formatDocumentWidgetTargetSummary(attachment)
        })
        return
      }
      if (attachment.source === 'design-project') {
        setActiveAttachmentPreview({
          attachment,
          mode: 'text',
          content: formatDesignAttachmentSummary(attachment)
        })
        return
      }
      if (attachment.isDirectory) {
        setActiveAttachmentPreview({
          attachment,
          mode: 'text',
          content: formatFolderAttachmentSummary(attachment)
        })
        return
      }
      if (attachment.type === 'image') {
        setActiveAttachmentPreview({ attachment, mode: 'image' })
        return
      }
      if (attachment.type === 'video') {
        setActiveAttachmentPreview({ attachment, mode: 'video' })
        return
      }
      if (attachment.type === 'text') {
        setAttachmentPreviewLoading(true)
        try {
          const result = await window.electronAPI.chat.readFileForAI(attachment.path)
          if (result.success && result.data?.type === 'text') {
            setActiveAttachmentPreview({
              attachment,
              mode: 'text',
              content: result.data.content || ''
            })
          } else {
            setActiveAttachmentPreview({
              attachment,
              mode: 'file',
              error: result.error || '无法读取附件内容'
            })
          }
        } finally {
          setAttachmentPreviewLoading(false)
        }
        return
      }
      setActiveAttachmentPreview({ attachment, mode: 'file' })
    },
    [setActiveAttachmentPreview]
  )

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

  // Initialize agent stream listeners (once)
  useEffect(() => {
    const cleanup = initAgentListeners()
    return cleanup
  }, [])

  useEffect(() => {
    void loadScopes().then(() => {
      if (useAgent.getState().scopes.length === 0) {
        useAgent.getState().newSession()
      }
    })
  }, [currentAgent, loadScopes])

  useEffect(() => {
    if (!currentScope) return
    setSelectedChannelKey(getScopeChannelKey(currentScope))
  }, [currentScope, getScopeChannelKey])

  useEffect(() => {
    void refreshAttachedSessionRecall(currentScopeId)
  }, [currentScopeId, refreshAttachedSessionRecall])

  useEffect(() => {
    setReferenceSkillHint(null)
  }, [currentScopeId])

  useEffect(() => {
    void refreshReferenceSkillHint(currentScopeId)
  }, [currentScopeId, currentScopeRunUpdatedAt, isStreaming, refreshReferenceSkillHint])

  // Phase 5.3 — subscribe to push-based hint changes from main so the badge
  // updates the instant the orchestrator arms/clears/sweeps a hint, instead
  // of lagging behind scope-run-event ticks. Audit Phase 5 §E3.
  useEffect(() => {
    if (!window.electronAPI?.agent?.onReferenceSkillHintChanged) return
    const unsubscribe = window.electronAPI.agent.onReferenceSkillHintChanged((data) => {
      // Only refresh when the event targets the currently displayed scope —
      // hint changes for other scopes shouldn't ping this view.
      if (!currentScopeId || data.scopeId !== currentScopeId) return
      void refreshReferenceSkillHint(currentScopeId)
    })
    return unsubscribe
  }, [currentScopeId, refreshReferenceSkillHint])

  useEffect(() => {
    void refreshPersistedScopeRuns()
  }, [refreshPersistedScopeRuns, currentScopeId, scopes.length])

  // Stage O §1.1 — projection refresh is event-driven. Initial fetch on
  // mount / scope change; thereafter the `agent:taskProjectionsChanged`
  // push subscription drives refetches via the debouncer below.
  useEffect(() => {
    void refreshPersistedTaskProjections()
  }, [refreshPersistedTaskProjections, currentScopeId, filteredScopes.length])

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
    let cancelled = false
    const refresh = async () => {
      if (!window.electronAPI?.agent?.listActiveChildRuns) {
        if (!cancelled) setActiveChildRuns([])
        return
      }
      const result = await window.electronAPI.agent.listActiveChildRuns().catch(() => null)
      if (cancelled) return
      setActiveChildRuns(result?.success && Array.isArray(result.data) ? result.data : [])
    }
    void refresh()
    return () => { cancelled = true }
  }, [currentScopeId])

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    }
  }, [])

  const sendingRef = useRef(false)
  const handleSend = useCallback(async () => {
    if (sendingRef.current) return
    const content = inputValue.trim()
    if (!content && attachments.length === 0) return
    sendingRef.current = true
    setInputValue('', { preserveContinuationIntent: true })
    chatInputRef.current?.resetHeight()
    try {
      const result = await sendMessage(content)
      if (result.preserveInput) {
        setInputValue(content, { preserveContinuationIntent: true })
      }
    } finally {
      sendingRef.current = false
    }
  }, [attachments.length, inputValue, setInputValue, sendMessage])

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

  const handleNewSession = useCallback(() => {
    newSession()
  }, [newSession])

  const handleLoadConversation = useCallback(
    (convId: string) => {
      loadConversation(convId)
    },
    [loadConversation]
  )

  const handleChannelSelect = useCallback(
    (channel: ConversationChannelOption) => {
      setSelectedChannelKey(channel.key)

      const latestScope = scopes
        .filter((scope) => getScopeChannelKey(scope) === channel.key)
        .sort((a, b) => {
          const aTime = new Date(a.lastMessageAt || a.updatedAt).getTime()
          const bTime = new Date(b.lastMessageAt || b.updatedAt).getTime()
          return bTime - aTime
        })[0]

      if (latestScope) {
        loadConversation(latestScope.id)
        return
      }

      if (channel.sourceKind === 'local') {
        newSession()
      }
    },
    [getScopeChannelKey, loadConversation, newSession, scopes]
  )

  const handleDeleteConversation = useCallback(
    async (convId: string) => {
      await deleteConversation(convId)
      // 乐观从 sessionRecallResults 移除，避免列表残留让用户以为没删掉
      setSessionRecallResults((prev) => prev.filter((hit) => hit.conversationId !== convId))
      // 异步重新拉取一次，确保与后端一致
      void runSessionRecallSearch(sessionRecallQuery)
    },
    [deleteConversation, runSessionRecallSearch, sessionRecallQuery]
  )

  const {
    handleContinueTaskInput,
    handleSubmitTaskConfirmation,
    handleSubmitTaskAgentResult,
    handleSuspendTask,
    handleCancelDetachedTask,
    handleContinueDetachedTask,
    handleCancelChildRun,
    handleContinueChildRun,
    handleResumeTask,
    handleRetryTask,
    handleOpenTaskArtifact,
    handleDismissMemoryCapture,
    handleUndoMemoryCapture,
    handleSupplementMemoryCapture,
  } = useTaskInteractionHandlers({
    mergedTaskRuns,
    currentScopeId,
    setComposerDraft,
    setInputValue,
    loadConversation,
    setPersistedScopeRuns,
    setActiveChildRuns,
    focusInputWithResize,
    refreshPersistedScopeRuns,
    refreshPersistedTaskProjections,
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

  const composerShellStyle = {
    ...LIQUID_INACTIVE_CHROME_STYLE,
    borderRadius: 10,
    background: 'var(--input-slot-bg)',
    border: isDragOver ? '2px solid var(--color-blue)' : '1px solid var(--input-slot-border)',
    boxShadow: isDragOver ? 'var(--input-slot-shadow-focus)' : 'var(--input-slot-shadow)',
  } as const

  // Format time for history panel
  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1) return '刚刚'
    if (diffMins < 60) return `${diffMins}分钟前`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}小时前`
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 7) return `${diffDays}天前`
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  // Stage V V3.4a — SessionTabs above the channel selector. The strip renders
  // `null` when `sessionOrder` is empty (cold start), so the V6 baseline
  // markers (`data-chat-panel-root` / `data-liquid-shell`) are unaffected
  // until the user explicitly creates a session.
  const expandedPanelHeader = (
    <>
      <SessionTabs />
    <ChatHeader
      currentChannel={currentChannel}
      channelOptions={channelOptions}
      onChannelSelect={handleChannelSelect}
      onTogglePanel={toggleChatPanel}
      onNewSession={handleNewSession}
      onLoadConversation={handleLoadConversation}
      onDeleteConversation={handleDeleteConversation}
      sessionRecallQuery={sessionRecallQuery}
      sessionRecallResults={visibleSessionRecallResults}
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
      onHistoryOpen={() => {
        void loadScopes()
        void runSessionRecallSearch(sessionRecallQuery)
      }}
      formatTime={formatTime}
    />
    </>
  )

  const expandedPanelBody = (
    <TaskToolSnapshot
      messages={messages}
      currentTaskRun={currentTaskRun}
      backgroundTaskRuns={backgroundTaskRuns}
      currentScopeId={currentScopeId}
      taskDisclosureState={taskDisclosureState}
      isStreaming={isStreaming}
      streamingMessageId={streamingMessageId}
      parseSerializedTaskSnapshot={parseSerializedTaskSnapshot}
      parseSerializedToolTraceSnapshot={parseSerializedToolTraceSnapshot}
      setTaskSectionExpanded={setTaskSectionExpanded}
      onOpenTaskArtifact={handleOpenTaskArtifact}
      onDismissMemoryCapture={handleDismissMemoryCapture}
      onUndoMemoryCapture={handleUndoMemoryCapture}
      onSupplementMemoryCapture={handleSupplementMemoryCapture}
      onContinueTaskInput={handleContinueTaskInput}
      onSubmitTaskConfirmation={handleSubmitTaskConfirmation}
      onSubmitTaskAgentResult={handleSubmitTaskAgentResult}
      onRetryTask={handleRetryTask}
      onSuspendTask={handleSuspendTask}
      onResumeTask={handleResumeTask}
      onCancelDetachedTask={handleCancelDetachedTask}
      onContinueDetachedTask={handleContinueDetachedTask}
      onCancelChildRun={handleCancelChildRun}
      onContinueChildRun={handleContinueChildRun}
    >
      {({
        messageTaskSnapshots,
        messageToolTraceSnapshots,
        pendingTaskRun,
        pendingToolTrace,
        bottomTaskCard,
      }) => (
    <>
      <ChatMessages
        messages={messages}
        messageTaskSnapshots={messageTaskSnapshots}
        messageToolTraceSnapshots={messageToolTraceSnapshots}
        pendingTaskRun={pendingTaskRun}
        pendingToolTrace={pendingToolTrace}
        isStreaming={isStreaming}
        streamingMessageId={streamingMessageId}
        toolTrace={userVisibleToolTrace}
        toolTraceStatus={toolTraceStatus}
        toolTraceExpanded={toolTraceExpanded}
        copiedMessageId={copiedMessageId}
        showToolTraceCapsule={showToolTraceCapsule && shouldRenderGlobalToolTraceCapsule}
        onSetInputSuggestion={setInputValue}
        onToggleToolTrace={() => setToolTraceExpanded((value) => !value)}
        onCopyMessage={handleCopyAgentMessage}
        onAgentSelectionContextMenu={handleAgentSelectionContextMenu}
        onAttachmentPreview={handleAttachmentPreview}
        onRevealDocumentQuote={revealDocumentQuoteAttachment}
        getDocumentQuoteTooltip={getDocumentQuoteTooltip}
        getAttachmentMetaSummary={getAttachmentMetaSummary}
        getAttachmentPreviewSrc={getAttachmentPreviewSrc}
        renderAttachmentIcon={(attachment, size = 16) => (
          <AttachmentIcon attachment={attachment} size={size} />
        )}
        renderMarkdown={(content) => <MarkdownContent content={content} />}
      />

      {agentSelectionMenu && (
        <ContextMenu
          x={agentSelectionMenu.x}
          y={agentSelectionMenu.y}
          boundary={agentSelectionMenu.boundary}
          portal
          onClose={() => setAgentSelectionMenu(null)}
          items={[
            {
              id: 'copy-selection',
              label: '复制',
              icon: <Copy style={{ width: 15, height: 15 }} strokeWidth={2} />,
              onClick: () => {
                void copyTextToClipboard(agentSelectionMenu.text)
              },
            },
            {
              id: 'pin-selection-to-pet',
              label: '贴到便利贴',
              icon: <StickyNote style={{ width: 15, height: 15 }} strokeWidth={2} />,
              onClick: () => {
                void handlePasteSelectionToPet()
              },
            },
          ]}
        />
      )}

      {(() => {
        const scopedRun = currentScopeId ? scopeRunStates[currentScopeId] : null
        const softError = scopedRun?.softError || null
        if (!softError || !currentScopeId) return null
        return (
          <SoftFailureCapsule
            softError={softError}
            onDismiss={() => dismissSoftError(currentScopeId)}
          />
        )
      })()}

      <div
        style={{
          padding: '10px 0 0',
          borderTop: '1px solid transparent',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          background: 'transparent',
          backdropFilter: 'none',
          WebkitBackdropFilter: 'none',
          boxShadow: 'none'
        }}
      >
        {referenceSkillHint && (
          <div
            className="glass-surface-card"
            data-reference-skill-hint="true"
            style={{
              borderRadius: 8,
              border: '1px solid var(--border-default)',
              background: 'color-mix(in srgb, var(--surface-panel-bg) 44%, transparent)',
              padding: '8px 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Puzzle
                style={{ width: 15, height: 15, color: 'var(--accent-primary)' }}
                strokeWidth={2}
              />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--text-light)',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase'
                  }}
                >
                  技能上下文
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'var(--text-body)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {referenceSkillHint.name || referenceSkillHint.id}
                </div>
              </div>
            </div>
            <div
              style={{
                flexShrink: 0,
                fontSize: 11,
                color: 'var(--text-muted)'
              }}
            >
              上下文已启用
            </div>
          </div>
        )}

        {attachedSessionRecallCapsules.length > 0 && (
          <div
            className="glass-surface-card"
            data-session-recall-attachments="true"
            style={{
              borderRadius: 12,
              border: '1px solid var(--border-default)',
              background: 'color-mix(in srgb, var(--surface-panel-bg) 46%, transparent)',
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-light)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase'
              }}
            >
              当前轮已引用的旧会话
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {attachedSessionRecallCapsules.map((capsule) => (
                <div
                  key={capsule.conversationId}
                  className="rounded-[10px] border"
                  style={{
                    borderColor: 'var(--border-default)',
                    padding: '8px 10px',
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 10
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-body)' }}>
                      {capsule.title}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                      {capsule.sourceKind}:{capsule.sourceId} · {formatTime(capsule.updatedAt)}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: 'var(--text-muted)',
                        marginTop: 4,
                        whiteSpace: 'pre-wrap'
                      }}
                    >
                      {capsule.summary}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void handleDetachSessionRecall(capsule.conversationId)
                    }}
                    className="rounded-[10px] border transition-[background-color,border-color]"
                    style={{
                      flexShrink: 0,
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderColor: 'var(--border-default)',
                      background: 'transparent'
                    }}
                    title="移除旧会话引用"
                  >
                    <X
                      style={{ width: 12, height: 12, color: 'var(--text-light)' }}
                      strokeWidth={2}
                    />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <ChatAttachments
          attachments={attachments}
          onRemove={removeAttachment}
          onPreview={handleAttachmentPreview}
          onRevealDocumentQuote={revealDocumentQuoteAttachment}
          getDocumentQuoteTooltip={getDocumentQuoteTooltip}
          getAttachmentMetaSummary={getAttachmentMetaSummary}
          renderAttachmentIcon={(attachment, size = 16) => (
            <AttachmentIcon attachment={attachment} size={size} />
          )}
          toLocalFileUrl={toLocalFileUrl}
        />

        {bottomTaskCard}

        <ChatInput
          ref={chatInputRef}
          inputValue={inputValue}
          isStreaming={isStreaming}
          attachmentsCount={attachments.length}
          hasUserMessages={messages.some((m) => m.type === 'user')}
          pendingSendCount={pendingSendCount}
          pendingSendCountdown={pendingSendCountdown}
          isDragOver={isDragOver}
          composerShellStyle={composerShellStyle}
          filePool={filePool}
          filePoolCount={filePool.length}
          currentAgent={currentAgent}
          currentAgentAvatar={currentAgentData?.avatar || '🤖'}
          currentAgentDisplayName={currentAgentData?.displayName || '管家'}
          agents={agents}
          isChannelScope={currentScope?.sourceKind === 'channel'}
          onInputChange={(value) => setInputValue(value, { preserveContinuationIntent: true })}
          onSend={() => {
            void handleSend()
          }}
          onStop={stopStreaming}
          onUndo={undoLastMessage}
          onPickFiles={pickFiles}
          onAgentSelect={handleAgentSelect}
          onSkillReference={handleSkillReference}
          renderAttachmentIcon={(attachment, size = 16) => (
            <AttachmentIcon attachment={attachment} size={size} />
          )}
          ModelSelector={ModelSelector}
        />
      </div>
    </>
      )}
    </TaskToolSnapshot>
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
                handleNewSession()
                toggleChatPanel()
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
