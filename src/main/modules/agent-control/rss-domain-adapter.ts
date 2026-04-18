import {
  filterAllowedToolNamesByPrefixes,
  readExecutedToolPayload,
  type DomainAdapter,
  type DomainAdapterPrepareResult,
} from './domain-adapter'

const TOOL_PREFIXES = ['rss_', 'skill_rss_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走 RSS 执行路径。优先使用 rss_* 或 skill_rss_* 工具完成任务，不要改走无关工具。'

interface RSSAdapterState {
  taskTitle: string
  taskSummary: string | null
  steps: Array<Record<string, unknown>>
  currentStepId: string | null
  waitingFor: 'none' | 'input'
  resumableActions: Array<'continue' | 'cancel' | 'none'>
  blockedReason: string | null
}

function createInitialRSSState(): RSSAdapterState {
  return {
    taskTitle: 'RSS 任务',
    taskSummary: null,
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: ['none'],
    blockedReason: null,
  }
}

function isRSSTool(toolName: string): boolean {
  return toolName.startsWith('rss_') || toolName.startsWith('skill_rss_')
}

function resolveRSSStepTitle(toolName: string): string {
  const titles: Record<string, string> = {
    rss_add_source: '添加订阅源',
    rss_fetch_updates: '刷新更新',
    rss_select_item: '定位条目',
    rss_analyze_item: '分析条目',
    rss_capture_session: '读取 RSS 上下文',
    skill_rss_add: '添加订阅源',
    skill_rss_update: '刷新更新',
    skill_rss_status: '检查订阅状态',
    skill_rss_list: '列出订阅源',
    skill_rss_stats: '查看 RSS 统计',
  }
  return titles[toolName] || toolName
}

function pickStructuredIdentifier(payload: Record<string, unknown> | null): string | null {
  const keys = ['ownerResourceId', 'itemId', 'sourceId', 'id', 'name', 'title']
  for (const key of keys) {
    if (typeof payload?.[key] === 'string' && String(payload[key] || '').trim()) {
      return String(payload[key]).trim()
    }
  }
  return null
}

function buildSummary(message: string, identifier: string | null): string {
  const normalized = message.trim() || 'RSS 操作已完成'
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

export class RSSDomainAdapter implements DomainAdapter {
  readonly id = 'rss'

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'rss'
  }

  prepare(params: Parameters<DomainAdapter['prepare']>[0]): DomainAdapterPrepareResult {
    return {
      allowedToolNames: filterAllowedToolNamesByPrefixes(params.allowedToolNames, TOOL_PREFIXES),
      sessionMessages: params.hasTools ? [{ role: 'user', content: INSTRUCTION }] : [],
      domainState: createInitialRSSState(),
    }
  }

  dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): ReturnType<DomainAdapter['dispatch']> {
    return { domainState: params.domainState }
  }

  applyResult(params: Parameters<DomainAdapter['applyResult']>[0]): ReturnType<DomainAdapter['applyResult']> {
    const previousState = (params.domainState as RSSAdapterState | null) || createInitialRSSState()
    if (params.phase !== 'tool_batch') {
      return { domainState: previousState }
    }

    let nextState = previousState
    for (const executedTool of params.toolBatch?.executedTools || []) {
      if (!isRSSTool(executedTool.toolName)) continue
      const payload = readExecutedToolPayload(executedTool)
      const message = typeof payload?.message === 'string' ? payload.message : executedTool.resultText
      const summary = buildSummary(message, pickStructuredIdentifier(payload))
      const blocked = isBlocked(message)
      const nextStep = {
        id: executedTool.toolName,
        title: resolveRSSStepTitle(executedTool.toolName),
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
    const state = (params.domainState as RSSAdapterState | null) || createInitialRSSState()
    if (!state.taskSummary) return null
    return {
      module: 'rss',
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
