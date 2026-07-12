import { useState, useRef, useEffect, useMemo } from 'react'
import { Wrench } from 'lucide-react'
import {
  buildTaskCardViewModel,
  deriveTaskCardRuntimeState,
  formatTaskUserFacingText,
  formatTaskProgressLabel,
  formatTaskStepDisplayTitle,
  getTaskStartModeLabel,
  isInternalAgentHandoffTask,
} from '../../../../modules/agent/taskCardViewModel'
import { formatSingleLinePreview, formatToolTracePreview } from '../../../../modules/agent/toolTracePreview'
import { deriveToolTimelineItems } from '../../../../modules/agent/toolTraceRows'
import { filterUserVisibleToolTraceEvents } from '../../../../modules/agent/toolTraceVisibility'
import type { ToolTraceEvent } from '../../../../modules/agent/types'
import { CapsuleChevron, ToolTimeline, ToolTimelineRow } from './ToolTimeline'
import { emitRendererAgentMetric } from '../../../../modules/agent/rendererMetrics'
import { progressPercent, memoryCaptureSourceLabel } from '../helpers/projection'
import {
  taskTypeBadgeLabel,
  interactionStateBadgeLabel,
  recoveryBadgeLabel,
  budgetWarningBadgeLabel,
} from '../helpers/badges'
import type { TaskCardRun } from '../../task-card-from-projection'
import { AgentStatusDot } from '../../../ui/dot-matrix/AgentStatusDot'
import { RunFeedbackStars } from './RunFeedbackStars'

// ---------------------------------------------------------------------------
// 2026-07-10 activity-capsule redesign — `TaskCard` 与 `ToolTraceCard` 共享
// 同一套「单行折叠 → 时间线 → 逐工具详情」三层披露渲染（Claude web / Matrix
// 风格）：
//   L1 折叠态只占一行（状态点 + 标题/最新动态 + 工具计数 + chevron）；
//   L2 展开成竖向时间线（进度 / 计划步骤 / 工具条目 / 产物 / 记忆 / 评分）；
//   L3 单个工具条目可再展开完整调用行与输出文本。
// 需要用户动作的行（继续/确认/取消…）不受折叠门控——有动作就直接露出，
// 交互闸门语义（Stage Q canResume、browser consent、detached/child-run 精确
// 路由）与旧卡片逐字保持。
// 两个导出组件都是纯 props 驱动（无 store / IPC），供 TaskToolSnapshot 消费；
// 时间线组件族（L2 条目 + L3 详情）在 ./ToolTimeline.tsx。
// ---------------------------------------------------------------------------

export const TASK_ACTION_BUTTON_STYLE: React.CSSProperties = {
  padding: '3px 8px',
  borderRadius: 8,
  border: '1px solid var(--border-default)',
  background: 'transparent',
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-snug)',
  fontWeight: 'var(--fw-medium)',
  color: 'var(--text-body)',
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
      className="t-meta"
      style={{ padding: '0 10px 7px 31px', color: 'var(--text-light)' }}
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
  background: 'color-mix(in srgb, var(--surface-card-bg) 20%, transparent)',
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
  width: '100%',
}

