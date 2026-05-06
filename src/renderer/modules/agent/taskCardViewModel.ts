import type {
  AgentArtifact,
  ScopeRunMemoryCapture,
  ScopeRunState,
  ToolTraceEvent,
} from './types'
import type { RecoveryRecordData, TaskProjectionRecordData } from '../../types/electron'
import { phaseToUserLabel, projectionStatusToUserLabel, taskCardVisualStateLabel } from './task-status-vocabulary'
import { filterUserVisibleToolTraceEvents, sanitizeInternalAgentDisplayText } from './toolTraceVisibility'

export type TaskSectionKey = 'overview' | 'plan' | 'details' | 'artifacts' | 'memory'

export type TaskDisclosureState = Partial<Record<TaskSectionKey, boolean>>

export interface TaskCardRunLike {
  scopeId: string
  taskId?: string | null
  phase: ScopeRunState['phase']
  terminalReason?: ScopeRunState['terminalReason']
  status?: TaskProjectionRecordData['status']
  title: string
  taskTitle?: string | null
  taskSummary?: string | null
  steps?: ScopeRunState['steps']
  currentStepId?: string | null
  waitingFor?: ScopeRunState['waitingFor']
  resumableActions?: ScopeRunState['resumableActions']
  recentArtifacts?: AgentArtifact[]
  taskContinuation?: ScopeRunState['taskContinuation']
  progress?: ScopeRunState['progress']
  memoryCapture?: ScopeRunMemoryCapture | null
  executionDiagnostics?: ScopeRunState['executionDiagnostics']
  taskType?: TaskProjectionRecordData['taskType']
  interactionState?: TaskProjectionRecordData['interactionState']
  budgetUsagePercent?: number | null
  stepBudget?: {
    stepId?: string | null
    maxIterations: number
    remainingIterations?: number
  } | null
  budgetWarningLevel?: TaskProjectionRecordData['budgetWarningLevel']
  degradationReason?: TaskProjectionRecordData['degradationReason']
  recoveryHistory?: RecoveryRecordData[]
  blockedReason?: string | null
  error?: string | null
  updatedAt: string
  toolTrace?: ToolTraceEvent[]
}

export interface TaskSectionViewModel {
  key: TaskSectionKey
  title: string
  expanded: boolean
  count: number
  summary?: string | null
}

export interface TaskEventGroupViewModel {
  id: string
  title: string
  summary: string
  events: ToolTraceEvent[]
}

export interface TaskCardViewModel {
  key: string
  title: string
  phase: ScopeRunState['phase']
  statusLabel: string
  summary: string
  currentStep?: NonNullable<TaskCardRunLike['steps']>[number] | null
  sections: Record<TaskSectionKey, TaskSectionViewModel>
  detailGroups: TaskEventGroupViewModel[]
  legacyHandoffHit?: 'pathMatch' | 'subtaskMatch' | 'rawIncludes'
}

export type TaskCardVisualState =
  | 'background_running'
  | 'budget_paused'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'running'

export type TaskCardAction = 'continue' | 'retry' | 'open_artifact' | 'cancel'

export interface TaskCardRuntimeState {
  visualState: TaskCardVisualState
  statusLabel: string
  actionSet: TaskCardAction[]
}

export interface TaskDisplayGroup {
  kind: 'group'
  key: string
  title: string
  summary: string
  children: TaskCardRunLike[]
  updatedAt: string
}

export interface TaskDisplayItem {
  kind: 'task'
  key: string
  run: TaskCardRunLike
}

export type TaskDisplayEntry = TaskDisplayItem | TaskDisplayGroup

function stableString(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim()
  return normalized || null
}

export function getTaskRunDisplayKey(run: TaskCardRunLike): string {
  const childRunId = stableString(run.taskContinuation?.childRunId)
  if (childRunId) return `child-run:${childRunId}`

  const taskId = stableString(run.taskId) || stableString(run.taskContinuation?.taskId)
  if (taskId) return `task:${taskId}`

  const detachedTaskId = stableString(run.taskContinuation?.detachedTaskId)
  if (detachedTaskId) return `detached:${detachedTaskId}`

  const taskRunId = stableString(run.taskContinuation?.taskRunId)
  if (taskRunId) return `task-run:${taskRunId}`

  const jobId = stableString(run.taskContinuation?.jobId)
  if (jobId) return `job:${jobId}`

  return `scope:${run.scopeId}`
}

