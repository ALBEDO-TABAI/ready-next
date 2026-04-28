import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'framer-motion'
import {
  X,
  FileText,
  Image,
  Film,
  Table,
  Globe,
  Puzzle,
  Pen,
  MessageSquareQuote,
  Folder,
  ChevronDown,
  PanelLeftClose,
  History,
  Plus,
  Wrench
} from 'lucide-react'
import {
  useAgent,
  initAgentListeners,
  ChatAttachment,
  ConversationScope,
  ScopeRunState
} from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'
import { useSettings, listChatSwitcherProfiles } from '../../stores/useSettings'
import { useNavigate } from 'react-router-dom'
import { READY_FOCUS_CHAT_INPUT_EVENT } from '../../modules/agent/chat-input-bridge'
import { revealDocumentQuoteAttachment } from '../../modules/agent/document-quote-navigation'
import { toLocalFileUrl } from '../../utils/dragDrop'
import {
  WORKBENCH_EDGE_RAIL_SIZE,
  WORKBENCH_TOPBAR_HEIGHT,
  WORKBENCH_TOPBAR_PADDING_RIGHT
} from '../../modules/workbench/chrome'
import {
  WORKBENCH_PANEL_MOTION_DURATION_S,
  WORKBENCH_PANEL_MOTION_EASE,
  WORKBENCH_PANEL_MOTION_OFFSET_PX,
  WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S,
} from '../../modules/workbench/panel-motion'
import { LIQUID_INACTIVE_CHROME_STYLE } from '../ui/LiquidGlassScene'
import { IconButton } from '../ui/IconButton'
import {
  buildTaskCardViewModel,
  createDefaultTaskDisclosureState,
  type TaskCardRunLike,
  type TaskSectionKey
} from '../../modules/agent/taskCardViewModel'
import { formatSingleLinePreview, formatToolTracePreview } from '../../modules/agent/toolTracePreview'
import type { SessionRecallCapsule, SessionRecallHit } from '../../../shared/session-recall'
import type { RecoveryRecordData, ReferenceSkillHintData, TaskProjectionRecordData } from '../../types/electron'
import ChatHeader from './ChatHeader'
import ChatMessages from './ChatMessages'
import ChatInput, { ChatInputHandle } from './ChatInput'
import { SoftFailureCapsule } from './SoftFailureCapsule'
import ChatAttachments from './ChatAttachments'

// ---------------------------------------------------------------------------
// Lightweight Markdown renderer (no external deps)
// Supports: **bold**, *italic*, `inline code`, ```code blocks```,
//           # headers, bullet lists (- / *), numbered lists, line breaks
// ---------------------------------------------------------------------------

interface MarkdownNode {
  type: 'text' | 'bold' | 'italic' | 'code' | 'codeblock' | 'header' | 'bullet' | 'numbered' | 'br'
  content: string
  level?: number // header level 1-3
  lang?: string // code block language
}

interface PersistedScopeRunSummary {
  scopeId: string
  agent: string
  title: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  channelKey: string
  threadKey: string
  phase: ScopeRunState['phase']
  taskId?: string | null
  taskTitle?: string | null
  taskSummary?: string | null
  steps?: ScopeRunState['steps']
  currentStepId?: string | null
  waitingFor?: ScopeRunState['waitingFor']
  resumableActions?: ScopeRunState['resumableActions']
  recentArtifacts?: ScopeRunState['recentArtifacts']
  taskContinuation?: ScopeRunState['taskContinuation']
  memoryCapture?: ScopeRunState['memoryCapture']
  blockedReason?: string | null
  error?: string | null
  updatedAt: string
}

type PersistedTaskProjection = TaskProjectionRecordData

interface TaskCardRun extends TaskCardRunLike {
  responseMessageId?: string | null
  responseSegmentToolTraceStart?: number | null
}

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

function normalizeProjectionSteps(
  steps: TaskProjectionRecordData['steps'] | undefined,
): ScopeRunState['steps'] {
  return (steps || []).map((step) => ({
    id: step.id,
    title: step.title || step.description || step.id,
    status: step.status || 'pending',
    detail: step.detail,
    updatedAt: step.updatedAt || new Date(0).toISOString(),
  }))
}

function resolveProjectionForTaskRun(
  projections: PersistedTaskProjection[] | undefined,
  run: Pick<TaskCardRun, 'taskId' | 'taskContinuation'>,
  persistedRun?: Pick<PersistedScopeRunSummary, 'taskId' | 'taskContinuation'> | null,
): PersistedTaskProjection | null {
  const items = projections || []
  const candidateIds = [
    run.taskId,
    run.taskContinuation?.taskId,
    persistedRun?.taskId,
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)

  for (const candidateId of candidateIds) {
    const matched = items.find((item) => item.taskId === candidateId)
    if (matched) return matched
  }

  return items.find((item) =>
    item.status === 'running' || item.status === 'blocked' || item.interactionState === 'resuming',
  ) || items[0] || null
}

function resolveProjectionWaitingFor(
  projection: PersistedTaskProjection | null,
  fallback?: ScopeRunState['waitingFor'],
): ScopeRunState['waitingFor'] {
  if (!projection) return fallback || 'none'
  if (projection.interactionState === 'awaiting_confirmation') return 'confirmation'
  if (projection.interactionState === 'awaiting_clarification') return 'clarification'
  if (projection.interactionState === 'human_takeover') return 'agent_result'
  if (projection.status === 'blocked') return 'background'
  return fallback || 'none'
}

function resolveProjectionBlockedReason(
  projection: PersistedTaskProjection | null,
  fallback?: string | null,
): string | null {
  if (!projection) return fallback || null
  return projection.blockedReason ?? null
}

function shouldPreferProjectionContinuation(projection: PersistedTaskProjection | null): boolean {
  return Boolean(
    projection?.continuationRef &&
    (
      projection.status === 'blocked' ||
      projection.interactionState === 'suspended' ||
      projection.continuationRef.pauseReason ||
      projection.continuationRef.detachedTaskId ||
      projection.continuationRef.taskRunId ||
      projection.continuationRef.runStatePath ||
      projection.continuationRef.outputDir
    ),
  )
}

function resolveTaskContinuationForProjection(
  projection: PersistedTaskProjection | null,
  fallback?: ScopeRunState['taskContinuation'],
): ScopeRunState['taskContinuation'] {
  if (shouldPreferProjectionContinuation(projection)) return projection?.continuationRef || null
  return fallback || projection?.continuationRef || null
}

function memoryCaptureSourceLabel(
  sourceType: 'resident_agent' | 'resident_user' | 'scope_memory' | 'trigger_rule' | undefined
): string {
  switch (sourceType) {
    case 'resident_agent':
      return '常驻记忆'
    case 'resident_user':
      return '用户偏好'
    case 'scope_memory':
      return '当前任务摘要'
    case 'trigger_rule':
      return '规则沉淀'
    default:
      return '记忆'
  }
}

function mapScopeToConversation(scope: ConversationScope) {
  return {
    id: scope.id,
    agent: scope.agent,
    title: scope.title,
    created_at: scope.createdAt,
    updated_at: scope.updatedAt
  }
}

function parseMarkdown(raw: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  const lines = raw.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      nodes.push({ type: 'codeblock', content: codeLines.join('\n'), lang })
      i++ // skip closing ```
      continue
    }

    // Header (# ## ###)
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/)
    if (headerMatch) {
      nodes.push({ type: 'header', content: headerMatch[2], level: headerMatch[1].length })
      i++
      continue
    }

    // Bullet list (- or *)
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/)
    if (bulletMatch) {
      nodes.push({ type: 'bullet', content: bulletMatch[1] })
      i++
      continue
    }

    // Numbered list
    const numMatch = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (numMatch) {
      nodes.push({ type: 'numbered', content: numMatch[1] })
      i++
      continue
    }

    // Empty line -> line break
    if (line.trim() === '') {
      nodes.push({ type: 'br', content: '' })
      i++
      continue
    }

    // Regular text line
    nodes.push({ type: 'text', content: line })
    i++
  }

  return nodes
}

