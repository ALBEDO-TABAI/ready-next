/**
 * Stage V — V1.8 ChatPanel task/tool snapshot region extraction.
 *
 * Consolidates the task/tool snapshot rendering region originally inlined
 * in `ChatPanel.tsx` (the `renderTaskSnapshotCard` useCallback, the four
 * derived snapshot maps / pending ReactNodes, and the bottom task card
 * JSX block) into a single TSX sub-component driven entirely by props
 * from the enclosing ChatPanel scope.
 *
 * The component is a render-prop: it owns the derivation of
 *   - `messageTaskSnapshots`
 *   - `messageToolTraceSnapshots`
 *   - `pendingTaskRun`
 *   - `pendingToolTrace`
 *   - `bottomTaskCard`
 * and passes them to the caller's `children` function so the existing
 * call sites (ChatMessages props at the expanded panel body + the
 * `{bottomTaskCard}` inline render inside the bottom shell) stay
 * unchanged structurally. This consolidates the region without
 * forcing the host component to take on additional wrapper layout.
 *
 * Pure TSX — no `useAgent`, no IPC, no DOM access. Every dependency
 * (live store values, handlers, the two `parseSerialized*` callbacks
 * still owned by ChatPanel for source-grep contract compatibility,
 * setTaskSectionExpanded, etc.) arrives via the props interface.
 *
 * Plan v4 modification: V1.8 was originally labeled "hook"; v4 of the
 * plan re-labels it as a "TSX sub-component". This file is the
 * sub-component; the render-prop shape lets it absorb every memo +
 * callback in the region while remaining a real React component (so the
 * V6 fixture snapshot tree depth at the seven call sites stays diff = 0).
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md §2 V1.8
 */

import { useCallback, useMemo } from 'react'
import type React from 'react'
import type { AgentMessage } from '../../../../stores/useAgent'
import {
  createDefaultTaskDisclosureState,
  getTaskRunDisplayKey,
  type TaskDisclosureState,
  type TaskSectionKey,
} from '../../../../modules/agent/taskCardViewModel'
import { filterUserVisibleToolTraceEvents } from '../../../../modules/agent/toolTraceVisibility'
import type { TaskCardRun } from '../../task-card-from-projection'
import { TaskCard, ToolTraceCard } from '../task/TaskCard'
import { isTaskVisible } from '../helpers/badges'

export interface TaskToolSnapshotRenderValues {
  messageTaskSnapshots: Record<string, React.ReactNode>
  messageToolTraceSnapshots: Record<string, React.ReactNode>
  pendingTaskRun: React.ReactNode | null
  pendingToolTrace: React.ReactNode | null
  bottomTaskCard: React.ReactNode | null
}

export interface TaskToolSnapshotProps {
  // --- Live store / derived state ---
  messages: AgentMessage[]
  currentTaskRun: TaskCardRun | null
  backgroundTaskRuns: TaskCardRun[]
  currentScopeId: string | null
  taskDisclosureState: Record<string, TaskDisclosureState>
  isStreaming: boolean
  streamingMessageId: string | null

  // --- Serialized payload parsers (kept in ChatPanel for source-grep
  // contract; passed in here as stable useCallback identities) ---
  parseSerializedTaskSnapshot: (raw: unknown) => TaskCardRun | null
  parseSerializedToolTraceSnapshot: (raw: unknown) => Array<{
    id: string
    kind: 'call' | 'result'
    text: string
    timestamp: Date
  }>

  // --- Mutators / handlers lifted from ChatPanel scope. Signatures mirror
  // the `TaskCard` prop interface exactly so the host can pass its existing
  // useCallback identities through without coercion. ---
  setTaskSectionExpanded: (taskKey: string, sectionKey: TaskSectionKey, expanded: boolean) => void
  onOpenTaskArtifact: (path: string) => void
  onDismissMemoryCapture: (scopeId: string) => void
  onUndoMemoryCapture: (scopeId: string) => void
  onSupplementMemoryCapture: (scopeId: string) => void
  onOpenScope: (scopeId: string) => void
  onContinueTaskInput: (scopeId: string) => void
  onSubmitTaskConfirmation: (scopeId: string, confirmed: boolean) => void
  onSubmitTaskAgentResult: (scopeId: string) => void
  onRetryTask: (scopeId: string) => void
  onSuspendTask: (scopeId: string) => void
  onResumeTask: (scopeId: string) => void
  onCancelDetachedTask: (scopeId: string, taskId?: string | null) => void
  onContinueDetachedTask: (scopeId: string, taskId?: string | null) => void
  onCancelChildRun: (scopeId: string, childRunId: string) => void
  onContinueChildRun: (scopeId: string, childRunId: string) => void
  onResumeBrowserTask: (scopeId: string, taskId: string) => void
  onConfirmBrowserCollectionConsent: (scopeId: string, requestId: string) => void