export function hasTaskRunResumeIdentity(run: TaskCardRunLike): boolean {
  const taskId = stableString(run.taskId) || stableString(run.taskContinuation?.taskId)
  return Boolean(
    stableString(run.taskContinuation?.childRunId) ||
    stableString(run.taskContinuation?.detachedTaskId) ||
    stableString(run.taskContinuation?.taskRunId) ||
    (taskId && (taskId.startsWith('skill-child:') || taskId.startsWith('detached:')))
  )
}

export function getTaskStartModeLabel(run: TaskCardRunLike): string | null {
  if (hasTaskRunResumeIdentity(run)) return '继续任务'
  if (run.taskType === 'continuation') return '新任务'
  return null
}

type ProgressWithActivity = ScopeRunState['progress'] & {
  detail?: string | null
  activityUpdatedAt?: string | null
  activityStale?: boolean | null
}

interface InternalAgentHandoffInfo {
  taskName: string
  summary: string
  progressLabel: string
  legacyHit?: 'pathMatch' | 'subtaskMatch' | 'rawIncludes'
}

const VEA_AUDIOVISUAL_HANDOFF_LABELS: Record<string, InternalAgentHandoffInfo> = {
  body: {
    taskName: 'body',
    summary: '视听报告正文还需要继续生成。点击“继续处理”即可，系统会接上剩余步骤。',
    progressLabel: '生成视听报告',
  },
  diagram: {
    taskName: 'diagram',
    summary: '视听报告图表还需要继续生成。点击“继续处理”即可，系统会接上剩余步骤。',
    progressLabel: '生成报告图表',
  },
  illustrate: {
    taskName: 'illustrate',
    summary: '视听报告插图说明还需要继续生成。点击“继续处理”即可，系统会接上剩余步骤。',
    progressLabel: '生成报告插图说明',
  },
}

function classifyInternalAgentHandoffText(text: string | null | undefined): InternalAgentHandoffInfo | null {
  const raw = String(text || '').trim()
  if (!raw) return null
  const pathMatch = raw.match(/audiovisual_handoff\/([^/\s`"'）)]+)\/task\.md/i)
  const subtaskMatch = raw.match(/视听剖析子任务\s*[`'“”"]?([^`'“”"\s；;]+)[`'“”"]?\s*待\s*agent\s*处理/i)
  if (!pathMatch && !subtaskMatch && !raw.includes('audiovisual_handoff')) return null
  const taskName = String(pathMatch?.[1] || subtaskMatch?.[1] || '').trim().toLowerCase()
  const legacyHit: InternalAgentHandoffInfo['legacyHit'] = pathMatch
    ? 'pathMatch'
    : subtaskMatch
      ? 'subtaskMatch'
      : 'rawIncludes'
  const base = VEA_AUDIOVISUAL_HANDOFF_LABELS[taskName] || {
    taskName: taskName || 'handoff',
    summary: '视听报告还有收尾内容需要继续生成。点击“继续处理”即可，系统会接上剩余步骤。',
    progressLabel: '生成视听报告',
  }
  return { ...base, legacyHit }
}

function classifyStructuredHandoff(progress: ProgressWithActivity | undefined | null): InternalAgentHandoffInfo | null {
  const handoff = progress?.handoff
  if (!handoff) return null
  return {
    taskName: handoff.taskName || 'handoff',
    summary: handoff.userMessage || '任务还有收尾内容需要继续处理。',
    progressLabel: VEA_AUDIOVISUAL_HANDOFF_LABELS[handoff.taskName || '']?.progressLabel || '处理收尾内容',
  }
}

export function formatTaskUserFacingText(text: string | null | undefined): string {
  const handoff = classifyInternalAgentHandoffText(text)
  return handoff?.summary || sanitizeInternalAgentDisplayText(text, '正在继续处理')
}

export function isInternalAgentHandoffTask(run: TaskCardRunLike): boolean {
  if (run.progress?.handoff) return true
  return [
    run.taskSummary,
    run.blockedReason,
    run.error,
    run.progress?.lastError,
    run.taskContinuation?.pauseReason,
  ].some((text) => classifyInternalAgentHandoffText(text))
}

function formatTaskStageLabel(stage: string | null | undefined, progress?: ProgressWithActivity | null): string {
  const structuredHandoff = classifyStructuredHandoff(progress)
  if (structuredHandoff && (!stage || stage === 'finalize')) return structuredHandoff.progressLabel
  const handoff = classifyInternalAgentHandoffText(progress?.lastError)
  if (handoff && (!stage || stage === 'finalize')) return handoff.progressLabel
  if (stage === 'prepare') return '准备素材'
  if (stage === 'score_batches') return 'AI 评分'
  if (stage === 'merge_validate') return '合并校验'
  if (stage === 'finalize') return '生成报告'
  return stage || '当前阶段'
}

export function formatTaskStepDisplayTitle(title: string | null | undefined, progress?: ProgressWithActivity | null): string {
  return formatTaskStageLabel(title, progress)
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100)))
}