/** Parse inline formatting: **bold**, *italic*, `code` */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  // Combined regex for inline code, bold, italic
  const regex = /(`([^`]+)`)|(\*\*(.+?)\*\*)|(\*(.+?)\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    if (match[1]) {
      // inline code
      parts.push(
        <code
          key={`ic-${key++}`}
          style={{
            background: 'var(--bg-code)',
            padding: '1px 5px',
            borderRadius: 4,
            fontSize: '0.9em',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
          }}
        >
          {match[2]}
        </code>
      )
    } else if (match[3]) {
      // bold
      parts.push(<strong key={`b-${key++}`}>{match[4]}</strong>)
    } else if (match[5]) {
      // italic
      parts.push(<em key={`i-${key++}`}>{match[6]}</em>)
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

function MarkdownContent({ content }: { content: string }) {
  const nodes = useMemo(() => parseMarkdown(content), [content])

  return (
    <div className="markdown-content" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {nodes.map((node, idx) => {
        switch (node.type) {
          case 'header': {
            const fontSize = node.level === 1 ? 16 : node.level === 2 ? 14.5 : 13.5
            return (
              <div key={idx} style={{ fontSize, fontWeight: 700, marginTop: 6, marginBottom: 2 }}>
                {renderInline(node.content)}
              </div>
            )
          }
          case 'codeblock':
            return (
              <pre
                key={idx}
                style={{
                  background: 'var(--bg-code)',
                  padding: '10px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: '4px 0',
                  lineHeight: 1.5
                }}
              >
                {node.content}
              </pre>
            )
          case 'bullet':
            return (
              <div key={idx} style={{ display: 'flex', gap: 6, paddingLeft: 4 }}>
                <span style={{ flexShrink: 0, color: 'var(--text-gray)' }}>&bull;</span>
                <span>{renderInline(node.content)}</span>
              </div>
            )
          case 'numbered':
            return (
              <div key={idx} style={{ display: 'flex', gap: 6, paddingLeft: 4 }}>
                <span
                  style={{
                    flexShrink: 0,
                    color: 'var(--text-gray)',
                    minWidth: 14,
                    textAlign: 'right'
                  }}
                >
                  {idx + 1}.
                </span>
                <span>{renderInline(node.content)}</span>
              </div>
            )
          case 'br':
            return <div key={idx} style={{ height: 6 }} />
          default:
            return <div key={idx}>{renderInline(node.content)}</div>
        }
      })}
    </div>
  )
}

function taskPhaseLabel(phase: ScopeRunState['phase']): string {
  if (phase === 'planning') return '规划中'
  if (phase === 'tool_running' || phase === 'responding' || phase === 'resuming') return '进行中'
  if (phase === 'checkpoint' || phase === 'takeover') return '等待继续'
  if (phase === 'done') return '已完成'
  if (phase === 'error') return '失败'
  if (phase === 'cancelled') return '已停止'
  return '待处理'
}

function taskTypeBadgeLabel(taskType: TaskCardRun['taskType'] | undefined): string {
  switch (taskType) {
    case 'direct_answer':
      return '直答'
    case 'short_task':
      return '短任务'
    case 'multi_step_task':
      return '多步任务'
    case 'media_task':
      return '媒体任务'
    case 'continuation':
      return '继续任务'
    default:
      return '任务'
  }
}

function interactionStateBadgeLabel(
  interactionState: TaskCardRun['interactionState'] | undefined
): string {
  switch (interactionState) {
    case 'awaiting_clarification':
      return '等补充'
    case 'awaiting_confirmation':
      return '等确认'
    case 'human_takeover':
      return '人工接手'
    case 'suspended':
      return '已暂停'
    case 'resuming':
      return '恢复中'
    case 'running':
      return '执行中'
    default:
      return '进行中'
  }
}

function recoveryBadgeLabel(recoveryHistory: RecoveryRecordData[]): string {
  const latest = recoveryHistory[recoveryHistory.length - 1]
  if (!latest) return '自动恢复'
  switch (latest.kind) {
    case 'rate_limit':
      return '限流恢复'
    case 'context_overflow':
      return '压缩恢复'
    case 'timeout_model':
      return '模型超时恢复'
    case 'timeout_tool':
      return '工具超时恢复'
    case 'auth':
      return '认证恢复'
    case 'transient':
      return '重试恢复'
    case 'host_unavailable':
      return '宿主降级'
    default:
      return '自动恢复'
  }
}

function budgetWarningBadgeLabel(level: TaskProjectionRecordData['budgetWarningLevel']): string | null {
  switch (level) {
    case 'warning':
      return '预算预警'
    case 'converge':
      return '接近上限'
    case 'exhausted':
      return '预算耗尽'
    default:
      return null
  }
}

function isTaskVisible(run: TaskCardRun | null | undefined): boolean {
  if (!run) return false
  return Boolean(
    run.taskTitle ||
    run.taskSummary ||
    (run.steps && run.steps.length > 0) ||
    (run.memoryCapture && run.memoryCapture.status !== 'dismissed')
  )
}

function TaskCard({
  run,
  taskKey,
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
}: {
  run: TaskCardRun
  taskKey: string
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
}) {
  const vm = buildTaskCardViewModel(run, disclosureState)
  const primaryTitle = vm.title
  const steps = run.steps || []
  const PLAN_STEP_COLLAPSE_THRESHOLD = 10
  const [showAllPlanSteps, setShowAllPlanSteps] = useState(false)
  const planStepsToRender = showAllPlanSteps ? steps : steps.slice(0, PLAN_STEP_COLLAPSE_THRESHOLD)
  const hiddenPlanStepCount = Math.max(0, steps.length - planStepsToRender.length)
  const recentArtifacts = run.recentArtifacts || []
  const isDetachedTask = typeof run.taskId === 'string' && run.taskId.startsWith('detached:')
  const visibleMemoryCapture =
    run.memoryCapture && run.memoryCapture.status === 'ready' ? run.memoryCapture : null
  const summaryPreview = formatSingleLinePreview(vm.summary)
  const metaBadges = [
    run.taskType ? taskTypeBadgeLabel(run.taskType) : null,
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
                    <div style={{ fontSize: 11.5, color: 'var(--text-body)' }}>{step.title}</div>
                    {step.detail && (
                      <div style={{ fontSize: 10.5, color: 'var(--text-light)', marginTop: 1 }}>
                        {step.detail}
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
        (run.waitingFor !== 'none' || (run.resumableActions || []).length > 0 || compact) && (
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
            {isDetachedTask && (run.resumableActions || []).includes('continue') && (
              <button
                type="button"
                onClick={() => onContinueDetachedTask?.(run.scopeId, run.taskId || null)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                继续后台任务
              </button>
            )}
            {run.interactionState === 'suspended' && (
              <button
                type="button"
                onClick={() => onResumeRun?.(run.scopeId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                继续运行
              </button>
            )}
            {(run.waitingFor === 'input' || run.waitingFor === 'clarification') && (
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
            {(run.resumableActions || []).includes('retry') && (
              <button
                type="button"
                onClick={() => onRetry?.(run.scopeId)}
                style={{ ...TASK_ACTION_BUTTON_STYLE }}
              >
                重试
              </button>
            )}
            {compact && (
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

function ToolTraceCard({
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

const TASK_ACTION_BUTTON_STYLE: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 8,
  border: '1px solid var(--border-default)',
  background: 'transparent',
  fontSize: 10.5,
  color: 'var(--text-body)',
  cursor: 'pointer'
}

export type ChatPanelState = 'expanding' | 'expanded' | 'collapsing' | 'collapsed'

function ChatPanelMotionLayer({
  header,
  body,
  children,
}: {
  header?: React.ReactNode
  body?: React.ReactNode
  children?: React.ReactNode
}) {
  const isPresent = useIsPresent()
  const layerZIndex = isPresent ? 1 : 2
  const reduceMotion = useReducedMotion()
  const content = !header || !body
    ? children
    : (
        <div
          className="grid h-full min-h-0"
          style={{
            gridTemplateRows: `${WORKBENCH_TOPBAR_HEIGHT}px minmax(0, 1fr)`
          }}
        >
          <div className="relative overflow-visible" style={{ zIndex: 4 }}>
            {header}
          </div>

          <div className="relative min-h-0 overflow-hidden flex flex-col" style={{ zIndex: 1 }}>
            {body}
          </div>
        </div>
      )

  return (
    <motion.div
      className="absolute inset-0 overflow-hidden"
      style={{
        zIndex: layerZIndex,
        pointerEvents: isPresent ? 'auto' : 'none',
        willChange: reduceMotion ? 'auto' : 'transform, opacity'
      }}
      initial={reduceMotion ? false : { x: WORKBENCH_PANEL_MOTION_OFFSET_PX, opacity: 0.01 }}
      animate={{
        x: 0,
        opacity: 1,
        transition: reduceMotion
          ? { duration: WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S }
          : { duration: WORKBENCH_PANEL_MOTION_DURATION_S, ease: WORKBENCH_PANEL_MOTION_EASE }
      }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: { duration: WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S } }
          : {
              x: WORKBENCH_PANEL_MOTION_OFFSET_PX,
              opacity: 0.01,
              transition: { duration: WORKBENCH_PANEL_MOTION_DURATION_S, ease: WORKBENCH_PANEL_MOTION_EASE }
            }
      }
    >
      {content}
    </motion.div>
  )
}

function CollapsedChatRail({
  onTogglePanel,
  onHistoryOpen,
  onNewSession
}: {
  onTogglePanel: () => void
  onHistoryOpen: () => void
  onNewSession: () => void
}) {
  return (
    <div
      className="flex h-full w-full flex-col"
      style={{
        width: WORKBENCH_EDGE_RAIL_SIZE,
        minWidth: WORKBENCH_EDGE_RAIL_SIZE,
        background: 'transparent',
        alignItems: 'flex-end',
        paddingRight: WORKBENCH_TOPBAR_PADDING_RIGHT,
        boxSizing: 'border-box'
      }}
    >
      <div
        className="flex w-full items-center justify-end"
        style={{
          height: WORKBENCH_TOPBAR_HEIGHT,
          borderBottom: '1px solid transparent'
        }}
      >
        <IconButton
          icon={<PanelLeftClose style={{ width: 15, height: 15 }} strokeWidth={2} />}
          onClick={onTogglePanel}
          title="展开聊天面板"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
        />
      </div>

      <div className="flex w-full flex-col items-end gap-2 pt-3">
        <IconButton
          icon={<History style={{ width: 14, height: 14 }} strokeWidth={2} />}
          onClick={onHistoryOpen}
          title="打开历史对话"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
        />
        <IconButton
          icon={<Plus style={{ width: 14, height: 14 }} strokeWidth={2} />}
          onClick={onNewSession}
          title="新建对话"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model Selector (wired to useSettings store)
// ---------------------------------------------------------------------------

function ModelSelector() {
  const navigate = useNavigate()
  const {
    config,
    workspace,
    loaded,
    loadConfig,
    activateProfile,
    getActiveProfile,
    getShortModelLabel,
    getShortProviderLabel,
  } = useSettings()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!loaded) loadConfig()
  }, [loaded, loadConfig])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const hasKey = !!config.apiKey
  const activeProfile = getActiveProfile()
  const label = activeProfile?.name || config.displayName || getShortProviderLabel()
  // `showInChatSwitcher` is pre-filtered into `visibleProfiles`.
  const { currentHiddenProfile, visibleProfiles } = listChatSwitcherProfiles(workspace)

  const resolveHost = (value: string): string => {
    try {
      return value ? new URL(value).hostname : '未配置'
    } catch {
      return value || '未配置'
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center active:scale-[0.98] transition-[background-color,transform] duration-200 ease-out"
        style={{
          padding: '3px 8px',
          borderRadius: 8,
          border: '1px solid transparent',
          background: 'transparent',
          gap: 4
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: hasKey ? 'var(--color-green)' : 'var(--color-red)' }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>{label}</span>
        <ChevronDown
          style={{
            width: 10,
            height: 10,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms ease'
          }}
          className="text-[var(--text-light)]"
        />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 4,
            minWidth: 248,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-default)',
            borderRadius: 12,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            padding: 8,
            zIndex: 100
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-light)',
              padding: '2px 8px',
              marginBottom: 4
            }}
          >
            当前模型
          </div>
          <div
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              background: 'var(--bg-hover)'
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-body)' }}>
              {getShortModelLabel()}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>
              {resolveHost(config.baseUrl)}
            </div>
          </div>

          {currentHiddenProfile && (
            <div style={{ marginTop: 8 }}>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--text-light)',
                  padding: '2px 8px',
                  marginBottom: 4,
                }}
              >
                当前使用中
              </div>
              <button
                onClick={() => {
                  activateProfile(currentHiddenProfile.id)
                  setOpen(false)
                }}
                className="w-full text-left hover:bg-black/5 transition-colors"
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border-default)',
                  background: 'transparent',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-body)' }}>
                  {currentHiddenProfile.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>
                  {getShortModelLabel(currentHiddenProfile.id)}
                </div>
              </button>
            </div>
          )}

          {visibleProfiles.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--text-light)',
                  padding: '2px 8px',
                  marginBottom: 4,
                }}
              >
                快速切换
              </div>
              <div className="flex flex-col gap-1">
                {visibleProfiles.map((profile) => {
                  const isActive = profile.id === activeProfile?.id
                  return (
                    <button
                      key={profile.id}
                      onClick={() => {
                        activateProfile(profile.id)
                        setOpen(false)
                      }}
                      className="w-full text-left hover:bg-black/5 transition-colors"
                      style={{
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: isActive ? '1px solid color-mix(in srgb, var(--color-blue) 28%, transparent)' : '1px solid transparent',
                        background: isActive ? 'var(--bg-hover)' : 'transparent',
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-body)' }}>{profile.name}</span>
                        {isActive && (
                          <span style={{ fontSize: 10, color: 'var(--color-blue)' }}>当前</span>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>
                        {getShortModelLabel(profile.id)}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {!hasKey && (
            <div
              style={{ fontSize: 10, color: 'var(--color-red)', padding: '4px 8px', marginTop: 4 }}
            >
              未配置 API Key，请前往设置页配置
            </div>
          )}

          <button
            onClick={() => {
              navigate('/settings?section=ai')
              setOpen(false)
            }}
            className="w-full flex items-center justify-center gap-2 hover:bg-black/5 transition-colors"
            style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--border-default)',
              background: 'transparent',
              fontSize: 11,
              color: 'var(--text-muted)',
            }}
          >
            <Wrench style={{ width: 12, height: 12 }} strokeWidth={2} />
            管理显示项
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Attachment icon helper
// ---------------------------------------------------------------------------

function AttachmentIcon({ attachment, size = 16 }: { attachment: ChatAttachment; size?: number }) {
  const style = { width: size, height: size }
  const cls = 'text-[var(--text-gray)]'
  if (attachment.isDirectory) {
    return <Folder style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'browser-tab') {
    return <Globe style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'document-quote') {
    return <MessageSquareQuote style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'design-project') {
    return <Pen style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'skill-folder') {
    return <Puzzle style={style} className={cls} strokeWidth={2} />
  }
  switch (attachment.type) {
    case 'image':
      return <Image style={style} className={cls} strokeWidth={2} />
    case 'video':
      return <Film style={style} className={cls} strokeWidth={2} />
    case 'spreadsheet':
      return <Table style={style} className={cls} strokeWidth={2} />
    default:
      return <FileText style={style} className={cls} strokeWidth={2} />
  }
}

function getAttachmentPreviewSrc(attachment: ChatAttachment): string | null {
  if (attachment.type !== 'image') return null
  if (!attachment.path || !attachment.path.startsWith('/')) return null
  return `file://${encodeURI(attachment.path)}`
}

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

