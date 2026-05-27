import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Wrench } from 'lucide-react'
import {
  buildTaskCardViewModel,
  formatTaskUserFacingText,
  formatTaskProgressLabel,
  formatTaskStepDisplayTitle,
  getTaskStartModeLabel,
  isInternalAgentHandoffTask,
  type TaskSectionKey,
} from '../../../../modules/agent/taskCardViewModel'
import { formatSingleLinePreview, formatToolTracePreview } from '../../../../modules/agent/toolTracePreview'
import { emitRendererAgentMetric } from '../../../../modules/agent/rendererMetrics'
import { progressPercent, memoryCaptureSourceLabel } from '../helpers/projection'
import {
  taskTypeBadgeLabel,
  interactionStateBadgeLabel,
  recoveryBadgeLabel,
  budgetWarningBadgeLabel,
} from '../helpers/badges'
import type { TaskCardRun } from '../../task-card-from-projection'

// ---------------------------------------------------------------------------
// Stage V V1.6 — `TaskCard` + `ToolTraceCard` extracted from ChatPanel.tsx.
// Both components were already fully props-driven in their original
// definition (no `useAgent` / store / IPC inside the function body — every
// dependency arrives via the props interface or the typed `TaskCardRun`
// argument). This module owns the colocated `TASK_ACTION_BUTTON_STYLE`
// constant, which is only consumed by TaskCard's action row.
//
// Per plan §2 V1.6, `TaskCard` accepts an optional `sessionId?: string`
// prop slot to pre-wire the V3.3a multi-session interface. The field is
// currently not consumed by the body — callers in ChatPanel pass the
// current scope id through so future multi-session routing has a stable
// entry point without another signature change.
//
// V6 fixture (`src/__tests__/chat-panel-baseline.test.ts`) snapshot diff
// must remain 0; behavior is preserved byte-for-byte.
// ---------------------------------------------------------------------------

export const TASK_ACTION_BUTTON_STYLE: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 8,
  border: '1px solid var(--border-default)',
  background: 'transparent',
  fontSize: 10.5,
  color: 'var(--text-body)',
  cursor: 'pointer'
}