function formatActivityAge(updatedAt: string | null | undefined, now: Date): string | null {
  if (!updatedAt) return null
  const updatedMs = new Date(updatedAt).getTime()
  const nowMs = now.getTime()
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) return null
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - updatedMs) / 1000))
  if (elapsedSeconds < 60) return `最近更新 ${elapsedSeconds} 秒前`
  return `最近更新 ${Math.floor(elapsedSeconds / 60)} 分钟前`
}

export function formatTaskProgressLabel(
  progress: ProgressWithActivity | undefined | null,
  now = new Date(),
): string | null {
  if (!progress) return null
  const detail = progress.detail?.trim() ? formatTaskStageLabel(progress.detail, progress) : null
  const structuredHandoff = classifyStructuredHandoff(progress)
  const stage = structuredHandoff?.progressLabel || formatTaskStageLabel(progress.stage, progress)
  const overall = progress.overallCoverage != null
    ? `总进度 ${clampPercent(progress.overallCoverage)}%`
    : null
  const activity = formatActivityAge(progress.activityUpdatedAt, now)

  if (progress.completed != null && progress.total != null) {
    return [detail || stage, `${progress.completed}/${progress.total}`, overall, activity].filter(Boolean).join(' · ')
  }
  if (progress.coverage != null) {
    return [detail || stage, `${clampPercent(progress.coverage)}%`, overall, activity].filter(Boolean).join(' · ')
  }
  return [detail || progress.stage || null, overall, activity].filter(Boolean).join(' · ') || null
}

function taskPhaseLabel(phase: ScopeRunState['phase']): string {
  return phaseToUserLabel(phase, 'taskCard')
}

function taskStatusLabel(status: TaskProjectionRecordData['status'] | undefined): string | null {
  return projectionStatusToUserLabel(status, 'taskCard')
}

function normalizeTaskFamily(title: string): string {
  const raw = String(title || '').trim()
  if (!raw) return 'task'
  const first = raw.split(/[：:\-—]/)[0]?.trim() || raw
  return first.toLowerCase()
}

function formatTaskTitleForUser(title: string | null | undefined): string {
  const raw = String(title || '').trim()
  if (!raw) return '任务'
  if (/^(后台)?技能(任务|执行)\s*[·:：-]?/i.test(raw)) return '正在处理任务'
  return sanitizeInternalAgentDisplayText(raw, '正在处理任务')
}

function buildDetailGroups(toolTrace: ToolTraceEvent[]): TaskEventGroupViewModel[] {
  const visibleToolTrace = filterUserVisibleToolTraceEvents(toolTrace)
  if (!Array.isArray(visibleToolTrace) || visibleToolTrace.length === 0) return []
  const groups: TaskEventGroupViewModel[] = []
  let current: TaskEventGroupViewModel | null = null

  for (const event of visibleToolTrace) {
    const text = String(event.text || '').trim()
    const stageMatch = text.match(/^\[阶段\]\s*步骤\s*\d+\/\d+\s*([^：:]+)[：:]\s*(.+)$/)
    if (stageMatch) {
      if (current) groups.push(current)
      current = {
        id: `group-${event.id}`,
        title: stageMatch[1].trim(),
        summary: stageMatch[2].trim(),
        events: [event],
      }
      continue
    }

    if (!current) {
      current = {
        id: `group-${event.id}`,
        title: '执行细节',
        summary: text,
        events: [event],
      }
      continue
    }

    current.events.push(event)
    if (!current.summary) current.summary = text
  }

  if (current) groups.push(current)
  return groups
}

function hasActiveChildTask(run: TaskCardRunLike): boolean {
  return (run.steps || []).some((step) => {
    const childTasks = (step as unknown as {
      childTasks?: Array<{ status?: string | null }>
    }).childTasks
    return Array.isArray(childTasks)
      && childTasks.some((child) => child.status === 'running' || child.status === 'blocked' || child.status === 'queued')
  })
}

