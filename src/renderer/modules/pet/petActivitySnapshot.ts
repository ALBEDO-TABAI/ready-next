import type { PetActivityEvent, PetActivitySnapshot, PetAnimationState } from '../../../shared/pet'
import type { ScopeRunState, ToolTraceEvent } from '../agent/types'
import { formatSingleLinePreview } from '../agent/toolTracePreview'

const PET_SUMMARY_LIMIT = 42
const PET_EVENT_LIMIT = 36
const PET_EVENT_COUNT = 3

const TOOL_LABELS: Record<string, string> = {
  exec_command: '运行本地命令',
  'functions.exec_command': '运行本地命令',
  apply_patch: '修改文件',
  'functions.apply_patch': '修改文件',
  write_stdin: '读取运行结果',
  'functions.write_stdin': '读取运行结果',
  search_query: '查询资料',
  open: '查看资料',
  click: '打开页面',
  find: '查找内容',
  screenshot: '查看截图',
  skill_run_shell: '运行本地命令',
  skill_write_artifact: '写入产物',
  skill_read_artifact: '读取产物',
}

function phaseToPetState(phase: ScopeRunState['phase'] | undefined): PetAnimationState {
  if (phase === 'tool_running' || phase === 'resuming') return 'running'
  if (phase === 'planning' || phase === 'responding' || phase === 'queued') return 'waiting'
  if (phase === 'checkpoint' || phase === 'takeover') return 'review'
  if (phase === 'error') return 'failed'
  if (phase === 'cancelled') return 'failed'
  return 'idle'
}

function phaseToTitle(phase: ScopeRunState['phase'] | undefined): string {
  if (phase === 'tool_running') return '正在调用工具'
  if (phase === 'planning' || phase === 'responding' || phase === 'queued') return '正在思考'
  if (phase === 'resuming') return '正在继续任务'
  if (phase === 'checkpoint' || phase === 'takeover') return '等待确认'
  if (phase === 'error') return '遇到问题'
  if (phase === 'cancelled') return '已停止'
  return '空闲'
}

function isBusyPhase(phase: ScopeRunState['phase'] | undefined): boolean {
  return phase === 'queued'
    || phase === 'planning'
    || phase === 'tool_running'
    || phase === 'checkpoint'
    || phase === 'takeover'
    || phase === 'resuming'
    || phase === 'responding'
    || phase === 'error'
}

function truncateText(text: string, limit: number): string {
  const chars = [...text]
  if (chars.length <= limit) return text
  return `${chars.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…`
}

function redactPaths(text: string): string {
  return text.replace(/(?:~|\/[A-Za-z0-9_.\-\u4e00-\u9fa5]+)(?:\/[^\s"'`，。；;:,)）\]}]+){1,}/g, (match) => {
    const parts = match.split('/').filter(Boolean)
    const name = parts[parts.length - 1] || '路径'
    return `…/${name}`
  })
}

function compactPetText(text: string | null | undefined, limit: number, appendEllipsis = false): string {
  const firstLine = formatSingleLinePreview(text, { appendEllipsis })
  if (!firstLine) return ''
  return truncateText(redactPaths(firstLine), limit)
}

function toolNameFromTrace(text: string): string | null {
  const firstLine = formatSingleLinePreview(text)
  const match = firstLine.match(/^([a-zA-Z_][\w:.-]*)\s*\(/)
  return match?.[1] || null
}

function summarizeToolCall(text: string): string {
  const toolName = toolNameFromTrace(text)
  if (!toolName) return compactPetText(text, PET_EVENT_LIMIT, true)
  return TOOL_LABELS[toolName] || `${toolName.split('.').pop() || toolName}…`
}

function sanitizeToolTraceText(event: ToolTraceEvent): string {
  if (event.kind === 'call') return summarizeToolCall(event.text)
  return compactPetText(event.text, PET_EVENT_LIMIT, true)
}

function toPetEvent(event: ToolTraceEvent): PetActivityEvent {
  return {
    id: event.id,
    kind: event.kind,
    text: sanitizeToolTraceText(event),
    timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp),
  }
}

function selectPetEvents(events: ToolTraceEvent[]): ToolTraceEvent[] {
  const recent = events.slice(-PET_EVENT_COUNT)
  const latestCall = [...events].reverse().find((event) => event.kind === 'call')
  if (!latestCall || recent.some((event) => event.id === latestCall.id)) return recent
  return [latestCall, ...recent.slice(-(PET_EVENT_COUNT - 1))]
}

function chooseSummary(run: ScopeRunState): string {
  const step = (run.steps || []).find((item) => item.id === run.currentStepId)
    || (run.steps || []).find((item) => item.status === 'running')
  const latestCall = [...(run.toolTrace || [])].reverse().find((event) => event.kind === 'call')
  const candidates = [
    step?.title,
    run.taskSummary,
    run.taskTitle,
    latestCall ? summarizeToolCall(latestCall.text) : null,
    run.latestText,
    run.responseBuffer,
  ]
  for (const candidate of candidates) {
    const summary = compactPetText(candidate, PET_SUMMARY_LIMIT)
    if (summary) return summary
  }
  return phaseToTitle(run.phase)
}

export function createPetActivitySnapshot(run: ScopeRunState | null | undefined): PetActivitySnapshot {
  if (!run || !isBusyPhase(run.phase)) {
    return {
      busy: false,
      state: 'idle',
      title: '空闲',
      summary: '',
      events: [],
      updatedAt: run?.updatedAt || null,
    }
  }

  return {
    busy: true,
    state: phaseToPetState(run.phase),
    title: phaseToTitle(run.phase),
    summary: chooseSummary(run),
    events: selectPetEvents(run.toolTrace || []).map(toPetEvent),
    updatedAt: run.updatedAt || null,
  }
}