export function TaskCard({
  run,
  taskKey,
  sessionId,
  compact = false,
  expanded = false,
  disclosureState,
  onToggleExpanded,
  onToggleSection,
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
}: {
  run: TaskCardRun
  taskKey: string
  /**
   * Stage V V3.3a interface — multi-session routing slot. Currently unused
   * by the body; callers pass the active scope id so future dispatches
   * can wire per-session behavior without changing this signature again.
   */
  sessionId?: string
  compact?: boolean
  expanded?: boolean
  disclosureState?: Record<string, boolean>
  onToggleExpanded?: () => void
  onToggleSection?: (taskKey: string, sectionKey: TaskSectionKey, expanded: boolean) => void
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
}) {
  const vm = buildTaskCardViewModel(run, disclosureState)
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
  const steps = run.steps || []
  const PLAN_STEP_COLLAPSE_THRESHOLD = 10
  const [showAllPlanSteps, setShowAllPlanSteps] = useState(false)
  const planStepsToRender = showAllPlanSteps ? steps : steps.slice(0, PLAN_STEP_COLLAPSE_THRESHOLD)
  const hiddenPlanStepCount = Math.max(0, steps.length - planStepsToRender.length)
  const recentArtifacts = run.recentArtifacts || []
  const isDetachedTask = typeof run.taskId === 'string' && run.taskId.startsWith('detached:')
  const childRunId = run.taskContinuation?.childRunId || null
  const isAgentHandoff = isInternalAgentHandoffTask(run)
  const shouldShowOpenScopeButton = Boolean(compact && run.scopeId !== sessionId)
  const progressLabel = formatTaskProgressLabel(run.progress)
  const progressValue = progressPercent(run.progress)
  const progressLastError = run.progress?.lastError ? formatTaskUserFacingText(run.progress.lastError) : null
  const visibleMemoryCapture =
    run.memoryCapture && run.memoryCapture.status === 'ready' ? run.memoryCapture : null
  const summaryPreview = formatSingleLinePreview(vm.summary)
  const metaBadges = [
    getTaskStartModeLabel(run) || (run.taskType ? taskTypeBadgeLabel(run.taskType) : null),
    run.interactionState && run.interactionState !== 'running'
      ? interactionStateBadgeLabel(run.interactionState)
      : null,
    run.budgetUsagePercent != null ? `预算 ${Math.round(run.budgetUsagePercent)}%` : null,
    run.stepBudget
      ? `步骤余量 ${Math.max(0, Math.round(run.stepBudget.remainingIterations || 0))}/${Math.max(0, Math.round(run.stepBudget.maxIterations || 0))}`
      : null,
    run.budgetWarningLevel ? budgetWarningBadgeLabel(run.budgetWarningLevel) : null,
    run.degradationReason ? `降级 ${run.degradationReason}` : null,
    run.recoveryHistory && run.recoveryHistory.length > 0
      ? recoveryBadgeLabel(run.recoveryHistory)
      : null
  ].filter(Boolean) as string[]
  const renderSectionButton = (sectionKey: TaskSectionKey) => {
    const section = vm.sections[sectionKey]
    if (section.count <= 0) return null
    return (
      <button
        key={section.key}
        type="button"
        onClick={() => onToggleSection?.(taskKey, section.key, !section.expanded)}
        className="flex items-center justify-between gap-3"
        style={{
          width: '100%',
          border: 'none',
          background: 'transparent',
          padding: '6px 0',
          cursor: 'pointer'
        }}
      >
        <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-body)' }}>
            {section.title}
          </div>
          {section.summary && (
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--text-light)',
                marginTop: 2,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {section.summary}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <span style={{ fontSize: 10, color: 'var(--text-light)' }}>{section.count}</span>
          <ChevronDown
            style={{
              width: 12,
              height: 12,
              color: 'var(--text-light)',
              transform: section.expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 160ms ease'
            }}
          />
        </div>
      </button>
    )
  }

  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid var(--border-default)',
        background: 'color-mix(in srgb, var(--surface-card-bg) 26%, transparent)',
        padding: compact ? '10px 12px' : '12px 12px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8
      }}
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        className="flex items-start justify-between gap-3"
        style={{
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-body)' }}>
            {primaryTitle}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-gray)', marginTop: 3 }}>
            {summaryPreview}
          </div>
          {metaBadges.length > 0 && (
            <div className="flex flex-wrap gap-1.5" style={{ marginTop: 6 }}>
              {metaBadges.map((badge) => (
                <span
                  key={badge}
                  style={{
                    padding: '3px 7px',
                    borderRadius: 999,
                    border: '1px solid var(--border-default)',
                    fontSize: 10,
                    color: 'var(--text-light)',
                    background: 'color-mix(in srgb, var(--surface-card-bg) 22%, transparent)'
                  }}
                >
                  {badge}
                </span>
              ))}
            </div>
          )}
          {expanded && vm.currentStep && (
            <div style={{ fontSize: 10.5, color: 'var(--text-light)', marginTop: 4 }}>
              当前步骤：{vm.currentStep.title}
            </div>
          )}
          {progressLabel && (
            <div style={{ marginTop: 7 }}>
              <div className="flex items-center justify-between" style={{ gap: 8 }}>
                <span
                  style={{
                    fontSize: 10.5,
                    color: 'var(--text-light)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {progressLabel}
                </span>
                {progressValue != null && (
                  <span style={{ fontSize: 10, color: 'var(--text-light)', flexShrink: 0 }}>
                    {progressValue}%
                  </span>
                )}
              </div>
              {progressValue != null && (
                <div
                  style={{
                    height: 5,
                    borderRadius: 999,
                    marginTop: 5,
                    overflow: 'hidden',
                    background: 'color-mix(in srgb, var(--text-light) 14%, transparent)',
                  }}
                >
                  <div
                    style={{
                      width: `${progressValue}%`,
                      height: '100%',
                      borderRadius: 999,
                      background: 'var(--color-blue)',
                    }}
                  />
                </div>
              )}
              {progressLastError && expanded && (
                <div style={{ fontSize: 10.5, color: 'var(--text-light)', marginTop: 4 }}>
                  当前状态：{progressLastError}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text-light)' }}>{vm.statusLabel}</div>
          <ChevronDown
            style={{
              width: 12,
              height: 12,
              color: 'var(--text-light)',
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 160ms ease'
            }}
          />
        </div>
      </button>

      {expanded && !compact && (
        <div
          className="flex flex-col"
          style={{ gap: 2, maxHeight: '60vh', overflowY: 'auto' }}
        >
          {renderSectionButton('plan')}
          {vm.sections.plan.expanded && steps.length > 0 && (
            <div className="flex flex-col" style={{ gap: 5, paddingBottom: 6 }}>
              {planStepsToRender.map((step) => (
                <div key={step.id} className="flex items-start gap-2">
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      marginTop: 5,
                      background:
                        step.status === 'done'
                          ? 'var(--color-green)'
                          : step.status === 'running'
                            ? 'var(--color-blue)'
                            : step.status === 'blocked'
                              ? 'var(--color-orange, #f59e0b)'
                              : step.status === 'error'
                                ? 'var(--color-red)'
                                : 'var(--border-default)',
                      flexShrink: 0
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 11.5, color: 'var(--text-body)' }}>
                      {formatTaskStepDisplayTitle(step.title, run.progress)}
                    </div>
                    {step.detail && (
                      <div style={{ fontSize: 10.5, color: 'var(--text-light)', marginTop: 1 }}>
                        {formatTaskUserFacingText(step.detail)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {hiddenPlanStepCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllPlanSteps(true)}
                  style={{
                    alignSelf: 'flex-start',
                    marginTop: 2,
                    padding: '3px 8px',
                    borderRadius: 999,
                    border: '1px dashed var(--border-default)',
                    background: 'transparent',
                    fontSize: 10.5,
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
                    marginTop: 2,
                    padding: '3px 8px',
                    borderRadius: 999,
                    border: '1px dashed var(--border-default)',
                    background: 'transparent',
                    fontSize: 10.5,
                    color: 'var(--text-light)',
                    cursor: 'pointer',
                  }}
                >
                  收起到前 {PLAN_STEP_COLLAPSE_THRESHOLD} 步
                </button>
              )}
            </div>
          )}

          {renderSectionButton('details')}
          {vm.sections.details.expanded && vm.detailGroups.length > 0 && (
            <div className="flex flex-col" style={{ gap: 8, paddingBottom: 6 }}>
              {vm.detailGroups.map((group) => (
                <div
                  key={group.id}
                  style={{
                    borderRadius: 8,
                    background: 'color-mix(in srgb, var(--surface-card-bg) 16%, transparent)',
                    padding: '7px 8px'
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-body)' }}>
                    {group.title}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-light)', marginTop: 2 }}>
                    {group.summary}
                  </div>
                  <div className="flex flex-col" style={{ gap: 3, marginTop: 6 }}>
                    {group.events.map((event) => (
                      <div
                        key={event.id}
                        style={{ fontSize: 10.5, color: 'var(--text-gray)', lineHeight: 1.45 }}
                      >
                        {event.text}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {renderSectionButton('artifacts')}
          {vm.sections.artifacts.expanded && recentArtifacts.length > 0 && (
            <div className="flex flex-wrap gap-1.5" style={{ paddingBottom: 6 }}>
              {recentArtifacts.slice(-3).map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => artifact.path && onOpenArtifact?.(artifact.path)}
                  style={{
                    padding: '4px 7px',
                    borderRadius: 8,
                    border: '1px solid var(--border-default)',
                    background: 'transparent',
                    fontSize: 10.5,
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

          {renderSectionButton('memory')}
        </div>
      )}

      {expanded && visibleMemoryCapture && vm.sections.memory.expanded && (
        <div
          style={{
            borderRadius: 10,
            background: 'color-mix(in srgb, var(--color-blue-light) 70%, transparent)',
            padding: '8px 9px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-body)' }}>
            已记录的常驻偏好 / 当前上下文
          </div>
          <div className="flex flex-col" style={{ gap: 4 }}>
            {visibleMemoryCapture.items.map((item) => (
              <div key={item.memoryId} style={{ fontSize: 10.5, color: 'var(--text-body)' }}>
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
      )}

      {expanded &&
        (run.waitingFor !== 'none' || (run.resumableActions || []).length > 0 || shouldShowOpenScopeButton) && (
          <div className="flex flex-wrap gap-1.5">
            {!isDetachedTask && (run.phase === 'planning' || run.phase === 'tool_running' || run.phase === 'responding' || run.phase === 'resuming') && (
              <button
                type="button"
                onClick={() => onSuspendRun?.(run.scopeId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                暂停任务
              </button>
            )}
            {isDetachedTask && (run.resumableActions || []).includes('cancel') && (
              <button
                type="button"
                onClick={() => onCancelDetachedTask?.(run.scopeId, run.taskId || null)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                取消后台任务
              </button>
            )}
            {/* Stage Q (Stage 11) — `continue` and `retry` actions are
                gated by `run.canResume` (main-derived truth). `cancel`
                stays ungated (always allowed). Audit §C-9 / §D / contract C7.
                Defensive default: undefined canResume treated as false. */}
            {isDetachedTask && run.canResume === true && (run.resumableActions || []).includes('continue') && (
              <button
                type="button"
                onClick={() => onContinueDetachedTask?.(run.scopeId, run.taskId || null)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                继续后台任务
              </button>
            )}
            {childRunId && run.canResume === true && (run.resumableActions || []).includes('continue') && (
              <button
                type="button"
                onClick={() => onContinueChildRun?.(run.scopeId, childRunId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                {isAgentHandoff ? '继续生成报告' : '继续处理'}
              </button>
            )}
            {childRunId && (run.resumableActions || []).includes('cancel') && (
              <button
                type="button"
                onClick={() => onCancelChildRun?.(run.scopeId, childRunId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                取消
              </button>
            )}
            {/* Stage Q — generic 继续运行 button: previously triggered on
                `interactionState === 'suspended'` alone; now also gated
                by `canResume === true`. Child-run and detached task cards
                use their exact-id buttons above. */}
            {run.interactionState === 'suspended' && run.canResume === true && !childRunId && !isDetachedTask && (
              <button
                type="button"
                onClick={() => onResumeRun?.(run.scopeId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                继续运行
              </button>
            )}
            {!isAgentHandoff && (run.waitingFor === 'input' || run.waitingFor === 'clarification') && (
              <button
                type="button"
                onClick={() => onContinueInput?.(run.scopeId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                补充后继续
              </button>
            )}
            {run.waitingFor === 'confirmation' && (
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
            {run.waitingFor === 'agent_result' && (
              <button
                type="button"
                onClick={() => onSubmitAgentResult?.(run.scopeId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                补交结果
              </button>
            )}
            {/* Stage Q (Stage 11) — retry gate: empty-shell projections
                can have stale 'retry' in resumableActions but
                canResume=false; we refuse to render the button.
                Defensive default applies (undefined → not resumable). */}
            {run.canResume === true && (run.resumableActions || []).includes('retry') && (
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
  events: Array<{ id: string; kind: 'call' | 'result'; text: string; timestamp: Date }>
  pending?: boolean
  expanded?: boolean
  onToggleExpanded?: () => void
}) {
  if (events.length === 0) return null
  const latestEvent = events[events.length - 1]
  const latestPreview = formatToolTracePreview(latestEvent?.text)
  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid var(--border-default)',
        background: 'color-mix(in srgb, var(--surface-card-bg) 20%, transparent)',
        padding: '9px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6
      }}
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        className="flex items-center justify-between gap-2"
        style={{
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <div className="flex items-center gap-2" style={{ minWidth: 0, flex: 1 }}>
          <Wrench
            style={{ width: 12, height: 12, color: 'var(--text-light)', flexShrink: 0 }}
            strokeWidth={2}
          />
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--text-body)',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            {pending ? '进行中的工具调用' : '工具调用'}
          </div>
          {!expanded && latestEvent ? (
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--text-gray)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
                flex: 1
              }}
            >
              {latestPreview}
            </div>
          ) : null}
        </div>
        <ChevronDown
          style={{
            width: 12,
            height: 12,
            color: 'var(--text-light)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 160ms ease'
          }}
        />
      </button>
      {expanded ? (
        <div className="flex flex-col" style={{ gap: 4 }}>
          {events.map((event) => (
            <div
              key={event.id}
              className="flex items-start gap-2"
              style={{ fontSize: 10.5, color: 'var(--text-gray)', lineHeight: 1.45 }}
            >
              <span
                style={{
                  color: event.kind === 'call' ? 'var(--color-blue)' : 'var(--color-green)',
                  marginTop: 1
                }}
              >
                {event.kind === 'call' ? '•' : '✓'}
              </span>
              <span style={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>{event.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
