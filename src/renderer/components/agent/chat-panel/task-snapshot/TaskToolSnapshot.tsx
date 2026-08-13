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

import { useCallback, useMemo, useState } from 'react'
import type React from 'react'
import type { AgentMessage, ToolTraceEvent } from '../../../../stores/useAgent'
import type { AgentArtifact } from '../../../../modules/agent/types'
import {
  createDefaultTaskDisclosureState,
  getTaskRunDisplayKey,
  type TaskDisclosureState,
  type TaskSectionKey,
} from '../../../../modules/agent/taskCardViewModel'
import { filterUserVisibleToolTraceEvents } from '../../../../modules/agent/toolTraceVisibility'
import { readBrowserConfirmationRequest } from '../../../../../shared/browser-confirmation-card'
import type { TaskCardRun } from '../../task-card-from-projection'
import { TaskCard, ToolTraceCard } from '../task/TaskCard'

export interface TaskToolSnapshotRenderValues {
  messageTaskSnapshots: Record<string, React.ReactNode>
  messageGeneratedImageArtifacts: Record<string, AgentArtifact[]>
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
  liveTaskRuns: TaskCardRun[]
  currentScopeId: string | null
  taskDisclosureState: Record<string, TaskDisclosureState>
  isStreaming: boolean
  streamingMessageId: string | null
  terminalDurationLabel?: string | null

  // --- Serialized payload parsers (kept in ChatPanel for source-grep
  // contract; passed in here as stable useCallback identities) ---
  parseSerializedTaskSnapshot: (raw: unknown) => TaskCardRun | null
  parseSerializedToolTraceSnapshot: (raw: unknown) => ToolTraceEvent[]

  // --- Mutators / handlers lifted from ChatPanel scope. Signatures mirror
  // the `TaskCard` prop interface exactly so the host can pass its existing
  // useCallback identities through without coercion. ---
  setTaskSectionExpanded: (taskKey: string, sectionKey: TaskSectionKey, expanded: boolean) => void
  onOpenTaskArtifact: (path: string) => void
  onDismissMemoryCapture: (scopeId: string) => void
  onUndoMemoryCapture: (scopeId: string) => void
  onSupplementMemoryCapture: (scopeId: string) => void
  onOpenScope: (scopeId: string) => void
  onCancelDetachedTask: (scopeId: string, taskId?: string | null) => void
  onCancelChildRun: (scopeId: string, childRunId: string) => void

  // --- Render-prop ---
  children: (values: TaskToolSnapshotRenderValues) => React.ReactNode
}

export const MAX_BOTTOM_BACKGROUND_TASK_CARDS = 2
const DISMISSED_BOTTOM_TASK_STORAGE_KEY = 'ready.agent.dismissed-bottom-task-cards.v1'
const MAX_PERSISTED_DISMISSED_TASKS = 200

function readDismissedBottomTaskKeys(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISMISSED_BOTTOM_TASK_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())))
  } catch {
    // silent-catch: malformed presentation-only state falls back to no dismissed cards.
    return new Set()
  }
}

function persistDismissedBottomTaskKeys(keys: Set<string>): void {
  if (typeof window === 'undefined') return
  try {
    const values = [...keys].slice(-MAX_PERSISTED_DISMISSED_TASKS)
    window.localStorage.setItem(DISMISSED_BOTTOM_TASK_STORAGE_KEY, JSON.stringify(values))
  } catch {
    // silent-catch: presentation-only persistence must never block task rendering.
  }
}

function taskRunSnapshotKey(run: TaskCardRun): string {
  return `${run.scopeId}:${getTaskRunDisplayKey(run)}`
}

function stableTaskIdentity(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim()
  return normalized || null
}

function taskRunIdentityValues(run: TaskCardRun): Set<string> {
  const childRunId = stableTaskIdentity(run.taskContinuation?.childRunId)
  const values = [
    stableTaskIdentity(run.taskId),
    stableTaskIdentity(run.taskContinuation?.taskId),
    childRunId,
    childRunId ? `skill-child:${childRunId}` : null,
  ]
  return new Set(values.filter((value): value is string => Boolean(value)))
}

function taskRunsShareIdentity(left: TaskCardRun, right: TaskCardRun): boolean {
  if (left.scopeId !== right.scopeId) return false
  const leftValues = taskRunIdentityValues(left)
  if (leftValues.size === 0) return false
  for (const value of taskRunIdentityValues(right)) {
    if (leftValues.has(value)) return true
  }
  return false
}

