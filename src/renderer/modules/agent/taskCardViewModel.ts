import type {
  AgentArtifact,
  ScopeRunMemoryCapture,
  ScopeRunState,
  ToolTraceEvent,
} from './types'

export type TaskSectionKey = 'overview' | 'plan' | 'details' | 'artifacts' | 'memory'

export type TaskDisclosureState = Partial<Record<TaskSectionKey, boolean>>

export interface TaskCardRunLike {
  scopeId: string
  phase: ScopeRunState['phase']
  title: string
  taskTitle?: string | null
  taskSummary?: string | null
  steps?: ScopeRunState['steps']
  currentStepId?: string | null
  waitingFor?: ScopeRunState['waitingFor']
  resumableActions?: ScopeRunState['resumableActions']
  recentArtifacts?: AgentArtifact[]
  taskContinuation?: ScopeRunState['taskContinuation']
  memoryCapture?: ScopeRunMemoryCapture | null
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

function taskPhaseLabel(phase: ScopeRunState['phase']): string {
  if (phase === 'planning') return '规划中'
  if (phase === 'tool_running' || phase === 'responding' || phase === 'resuming') return '进行中'
  if (phase === 'checkpoint' || phase === 'takeover') return '等待继续'
  if (phase === 'done') return '已完成'
  if (phase === 'error') return '失败'
  if (phase === 'cancelled') return '已停止'
  return '待处理'
}

function normalizeTaskFamily(title: string): string {
  const raw = String(title || '').trim()
  if (!raw) return 'task'
  const first = raw.split(/[：:\-—]/)[0]?.trim() || raw
  return first.toLowerCase()
}

function buildDetailGroups(toolTrace: ToolTraceEvent[]): TaskEventGroupViewModel[] {
  if (!Array.isArray(toolTrace) || toolTrace.length === 0) return []
  const groups: TaskEventGroupViewModel[] = []
  let current: TaskEventGroupViewModel | null = null

  for (const event of toolTrace) {
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
  const currentStep = steps.find((step) => step.id === run.currentStepId) || steps.find((step) => step.status === 'running') || null
  const detailGroups = buildDetailGroups(run.toolTrace || [])
  const recentArtifacts = run.recentArtifacts || []
  const memoryItems = run.memoryCapture?.items || []
  const summary = run.taskSummary || run.blockedReason || run.error || taskPhaseLabel(run.phase)

  return {
    key: run.scopeId,
    title: run.taskTitle || run.title || '任务',
    phase: run.phase,
    statusLabel: taskPhaseLabel(run.phase),
    summary,
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
    singles.push({ kind: 'task', key: run.scopeId, run })
  }

  const groupedEntries: TaskDisplayEntry[] = []
  for (const [family, items] of activeFamilies.entries()) {
    if (items.length === 1) {
      groupedEntries.push({ kind: 'task', key: items[0].scopeId, run: items[0] })
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