  // --- Render-prop ---
  children: (values: TaskToolSnapshotRenderValues) => React.ReactNode
}

export const MAX_BOTTOM_BACKGROUND_TASK_CARDS = 2

export function selectBottomBackgroundTaskRuns<T>(
  runs: readonly T[],
): { visibleRuns: T[]; hiddenCount: number } {
  const visibleRuns = runs.slice(0, MAX_BOTTOM_BACKGROUND_TASK_CARDS)
  return {
    visibleRuns,
    hiddenCount: Math.max(0, runs.length - visibleRuns.length),
  }
}

export function TaskToolSnapshot(props: TaskToolSnapshotProps): React.ReactElement {
  const {
    messages,
    currentTaskRun,
    backgroundTaskRuns,
    currentScopeId,
    taskDisclosureState,
    isStreaming,
    streamingMessageId,
    parseSerializedTaskSnapshot,
    parseSerializedToolTraceSnapshot,
    setTaskSectionExpanded,
    onOpenTaskArtifact,
    onDismissMemoryCapture,
    onUndoMemoryCapture,
    onSupplementMemoryCapture,
    onOpenScope,
    onContinueTaskInput,
    onSubmitTaskConfirmation,
    onSubmitTaskAgentResult,
    onRetryTask,
    onSuspendTask,
    onResumeTask,
    onCancelDetachedTask,
    onContinueDetachedTask,
    onCancelChildRun,
    onContinueChildRun,
    onResumeBrowserTask,
    onConfirmBrowserCollectionConsent,
    children,
  } = props

  const renderTaskSnapshotCard = useCallback(
    (run: TaskCardRun, key: string, compact = false) => {
      const expanded = Boolean(taskDisclosureState[key]?.overview)
      return (
        <TaskCard
          key={key}
          run={run}
          taskKey={key}
          // Stage V V1.6 / V3.3a — pre-wire the multi-session slot with the
          // active scope id. Currently unused by TaskCard's body; reserved
          // for V3.3a per-session routing.
          sessionId={currentScopeId || undefined}
          compact={compact}
          expanded={expanded}
          disclosureState={{
            ...createDefaultTaskDisclosureState(run),
            ...(taskDisclosureState[key] || {})
          }}
          onToggleExpanded={() => setTaskSectionExpanded(key, 'overview', !expanded)}
          onToggleSection={setTaskSectionExpanded}
          onOpenArtifact={onOpenTaskArtifact}
          onDismissMemoryCapture={onDismissMemoryCapture}
          onUndoMemoryCapture={onUndoMemoryCapture}
          onSupplementMemoryCapture={onSupplementMemoryCapture}
          onOpenScope={onOpenScope}
          onContinueInput={onContinueTaskInput}
          onSubmitConfirmation={onSubmitTaskConfirmation}
          onSubmitAgentResult={onSubmitTaskAgentResult}
          onRetry={onRetryTask}
          onSuspendRun={onSuspendTask}
          onResumeRun={onResumeTask}
          onCancelDetachedTask={onCancelDetachedTask}
          onContinueDetachedTask={onContinueDetachedTask}
          onCancelChildRun={onCancelChildRun}
          onContinueChildRun={onContinueChildRun}
          onResumeBrowserTask={onResumeBrowserTask}
          onConfirmBrowserCollectionConsent={onConfirmBrowserCollectionConsent}
        />
      )
    },
    [
      currentScopeId,
      onOpenScope,
      onContinueTaskInput,
      onCancelDetachedTask,
      onCancelChildRun,
      onContinueDetachedTask,
      onContinueChildRun,
      onConfirmBrowserCollectionConsent,
      onResumeBrowserTask,
      onDismissMemoryCapture,
      onOpenTaskArtifact,
      onRetryTask,
      onResumeTask,
      onSuspendTask,
      onSubmitTaskAgentResult,
      onSubmitTaskConfirmation,
      onSupplementMemoryCapture,
      onUndoMemoryCapture,
      setTaskSectionExpanded,
      taskDisclosureState
    ]
  )

  const messageTaskSnapshots = useMemo<Record<string, React.ReactNode>>(() => {
    const nextSnapshots: Record<string, React.ReactNode> = {}
    for (const message of messages) {
      if (message.type !== 'agent') continue
      const snapshot = parseSerializedTaskSnapshot(message.meta?.taskSnapshot)
      if (!snapshot || !isTaskVisible(snapshot)) continue
      nextSnapshots[message.id] = renderTaskSnapshotCard(snapshot, `task-snapshot-${message.id}`)
    }

    if (
      currentTaskRun &&
      currentTaskRun.responseMessageId &&
      messages.find((message) => message.id === currentTaskRun.responseMessageId)?.content.trim() &&
      !nextSnapshots[currentTaskRun.responseMessageId] &&
      isTaskVisible(currentTaskRun)
    ) {
      nextSnapshots[currentTaskRun.responseMessageId] = renderTaskSnapshotCard(
        currentTaskRun,
        `task-snapshot-${currentTaskRun.responseMessageId}`
      )
    }

    return nextSnapshots
  }, [currentTaskRun, messages, parseSerializedTaskSnapshot, renderTaskSnapshotCard])

  const currentToolTraceSegment = useMemo(() => {
    if (!currentTaskRun) return []
    const startIndex = Math.max(0, currentTaskRun.responseSegmentToolTraceStart || 0)
    return (currentTaskRun.toolTrace || []).slice(startIndex)
  }, [currentTaskRun])

  const currentVisibleToolTraceSegment = useMemo(
    () => filterUserVisibleToolTraceEvents(currentToolTraceSegment),
    [currentToolTraceSegment],
  )

  const messageToolTraceSnapshots = useMemo<Record<string, React.ReactNode>>(() => {
    const nextSnapshots: Record<string, React.ReactNode> = {}
    for (const message of messages) {
      if (message.type !== 'agent') continue
      const events = parseSerializedToolTraceSnapshot(message.meta?.toolTraceSnapshot)
      const visibleEvents = filterUserVisibleToolTraceEvents(events)
      if (visibleEvents.length === 0) continue
      const toolKey = `message-tool-${message.id}`
      const expanded = Boolean(taskDisclosureState[toolKey]?.overview)
      nextSnapshots[message.id] = (
        <ToolTraceCard
          key={toolKey}
          events={visibleEvents}
          expanded={expanded}
          onToggleExpanded={() => setTaskSectionExpanded(toolKey, 'overview', !expanded)}
        />
      )
    }

    if (
      currentTaskRun &&
      currentTaskRun.responseMessageId &&
      messages.find((message) => message.id === currentTaskRun.responseMessageId)?.content.trim() &&
      !nextSnapshots[currentTaskRun.responseMessageId] &&
      currentVisibleToolTraceSegment.length > 0
    ) {
      const toolKey = `live-tool-${currentTaskRun.responseMessageId}`
      const expanded = Boolean(taskDisclosureState[toolKey]?.overview)
      nextSnapshots[currentTaskRun.responseMessageId] = (
        <ToolTraceCard
          key={toolKey}
          events={currentVisibleToolTraceSegment}
          expanded={expanded}
          onToggleExpanded={() => setTaskSectionExpanded(toolKey, 'overview', !expanded)}
        />
      )
    }

    return nextSnapshots
  }, [
    currentTaskRun,
    currentVisibleToolTraceSegment,
    messages,
    parseSerializedToolTraceSnapshot,
    setTaskSectionExpanded,
    taskDisclosureState
  ])

  const pendingTaskRun = useMemo<React.ReactNode | null>(() => {
    const streamMessage = messages.find((message) => message.id === streamingMessageId)
    if (!currentTaskRun || !isStreaming || !streamingMessageId) return null
    if (streamMessage && streamMessage.content.length > 0) return null
    return renderTaskSnapshotCard(currentTaskRun, `pending-task-${currentTaskRun.scopeId}`)
  }, [currentTaskRun, isStreaming, messages, renderTaskSnapshotCard, streamingMessageId])

  const pendingToolTrace = useMemo<React.ReactNode | null>(() => {
    const streamMessage = messages.find((message) => message.id === streamingMessageId)
    if (!currentTaskRun || !isStreaming || !streamingMessageId) return null
    if (streamMessage && streamMessage.content.length > 0) return null
    if (currentVisibleToolTraceSegment.length === 0) return null
    const toolKey = `pending-tool-${currentTaskRun.scopeId}`
    const expanded = Boolean(taskDisclosureState[toolKey]?.overview)
    return (
      <ToolTraceCard
        key={toolKey}
        events={currentVisibleToolTraceSegment}
        pending
        expanded={expanded}
        onToggleExpanded={() => setTaskSectionExpanded(toolKey, 'overview', !expanded)}
      />
    )
  }, [
    currentTaskRun,
    currentVisibleToolTraceSegment,
    isStreaming,
    messages,
    setTaskSectionExpanded,
    streamingMessageId,
    taskDisclosureState
  ])

  const bottomTaskCard = useMemo<React.ReactNode | null>(() => {
    // The bottom task card is reserved for tasks that genuinely benefit from
    // a stationary progress surface — work that runs long enough and emits
    // enough rolling output that the user wants a fixed anchor to glance
    // at without scrolling the chat. For everything else (chit-chat, single-
    // tool calls, planning-phase placeholders, the ask_user_questions wait
    // state), the floating "正在思考" capsule plus the inline task snapshot
    // already carry the signal and the bottom card just steals room.
    //
    // Three suppression rules:
    //   (a) A pending `ask_user_questions` card already owns the "I'm waiting
    //       on you" signal — the bottom card would be pure duplication.
    //   (b) Task isn't classified as heavy yet (`taskType` is undefined,
    //       `direct_answer`, `short_task`, or a `multi_step_task` that has
    //       NOT produced concrete multi-step evidence). Even when planning
    //       phase is active, stay silent rather than render a "正在理解需求"
    //       placeholder.
    //   (c) "Heavy" means one of:
    //         - `media_task` (always heavy by construction — VEA-style)
    //         - `continuation` (resumed work, usually long)
    //         - `multi_step_task` WITH ≥2 tracked steps OR a structured
    //           progress total OR at least one artifact emitted (i.e. the
    //           task is actually multi-stepping, not just classified as
    //           such by a hopeful intent classifier).
    //
    // Background tasks are unaffected and continue to surface regardless —
    // those represent independent long-running work that owns the bottom
    // strip even when the foreground turn is light.
    const hasPendingAskUserCard = messages.some(
      (m) => m.type === 'ask_user_questions' && m.askUserQuestions?.status === 'pending',
    )

    function isHeavyOngoing(run: typeof currentTaskRun): boolean {
      if (!run) return false
      const taskType = run.taskType
      if (taskType === 'media_task') return true
      if (taskType === 'continuation') return true
      if (taskType === 'multi_step_task') {
        const stepCount = run.steps?.length ?? 0
        const totalSteps = typeof run.progress?.total === 'number' ? run.progress.total : 0
        const artifactCount = run.recentArtifacts?.length ?? 0
        return stepCount >= 2 || totalSteps >= 2 || artifactCount >= 1
      }
      return false
    }

    const foregroundActive = Boolean(
      currentTaskRun &&
      (
        isStreaming ||
        currentTaskRun.phase === 'queued' ||
        currentTaskRun.phase === 'planning' ||
        currentTaskRun.phase === 'tool_running' ||
        currentTaskRun.phase === 'takeover' ||
        currentTaskRun.phase === 'resuming' ||
        currentTaskRun.phase === 'responding'
      )
    )
    const suppressForeground = foregroundActive && (hasPendingAskUserCard || !isHeavyOngoing(currentTaskRun))
    const effectiveForegroundActive = foregroundActive && !suppressForeground

    if (!effectiveForegroundActive && backgroundTaskRuns.length === 0) return null
    const { visibleRuns: visibleBackgroundTaskRuns, hiddenCount } = selectBottomBackgroundTaskRuns(backgroundTaskRuns)
    return (
      // width:100% + box-sizing so the card visually pairs with the
      // composer chrome (which is also `w-full`). Without the explicit
      // width some intrinsic-sized children inside TaskCard can collapse
      // the wrapper narrower than the input slot.
      <div className="flex flex-col" style={{ gap: 6, width: '100%', boxSizing: 'border-box' }}>
        {effectiveForegroundActive && currentTaskRun
          ? renderTaskSnapshotCard(
              currentTaskRun,
              `bottom-task-${currentTaskRun.scopeId}-${getTaskRunDisplayKey(currentTaskRun)}`,
              true,
            )
          : null}
        {backgroundTaskRuns.length > 0 && (
          <div
            className="panel-hover-scrollbar flex flex-col"
            style={{
              gap: 6,
              width: '100%',
              maxHeight: 'min(38vh, 260px)',
              overflowY: 'auto',
              paddingRight: hiddenCount > 0 ? 2 : 0,
            }}
          >
            {(effectiveForegroundActive || backgroundTaskRuns.length > 1) && (
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: 'var(--text-light)',
                  padding: '0 2px',
                }}
              >
                后台任务
              </div>
            )}
            {visibleBackgroundTaskRuns.map((run) =>
              renderTaskSnapshotCard(
                run,
                `bottom-task-${run.scopeId}-${getTaskRunDisplayKey(run)}`,
                true,
              ),
            )}
            {hiddenCount > 0 && (
              <div
                style={{
                  border: '1px solid var(--border-default)',
                  borderRadius: 8,
                  padding: '6px 8px',
                  fontSize: 11.5,
                  color: 'var(--text-light)',
                  background: 'color-mix(in srgb, var(--surface-panel-bg) 38%, transparent)',
                }}
              >
                还有 {hiddenCount} 个后台任务，可在任务面板查看
              </div>
            )}
          </div>
        )}
      </div>
    )
  }, [backgroundTaskRuns, currentTaskRun, isStreaming, messages, renderTaskSnapshotCard])

  return (
    <>
      {children({
        messageTaskSnapshots,
        messageToolTraceSnapshots,
        pendingTaskRun,
        pendingToolTrace,
        bottomTaskCard,
      })}
    </>
  )
}