export function newerTaskSnapshot(snapshot: TaskCardRun, liveTaskRuns: TaskCardRun[]): TaskCardRun {
  const snapshotKey = taskRunSnapshotKey(snapshot)
  const liveRun =
    liveTaskRuns.find((run) => taskRunSnapshotKey(run) === snapshotKey) ||
    liveTaskRuns.find((run) => taskRunsShareIdentity(snapshot, run))
  if (!liveRun) return snapshot
  const liveUpdatedAt = new Date(liveRun.updatedAt).getTime()
  const snapshotUpdatedAt = new Date(snapshot.updatedAt).getTime()
  if (!Number.isFinite(liveUpdatedAt) || !Number.isFinite(snapshotUpdatedAt)) return liveRun
  return liveUpdatedAt >= snapshotUpdatedAt ? liveRun : snapshot
}

export type TurnActivityPresentation = 'none' | 'activity' | 'task'

function isTerminalTaskRun(run: Omit<TaskCardRun, '__brand'>): boolean {
  return run.phase === 'done'
    || run.phase === 'error'
    || run.phase === 'cancelled'
    || run.status === 'completed'
    || run.status === 'failed'
    || run.status === 'killed'
}

function hasLongTaskEvidence(run: Omit<TaskCardRun, '__brand'>): boolean {
  const taskId = stableTaskIdentity(run.taskId)
  const continuationTaskId = stableTaskIdentity(run.taskContinuation?.taskId)
  const hasOwnedBackgroundIdentity = Boolean(
    run.taskContinuation?.childRunId
    || run.taskContinuation?.detachedTaskId
    || taskId?.startsWith('skill-child:')
    || taskId?.startsWith('detached:')
    || continuationTaskId?.startsWith('skill-child:')
    || continuationTaskId?.startsWith('detached:'),
  )
  const hasOpenWait = !isTerminalTaskRun(run)
    && Boolean(run.waitingFor && run.waitingFor !== 'none')
  const planStepCount = (run.steps || []).filter((step) => !step.id.startsWith('codex-tool:')).length
  const progressTotal = typeof run.progress?.total === 'number' ? run.progress.total : 0
  return Boolean(
    readBrowserConfirmationRequest(run.taskContinuation)
    || hasOwnedBackgroundIdentity
    || hasOpenWait
    || planStepCount >= 2
    || progressTotal >= 2
    || (run.recentArtifacts?.length ?? 0) > 0
    || (run.memoryCapture && run.memoryCapture.status !== 'dismissed'),
  )
}

/**
 * Matrix-style turn presentation is derived from observable work, never from
 * the generic planning seed or a hopeful taskType classification.
 */
export function resolveTurnActivityPresentation(
  run: Omit<TaskCardRun, '__brand'> | null | undefined,
  visibleToolEventCount: number,
): TurnActivityPresentation {
  if (!run) return visibleToolEventCount > 0 ? 'activity' : 'none'
  if (hasLongTaskEvidence(run)) return 'task'
  if (visibleToolEventCount > 0) return 'activity'
  return 'none'
}

export function shouldRenderPendingTaskCard(
  run: TaskCardRun,
  visibleToolEventCount: number,
): boolean {
  return resolveTurnActivityPresentation(run, visibleToolEventCount) === 'task'
}

