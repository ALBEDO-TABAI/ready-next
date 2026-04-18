import {
  filterAllowedToolNamesByPrefixes,
  readExecutedToolPayload,
  type DomainAdapter,
  type DomainAdapterPrepareResult,
} from './domain-adapter'

const TOOL_PREFIXES = ['calendar_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走日程执行路径。优先使用 calendar_* 工具完成任务，不要改走无关工具。'

interface CalendarAdapterState {
  taskTitle: string
  taskSummary: string | null
  steps: Array<Record<string, unknown>>
  currentStepId: string | null
  waitingFor: 'none' | 'input'
  resumableActions: Array<'continue' | 'cancel' | 'none'>
  blockedReason: string | null
}

function createInitialCalendarState(): CalendarAdapterState {
  return {
    taskTitle: '日程任务',
    taskSummary: null,
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: ['none'],
    blockedReason: null,
  }
}

function isCalendarTool(toolName: string): boolean {
  return toolName.startsWith('calendar_')
}

function resolveCalendarStepTitle(toolName: string): string {
  const titles: Record<string, string> = {
    calendar_list_window: '读取日程窗口',
    calendar_create_event: '创建日程',
    calendar_update_event: '更新日程',
    calendar_delete_event: '删除日程',
    calendar_capture_session: '读取日程上下文',
  }
  return titles[toolName] || toolName
}

function pickCalendarIdentifier(payload: Record<string, unknown> | null): string | null {
  const keys = ['ownerResourceId', 'calendarId', 'eventId', 'id', 'title']
  for (const key of keys) {
    if (typeof payload?.[key] === 'string' && String(payload[key] || '').trim()) {
      return String(payload[key]).trim()
    }
  }
  return null
}

function buildSummary(message: string, identifier: string | null): string {
  const normalized = message.trim() || '日程操作已完成'
  if (!identifier || normalized.includes(identifier)) {
    return normalized
  }
  return `${normalized} (${identifier})`
}

function isBlocked(message: string): boolean {
  const normalized = String(message || '').trim()
  return /^Error:/i.test(normalized) || /\brequired\b/i.test(normalized) || /请提供|请选择|需要补充/.test(normalized)
}

function upsertStep(steps: Array<Record<string, unknown>>, nextStep: Record<string, unknown>): Array<Record<string, unknown>> {
  const nextSteps = steps.filter((step) => step.id !== nextStep.id)
  nextSteps.push(nextStep)
  return nextSteps
}

export class CalendarDomainAdapter implements DomainAdapter {
  readonly id = 'calendar'

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'calendar'
  }

  prepare(params: Parameters<DomainAdapter['prepare']>[0]): DomainAdapterPrepareResult {
    return {
      allowedToolNames: filterAllowedToolNamesByPrefixes(params.allowedToolNames, TOOL_PREFIXES),
      sessionMessages: params.hasTools ? [{ role: 'user', content: INSTRUCTION }] : [],
      domainState: createInitialCalendarState(),
    }
  }

  dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): ReturnType<DomainAdapter['dispatch']> {
    return { domainState: params.domainState }
  }

  applyResult(params: Parameters<DomainAdapter['applyResult']>[0]): ReturnType<DomainAdapter['applyResult']> {
    const previousState = (params.domainState as CalendarAdapterState | null) || createInitialCalendarState()
    if (params.phase !== 'tool_batch') {
      return { domainState: previousState }
    }

    let nextState = previousState
    for (const executedTool of params.toolBatch?.executedTools || []) {
      if (!isCalendarTool(executedTool.toolName)) continue
      const payload = readExecutedToolPayload(executedTool)
      const message = typeof payload?.message === 'string' ? payload.message : executedTool.resultText
      const summary = buildSummary(message, pickCalendarIdentifier(payload))
      const blocked = isBlocked(message)
      const nextStep = {
        id: executedTool.toolName,
        title: resolveCalendarStepTitle(executedTool.toolName),
        status: blocked ? 'blocked' : 'done',
        detail: summary,
        updatedAt: new Date().toISOString(),
      }
      nextState = {
        ...nextState,
        taskSummary: summary,
        steps: upsertStep(nextState.steps, nextStep),
        currentStepId: executedTool.toolName,
        waitingFor: blocked ? 'input' : 'none',
        resumableActions: blocked ? ['continue', 'cancel'] : ['none'],
        blockedReason: blocked ? summary : null,
      }
    }

    if (!nextState.taskSummary) {
      return { domainState: nextState }
    }

    return {
      domainState: nextState,
      interactionState: nextState.waitingFor === 'input' ? 'awaiting_clarification' : null,
      projection: {
        phase: nextState.waitingFor === 'input' ? 'blocked' : 'done',
        summary: nextState.taskSummary,
        waitingFor: nextState.waitingFor,
        resumableActions: nextState.resumableActions,
        blockedReason: nextState.blockedReason,
      },
    }
  }

  buildProjectionPatch(params: Parameters<DomainAdapter['buildProjectionPatch']>[0]): Record<string, unknown> | null {
    const state = (params.domainState as CalendarAdapterState | null) || createInitialCalendarState()
    if (!state.taskSummary) return null
    return {
      module: 'calendar',
      message: params.projection.summary,
      taskTitle: state.taskTitle,
      taskSummary: state.taskSummary,
      steps: state.steps,
      currentStepId: state.currentStepId,
      waitingFor: state.waitingFor,
      resumableActions: state.resumableActions,
      blockedReason: state.blockedReason,
    }
  }
}