export function TaskCard({
  run,
  sessionId,
  events,
  pending = false,
  compact = false,
  expanded = false,
  disclosureState,
  onToggleExpanded,
  onOpenScope,
  onOpenArtifact,
  onDismissMemoryCapture,
  onUndoMemoryCapture,
  onSupplementMemoryCapture,
  onContinueInput,
  onSubmitConfirmation,
  onSubmitAgentResult,
  onRetry,
  onSuspendRun,
  onResumeRun,
  onCancelDetachedTask,
  onContinueDetachedTask,
  onCancelChildRun,
  onContinueChildRun,
  onResumeBrowserTask,
  onConfirmBrowserCollectionConsent,
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
  disclosureState?: Record<string, boolean>
  onToggleExpanded?: () => void
  onOpenScope?: (scopeId: string) => void
  onOpenArtifact?: (path: string) => void
  onDismissMemoryCapture?: (scopeId: string) => void
  onUndoMemoryCapture?: (scopeId: string) => void
  onSupplementMemoryCapture?: (scopeId: string) => void
  onContinueInput?: (scopeId: string) => void
  onSubmitConfirmation?: (scopeId: string, confirmed: boolean) => void
  onSubmitAgentResult?: (scopeId: string) => void
  onRetry?: (scopeId: string) => void
  onSuspendRun?: (scopeId: string) => void
  onResumeRun?: (scopeId: string) => void
  onCancelDetachedTask?: (scopeId: string, taskId?: string | null) => void
  onContinueDetachedTask?: (scopeId: string, taskId?: string | null) => void
  onCancelChildRun?: (scopeId: string, childRunId: string) => void
  onContinueChildRun?: (scopeId: string, childRunId: string) => void
  onResumeBrowserTask?: (scopeId: string, taskId: string) => void
  onConfirmBrowserCollectionConsent?: (scopeId: string, requestId: string) => void
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
  const primaryTitle = vm.title
  const steps = vm.steps
  const PLAN_STEP_COLLAPSE_THRESHOLD = 10
  const [showAllPlanSteps, setShowAllPlanSteps] = useState(false)
  const planStepsToRender = showAllPlanSteps ? steps : steps.slice(0, PLAN_STEP_COLLAPSE_THRESHOLD)
  const hiddenPlanStepCount = Math.max(0, steps.length - planStepsToRender.length)
  const recentArtifacts = run.recentArtifacts || []
  const isDetachedTask = typeof run.taskId === 'string' && run.taskId.startsWith('detached:')
  const childRunId = run.taskContinuation?.childRunId || null
  const isAgentHandoff = isInternalAgentHandoffTask(run)
  const shouldShowOpenScopeButton = Boolean(compact && run.scopeId !== sessionId)
  const browserTaskId = (() => {
    if (run.module !== 'browser') return null
    const continuationTaskId = typeof run.taskContinuation?.detachedTaskId === 'string'
      && run.taskContinuation.detachedTaskId.startsWith('browser-task-')
      ? run.taskContinuation.detachedTaskId
      : null
    if (continuationTaskId) return continuationTaskId
    return typeof run.taskId === 'string' && run.taskId.startsWith('browser-task-')
      ? run.taskId
      : null
  })()
  const browserCollectionConsent = run.module === 'browser'
    ? run.progress?.browserCollectionConsent || null
    : null
  const browserCollectionConsentLabel = browserCollectionConsent?.consentKind === 'high_control_url_batch_downgrade'
    ? '确认降级采集'
    : '确认部分采集'
  const progressLabel = formatTaskProgressLabel(run.progress)
  const progressValue = progressPercent(run.progress)
  const progressLabelAlreadyHasPercent = Boolean(progressLabel && /\d+%/.test(progressLabel))
  const progressLastError = run.progress?.lastError ? formatTaskUserFacingText(run.progress.lastError) : null
  const visibleMemoryCapture =
    run.memoryCapture && run.memoryCapture.status === 'ready' ? run.memoryCapture : null
  const summaryPreview = formatSingleLinePreview(vm.summary)
  const hasTerminalTaskStatus = (
    run.phase === 'done'
    || run.phase === 'cancelled'
    || run.status === 'completed'
    || run.status === 'failed'
    || run.status === 'killed'
  )
  const shouldShowInteractionBadge = Boolean(
    run.interactionState
    && run.interactionState !== 'running'
    && !hasTerminalTaskStatus,
  )
  const metaBadges = [
    getTaskStartModeLabel(run) || (run.taskType ? taskTypeBadgeLabel(run.taskType) : null),
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

  // 动作行按钮逐个求值（单一来源，JSX 复用同名布尔），动作行 = 任一按钮
  // 会渲染。阻塞型动作（等待补充/确认/可恢复/consent）折叠态也必须露出；
  // 「暂停任务」属于运行态可选控制，只在展开时出现，保住折叠一行的承诺。
  const resumableActions = run.resumableActions || []
  const showSuspendButton = Boolean(
    expanded
    && !isDetachedTask
    && (run.phase === 'planning' || run.phase === 'tool_running' || run.phase === 'responding' || run.phase === 'resuming'),
  )
  const showCancelDetached = isDetachedTask && resumableActions.includes('cancel')
  /* Stage Q (Stage 11) — `continue` / `retry` gated by `run.canResume`
     (main-derived truth); `cancel` stays ungated. Audit §C-9 / contract C7.
     Defensive default: undefined canResume treated as false. */
  const showContinueDetached = isDetachedTask && run.canResume === true && resumableActions.includes('continue')
  const showContinueChild = Boolean(childRunId) && run.canResume === true && resumableActions.includes('continue')
  const showCancelChild = Boolean(childRunId) && resumableActions.includes('cancel')
  const showResumeBrowser = Boolean(browserTaskId) && run.canResume === true && resumableActions.includes('continue')
  const showConsentButton = Boolean(browserCollectionConsent?.requestId)
  /* Stage Q — generic 继续运行：suspended + canResume，且 child/detached/
     browser 各自的精确按钮优先；waitingFor/resumable 残余条件保持旧动作行
     外层门的语义（waitingFor='none' 且无可恢复动作时不出现）。 */
  const showGenericResume = run.interactionState === 'suspended'
    && run.canResume === true
    && !childRunId
    && !isDetachedTask
    && !browserTaskId
    && (run.waitingFor !== 'none' || resumableActions.length > 0)
  const showContinueInput = !isAgentHandoff && (run.waitingFor === 'input' || run.waitingFor === 'clarification')
  const showConfirmationPair = run.waitingFor === 'confirmation' && !browserCollectionConsent
  const showAgentResult = run.waitingFor === 'agent_result'
  const showRetry = run.canResume === true && resumableActions.includes('retry')
  const hasActionRow = showSuspendButton
    || showCancelDetached
    || showContinueDetached
    || showContinueChild
    || showCancelChild
    || showResumeBrowser
    || showConsentButton
    || showGenericResume
    || showContinueInput
    || showConfirmationPair
    || showAgentResult
    || showRetry
    || shouldShowOpenScopeButton
  const showProgressRow = Boolean(progressLabel && (expanded || compact || !hasTerminalTaskStatus))

  return (
    <div
      data-ready-task-card="true"
      data-ready-task-scope-id={run.scopeId || undefined}
      data-ready-task-id={run.taskId || undefined}
      data-ready-task-child-run-id={childRunId || undefined}
      style={CAPSULE_SHELL_STYLE}
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        className="hover:bg-[color-mix(in_srgb,var(--surface-card-bg)_44%,transparent)] transition-colors duration-160"
        style={CAPSULE_HEADER_STYLE}
      >
        <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          <AgentStatusDot state={taskRuntimeState.visualState} size={11} />
        </span>
        <span
          className="t-ui"
          data-typography-role="ui"
          style={{
            color: 'var(--text-body)',
            fontWeight: 'var(--fw-medium)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {primaryTitle}
        </span>
        {headerPreview ? (
          <span
            className="t-meta"
            data-typography-role="meta"
            style={{
              color: 'var(--text-gray)',
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
        <span className="t-meta" data-typography-role="meta" style={{ color: 'var(--text-light)', flexShrink: 0 }}>
          {vm.statusLabel}
        </span>
        {toolCount > 0 ? (
          <span className="t-data" data-typography-role="data" style={{ color: 'var(--text-light)', flexShrink: 0 }}>
            {toolCount} 个工具
          </span>
        ) : null}
        <CapsuleChevron expanded={expanded} />
      </button>

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
        <div style={{ padding: '0 0 8px' }}>
          <div className="flex items-center justify-between" style={{ gap: 8 }}>
            <span
              className="t-meta"
              data-typography-role="meta"
              style={{
                color: 'var(--text-light)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {progressLabel}
            </span>
            {progressValue != null && !progressLabelAlreadyHasPercent && (
              <span className="t-data" data-typography-role="data" style={{ color: 'var(--text-light)', flexShrink: 0 }}>
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
                background: 'color-mix(in srgb, var(--text-light) 14%, transparent)',
              }}
            >
              <div
                style={{
                  width: `${progressValue}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: 'var(--color-ready-orange)',
                }}
              />
            </div>
          )}
          {progressLastError && expanded && (
            <div className="t-meta" data-typography-role="meta" style={{ color: 'var(--text-light)', marginTop: 4 }}>
              当前状态：{progressLastError}
            </div>
          )}
        </div>
      ) : null}

      {expanded && !compact && (
        <div
          className="flex flex-col"
          style={{
            gap: 10,
            padding: '8px 0 10px',
            borderTop: '1px solid color-mix(in srgb, var(--border-default) 72%, transparent)',
            maxHeight: '60vh',
            overflowY: 'auto',
          }}
        >
          {metaBadges.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {metaBadges.map((badge) => (
                <span
                  key={badge}
                  style={{
                    padding: '2px 7px',
                    borderRadius: 999,
                    border: '1px solid var(--border-default)',
                    fontSize: 'var(--text-xs)',
                    lineHeight: 'var(--leading-tight)',
                    fontWeight: 'var(--fw-medium)',
                    letterSpacing: 'var(--tracking-label)',
                    color: 'var(--text-light)',
                    background: 'color-mix(in srgb, var(--surface-card-bg) 22%, transparent)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {badge}
                </span>
              ))}
            </div>
          )}

          {summaryPreview && vm.summary !== primaryTitle && vm.summary !== vm.statusLabel ? (
            <div className="t-meta" data-typography-role="meta" style={{ color: 'var(--text-gray)' }}>
              {formatTaskUserFacingText(vm.summary)}
            </div>
          ) : null}

          {expanded && vm.currentStep && !hasTerminalTaskStatus ? (
            <div className="t-meta" data-typography-role="meta" style={{ color: 'var(--text-light)' }}>
              当前步骤：{vm.currentStep.title}
            </div>
          ) : null}

          {steps.length > 0 && (
            <div className="flex flex-col" style={{ gap: 5 }}>
              {planStepsToRender.map((step) => (
                <div key={step.id} className="flex items-start gap-2">
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 999,
                      marginTop: 5,
                      background:
                        step.status === 'done'
                          ? 'var(--color-green)'
                          : step.status === 'running'
                            ? 'var(--color-ready-orange)'
                            : step.status === 'blocked'
                              ? 'var(--color-orange, #f59e0b)'
                              : step.status === 'error'
                                ? 'var(--color-red)'
                                : 'var(--border-default)',
                      flexShrink: 0
                    }}
                  />
                  <div className="t-meta" data-typography-role="meta" style={{ minWidth: 0, flex: 1, color: 'var(--text-body)' }}>
                    {formatTaskStepDisplayTitle(step.title, run.progress)}
                    {step.detail ? (
                      <span style={{ color: 'var(--text-light)' }}>
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
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px dashed var(--border-default)',
                    background: 'transparent',
                    fontSize: 'var(--text-xs)',
                    lineHeight: 'var(--leading-snug)',
                    fontWeight: 'var(--fw-medium)',
                    color: 'var(--text-light)',
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
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px dashed var(--border-default)',
                    background: 'transparent',
                    fontSize: 'var(--text-xs)',
                    lineHeight: 'var(--leading-snug)',
                    fontWeight: 'var(--fw-medium)',
                    color: 'var(--text-light)',
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
            <div className="flex flex-wrap gap-1.5">
              {recentArtifacts.slice(-3).map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => artifact.path && onOpenArtifact?.(artifact.path)}
                  style={{
                    padding: '3px 7px',
                    borderRadius: 8,
                    border: '1px solid var(--border-default)',
                    background: 'transparent',
                    fontSize: 'var(--text-xs)',
                    lineHeight: 'var(--leading-snug)',
                    fontWeight: 'var(--fw-medium)',
                    color: 'var(--text-gray)',
                    cursor: artifact.path ? 'pointer' : 'default'
                  }}
                  title={artifact.path || artifact.label}
                >
                  {artifact.label}
                </button>
              ))}
            </div>
          )}

          {/* D5 — 终态 run 的用户反馈入口（runId 由 main 侧按 taskId 解析）。 */}
          {hasTerminalTaskStatus && !isDetachedTask && run.taskId ? (
            <RunFeedbackStars taskId={run.taskId} />
          ) : null}
        </div>
      )}

      {visibleMemoryCapture && (
        <div style={{ padding: '0 10px 10px' }}>
          <div
            style={{
              borderRadius: 8,
              background: 'var(--ready-task-card-accent-bg, color-mix(in srgb, var(--color-blue-light) 70%, transparent))',
              padding: '8px 9px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6
            }}
          >
            <div className="t-ui" data-typography-role="ui" style={{ color: 'var(--text-body)' }}>
              已记录的常驻偏好 / 当前上下文
            </div>
            <div className="flex flex-col" style={{ gap: 4 }}>
              {visibleMemoryCapture.items.map((item) => (
                <div key={item.memoryId} className="t-meta" data-typography-role="meta" style={{ color: 'var(--text-body)' }}>
                  {memoryCaptureSourceLabel(item.sourceType)} · {item.title}
                  {item.summary ? `：${item.summary}` : ''}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => onDismissMemoryCapture?.(run.scopeId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                确认
              </button>
              <button
                type="button"
                onClick={() => onUndoMemoryCapture?.(run.scopeId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                撤销
              </button>
              <button
                type="button"
                onClick={() => onSupplementMemoryCapture?.(run.scopeId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                补充
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 动作行不受折叠门控：等待用户/可恢复/需确认时必须一眼可点。 */}
      {hasActionRow && (
        <div className="flex flex-wrap gap-1.5" style={{ padding: '0 10px 9px' }}>
          {showSuspendButton && (
            <button
              type="button"
              onClick={() => onSuspendRun?.(run.scopeId)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              暂停任务
            </button>
          )}
          {showCancelDetached && (
            <button
              type="button"
              onClick={() => onCancelDetachedTask?.(run.scopeId, run.taskId || null)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              取消后台任务
            </button>
          )}
          {showContinueDetached && (
            <button
              type="button"
              onClick={() => onContinueDetachedTask?.(run.scopeId, run.taskId || null)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              继续后台任务
            </button>
          )}
          {showContinueChild && childRunId && (
            <button
              type="button"
              data-ready-task-action="continue-child-run"
              data-ready-task-scope-id={run.scopeId || undefined}
              data-ready-task-id={run.taskId || undefined}
              data-ready-task-child-run-id={childRunId}
              onClick={() => onContinueChildRun?.(run.scopeId, childRunId)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              {isAgentHandoff ? '继续生成报告' : '继续处理'}
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
          {showResumeBrowser && browserTaskId && (
            <button
              type="button"
              data-ready-task-action="resume-browser-task"
              data-ready-task-scope-id={run.scopeId || undefined}
              data-ready-task-id={browserTaskId}
              onClick={() => onResumeBrowserTask?.(run.scopeId, browserTaskId)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              继续浏览器采集
            </button>
          )}
          {showConsentButton && browserCollectionConsent?.requestId && (
            <button
              type="button"
              data-ready-task-action="confirm-browser-collection-consent"
              data-ready-task-scope-id={run.scopeId || undefined}
              data-ready-task-id={run.taskId || undefined}
              data-ready-task-consent-kind={browserCollectionConsent.consentKind}
              data-ready-task-consent-request-id={browserCollectionConsent.requestId}
              onClick={() => onConfirmBrowserCollectionConsent?.(run.scopeId, browserCollectionConsent.requestId)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              {browserCollectionConsentLabel}
            </button>
          )}
          {showGenericResume && (
            <button
              type="button"
              onClick={() => onResumeRun?.(run.scopeId)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              继续运行
            </button>
          )}
          {showContinueInput && (
            <button
              type="button"
              onClick={() => onContinueInput?.(run.scopeId)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              补充后继续
            </button>
          )}
          {showConfirmationPair && (
            <>
              <button
                type="button"
                onClick={() => onSubmitConfirmation?.(run.scopeId, true)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                确认继续
              </button>
              <button
                type="button"
                onClick={() => onSubmitConfirmation?.(run.scopeId, false)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                暂不继续
              </button>
            </>
          )}
          {showAgentResult && (
            <button
              type="button"
              onClick={() => onSubmitAgentResult?.(run.scopeId)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              补交结果
            </button>
          )}
          {showRetry && (
            <button
              type="button"
              onClick={() => onRetry?.(run.scopeId)}
              style={{ ...TASK_ACTION_BUTTON_STYLE }}
            >
              重试
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
  onToggleExpanded
}: {
  events: ToolTraceEvent[]
  pending?: boolean
  expanded?: boolean
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
        className="hover:bg-[color-mix(in_srgb,var(--surface-card-bg)_44%,transparent)] transition-colors duration-160"
        style={CAPSULE_HEADER_STYLE}
      >
        <Wrench
          style={{ width: 12, height: 12, color: 'var(--text-light)', flexShrink: 0 }}
          strokeWidth={2}
        />
        {!expanded && recentItems.length === 0 && latestEvent ? (
          <span
            className="t-meta"
            data-typography-role="meta"
            style={{
              color: 'var(--text-gray)',
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
            style={{ color: 'var(--text-body)', whiteSpace: 'nowrap', minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {pending ? '正在执行' : '执行过程'}
          </span>
        )}
        <span className="t-data" data-typography-role="data" style={{ color: 'var(--text-light)', flexShrink: 0 }}>
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
            borderTop: '1px solid color-mix(in srgb, var(--border-default) 72%, transparent)',
          }}
        >
          <ToolTimeline items={items} />
        </div>
      ) : null}
    </div>
  )
}