function hasRecentArtifact(run: TaskCardRunLike): boolean {
  return (run.recentArtifacts || []).length > 0
}

function hasBackgroundSignal(run: TaskCardRunLike): boolean {
  return run.waitingFor === 'background'
    || run.terminalReason === 'checkpoint_background'
    || run.taskContinuation?.blockerType === 'background_running'
    || hasActiveChildTask(run)
}

function hasBudgetPausedSignal(run: TaskCardRunLike): boolean {
  return run.taskContinuation?.pauseReason === 'budget_exhausted'
    || run.taskContinuation?.blockerType === 'budget_paused'
    || run.terminalReason === 'checkpoint_budget'
    || run.degradationReason === 'budget_exhausted'
}

function hasBlockedTerminalReason(run: TaskCardRunLike): boolean {
  return run.terminalReason === 'blocked_config'
    || run.terminalReason === 'blocked_external'
}

export function deriveTaskCardRuntimeState(run: TaskCardRunLike): TaskCardRuntimeState {
  const hasLiveBackground = hasBackgroundSignal(run)
  const hasBudgetPaused = hasBudgetPausedSignal(run)
  const isAgentHandoff = isInternalAgentHandoffTask(run)
  const isFailed = (run.phase === 'error' || run.status === 'failed') && !hasLiveBackground && !hasBudgetPaused
  if (isFailed) {
    return { visualState: 'failed', statusLabel: taskCardVisualStateLabel('failed'), actionSet: ['retry', 'cancel', 'open_artifact'] }
  }
  if (hasBudgetPaused) {
    return { visualState: 'budget_paused', statusLabel: taskCardVisualStateLabel('budget_paused'), actionSet: ['continue', 'retry', 'cancel'] }
  }
  if (hasLiveBackground) {
    return { visualState: 'background_running', statusLabel: taskCardVisualStateLabel('background_running'), actionSet: ['continue', 'open_artifact', 'cancel'] }
  }
  if (
    (run.waitingFor && run.waitingFor !== 'none')
    || hasBlockedTerminalReason(run)
    || run.terminalReason === 'checkpoint_user_input'
    || run.status === 'blocked'
    || run.interactionState === 'awaiting_clarification'
    || run.interactionState === 'awaiting_confirmation'
    || run.interactionState === 'human_takeover'
  ) {
    const actions = (run.resumableActions || []).filter((action): action is TaskCardAction =>
      action === 'continue' || action === 'retry' || action === 'open_artifact' || action === 'cancel',
    )
    return {
      visualState: 'waiting',
      statusLabel: isAgentHandoff ? taskCardVisualStateLabel('waiting_handoff') : taskCardVisualStateLabel('waiting_input'),
      actionSet: actions.length > 0 ? actions : ['continue', 'cancel'],
    }
  }
  if (run.phase === 'done' || run.status === 'done') {
    return {
      visualState: 'done',
      statusLabel: taskCardVisualStateLabel('done'),
      actionSet: hasRecentArtifact(run) ? ['open_artifact'] : [],
    }
  }
  return { visualState: 'running', statusLabel: taskStatusLabel(run.status) || taskPhaseLabel(run.phase), actionSet: ['cancel'] }
}

export function createDefaultTaskDisclosureState(run: TaskCardRunLike): TaskDisclosureState {
  return {
    overview: true,
    plan: false,
    details: false,
    artifacts: false,
    memory: Boolean(run.memoryCapture && run.memoryCapture.status === 'ready'),
  }
}

export function setTaskDisclosureExpanded(
  current: TaskDisclosureState | undefined,
  section: TaskSectionKey,
  expanded: boolean,
): TaskDisclosureState {
  return {
    ...(current || {}),
    [section]: expanded,
  }
}