export function terminalGeneratedImageArtifacts(run: TaskCardRun | null): AgentArtifact[] {
  if (!run) return []
  if (run.taskTitle?.trim() !== 'AI 生图') return []
  const terminal = (
    run.phase === 'done'
    || run.phase === 'cancelled'
    || run.status === 'completed'
    || run.status === 'failed'
    || run.status === 'killed'
  )
  if (!terminal) return []
  return (run.recentArtifacts || []).filter((artifact) => artifact.kind === 'generated_image')
}

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
    liveTaskRuns,
    currentScopeId,
    taskDisclosureState,
    isStreaming,
    streamingMessageId,
    terminalDurationLabel = null,
    parseSerializedTaskSnapshot,
    parseSerializedToolTraceSnapshot,
    setTaskSectionExpanded,
    onOpenTaskArtifact,
    onDismissMemoryCapture,
    onUndoMemoryCapture,
    onSupplementMemoryCapture,
    onOpenScope,
    onCancelDetachedTask,
    onCancelChildRun,
    children,
  } = props
  const [dismissedBottomTaskKeys, setDismissedBottomTaskKeys] = useState<Set<string>>(readDismissedBottomTaskKeys)

  const renderTaskSnapshotCard = useCallback(
    (
      run: TaskCardRun,
      key: string,
      compact = false,
      events?: ToolTraceEvent[],
      pending = false,
      dismissible = false,
    ) => {
      const dismissalKey = taskRunSnapshotKey(run)
      if (dismissible && dismissedBottomTaskKeys.has(dismissalKey)) return null
      const expanded = Boolean(taskDisclosureState[key]?.overview)
      const carriesForegroundDuration = Boolean(
        terminalDurationLabel
        && currentTaskRun
        && taskRunsShareIdentity(run, currentTaskRun)
      )
      return (
        <TaskCard
          key={key}
          run={run}
          // Stage V V1.6 / V3.3a — pre-wire the multi-session slot with the
          // active scope id. Currently unused by TaskCard's body; reserved
          // for V3.3a per-session routing.
          sessionId={currentScopeId || undefined}
          events={events}
          pending={pending}
          compact={compact}
          expanded={expanded}
          terminalDuration={carriesForegroundDuration ? terminalDurationLabel : null}
          disclosureState={{
            ...createDefaultTaskDisclosureState(run),
            ...(taskDisclosureState[key] || {})
          }}
          onToggleExpanded={() => setTaskSectionExpanded(key, 'overview', !expanded)}
          onOpenArtifact={onOpenTaskArtifact}
          onDismissMemoryCapture={onDismissMemoryCapture}
          onUndoMemoryCapture={onUndoMemoryCapture}
          onSupplementMemoryCapture={onSupplementMemoryCapture}
          onOpenScope={onOpenScope}
          onCancelDetachedTask={onCancelDetachedTask}
          onCancelChildRun={onCancelChildRun}
          dismissible={dismissible}
          onDismiss={dismissible ? () => {
            setDismissedBottomTaskKeys((current) => {
              const next = new Set(current).add(dismissalKey)
              persistDismissedBottomTaskKeys(next)
              return next
            })
          } : undefined}
        />
      )
    },
    [
      currentScopeId,
      currentTaskRun,
      onOpenScope,
      onCancelDetachedTask,
      onCancelChildRun,
      onDismissMemoryCapture,
      onOpenTaskArtifact,
      onSupplementMemoryCapture,
      onUndoMemoryCapture,
      setTaskSectionExpanded,
      dismissedBottomTaskKeys,
      taskDisclosureState,
      terminalDurationLabel,
    ]
  )

  const currentToolTraceSegment = useMemo(() => {
    if (!currentTaskRun) return []
    const startIndex = Math.max(0, currentTaskRun.responseSegmentToolTraceStart || 0)
    return (currentTaskRun.toolTrace || []).slice(startIndex)
  }, [currentTaskRun])

  const currentVisibleToolTraceSegment = useMemo(
    () => filterUserVisibleToolTraceEvents(currentToolTraceSegment),
    [currentToolTraceSegment],
  )

  // Activity-capsule 合并：有可见 task snapshot 的消息，把该消息段的工具
  // 事件并入同一张任务胶囊（时间线在胶囊内展开）；只有无 task 的消息才
  // 落到独立的 ToolTraceCard。两个 map 对同一 message id 互斥。
  const {
    messageTaskSnapshots,
    messageGeneratedImageArtifacts,
  } = useMemo<{
    messageTaskSnapshots: Record<string, React.ReactNode>
    messageGeneratedImageArtifacts: Record<string, AgentArtifact[]>
  }>(() => {
    const nextSnapshots: Record<string, React.ReactNode> = {}
    const nextGeneratedImages: Record<string, AgentArtifact[]> = {}
    for (const message of messages) {
      if (message.type !== 'agent') continue
      if (isStreaming && message.id === streamingMessageId && !message.content.trim()) continue
      const snapshot = parseSerializedTaskSnapshot(message.meta?.taskSnapshot)
      const messageTaskId = stableTaskIdentity(
        typeof message.meta?.taskId === 'string' ? message.meta.taskId : null,
      )
      const liveMessageRun = messageTaskId
        ? liveTaskRuns.find((run) => taskRunIdentityValues(run).has(messageTaskId))
        : liveTaskRuns.find((run) => run.responseMessageId === message.id)
      const taskRun = snapshot
        ? newerTaskSnapshot(snapshot, liveTaskRuns)
        : liveMessageRun
      if (!taskRun) continue
      const generatedImages = terminalGeneratedImageArtifacts(taskRun)
      if (generatedImages.length > 0) nextGeneratedImages[message.id] = generatedImages
      const segmentEvents = filterUserVisibleToolTraceEvents(
        parseSerializedToolTraceSnapshot(message.meta?.toolTraceSnapshot),
      )
      const visibleEventCount = segmentEvents.length > 0
        ? segmentEvents.length
        : filterUserVisibleToolTraceEvents(taskRun.toolTrace || []).length
      if (resolveTurnActivityPresentation(taskRun, visibleEventCount) !== 'task') continue
      nextSnapshots[message.id] = renderTaskSnapshotCard(
        taskRun,
        `task-snapshot-${message.id}`,
        false,
        segmentEvents,
      )
    }

    if (
      currentTaskRun &&
      currentTaskRun.responseMessageId &&
      messages.find((message) => message.id === currentTaskRun.responseMessageId)?.content.trim() &&
      !nextSnapshots[currentTaskRun.responseMessageId] &&
      resolveTurnActivityPresentation(currentTaskRun, currentVisibleToolTraceSegment.length) === 'task'
    ) {
      nextSnapshots[currentTaskRun.responseMessageId] = renderTaskSnapshotCard(
        currentTaskRun,
        `task-snapshot-${currentTaskRun.responseMessageId}`,
        false,
        currentVisibleToolTraceSegment,
      )
    }

    if (currentTaskRun?.responseMessageId) {
      const generatedImages = terminalGeneratedImageArtifacts(currentTaskRun)
      if (generatedImages.length > 0) {
        nextGeneratedImages[currentTaskRun.responseMessageId] = generatedImages
      }
    }

    return {
      messageTaskSnapshots: nextSnapshots,
      messageGeneratedImageArtifacts: nextGeneratedImages,
    }
  }, [
    currentTaskRun,
    currentVisibleToolTraceSegment,
    isStreaming,
    liveTaskRuns,
    messages,
    parseSerializedTaskSnapshot,
    parseSerializedToolTraceSnapshot,
    renderTaskSnapshotCard,
    streamingMessageId,
  ])

  const messageToolTraceSnapshots = useMemo<Record<string, React.ReactNode>>(() => {
    const nextSnapshots: Record<string, React.ReactNode> = {}
    for (const message of messages) {
      if (message.type !== 'agent') continue
      // 该消息已有任务胶囊时，工具事件由胶囊时间线承载，不再单独渲染。
      if (messageTaskSnapshots[message.id]) continue
      const events = parseSerializedToolTraceSnapshot(message.meta?.toolTraceSnapshot)
      const visibleEvents = filterUserVisibleToolTraceEvents(events)
      if (visibleEvents.length === 0) continue
      const toolKey = `message-tool-${message.id}`
      const expanded = Boolean(taskDisclosureState[toolKey]?.overview)
      nextSnapshots[message.id] = (
        <ToolTraceCard
          key={toolKey}
          events={visibleEvents}
          terminalDuration={
            terminalDurationLabel
            && currentTaskRun?.responseMessageId === message.id
              ? terminalDurationLabel
              : null
          }
          expanded={expanded}
          onToggleExpanded={() => setTaskSectionExpanded(toolKey, 'overview', !expanded)}
        />
      )
    }

    if (
      currentTaskRun &&
      currentTaskRun.responseMessageId &&
      messages.find((message) => message.id === currentTaskRun.responseMessageId)?.content.trim() &&
      !messageTaskSnapshots[currentTaskRun.responseMessageId] &&
      !nextSnapshots[currentTaskRun.responseMessageId] &&
      currentVisibleToolTraceSegment.length > 0
    ) {
      const toolKey = `live-tool-${currentTaskRun.responseMessageId}`
      const expanded = Boolean(taskDisclosureState[toolKey]?.overview)
      nextSnapshots[currentTaskRun.responseMessageId] = (
        <ToolTraceCard
          key={toolKey}
          events={currentVisibleToolTraceSegment}
          terminalDuration={terminalDurationLabel}
          expanded={expanded}
          onToggleExpanded={() => setTaskSectionExpanded(toolKey, 'overview', !expanded)}
        />
      )
    }

    return nextSnapshots
  }, [
    currentTaskRun,
    currentVisibleToolTraceSegment,
    messageTaskSnapshots,
    messages,
    parseSerializedToolTraceSnapshot,
    setTaskSectionExpanded,
    taskDisclosureState,
    terminalDurationLabel,
  ])

  const pendingTaskRun = useMemo<React.ReactNode | null>(() => {
    const streamMessage = messages.find((message) => message.id === streamingMessageId)
    if (!currentTaskRun || !isStreaming || !streamingMessageId) return null
    if (streamMessage && streamMessage.content.length > 0) return null
    if (!shouldRenderPendingTaskCard(currentTaskRun, currentVisibleToolTraceSegment.length)) return null
    return renderTaskSnapshotCard(
      currentTaskRun,
      `pending-task-${currentTaskRun.scopeId}`,
      false,
      currentVisibleToolTraceSegment,
      true,
    )
  }, [currentTaskRun, currentVisibleToolTraceSegment, isStreaming, messages, renderTaskSnapshotCard, streamingMessageId])

  const pendingToolTrace = useMemo<React.ReactNode | null>(() => {
    const streamMessage = messages.find((message) => message.id === streamingMessageId)
    if (!currentTaskRun || !isStreaming || !streamingMessageId) return null
    if (streamMessage && streamMessage.content.length > 0) return null
    if (currentVisibleToolTraceSegment.length === 0) return null
    if (resolveTurnActivityPresentation(currentTaskRun, currentVisibleToolTraceSegment.length) !== 'activity') return null
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
    // Only real long/background work owns a stationary surface. Direct
    // answers and short tool activity remain in the turn that produced them.
    const hasPendingAskUserCard = messages.some(
      (m) => m.type === 'ask_user_questions' && m.askUserQuestions?.status === 'pending',
    )
    const hasPendingBrowserConfirmation = Boolean(
      currentTaskRun && readBrowserConfirmationRequest(currentTaskRun.taskContinuation),
    )

    const foregroundActive = Boolean(
      currentTaskRun &&
      (
        hasPendingBrowserConfirmation ||
        isStreaming ||
        currentTaskRun.phase === 'queued' ||
        currentTaskRun.phase === 'planning' ||
        currentTaskRun.phase === 'tool_running' ||
        currentTaskRun.phase === 'takeover' ||
        currentTaskRun.phase === 'resuming' ||
        currentTaskRun.phase === 'responding'
      )
    )
    const suppressForeground = foregroundActive
      && !hasPendingBrowserConfirmation
      && (
        hasPendingAskUserCard
        || resolveTurnActivityPresentation(currentTaskRun, currentVisibleToolTraceSegment.length) !== 'task'
      )
    const effectiveForegroundActive = foregroundActive && !suppressForeground

    const foregroundDismissed = currentTaskRun
      ? dismissedBottomTaskKeys.has(taskRunSnapshotKey(currentTaskRun))
      : false
    const visibleForegroundActive = effectiveForegroundActive && !foregroundDismissed
    const undismissedBackgroundTaskRuns = backgroundTaskRuns.filter(
      (run) => !dismissedBottomTaskKeys.has(taskRunSnapshotKey(run)),
    )
    if (!visibleForegroundActive && undismissedBackgroundTaskRuns.length === 0) return null
    const { visibleRuns: visibleBackgroundTaskRuns, hiddenCount } = selectBottomBackgroundTaskRuns(undismissedBackgroundTaskRuns)
    return (
      // width:100% + box-sizing so the card visually pairs with the
      // composer chrome (which is also `w-full`). Without the explicit
      // width some intrinsic-sized children inside TaskCard can collapse
      // the wrapper narrower than the input slot.
      <div
        className="flex flex-col"
        style={{ gap: 6, width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}
      >
        {visibleForegroundActive && currentTaskRun
          ? renderTaskSnapshotCard(
              currentTaskRun,
              `bottom-task-${currentTaskRun.scopeId}-${getTaskRunDisplayKey(currentTaskRun)}`,
              true,
              undefined,
              false,
              true,
            )
          : null}
        {undismissedBackgroundTaskRuns.length > 0 && (
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
            {(visibleForegroundActive || undismissedBackgroundTaskRuns.length > 1) && (
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
                undefined,
                false,
                true,
              ),
            )}
            {hiddenCount > 0 && (
              <div
                style={{
                  padding: '6px 8px',
                  fontSize: 11.5,
                  color: 'var(--text-light)',
                }}
              >
                还有 {hiddenCount} 个后台任务，可在任务面板查看
              </div>
            )}
          </div>
        )}
      </div>
    )
  }, [backgroundTaskRuns, currentTaskRun, currentVisibleToolTraceSegment.length, dismissedBottomTaskKeys, isStreaming, messages, renderTaskSnapshotCard])

  return (
    <>
      {children({
        messageTaskSnapshots,
        messageGeneratedImageArtifacts,
        messageToolTraceSnapshots,
        pendingTaskRun,
        pendingToolTrace,
        bottomTaskCard,
      })}
    </>
  )
}