interface ConversationChannelOption {
  key: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  label: string
  caption: string
}

const IMAGE_ATTACHMENT_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff'])
const VIDEO_ATTACHMENT_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi'])
const TEXT_ATTACHMENT_EXTS = new Set([
  'txt',
  'md',
  'csv',
  'pdf',
  'json',
  'html',
  'docx',
  'doc',
  'rtf',
  'odt'
])
const SPREADSHEET_ATTACHMENT_EXTS = new Set(['xlsx', 'xls', 'tsv'])

function getAttachmentTypeFromExt(ext?: string, isDirectory = false): ChatAttachment['type'] {
  if (isDirectory) return 'other'
  const normalizedExt = String(ext || '')
    .toLowerCase()
    .replace(/^\./, '')
  if (IMAGE_ATTACHMENT_EXTS.has(normalizedExt)) return 'image'
  if (VIDEO_ATTACHMENT_EXTS.has(normalizedExt)) return 'video'
  if (TEXT_ATTACHMENT_EXTS.has(normalizedExt)) return 'text'
  if (SPREADSHEET_ATTACHMENT_EXTS.has(normalizedExt)) return 'spreadsheet'
  return 'other'
}

function getPathBasename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

function createLocalPathAttachment(params: {
  name?: string
  path: string
  ext?: string
  size?: number
  isDirectory?: boolean
}): ChatAttachment {
  const isDirectory = Boolean(params.isDirectory)
  const normalizedExt = isDirectory
    ? ''
    : String(params.ext || getPathBasename(params.path).split('.').pop() || '')
        .toLowerCase()
        .replace(/^\./, '')

  return {
    id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: params.name || getPathBasename(params.path),
    path: params.path,
    type: getAttachmentTypeFromExt(normalizedExt, isDirectory),
    isDirectory,
    size: params.size || 0,
    ext: normalizedExt ? `.${normalizedExt}` : '',
    source: 'file'
  }
}

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
  const [selectedChannelKey, setSelectedChannelKey] = useState('local:app')
  const [pendingSendCountdown, setPendingSendCountdown] = useState(0)
  const [attachmentPreviewLoading, setAttachmentPreviewLoading] = useState(false)
  const [persistedScopeRuns, setPersistedScopeRuns] = useState<PersistedScopeRunSummary[]>([])
  const [persistedTaskProjections, setPersistedTaskProjections] = useState<
    Record<string, PersistedTaskProjection[]>
  >({})
  const [sessionRecallQuery, setSessionRecallQuery] = useState('')
  const [sessionRecallResults, setSessionRecallResults] = useState<SessionRecallHit[]>([])
  const [attachedSessionRecallCapsules, setAttachedSessionRecallCapsules] = useState<
    SessionRecallCapsule[]
  >([])
  const [referenceSkillHint, setReferenceSkillHint] = useState<ReferenceSkillHintData | null>(null)
  const [sessionRecallSearching, setSessionRecallSearching] = useState(false)
  const [sessionRecallError, setSessionRecallError] = useState<string | null>(null)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatInputRef = useRef<ChatInputHandle | null>(null)
  const focusInputWithResize = useCallback(() => {
    chatInputRef.current?.focusWithResize()
  }, [])

  const currentAgentData = agents.find((a) => a.name === currentAgent)
  const getScopeChannelKey = useCallback((scope: ConversationScope) => {
    const sourceId = scope.sourceKind === 'local' ? 'app' : scope.sourceId
    return `${scope.sourceKind}:${sourceId}`
  }, [])
  const channelOptions = useMemo<ConversationChannelOption[]>(() => {
    const options = new Map<string, ConversationChannelOption>()
    options.set('local:app', {
      key: 'local:app',
      sourceKind: 'local',
      sourceId: 'app',
      label: '应用内',
      caption: '本地会话'
    })

    for (const scope of scopes) {
      const key = getScopeChannelKey(scope)
      if (options.has(key)) continue

      const channelType = String(scope.meta?.channelType || '')
      const sourceLabel = String(scope.meta?.sourceLabel || '')
      let label = sourceLabel || '远程会话'
      let caption = sourceLabel || '频道会话'

      if (
        channelType === 'feishu-app' ||
        channelType === 'feishu-bot' ||
        /飞书/.test(sourceLabel)
      ) {
        label = '飞书会话'
        caption = sourceLabel || '飞书频道'
      } else if (channelType === 'telegram-bot' || /telegram/i.test(sourceLabel)) {
        label = 'Telegram'
        caption = sourceLabel || 'Telegram 频道'
      }

      options.set(key, {
        key,
        sourceKind: scope.sourceKind,
        sourceId: scope.sourceId,
        label,
        caption
      })
    }

    return Array.from(options.values())
  }, [getScopeChannelKey, scopes])
  const currentChannel = useMemo<ConversationChannelOption>(() => {
    return (
      channelOptions.find((option) => option.key === selectedChannelKey) ||
      channelOptions[0] || {
        key: 'local:app',
        sourceKind: 'local',
        sourceId: 'app',
        label: '应用内',
        caption: '本地会话'
      }
    )
  }, [channelOptions, selectedChannelKey])
  const filteredScopes = useMemo(() => {
    return scopes
      .filter((scope) => getScopeChannelKey(scope) === selectedChannelKey)
      .sort((a, b) => {
        const aTime = new Date(a.lastMessageAt || a.updatedAt).getTime()
        const bTime = new Date(b.lastMessageAt || b.updatedAt).getTime()
        return bTime - aTime
      })
  }, [getScopeChannelKey, scopes, selectedChannelKey])
  const visibleSessionRecallResults = useMemo(() => {
    return sessionRecallResults.filter((item) => {
      return item.sourceKind === currentChannel.sourceKind && item.sourceId === currentChannel.sourceId
    })
  }, [currentChannel.sourceId, currentChannel.sourceKind, sessionRecallResults])
  const attachedSessionRecallConversationIds = useMemo(
    () => attachedSessionRecallCapsules.map((capsule) => capsule.conversationId),
    [attachedSessionRecallCapsules]
  )
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

  const refreshAttachedSessionRecall = useCallback(async (scopeId?: string | null) => {
    if (!scopeId || !window.electronAPI?.agent?.listAttachedSessionRecallContexts) {
      setAttachedSessionRecallCapsules([])
      return
    }
    const result = await window.electronAPI.agent
      .listAttachedSessionRecallContexts(scopeId)
      .catch(() => null)
    if (!result?.success || !Array.isArray(result.data)) {
      setAttachedSessionRecallCapsules([])
      return
    }
    setAttachedSessionRecallCapsules(result.data as SessionRecallCapsule[])
  }, [])

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

  const runSessionRecallSearch = useCallback(
    async (query: string) => {
      if (!window.electronAPI?.agent?.searchSessionRecall) return
      const normalized = query.trim()
      setSessionRecallSearching(true)
      setSessionRecallError(null)
      try {
        const result = await window.electronAPI.agent
          .searchSessionRecall({
            query: normalized || undefined,
            currentScopeId: currentScopeId || undefined,
            limit: 12
          })
          .catch(() => null)
        if (!result?.success || !Array.isArray(result.data)) {
          setSessionRecallResults([])
          setSessionRecallError(result?.error || '旧会话搜索失败')
          return
        }
        setSessionRecallResults(result.data as SessionRecallHit[])
      } finally {
        setSessionRecallSearching(false)
      }
    },
    [currentScopeId]
  )

  const handleAttachSessionRecall = useCallback(
    async (conversationId: string) => {
      if (!currentScopeId || !window.electronAPI?.agent?.attachSessionRecallContext) return
      setSessionRecallError(null)
      const result = await window.electronAPI.agent
        .attachSessionRecallContext(currentScopeId, conversationId)
        .catch(() => null)
      if (!result?.success || !result.data) {
        setSessionRecallError(result?.error || '引用旧会话失败')
        return
      }
      const payload = result.data as { scope: ConversationScope; capsule: SessionRecallCapsule }
      useAgent.setState((state) => {
        const nextScopes = state.scopes.map((scope) =>
          scope.id === payload.scope.id ? payload.scope : scope
        )
        return {
          scopes: nextScopes,
          currentScope:
            state.currentScope?.id === payload.scope.id ? payload.scope : state.currentScope,
          conversations: nextScopes.map(mapScopeToConversation)
        }
      })
      setAttachedSessionRecallCapsules((current) => {
        const filtered = current.filter(
          (item) => item.conversationId !== payload.capsule.conversationId
        )
        return [...filtered, payload.capsule]
      })
    },
    [currentScopeId]
  )

  const handleDetachSessionRecall = useCallback(
    async (conversationId: string) => {
      if (!currentScopeId || !window.electronAPI?.agent?.detachSessionRecallContext) return
      setSessionRecallError(null)
      const result = await window.electronAPI.agent
        .detachSessionRecallContext(currentScopeId, conversationId)
        .catch(() => null)
      if (!result?.success || !result.data) {
        setSessionRecallError(result?.error || '移除旧会话引用失败')
        return
      }
      const payload = result.data as { scope: ConversationScope }
      useAgent.setState((state) => {
        const nextScopes = state.scopes.map((scope) =>
          scope.id === payload.scope.id ? payload.scope : scope
        )
        return {
          scopes: nextScopes,
          currentScope:
            state.currentScope?.id === payload.scope.id ? payload.scope : state.currentScope,
          conversations: nextScopes.map(mapScopeToConversation)
        }
      })
      setAttachedSessionRecallCapsules((current) =>
        current.filter((item) => item.conversationId !== conversationId)
      )
    },
    [currentScopeId]
  )

  const inMemoryTaskRuns = useMemo<TaskCardRun[]>(() => {
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
        return {
          scopeId: scope.id,
          taskId: run.taskId || run.taskContinuation?.taskId || null,
          phase: run.phase,
          title: scope.title,
          taskTitle: run.taskTitle,
          taskSummary: run.taskSummary,
          steps: run.steps,
          currentStepId: run.currentStepId,
          waitingFor: run.waitingFor,
          resumableActions: run.resumableActions,
          recentArtifacts: run.recentArtifacts,
          taskContinuation: run.taskContinuation,
          memoryCapture: run.memoryCapture,
          blockedReason: run.blockedReason,
          error: run.error,
          updatedAt: run.updatedAt || scope.updatedAt,
          toolTrace: run.toolTrace,
          responseMessageId: run.responseMessageId || null,
          responseSegmentToolTraceStart: run.responseSegmentToolTraceStart ?? 0
        } satisfies TaskCardRun
      })
      .filter(Boolean) as TaskCardRun[]
  }, [filteredScopes, scopeRunStates])

  const mergedTaskRuns = useMemo<TaskCardRun[]>(() => {
    const persistedScopeRunByScopeId = new Map(
      persistedScopeRuns.map((persistedRun) => [persistedRun.scopeId, persistedRun] as const),
    )
    const mappedPersisted = persistedScopeRuns.map((run) => {
      const projection = resolveProjectionForTaskRun(
        persistedTaskProjections[run.scopeId],
        run,
        run,
      )
      return {
        scopeId: run.scopeId,
        taskId: projection?.taskId || run.taskId || run.taskContinuation?.taskId || null,
        phase: run.phase,
        status: projection?.status,
        title: run.title,
        taskTitle: projection?.taskTitle || run.taskTitle,
        taskSummary: projection?.taskSummary || run.taskSummary,
        steps:
          (projection?.steps && projection.steps.length > 0)
            ? normalizeProjectionSteps(projection.steps)
            : (run.steps || []),
        currentStepId: projection?.currentStepId || run.currentStepId,
        waitingFor: projection?.status === 'blocked'
          ? resolveProjectionWaitingFor(projection, run.waitingFor)
          : run.waitingFor,
        resumableActions:
          (projection?.resumableActions && projection.resumableActions.length > 0)
            ? projection.resumableActions
            : (run.resumableActions || []),
        recentArtifacts:
          (projection?.recentArtifacts && projection.recentArtifacts.length > 0)
            ? projection.recentArtifacts
            : (run.recentArtifacts || []),
        taskContinuation: resolveTaskContinuationForProjection(projection, run.taskContinuation),
        memoryCapture: run.memoryCapture,
        taskType: projection?.taskType,
        interactionState: projection?.interactionState,
        budgetUsagePercent: projection?.budgetUsagePercent,
        stepBudget: projection?.budget?.stepBudget,
        budgetWarningLevel: projection?.budgetWarningLevel,
        degradationReason: projection?.degradationReason,
        recoveryHistory: projection?.recoveryHistory,
        blockedReason: resolveProjectionBlockedReason(projection, run.blockedReason),
        error: run.error,
        updatedAt: run.updatedAt,
        toolTrace: []
      }
    })
    const merged = new Map<string, TaskCardRun>()
    for (const run of mappedPersisted) merged.set(run.scopeId, run)
    for (const run of inMemoryTaskRuns) {
      const persistedRun = persistedScopeRunByScopeId.get(run.scopeId) || null
      const projection = resolveProjectionForTaskRun(
        persistedTaskProjections[run.scopeId],
        run,
        persistedRun,
      )
      merged.set(run.scopeId, {
        ...run,
        taskId: projection?.taskId || run.taskId || persistedRun?.taskId || run.taskContinuation?.taskId || null,
        status: projection?.status,
        taskTitle: projection?.taskTitle || run.taskTitle,
        taskSummary: projection?.taskSummary || run.taskSummary,
        steps:
          (projection?.steps && projection.steps.length > 0)
            ? normalizeProjectionSteps(projection.steps)
            : (run.steps || []),
        currentStepId: projection?.currentStepId || run.currentStepId,
        waitingFor: projection?.status === 'blocked'
          ? resolveProjectionWaitingFor(projection, run.waitingFor)
          : run.waitingFor,
        resumableActions:
          (projection?.resumableActions && projection.resumableActions.length > 0)
            ? projection.resumableActions
            : (run.resumableActions || []),
        recentArtifacts:
          (projection?.recentArtifacts && projection.recentArtifacts.length > 0)
            ? projection.recentArtifacts
            : (run.recentArtifacts || []),
        taskContinuation: resolveTaskContinuationForProjection(projection, run.taskContinuation),
        taskType: projection?.taskType,
        interactionState: projection?.interactionState,
        budgetUsagePercent: projection?.budgetUsagePercent,
        stepBudget: projection?.budget?.stepBudget,
        budgetWarningLevel: projection?.budgetWarningLevel,
        degradationReason: projection?.degradationReason,
        recoveryHistory: projection?.recoveryHistory,
        blockedReason: resolveProjectionBlockedReason(projection, run.blockedReason)
      })
    }
    return Array.from(merged.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  }, [inMemoryTaskRuns, persistedScopeRuns, persistedTaskProjections])

  const currentTaskRun = useMemo(() => {
    const currentRun = currentScopeId
      ? mergedTaskRuns.find((item) => item.scopeId === currentScopeId) || null
      : null
    return currentRun && isTaskVisible(currentRun) ? currentRun : null
  }, [currentScopeId, mergedTaskRuns])

  const showToolTraceCapsule =
    !currentTaskRun &&
    (toolTrace.length > 0 ||
      isStreaming ||
      toolTraceStatus === 'error' ||
      toolTraceStatus === 'cancelled')
  const shouldRenderGlobalToolTraceCapsule = !currentTaskRun

  const parseSerializedTaskSnapshot = useCallback((raw: unknown): TaskCardRun | null => {
    if (!raw || typeof raw !== 'object') return null
    const snapshot = raw as SerializedTaskSnapshot
    if (!snapshot.scopeId || !snapshot.updatedAt) return null
    return {
      scopeId: snapshot.scopeId,
      taskId: snapshot.taskId || snapshot.taskContinuation?.taskId || null,
      phase: snapshot.phase,
      title: snapshot.title || '任务',
      taskTitle: snapshot.taskTitle,
      taskSummary: snapshot.taskSummary,
      steps: snapshot.steps,
      currentStepId: snapshot.currentStepId || null,
      waitingFor: snapshot.waitingFor,
      resumableActions: snapshot.resumableActions,
      recentArtifacts: snapshot.recentArtifacts,
      taskContinuation: snapshot.taskContinuation,
      memoryCapture: snapshot.memoryCapture,
      blockedReason: snapshot.blockedReason,
      error: snapshot.error,
      updatedAt: snapshot.updatedAt,
      toolTrace: (snapshot.toolTrace || []).map((event) => ({
        id: event.id,
        kind: event.kind,
        text: event.text,
        timestamp: new Date(event.timestamp)
      })),
      responseMessageId: snapshot.responseMessageId || null
    } as TaskCardRun
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

  const handleCopyAgentMessage = useCallback(async (messageId: string, content: string) => {
    if (!content?.trim()) return
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(content)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = content
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.focus()
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }

      setCopiedMessageId(messageId)
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
      copyFeedbackTimerRef.current = setTimeout(() => {
        setCopiedMessageId((current) => (current === messageId ? null : current))
        copyFeedbackTimerRef.current = null
      }, 1500)
    } catch {
      // Keep silent; copy failure shouldn't break chat interactions.
    }
  }, [])

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

  useEffect(() => {
    void refreshPersistedTaskProjections()
  }, [refreshPersistedTaskProjections, currentScopeId, persistedScopeRuns])

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
      await sendMessage(content)
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
    (convId: string) => {
      deleteConversation(convId)
    },
    [deleteConversation]
  )

  const patchScopeRun = useCallback(
    (scopeId: string, updater: (previous: ScopeRunState | null) => ScopeRunState | null) => {
      useAgent.setState((state) => {
        const previous = state.scopeRunStates[scopeId] || null
        const next = updater(previous)
        if (!next) return state
        return {
          scopeRunStates: {
            ...state.scopeRunStates,
            [scopeId]: next
          }
        }
      })
    },
    []
  )

  // Phase 4: applySkillExecutionDetailToScope removed — the only caller was
  // handleRetryTask's restartFromStep branch, also retired.

  const buildRunContinuationIntent = useCallback(
    (
      run: Pick<ScopeRunState, 'taskId' | 'taskContinuation' | 'blockedReason'> | null | undefined,
      responseText?: string,
    ) => {
      const taskId = run?.taskId || run?.taskContinuation?.taskId || null
      if (!taskId) return undefined
      return {
        taskId,
        executionId: run?.taskContinuation?.executionId || undefined,
        stepId: run?.taskContinuation?.stepId || undefined,
        blockedReason: run?.blockedReason || undefined,
        responseText: responseText || undefined,
        todoId: run?.taskContinuation?.todoId || undefined,
        todoTitle: run?.taskContinuation?.todoTitle || undefined,
        pauseReason: run?.taskContinuation?.pauseReason || undefined,
        detachedTaskId: run?.taskContinuation?.detachedTaskId || undefined,
        taskRunId: run?.taskContinuation?.taskRunId || undefined,
        jobId: run?.taskContinuation?.jobId || undefined,
        skillId: run?.taskContinuation?.skillId || undefined,
        action: run?.taskContinuation?.action || undefined,
        runStatePath: run?.taskContinuation?.runStatePath || undefined,
        outputDir: run?.taskContinuation?.outputDir || undefined,
        progressFingerprint: run?.taskContinuation?.progressFingerprint || undefined,
      }
    },
    [],
  )

  const handleContinueTaskInput = useCallback(
    async (scopeId: string) => {
      const run =
        useAgent.getState().scopeRunStates[scopeId] ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)
      const responseText = window.prompt('补充后继续', run?.taskSummary || '请继续，补充信息如下：')
      if (responseText == null) return
      const trimmed = responseText.trim()
      if (!trimmed) return
      await window.electronAPI.agent.respondToInteraction({
        scopeId,
        taskId: run?.taskId || undefined,
        responseText: trimmed,
        continuationIntent: buildRunContinuationIntent(run, trimmed),
      })
    },
    [buildRunContinuationIntent, mergedTaskRuns]
  )

  const handleSubmitTaskConfirmation = useCallback(
    async (scopeId: string, confirmed: boolean) => {
      const run =
        useAgent.getState().scopeRunStates[scopeId] ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)
      await window.electronAPI.agent.respondToInteraction({
        scopeId,
        taskId: run?.taskId || undefined,
        responseText: confirmed ? '确认继续。' : '暂不继续，请先停止。',
        continuationIntent: buildRunContinuationIntent(
          run,
          confirmed ? '确认继续。' : '暂不继续，请先停止。',
        ),
      })
    },
    [buildRunContinuationIntent, mergedTaskRuns]
  )

  const handleSubmitTaskAgentResult = useCallback(
    async (scopeId: string) => {
      const run =
        useAgent.getState().scopeRunStates[scopeId] ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)
      const responseText = window.prompt('补交结果', run?.taskSummary || '人工步骤已完成，请继续。')
      if (responseText == null) return
      const trimmed = responseText.trim()
      if (!trimmed) return
      await window.electronAPI.agent.respondToInteraction({
        scopeId,
        taskId: run?.taskId || undefined,
        responseText: trimmed,
        continuationIntent: buildRunContinuationIntent(run, trimmed),
      })
    },
    [buildRunContinuationIntent, mergedTaskRuns]
  )

  const handleSuspendTask = useCallback(async (scopeId: string) => {
    const run =
      useAgent.getState().scopeRunStates[scopeId] ||
      mergedTaskRuns.find((item) => item.scopeId === scopeId)
    await window.electronAPI.agent.suspendRun({
      scopeId,
      taskId: run?.taskId || undefined,
    })
  }, [mergedTaskRuns])

  const handleCancelDetachedTask = useCallback(async (_scopeId: string, taskId?: string | null) => {
    const detachedTaskId = typeof taskId === 'string' && taskId.startsWith('detached:')
      ? taskId.slice('detached:'.length)
      : ''
    if (!detachedTaskId || !window.electronAPI?.agent?.cancelDetachedSkillTask) return
    await window.electronAPI.agent.cancelDetachedSkillTask(detachedTaskId, _scopeId).catch(() => null)
    void refreshPersistedScopeRuns()
    void refreshPersistedTaskProjections()
  }, [refreshPersistedScopeRuns, refreshPersistedTaskProjections])

  const handleContinueDetachedTask = useCallback((scopeId: string, taskId?: string | null) => {
    const detachedTaskId = typeof taskId === 'string' && taskId.startsWith('detached:')
      ? taskId.slice('detached:'.length)
      : ''
    if (!detachedTaskId) return
    if (currentScopeId !== scopeId) {
      void loadConversation(scopeId)
    }
    const run =
      useAgent.getState().scopeRunStates[scopeId] ||
      mergedTaskRuns.find((item) => item.scopeId === scopeId && (
        item.taskId === taskId ||
        item.taskId === detachedTaskId ||
        item.taskContinuation?.detachedTaskId === detachedTaskId ||
        item.taskContinuation?.taskId === detachedTaskId
      )) ||
      mergedTaskRuns.find((item) => item.scopeId === scopeId)
    const continuationRun: Pick<ScopeRunState, 'taskId' | 'taskContinuation' | 'blockedReason'> = run || {
      taskId: detachedTaskId,
      blockedReason: '后台任务仍在运行',
      taskContinuation: {
        taskId: detachedTaskId,
        detachedTaskId,
        pauseReason: 'background_running',
        blockerType: 'background_running',
      },
    }
    setComposerDraft(`继续后台任务 ${detachedTaskId}`, buildRunContinuationIntent(continuationRun) || null)
    focusInputWithResize()
  }, [buildRunContinuationIntent, currentScopeId, focusInputWithResize, loadConversation, mergedTaskRuns, setComposerDraft])

  const handleResumeTask = useCallback(async (scopeId: string) => {
    const run =
      useAgent.getState().scopeRunStates[scopeId] ||
      mergedTaskRuns.find((item) => item.scopeId === scopeId)
    await window.electronAPI.agent.resumeRun({
      scopeId,
      taskId: run?.taskId || undefined,
      continuationIntent: buildRunContinuationIntent(run),
    })
  }, [buildRunContinuationIntent, mergedTaskRuns])

  const handleRetryTask = useCallback(
    async (scopeId: string) => {
      const run =
        useAgent.getState().scopeRunStates[scopeId] ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)
      // Phase 4: skill_executions state machine retired — the legacy
      // `restartFromStep` IPC bridge is gone. Retry now always goes through
      // the composer draft path; the LLM re-plans from the current state.
      setComposerDraft(
        '请重试刚才的任务，并在开始前先说明你准备怎么继续。',
        buildRunContinuationIntent(run) || null,
      )
      focusInputWithResize()
    },
    [buildRunContinuationIntent, focusInputWithResize, mergedTaskRuns, setComposerDraft]
  )

  const handleOpenTaskArtifact = useCallback(async (path: string) => {
    await window.electronAPI.document.openPath(path).catch(() => undefined)
  }, [])

  const handleDismissMemoryCapture = useCallback(
    (scopeId: string) => {
      patchScopeRun(scopeId, (previous) =>
        previous
          ? {
              ...previous,
              memoryCapture: previous.memoryCapture
                ? { ...previous.memoryCapture, status: 'dismissed' }
                : null
            }
          : null
      )
      setPersistedScopeRuns((current) =>
        current.map((item) =>
          item.scopeId === scopeId && item.memoryCapture
            ? { ...item, memoryCapture: { ...item.memoryCapture, status: 'dismissed' } }
            : item
        )
      )
    },
    [patchScopeRun]
  )

  const handleUndoMemoryCapture = useCallback(
    async (scopeId: string) => {
      const capture =
        useAgent.getState().scopeRunStates[scopeId]?.memoryCapture ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)?.memoryCapture
      if (!capture) return
      await Promise.all(
        capture.items.map((item) =>
          window.electronAPI.memory.delete(item.memoryId).catch(() => undefined)
        )
      )
      patchScopeRun(scopeId, (previous) =>
        previous
          ? {
              ...previous,
              memoryCapture: previous.memoryCapture
                ? { ...previous.memoryCapture, status: 'reverted' }
                : null
            }
          : null
      )
      setPersistedScopeRuns((current) =>
        current.map((item) =>
          item.scopeId === scopeId && item.memoryCapture
            ? { ...item, memoryCapture: { ...item.memoryCapture, status: 'reverted' } }
            : item
        )
      )
    },
    [mergedTaskRuns, patchScopeRun]
  )

  const handleSupplementMemoryCapture = useCallback(
    (scopeId: string) => {
      const capture =
        useAgent.getState().scopeRunStates[scopeId]?.memoryCapture ||
        mergedTaskRuns.find((item) => item.scopeId === scopeId)?.memoryCapture
      const draft = [
        '请记住以下长期偏好或经验：',
        ...(capture?.items.map(
          (item) => `- ${item.title}${item.summary ? `：${item.summary}` : ''}`
        ) || []),
        '',
        '我还想补充：'
      ].join('\n')
      setInputValue(draft)
      focusInputWithResize()
    },
    [focusInputWithResize, mergedTaskRuns, setInputValue]
  )

  const renderTaskSnapshotCard = useCallback(
    (run: TaskCardRun, key: string, compact = false) => {
      const expanded = Boolean(taskDisclosureState[key]?.overview)
      return (
        <TaskCard
          key={key}
          run={run}
          taskKey={key}
          compact={compact}
          expanded={expanded}
          disclosureState={{
            ...createDefaultTaskDisclosureState(run),
            ...(taskDisclosureState[key] || {})
          }}
          onToggleExpanded={() => setTaskSectionExpanded(key, 'overview', !expanded)}
          onToggleSection={setTaskSectionExpanded}
          onOpenArtifact={handleOpenTaskArtifact}
          onDismissMemoryCapture={handleDismissMemoryCapture}
          onUndoMemoryCapture={handleUndoMemoryCapture}
          onSupplementMemoryCapture={handleSupplementMemoryCapture}
          onContinueInput={handleContinueTaskInput}
          onSubmitConfirmation={handleSubmitTaskConfirmation}
          onSubmitAgentResult={handleSubmitTaskAgentResult}
          onRetry={handleRetryTask}
          onSuspendRun={handleSuspendTask}
          onResumeRun={handleResumeTask}
          onCancelDetachedTask={handleCancelDetachedTask}
          onContinueDetachedTask={handleContinueDetachedTask}
        />
      )
    },
    [
      handleContinueTaskInput,
      handleCancelDetachedTask,
      handleContinueDetachedTask,
      handleDismissMemoryCapture,
      handleOpenTaskArtifact,
      handleRetryTask,
      handleResumeTask,
      handleSuspendTask,
      handleSubmitTaskAgentResult,
      handleSubmitTaskConfirmation,
      handleSupplementMemoryCapture,
      handleUndoMemoryCapture,
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

  const messageToolTraceSnapshots = useMemo<Record<string, React.ReactNode>>(() => {
    const nextSnapshots: Record<string, React.ReactNode> = {}
    for (const message of messages) {
      if (message.type !== 'agent') continue
      const events = parseSerializedToolTraceSnapshot(message.meta?.toolTraceSnapshot)
      if (events.length === 0) continue
      const toolKey = `message-tool-${message.id}`
      const expanded = Boolean(taskDisclosureState[toolKey]?.overview)
      nextSnapshots[message.id] = (
        <ToolTraceCard
          key={toolKey}
          events={events}
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
      currentToolTraceSegment.length > 0
    ) {
      const toolKey = `live-tool-${currentTaskRun.responseMessageId}`
      const expanded = Boolean(taskDisclosureState[toolKey]?.overview)
      nextSnapshots[currentTaskRun.responseMessageId] = (
        <ToolTraceCard
          key={toolKey}
          events={currentToolTraceSegment}
          expanded={expanded}
          onToggleExpanded={() => setTaskSectionExpanded(toolKey, 'overview', !expanded)}
        />
      )
    }

    return nextSnapshots
  }, [
    currentTaskRun,
    currentToolTraceSegment,
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
    if (currentToolTraceSegment.length === 0) return null
    const toolKey = `pending-tool-${currentTaskRun.scopeId}`
    const expanded = Boolean(taskDisclosureState[toolKey]?.overview)
    return (
      <ToolTraceCard
        key={toolKey}
        events={currentToolTraceSegment}
        pending
        expanded={expanded}
        onToggleExpanded={() => setTaskSectionExpanded(toolKey, 'overview', !expanded)}
      />
    )
  }, [
    currentTaskRun,
    currentToolTraceSegment,
    isStreaming,
    messages,
    setTaskSectionExpanded,
    streamingMessageId,
    taskDisclosureState
  ])

  // W3: Drag & drop support (app-internal + OS files)
  const [isDragOver, setIsDragOver] = useState(false)

  useEffect(() => {
    const handler = () => {
      focusInputWithResize()
    }
    window.addEventListener(READY_FOCUS_CHAT_INPUT_EVENT, handler as EventListener)
    return () => window.removeEventListener(READY_FOCUS_CHAT_INPUT_EVENT, handler as EventListener)
  }, [focusInputWithResize])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      // 1. Check for app-internal ready-drag data first
      const readyRaw = e.dataTransfer.getData('application/x-ready-drag')
      if (readyRaw) {
        try {
          const data = JSON.parse(readyRaw) as {
            type:
              | 'file'
              | 'folder'
              | 'browser-tab'
              | 'doc-tab'
              | 'design-project'
              | 'video-project'
              | 'calendar-event'
              | 'skill-folder'
            path?: string
            name: string
            url?: string
            tabId?: string
            ext?: string
            size?: number
            title?: string
            heading?: string
            selection?: string
            excerpt?: string
            eventId?: string
            startTime?: string
            endTime?: string
            calendarId?: string
            description?: string
            projectId?: string
            duration?: number
            videoClipCount?: number
            subtitleClipCount?: number
            audioClipCount?: number
            dirty?: boolean
            saveStatus?: string
            snapshotHash?: string
            selectionSummary?: string
            currentToolContext?: string
            layoutDigest?: unknown
            source?: 'system' | 'imported'
            skillId?: string
            defaultCommand?: string
          }

          if (data.type === 'skill-folder' && data.path) {
            const inferredSkillId = data.skillId

            addAttachments([
              {
                id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: data.name,
                path: data.path,
                type: 'text',
                size: 0,
                ext: '.skill',
                source: 'skill-folder',
                skillId: inferredSkillId,
                skillFolderPath: data.path
              }
            ])

            const mention = `@[${data.name}]`
            const currentInput = useAgent.getState().inputValue.trim()
            setInputValue(currentInput ? `${currentInput}\n${mention}` : mention)
            focusInputWithResize()
          } else if (data.type === 'browser-tab' && data.url) {
            void (async () => {
              const fallbackTitle = data.title || data.name || '网页标签'
              let snapshot = {
                title: fallbackTitle,
                url: data.url,
                heading: data.heading || '',
                selection: data.selection || '',
                excerpt: data.excerpt || '',
                capturedAt: Date.now()
              }
              try {
                if (window.electronAPI?.browser?.getTabContext && data.tabId) {
                  const ctx = await window.electronAPI.browser.getTabContext(data.tabId)
                  if (ctx.success && ctx.data) {
                    snapshot = {
                      title: ctx.data.title || snapshot.title,
                      url: ctx.data.url || snapshot.url,
                      heading: ctx.data.heading || snapshot.heading,
                      selection: ctx.data.selection || snapshot.selection,
                      excerpt: ctx.data.excerpt || snapshot.excerpt,
                      capturedAt: ctx.data.capturedAt || snapshot.capturedAt
                    }
                  }
                }
              } catch {
                // keep fallback snapshot
              }

              const fallbackPath = data.tabId
                ? `browser-tab://${data.tabId}`
                : `browser-tab://${Date.now()}`
              addAttachments([
                {
                  id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  name: snapshot.title || fallbackTitle,
                  path: snapshot.url || fallbackPath,
                  type: 'text',
                  size: snapshot.excerpt.length,
                  ext: '.url',
                  source: 'browser-tab',
                  browserTabId: data.tabId,
                  url: snapshot.url || data.url,
                  title: snapshot.title || fallbackTitle,
                  heading: snapshot.heading,
                  selection: snapshot.selection,
                  excerpt: snapshot.excerpt,
                  capturedAt: snapshot.capturedAt
                }
              ])
              focusInputWithResize()
            })()
          } else if (data.type === 'design-project') {
            const designData = data as typeof data & {
              selectedElementCount?: number
              selectionBounds?: { x: number; y: number; w: number; h: number }
              latestReviewSummary?: string
              repairScope?: string
            }
            const fallbackPath =
              data.path && data.path.startsWith('/')
                ? data.path
                : `design-project://${encodeURIComponent(data.name || 'draft')}#${encodeURIComponent(String(data.snapshotHash || Date.now()))}`
            addAttachments([
              {
                id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: data.name || '设计草稿',
                path: fallbackPath,
                type: 'text',
                size: 0,
                ext: '.tldr',
                source: 'design-project',
                dirty: typeof data.dirty === 'boolean' ? data.dirty : undefined,
                saveStatus: typeof data.saveStatus === 'string' ? data.saveStatus : undefined,
                snapshotHash: typeof data.snapshotHash === 'string' ? data.snapshotHash : undefined,
                selectionSummary:
                  typeof data.selectionSummary === 'string' ? data.selectionSummary : undefined,
                selectedElementCount:
                  typeof designData.selectedElementCount === 'number'
                    ? designData.selectedElementCount
                    : undefined,
                selectionBounds:
                  designData.selectionBounds && typeof designData.selectionBounds === 'object'
                    ? (designData.selectionBounds as { x: number; y: number; w: number; h: number })
                    : undefined,
                currentToolContext:
                  typeof data.currentToolContext === 'string' ? data.currentToolContext : undefined,
                latestReviewSummary:
                  typeof designData.latestReviewSummary === 'string'
                    ? designData.latestReviewSummary
                    : undefined,
                repairScope:
                  designData.repairScope === 'run-owned' || designData.repairScope === 'selected'
                    ? designData.repairScope
                    : undefined
              }
            ])
            focusInputWithResize()
          } else if (data.type === 'video-project') {
            const lines = [
              '### 剪辑项目引用',
              `- 项目: ${data.name}`,
              data.path ? `- 关联文件: ${data.path}` : null,
              typeof data.duration === 'number' ? `- 时长: ${data.duration.toFixed(1)} 秒` : null,
              typeof data.videoClipCount === 'number'
                ? `- 视频轨片段: ${data.videoClipCount}`
                : null,
              typeof data.subtitleClipCount === 'number'
                ? `- 字幕轨片段: ${data.subtitleClipCount}`
                : null,
              typeof data.audioClipCount === 'number'
                ? `- 音频轨片段: ${data.audioClipCount}`
                : null
            ].filter(Boolean)
            const currentInput = useAgent.getState().inputValue
            const snippet = lines.join('\n')
            setInputValue(currentInput ? `${currentInput}\n${snippet}` : snippet)
            focusInputWithResize()
          } else if (data.type === 'calendar-event') {
            const start = data.startTime ? new Date(data.startTime) : null
            const end = data.endTime ? new Date(data.endTime) : null
            const hasValidTime =
              !!start && !!end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
            const lines = [
              '### 日程事件引用',
              `- 标题: ${data.title || data.name}`,
              hasValidTime ? `- 时间: ${start.toLocaleString()} - ${end.toLocaleString()}` : null,
              data.calendarId ? `- 日历: ${data.calendarId}` : null,
              data.description ? `- 备注: ${data.description.slice(0, 600)}` : null
            ].filter(Boolean)
            const currentInput = useAgent.getState().inputValue
            const snippet = lines.join('\n')
            setInputValue(currentInput ? `${currentInput}\n${snippet}` : snippet)
            focusInputWithResize()
          } else if (
            (data.type === 'file' || data.type === 'doc-tab' || data.type === 'folder') &&
            data.path
          ) {
            addAttachments([
              createLocalPathAttachment({
                name: data.name,
                path: data.path,
                ext: data.ext,
                size: data.size,
                isDirectory: data.type === 'folder'
              })
            ])
            focusInputWithResize()
          }
        } catch {
          /* ignore malformed data */
        }
        return
      }

      // 2. Fallback: OS file drop
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return

      const newAttachments = await Promise.all(
        files.map(async (file) => {
          const path =
            typeof window !== 'undefined' && window.electronAPI
              ? window.electronAPI.getFilePathFromDrop(file)
              : file.name
          if (!path) return null

          let isDirectory = false
          if (window.electronAPI?.document?.stat) {
            const statResult = await window.electronAPI.document.stat(path).catch(() => null)
            isDirectory = statResult?.data?.isDirectory ?? statResult?.stat?.isDirectory ?? false
          }

          return createLocalPathAttachment({
            name: file.name || getPathBasename(path),
            path,
            ext: file.name.split('.').pop(),
            size: file.size,
            isDirectory
          })
        })
      )
      addAttachments(newAttachments.filter(Boolean) as ChatAttachment[])
      focusInputWithResize()
    },
    [addAttachments, focusInputWithResize, setInputValue]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

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

  const expandedPanelHeader = (
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
  )

  const expandedPanelBody = (
    <>
      <ChatMessages
        messages={messages}
        messageTaskSnapshots={messageTaskSnapshots}
        messageToolTraceSnapshots={messageToolTraceSnapshots}
        pendingTaskRun={pendingTaskRun}
        pendingToolTrace={pendingToolTrace}
        isStreaming={isStreaming}
        streamingMessageId={streamingMessageId}
        toolTrace={toolTrace}
        toolTraceStatus={toolTraceStatus}
        toolTraceExpanded={toolTraceExpanded}
        copiedMessageId={copiedMessageId}
        showToolTraceCapsule={showToolTraceCapsule && shouldRenderGlobalToolTraceCapsule}
        onSetInputSuggestion={setInputValue}
        onToggleToolTrace={() => setToolTraceExpanded((value) => !value)}
        onCopyMessage={handleCopyAgentMessage}
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
          renderAttachmentIcon={(attachment, size = 16) => (
            <AttachmentIcon attachment={attachment} size={size} />
          )}
          ModelSelector={ModelSelector}
        />
      </div>
    </>
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

      {activeAttachmentPreview && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(10, 14, 22, 0.42)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            zIndex: 40
          }}
          onClick={() => setActiveAttachmentPreview(null)}
        >
          <div
            className="glass-surface-floating"
            style={{
              width: 'min(760px, 100%)',
              maxHeight: '82%',
              overflow: 'hidden',
              borderRadius: 16,
              border: '1px solid var(--border-default)',
              background: 'color-mix(in srgb, var(--surface-floating-bg) 32%, transparent)',
              display: 'flex',
              flexDirection: 'column'
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '14px 16px',
                borderBottom: '1px solid var(--border-default)'
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>
                  {activeAttachmentPreview.attachment.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-gray)', marginTop: 2 }}>
                  {activeAttachmentPreview.attachment.path}
                </div>
              </div>
              <div className="flex items-center" style={{ gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    void handleRevealAttachment(activeAttachmentPreview.attachment)
                  }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: '1px solid var(--border-default)',
                    fontSize: 12,
                    color: 'var(--text-body)'
                  }}
                >
                  在 Finder 中显示
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleOpenAttachment(activeAttachmentPreview.attachment)
                  }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: '1px solid var(--border-default)',
                    fontSize: 12,
                    color: 'var(--text-body)'
                  }}
                >
                  系统打开
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAttachmentPreview(null)}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    border: '1px solid var(--border-default)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <X style={{ width: 14, height: 14 }} strokeWidth={2} />
                </button>
              </div>
            </div>

            <div style={{ padding: 16, overflow: 'auto' }}>
              {attachmentPreviewLoading && (
                <div style={{ fontSize: 12, color: 'var(--text-gray)' }}>正在读取附件内容…</div>
              )}

              {!attachmentPreviewLoading && activeAttachmentPreview.mode === 'image' && (
                <img
                  src={toLocalFileUrl(activeAttachmentPreview.attachment.path)}
                  alt={activeAttachmentPreview.attachment.name}
                  style={{
                    width: '100%',
                    maxHeight: '70vh',
                    objectFit: 'contain',
                    borderRadius: 12
                  }}
                />
              )}

              {!attachmentPreviewLoading && activeAttachmentPreview.mode === 'video' && (
                <video
                  src={toLocalFileUrl(activeAttachmentPreview.attachment.path)}
                  controls
                  style={{ width: '100%', maxHeight: '70vh', borderRadius: 12, background: '#000' }}
                />
              )}

              {!attachmentPreviewLoading && activeAttachmentPreview.mode === 'text' && (
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: 'var(--text-body)',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 12,
                    padding: 14
                  }}
                >
                  {activeAttachmentPreview.content || '(空文本附件)'}
                </pre>
              )}

              {!attachmentPreviewLoading && activeAttachmentPreview.mode === 'file' && (
                <div
                  style={{
                    borderRadius: 12,
                    border: '1px solid var(--border-default)',
                    background: 'var(--bg-secondary)',
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8
                  }}
                >
                  <div style={{ fontSize: 12, color: 'var(--text-body)' }}>
                    该附件暂不支持内嵌预览。
                  </div>
                  {activeAttachmentPreview.error && (
                    <div style={{ fontSize: 12, color: 'var(--color-red)' }}>
                      {activeAttachmentPreview.error}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