export function buildTaskCardViewModel(
  run: TaskCardRunLike,
  disclosure: TaskDisclosureState | undefined,
): TaskCardViewModel {
  const effectiveDisclosure = {
    ...createDefaultTaskDisclosureState(run),
    ...(disclosure || {}),
  }
  const steps = run.steps || []
  const rawCurrentStep = steps.find((step) => step.id === run.currentStepId) || steps.find((step) => step.status === 'running') || null
  const currentStep = rawCurrentStep
    ? { ...rawCurrentStep, title: formatTaskStepDisplayTitle(rawCurrentStep.title, run.progress) }
    : null
  const detailGroups = buildDetailGroups(run.toolTrace || [])
  const recentArtifacts = run.recentArtifacts || []
  const memoryItems = run.memoryCapture?.items || []
  const structuredHandoffMessage = run.progress?.handoff?.userMessage
  const rawHandoffSource = run.taskSummary || run.blockedReason || run.error || taskPhaseLabel(run.phase)
  const summary = structuredHandoffMessage
    || formatTaskUserFacingText(rawHandoffSource)
  const legacyHandoffHit = structuredHandoffMessage
    ? undefined
    : classifyInternalAgentHandoffText(rawHandoffSource)?.legacyHit
  const runtimeState = deriveTaskCardRuntimeState(run)
  const statusLabel = run.phase === 'cancelled' ? taskPhaseLabel(run.phase) : runtimeState.statusLabel

  return {
    key: getTaskRunDisplayKey(run),
    title: formatTaskTitleForUser(run.taskTitle || run.title),
    phase: run.phase,
    statusLabel,
    summary,
    legacyHandoffHit,
    currentStep,
    sections: {
      overview: {
        key: 'overview',
        title: '概览',
        expanded: true,
        count: currentStep ? 1 : 0,
        summary,
      },
      plan: {
        key: 'plan',
        title: '计划与步骤',
        expanded: Boolean(effectiveDisclosure.plan),
        count: steps.length,
        summary: currentStep ? `当前：${currentStep.title}` : (steps[0]?.title || null),
      },
      details: {
        key: 'details',
        title: '执行细节',
        expanded: Boolean(effectiveDisclosure.details),
        count: detailGroups.reduce((sum, group) => sum + group.events.length, 0),
        summary: detailGroups[0]?.summary || null,
      },
      artifacts: {
        key: 'artifacts',
        title: '产物',
        expanded: Boolean(effectiveDisclosure.artifacts),
        count: recentArtifacts.length,
        summary: recentArtifacts[0]?.label || null,
      },
      memory: {
        key: 'memory',
        title: '记忆',
        expanded: Boolean(effectiveDisclosure.memory),
        count: memoryItems.length,
        summary: memoryItems[0]?.title || null,
      },
    },
    detailGroups,
  }
}

export function groupTaskRunsForDisplay(
  runs: TaskCardRunLike[],
  now = new Date(),
): TaskDisplayEntry[] {
  const activeFamilies = new Map<string, TaskCardRunLike[]>()
  const singles: TaskDisplayEntry[] = []
  const nowMs = now.getTime()

  for (const run of runs) {
    const title = run.taskTitle || run.title || ''
    const family = normalizeTaskFamily(title)
    const updatedAtMs = new Date(run.updatedAt).getTime()
    if (title && nowMs - updatedAtMs <= 120_000) {
      const existing = activeFamilies.get(family) || []
      existing.push(run)
      activeFamilies.set(family, existing)
      continue
    }
    singles.push({ kind: 'task', key: getTaskRunDisplayKey(run), run })
  }

  const groupedEntries: TaskDisplayEntry[] = []
  for (const [family, items] of activeFamilies.entries()) {
    if (items.length === 1) {
      groupedEntries.push({ kind: 'task', key: getTaskRunDisplayKey(items[0]), run: items[0] })
      continue
    }
    const latest = items
      .slice()
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
    const completed = items.filter((item) => item.phase === 'done').length
    const running = items.filter((item) =>
      item.phase === 'planning' ||
      item.phase === 'tool_running' ||
      item.phase === 'checkpoint' ||
      item.phase === 'takeover' ||
      item.phase === 'resuming' ||
      item.phase === 'responding',
    ).length
    const failed = items.filter((item) => item.phase === 'error').length
    groupedEntries.push({
      kind: 'group',
      key: `group:${family}`,
      title: latest.taskTitle || latest.title || '任务组',
      summary: `${items.length} 个子任务 · ${completed} 完成 · ${running} 运行中 · ${failed} 失败`,
      children: items
        .slice()
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
      updatedAt: latest.updatedAt,
    })
  }

  return [...groupedEntries, ...singles].sort((a, b) => {
    const aTime = new Date(a.kind === 'group' ? a.updatedAt : a.run.updatedAt).getTime()
    const bTime = new Date(b.kind === 'group' ? b.updatedAt : b.run.updatedAt).getTime()
    return bTime - aTime
  })
}
