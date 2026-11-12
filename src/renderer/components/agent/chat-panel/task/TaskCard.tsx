import { useState, useRef, useEffect, useMemo } from 'react'
import { Circle, CircleCheck, CircleDot, CirclePause, CircleX, Wrench, X } from 'lucide-react'
import {
  buildTaskCardViewModel,
  deriveTaskCardRuntimeState,
  formatTaskUserFacingText,
  formatTaskProgressLabel,
  formatTaskStepDisplayTitle,
  getTaskStartModeLabel,
} from '../../../../modules/agent/taskCardViewModel'
import { formatSingleLinePreview, formatToolTracePreview } from '../../../../modules/agent/toolTracePreview'
import { deriveToolTimelineItems } from '../../../../modules/agent/toolTraceRows'
import { filterUserVisibleToolTraceEvents } from '../../../../modules/agent/toolTraceVisibility'
import type { ToolTraceEvent } from '../../../../modules/agent/types'
import { CapsuleChevron, ToolTimeline, ToolTimelineRow } from './ToolTimeline'
import { emitRendererAgentMetric } from '../../../../modules/agent/rendererMetrics'
import { progressPercent } from '../helpers/projection'
import {
  taskTypeBadgeLabel,
  interactionStateBadgeLabel,
  recoveryBadgeLabel,
  budgetWarningBadgeLabel,
} from '../helpers/badges'
import type { TaskCardRun } from '../../task-card-from-projection'
import { AgentStatusDot } from '../../../ui/dot-matrix/AgentStatusDot'
import { IconButton } from '../../../ui'
import { TaskCardFooter } from './TaskCardFooter'
import {
  buildBrowserConfirmationCard,
  readBrowserConfirmationRequest,
} from '../../../../../shared/browser-confirmation-card'

// ---------------------------------------------------------------------------
// Matrix-style disclosure primitives. TaskCard is reserved for observable
// long/background work; ToolTraceCard owns same-turn tool activity. Both use
// one-line collapse, timeline disclosure, and per-tool details without
// inventing a second runtime state machine in Renderer.
// ---------------------------------------------------------------------------

export const TASK_ACTION_BUTTON_STYLE: React.CSSProperties = {
  padding: '3px 8px',
  borderRadius: 8,
  border: '1px solid var(--rn-hair-2)',
  background: 'transparent',
  fontSize: 'var(--rn-fs-2xs)',
  lineHeight: 1.3,
  fontWeight: 500,
  color: 'var(--rn-ink)',
  cursor: 'pointer'
}

export function DynamicDeliveryTaskSummary({ run }: { run: TaskCardRun }) {
  if (!run.deliveryState || run.deliveryState.decision === 'single_path') return null
  const verifierLabel = dynamicDeliveryVerifierLabel(run.phase, run.deliveryState.verifier.status)
  const verifierStateLabel = {
    not_required: '',
    pending: verifierLabel,
    accepted: '独立复核已通过',
    repair: '正在按独立复核修补',
    blocked: '独立复核未通过',
  }[run.deliveryState.verifier.status]
  return (
    <div
      data-ready-dynamic-delivery-summary="true"
      className="ready-task-content-line t-meta"
      style={{ paddingBottom: 7, color: 'var(--rn-ink-3)' }}
    >
      {run.deliveryState.packages.length > 0
        ? `协作者 ${run.deliveryState.packages.map((item) => item.binding.effectiveAgentId).join('、')}`
        : verifierStateLabel}
      {run.deliveryState.packages.length > 0 && verifierStateLabel ? ` · ${verifierStateLabel}` : ''}
      {run.deliveryState.packages.some((item) => item.status === 'degraded') ? ' · 有协作项已降级' : ''}
      {run.deliveryState.packages.some((item) => item.status === 'blocked') ? ' · 有协作项被阻塞' : ''}
    </div>
  )
}

export function dynamicDeliveryVerifierLabel(
  phase: TaskCardRun['phase'],
  verifierStatus: 'not_required' | 'pending' | 'accepted' | 'repair' | 'blocked',
): string {
  if (verifierStatus !== 'pending') return ''
  return phase === 'done' || phase === 'error' || phase === 'cancelled' ? '' : '等待独立复核'
}

const CAPSULE_SHELL_STYLE: React.CSSProperties = {
  borderRadius: 12,
  border: 0,
  background: 'transparent',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const CAPSULE_HEADER_STYLE: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: '7px 0',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  textAlign: 'left',
}

const TASK_CARD_HEADER_STYLE: React.CSSProperties = {
  ...CAPSULE_HEADER_STYLE,
  padding: '7px 0',
}

function TaskStepStatusGlyph({ status }: { status: string }) {
  const config = status === 'done'
    ? { Icon: CircleCheck, label: '步骤已完成' }
    : status === 'running'
      ? { Icon: CircleDot, label: '步骤进行中' }
      : status === 'blocked'
        ? { Icon: CirclePause, label: '步骤已阻塞' }
        : status === 'error'
          ? { Icon: CircleX, label: '步骤失败' }
          : { Icon: Circle, label: '步骤待执行' }
  return (
    <span
      className="ready-task-step-glyph"
      data-ready-task-step-status={status}
      role="img"
      aria-label={config.label}
    >
      <config.Icon aria-hidden="true" size={12} strokeWidth={1.65} />
    </span>
  )
}

export function TaskCard({
  run,
  sessionId,
  events,
  pending = false,
  compact = false,
  expanded = false,
  terminalDuration,
  disclosureState,
  onToggleExpanded,
  onOpenScope,
  onOpenArtifact,
  onCancelDetachedTask,
  onCancelChildRun,
  dismissible = false,
  onDismiss,
}: {
  run: TaskCardRun
  /**
   * Stage V V3.3a interface — multi-session routing slot. Currently unused
   * by the body; callers pass the active scope id so future dispatches
   * can wire per-session behavior without changing this signature again.
   */
  sessionId?: string
  /**
   * 本消息段的工具事件（已过 filterUserVisibleToolTraceEvents）。缺省时
   * 回退到 run.toolTrace 的可见子集，兼容仅存 taskSnapshot 的历史消息。
   */
  events?: ToolTraceEvent[]
  /** 流式进行中的占位胶囊：折叠态自动浮出最近工具动态。 */
  pending?: boolean
  compact?: boolean
  expanded?: boolean
  terminalDuration?: string | null
  disclosureState?: Record<string, boolean>
  onToggleExpanded?: () => void
  onOpenScope?: (scopeId: string) => void
  onOpenArtifact?: (path: string) => void
  onCancelDetachedTask?: (scopeId: string, taskId?: string | null) => void
  onCancelChildRun?: (scopeId: string, childRunId: string) => void
  /** Presentation-only removal. It never stops the underlying task. */
  dismissible?: boolean
  onDismiss?: () => void
}) {
  const vm = buildTaskCardViewModel(run, disclosureState)
  const taskRuntimeState = deriveTaskCardRuntimeState(run)
  const legacyHandoffReportedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const hit = vm.legacyHandoffHit
    if (!hit) return
    const dedupKey = `${vm.key}|${hit}`
    if (legacyHandoffReportedRef.current.has(dedupKey)) return
    legacyHandoffReportedRef.current.add(dedupKey)
    emitRendererAgentMetric('legacy_handoff_text_fallback_used', {
      scopeId: run.scopeId ?? null,
      taskId: run.taskId ?? null,
      source: hit,
    })
  }, [vm.legacyHandoffHit, vm.key, run.scopeId, run.taskId])
  const steps = vm.steps.filter((step) => !step.id.startsWith('codex-tool:'))
  const PLAN_STEP_COLLAPSE_THRESHOLD = 10
  const [showAllPlanSteps, setShowAllPlanSteps] = useState(false)
  const [swipeOffset, setSwipeOffset] = useState(0)
  const swipeStartXRef = useRef<number | null>(null)
  const swipeOffsetRef = useRef(0)
  const suppressHeaderClickRef = useRef(false)
  const planStepsToRender = showAllPlanSteps ? steps : steps.slice(0, PLAN_STEP_COLLAPSE_THRESHOLD)
  const hiddenPlanStepCount = Math.max(0, steps.length - planStepsToRender.length)
  const recentArtifacts = run.recentArtifacts || []
  const compactPrimaryArtifact = compact && !expanded
    ? recentArtifacts.find((artifact) => artifact.kind === 'collection_output' && artifact.path)
      || recentArtifacts.find((artifact) => artifact.path)
      || null
    : null
  const isDetachedTask = typeof run.taskId === 'string' && run.taskId.startsWith('detached:')
  const childRunId = run.taskContinuation?.childRunId || null
  const shouldShowOpenScopeButton = Boolean(compact && run.scopeId !== sessionId)
  const progressLabel = formatTaskProgressLabel(run.progress)
  const progressValue = progressPercent(run.progress)
  const progressLabelAlreadyHasPercent = Boolean(progressLabel && /\d+%/.test(progressLabel))
  const progressLastError = run.progress?.lastError ? formatTaskUserFacingText(run.progress.lastError) : null
  const summaryPreview = formatSingleLinePreview(vm.summary)
  const hasTerminalTaskStatus = (
    run.phase === 'done'
    || run.phase === 'cancelled'
    || run.status === 'completed'
    || run.status === 'failed'
    || run.status === 'killed'
  )
  const hasPlaceholderTitle = vm.title === '正在理解需求' || vm.title === '正在生成…'
  const primaryTitle = hasPlaceholderTitle
    ? (hasTerminalTaskStatus ? vm.statusLabel : '任务进行中')
    : vm.title
  const shouldShowInteractionBadge = Boolean(
    run.interactionState
    && run.interactionState !== 'running'
    && !hasTerminalTaskStatus,
  )
  const taskKindBadge = getTaskStartModeLabel(run)
    || (run.taskType ? taskTypeBadgeLabel(run.taskType) : null)
  const metaBadges = [
    shouldShowInteractionBadge ? interactionStateBadgeLabel(run.interactionState) : null,
    run.budgetWarningLevel ? budgetWarningBadgeLabel(run.budgetWarningLevel) : null,
    run.recoveryHistory && run.recoveryHistory.length > 0
      ? recoveryBadgeLabel(run.recoveryHistory)
      : null
  ].filter(Boolean) as string[]

  // 时间线数据源：优先本消息段事件；缺省回退到 run.toolTrace 的可见子集。
  const timelineEvents = useMemo(
    () => (events && events.length > 0 ? events : filterUserVisibleToolTraceEvents(run.toolTrace || [])),
    [events, run.toolTrace],
  )
  const timelineItems = useMemo(() => deriveToolTimelineItems(timelineEvents), [timelineEvents])
  const toolCount = timelineItems.length
  // 运行态折叠时自动浮出最近动态（P0-2 语义，与 ToolTraceCard 一致）。
  const recentItems = pending && !expanded && !compact ? timelineItems.slice(-3) : []
  const headerPreviewSource = pending && timelineEvents.length > 0
      ? formatToolTracePreview(timelineEvents[timelineEvents.length - 1]?.text)
      : summaryPreview
  const headerPreview = headerPreviewSource === primaryTitle || headerPreviewSource === vm.statusLabel
    ? ''
    : headerPreviewSource

  // Only actions with a live runtime owner remain interactive. Historical
  // checkpoint/confirmation/takeover states stay readable but cannot create a
  // successor run from the task card.
  const resumableActions = run.resumableActions || []
  const showCancelDetached = isDetachedTask && resumableActions.includes('cancel')
  /* Generic continuation is retired. Detached and child tasks retain only
     their dedicated query/cancel controls; retry below starts a new user turn. */
  const showCancelChild = Boolean(childRunId) && resumableActions.includes('cancel')
  const confirmationRequest = readBrowserConfirmationRequest(run.taskContinuation)
  const confirmationCard = confirmationRequest
    ? buildBrowserConfirmationCard(confirmationRequest)
    : null
  const hasActionRow = showCancelDetached
    || showCancelChild
    || shouldShowOpenScopeButton
  const showProgressRow = Boolean(progressLabel && (expanded || compact || !hasTerminalTaskStatus))

  return (
    <div
      data-ready-task-card="true"
      data-ready-task-scope-id={run.scopeId || undefined}
      data-ready-task-id={run.taskId || undefined}
      data-ready-task-child-run-id={childRunId || undefined}
      data-ready-task-dismissible={dismissible ? 'true' : undefined}
      className="w-full max-w-full min-w-0 box-border"
      onPointerDown={(event) => {
        if (!dismissible || event.button !== 0) return
        if ((event.target as HTMLElement).closest('[data-ready-task-dismiss="true"]')) return
        swipeStartXRef.current = event.clientX
        swipeOffsetRef.current = 0
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (swipeStartXRef.current == null) return
        const delta = Math.max(0, event.clientX - swipeStartXRef.current)
        if (delta > 8) suppressHeaderClickRef.current = true
        const nextOffset = Math.min(120, delta)
        swipeOffsetRef.current = nextOffset
        setSwipeOffset(nextOffset)
      }}
      onPointerUp={() => {
        if (swipeStartXRef.current == null) return
        const shouldDismiss = swipeOffsetRef.current >= 72
        swipeStartXRef.current = null
        swipeOffsetRef.current = 0
        setSwipeOffset(0)
        if (shouldDismiss) onDismiss?.()
        setTimeout(() => { suppressHeaderClickRef.current = false }, 0)
      }}
      onPointerCancel={() => {
        swipeStartXRef.current = null
        swipeOffsetRef.current = 0
        setSwipeOffset(0)
        suppressHeaderClickRef.current = false
      }}
      style={{
        ...CAPSULE_SHELL_STYLE,
        position: 'relative',
        touchAction: dismissible ? 'pan-y' : undefined,
        transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
        opacity: swipeOffset ? Math.max(0.55, 1 - swipeOffset / 220) : 1,
        transition: swipeStartXRef.current == null ? 'transform 160ms ease, opacity 160ms ease' : 'none',
      }}
    >
      <button
        type="button"
        onClick={() => {
          if (suppressHeaderClickRef.current) return
          onToggleExpanded?.()
        }}
        className="w-full max-w-full min-w-0 box-border overflow-hidden hover:bg-[var(--rn-fill)] transition-colors duration-160"
        style={{ ...TASK_CARD_HEADER_STYLE, paddingRight: dismissible ? 26 : 0 }}
      >
        <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          <AgentStatusDot state={taskRuntimeState.visualState} size={11} />
        </span>
        <span
          className="t-ui"
          data-typography-role="ui"
          style={{
            color: 'var(--rn-ink)',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {primaryTitle}
        </span>
        {hasTerminalTaskStatus && terminalDuration ? (
          <span
            className="t-data"
            data-ready-task-terminal-duration="true"
            data-typography-role="data"
            style={{ color: 'var(--rn-ink)', flexShrink: 0 }}
          >
            用时 {terminalDuration}
          </span>
        ) : null}
        {headerPreview ? (
          <span
            className="t-meta"
            data-typography-role="meta"
            style={{
              color: 'var(--rn-ink-3)',
              minWidth: 0,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {headerPreview}
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        <span className="t-meta" data-typography-role="meta" style={{ color: 'var(--rn-ink-3)', flexShrink: 0 }}>
          {vm.statusLabel}
        </span>
        {toolCount > 0 ? (
          <span className="t-data" data-typography-role="data" style={{ color: 'var(--rn-ink-3)', flexShrink: 0 }}>
            {toolCount} 个工具
          </span>
        ) : null}
        <CapsuleChevron expanded={expanded} />
      </button>

      {dismissible ? (
        <IconButton
          size="sm"
          icon={<X />}
          data-ready-task-dismiss="true"
          aria-label="清除任务卡"
          title="清除任务卡（不会停止任务）"
          onClick={(event) => {
            event.stopPropagation()
            onDismiss?.()
          }}
          style={{ position: 'absolute', top: 6, right: 7, zIndex: 2 }}
        />
      ) : null}

      <DynamicDeliveryTaskSummary run={run} />

      {recentItems.length > 0 ? (
        <div data-ready-task-recent-activity="true" style={{ padding: '0 0 8px' }}>
          <div className="flex flex-col">
            {recentItems.map((item, index) => (
              <ToolTimelineRow
                key={item.id}
                item={item}
                isLast={index === recentItems.length - 1}
                interactive={false}
              />
            ))}
          </div>
        </div>
      ) : null}

      {showProgressRow ? (
        <div className="ready-task-content-line" style={{ paddingBottom: 8 }}>
          <div className="flex items-center justify-between" style={{ gap: 8 }}>
            <span
              className="t-meta"
              data-typography-role="meta"
              style={{
                color: 'var(--rn-ink-3)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {progressLabel}
            </span>
            {progressValue != null && !progressLabelAlreadyHasPercent && (
              <span className="t-data" data-typography-role="data" style={{ color: 'var(--rn-ink-3)', flexShrink: 0 }}>
                {progressValue}%
              </span>
            )}
          </div>
          {progressValue != null && (
            <div
              style={{
                height: 4,
                borderRadius: 999,
                marginTop: 4,
                overflow: 'hidden',
                background: 'var(--rn-fill-2)',
              }}
            >
              <div
                style={{
                  width: `${progressValue}%`,
                  height: '100%',
                  borderRadius: 999,
                  // DL5: the signal colour marks work that is running; a finished bar is ink.
                  background: hasTerminalTaskStatus ? 'var(--rn-ink-3)' : 'var(--rn-accent)',
                }}
              />
            </div>
          )}
          {progressLastError && expanded && (
            <div className="t-meta" data-typography-role="meta" style={{ color: 'var(--rn-ink-3)', marginTop: 4 }}>
              当前状态：{progressLastError}
            </div>
          )}
        </div>
      ) : null}

      {compactPrimaryArtifact ? (
        <div className="ready-task-content-line" style={{ paddingBottom: 8 }}>
          <button
            type="button"
            data-ready-task-primary-artifact="true"
            onClick={() => compactPrimaryArtifact.path && onOpenArtifact?.(compactPrimaryArtifact.path)}
            title={compactPrimaryArtifact.path || compactPrimaryArtifact.label}
            style={{
              ...TASK_ACTION_BUTTON_STYLE,
              color: 'var(--rn-ink-3)',
            }}
          >
            {compactPrimaryArtifact.kind === 'collection_output' ? '打开采集结果' : compactPrimaryArtifact.label}
          </button>
        </div>
      ) : null}

      {expanded && (
        <div
          className="flex flex-col"
          style={{
            gap: 10,
            padding: '8px 0 10px',
            borderTop: '1px solid var(--rn-hair)',
            maxHeight: '60vh',
            overflowY: 'auto',
          }}
        >
          {metaBadges.length > 0 && (
            <div className="ready-task-content-line flex flex-wrap gap-1.5">
              {metaBadges.map((badge) => (
                <span
                  key={badge}
                  style={{
                    padding: '2px 7px',
                    borderRadius: 999,
                    border: '1px solid var(--rn-hair-2)',
                    fontSize: 'var(--rn-fs-2xs)',
                    lineHeight: 1.2,
                    fontWeight: 500,
                    letterSpacing: '0.08em',
                    color: 'var(--rn-ink-3)',
                    background: 'transparent',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {badge}
                </span>
              ))}
            </div>
          )}

          {summaryPreview && vm.summary !== primaryTitle && vm.summary !== vm.statusLabel ? (
            <div
              className="ready-thinking-reasoning t-meta"
              data-ready-thinking-reasoning={hasTerminalTaskStatus ? 'done' : 'running'}
              data-typography-role="meta"
            >
              {formatTaskUserFacingText(vm.summary)}
            </div>
          ) : null}

          {expanded && vm.currentStep && !hasTerminalTaskStatus ? (
            <div className="ready-task-content-line t-meta" data-typography-role="meta" style={{ color: 'var(--rn-ink-3)' }}>
              当前步骤：{vm.currentStep.title}
            </div>
          ) : null}

          {steps.length > 0 && (
            <div className="flex flex-col" style={{ gap: 5 }}>
              {planStepsToRender.map((step) => (
                <div
                  key={step.id}
                  className="ready-task-todo-row flex items-start gap-2"
                  data-ready-task-todo-state={step.status}
                >
                  <TaskStepStatusGlyph status={step.status} />
                  <div
                    className="ready-task-todo-label t-meta"
                    data-typography-role="meta"
                    style={{ minWidth: 0, flex: 1 }}
                  >
                    {formatTaskStepDisplayTitle(step.title, run.progress)}
                    {step.detail ? (
                      <span style={{ color: 'var(--rn-ink-3)' }}>
                        {' · '}
                        {formatTaskUserFacingText(step.detail)}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
              {hiddenPlanStepCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllPlanSteps(true)}
                  style={{
                    alignSelf: 'flex-start',
                    marginLeft: 20,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px dashed var(--rn-hair-2)',
                    background: 'transparent',
                    fontSize: 'var(--rn-fs-2xs)',
                    lineHeight: 1.3,
                    fontWeight: 500,
                    color: 'var(--rn-ink-3)',
                    cursor: 'pointer',
                  }}
                >
                  展开剩余 {hiddenPlanStepCount} 步
                </button>
              )}
              {showAllPlanSteps && steps.length > PLAN_STEP_COLLAPSE_THRESHOLD && (
                <button
                  type="button"
                  onClick={() => setShowAllPlanSteps(false)}
                  style={{
                    alignSelf: 'flex-start',
                    marginLeft: 20,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px dashed var(--rn-hair-2)',
                    background: 'transparent',
                    fontSize: 'var(--rn-fs-2xs)',
                    lineHeight: 1.3,
                    fontWeight: 500,
                    color: 'var(--rn-ink-3)',
                    cursor: 'pointer',
                  }}
                >
                  收起到前 {PLAN_STEP_COLLAPSE_THRESHOLD} 步
                </button>
              )}
            </div>
          )}

          <ToolTimeline items={timelineItems} />

          {recentArtifacts.length > 0 && (
            <div className="ready-task-content-line flex flex-wrap gap-1.5">
              {recentArtifacts.slice(-3).map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => artifact.path && onOpenArtifact?.(artifact.path)}
                  style={{
                    padding: '3px 7px',
                    borderRadius: 8,
                    border: '1px solid var(--rn-hair-2)',
                    background: 'transparent',
                    fontSize: 'var(--rn-fs-2xs)',
                    lineHeight: 1.3,
                    fontWeight: 500,
                    color: 'var(--rn-ink-3)',
                    cursor: artifact.path ? 'pointer' : 'default'
                  }}
                  title={artifact.path || artifact.label}
                >
                  {artifact.label}
                </button>
              ))}
            </div>
          )}

          <TaskCardFooter taskId={run.taskId} taskKindBadge={taskKindBadge} terminal={hasTerminalTaskStatus} detached={isDetachedTask} />
        </div>
      )}

      {run.waitingFor === 'confirmation' && confirmationCard && (
        <div
          data-ready-browser-confirmation-card={confirmationCard.kind}
          data-ready-browser-confirmation-request-id={confirmationCard.requestId}
          className="mx-2.5 mb-2 rounded-[10px] border p-2.5"
          style={{ borderColor: 'var(--rn-hair)', background: 'transparent' }}
        >
          <div className="text-[12px] font-semibold" style={{ color: 'var(--rn-ink)' }}>
            {confirmationCard.title}
          </div>
          <div className="mt-1 text-[11px]" style={{ color: 'var(--rn-ink)' }}>
            {confirmationCard.description}
          </div>
          <div className="mt-1 text-[10.5px]" style={{ color: 'var(--rn-ink-3)' }}>
            {confirmationCard.detail}
          </div>
        </div>
      )}

      {/* 动作行不受折叠门控：等待用户/可恢复/需确认时必须一眼可点。 */}
      {hasActionRow && (
        <div className="flex flex-wrap gap-1.5" style={{ padding: '0 10px 9px' }}>
          {showCancelDetached && (
            <button
              type="button"
              onClick={() => onCancelDetachedTask?.(run.scopeId, run.taskId || null)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              取消后台任务
            </button>
          )}
          {showCancelChild && childRunId && (
            <button
              type="button"
              data-ready-task-action="cancel-child-run"
              data-ready-task-scope-id={run.scopeId || undefined}
              data-ready-task-id={run.taskId || undefined}
              data-ready-task-child-run-id={childRunId}
              onClick={() => onCancelChildRun?.(run.scopeId, childRunId)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              取消
            </button>
          )}
          {shouldShowOpenScopeButton && (
            <button
              type="button"
              onClick={() => onOpenScope?.(run.scopeId)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              打开会话
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ToolTraceCard({
  events,
  pending = false,
  expanded = false,
  terminalDuration = null,
  onToggleExpanded
}: {
  events: ToolTraceEvent[]
  pending?: boolean
  expanded?: boolean
  terminalDuration?: string | null
  onToggleExpanded?: () => void
}) {
  const items = useMemo(() => deriveToolTimelineItems(events), [events])
  if (events.length === 0) return null
  const latestEvent = events[events.length - 1]
  const latestPreview = formatToolTracePreview(latestEvent?.text)
  // P0-2 — running state auto-surfaces the most recent activity rows so the
  // user sees per-tool progress without opening the card; completion falls
  // back to the compact collapsed header (auto-collapse), manual expand
  // still shows the full timeline.
  const recentItems = pending && !expanded ? items.slice(-3) : []
  return (
    <div data-ready-tool-trace-card="true" style={CAPSULE_SHELL_STYLE}>
      <button
        type="button"
        onClick={onToggleExpanded}
        className="hover:bg-[var(--rn-fill)] transition-colors duration-160"
        style={CAPSULE_HEADER_STYLE}
      >
        <Wrench
          style={{ width: 12, height: 12, color: 'var(--rn-ink-3)', flexShrink: 0 }}
          strokeWidth={2}
        />
        {!pending && terminalDuration ? (
          <>
            <span
              className="t-ui"
              data-typography-role="ui"
              style={{ color: 'var(--rn-ink)', whiteSpace: 'nowrap', minWidth: 0 }}
            >
              本轮用时
            </span>
            <span
              className="t-data"
              data-ready-tool-terminal-duration="true"
              data-typography-role="data"
              style={{ color: 'var(--rn-ink)', flex: 1, minWidth: 0 }}
            >
              {terminalDuration}
            </span>
          </>
        ) : !expanded && recentItems.length === 0 && latestEvent ? (
          <span
            className="t-meta"
            data-typography-role="meta"
            style={{
              color: 'var(--rn-ink-3)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              flex: 1
            }}
          >
            {latestPreview}
          </span>
        ) : (
          <span
            className="t-ui"
            data-typography-role="ui"
            style={{ color: 'var(--rn-ink)', whiteSpace: 'nowrap', minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {pending ? '正在执行' : '执行过程'}
          </span>
        )}
        <span className="t-data" data-typography-role="data" style={{ color: 'var(--rn-ink-3)', flexShrink: 0 }}>
          {items.length} 个工具
        </span>
        <CapsuleChevron expanded={Boolean(expanded)} />
      </button>
      {!expanded && recentItems.length > 0 ? (
        <div className="flex flex-col" style={{ padding: '0 0 8px' }} data-ready-tool-trace-recent="true">
          {recentItems.map((item, index) => (
            <ToolTimelineRow
              key={item.id}
              item={item}
              isLast={index === recentItems.length - 1}
              interactive={false}
            />
          ))}
        </div>
      ) : null}
      {expanded ? (
        <div
          style={{
            padding: '8px 0 10px',
            borderTop: '1px solid var(--rn-hair)',
          }}
        >
          <ToolTimeline items={items} />
        </div>
      ) : null}
    </div>
  )
}
