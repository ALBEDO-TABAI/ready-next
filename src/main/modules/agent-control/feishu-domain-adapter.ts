import {
  filterAllowedToolNamesByPrefixes,
  readExecutedToolPayload,
  type DomainAdapter,
  type DomainAdapterPrepareResult,
} from './domain-adapter'

const TOOL_PREFIXES = ['feishu_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走飞书执行路径。优先使用 feishu_* 工具完成任务，不要改走无关工具。'

interface FeishuAdapterState {
  taskTitle: string
  taskSummary: string | null
  steps: Array<Record<string, unknown>>
  currentStepId: string | null
  waitingFor: 'none' | 'input'
  resumableActions: Array<'continue' | 'cancel' | 'none'>
  blockedReason: string | null
}

function createInitialFeishuState(): FeishuAdapterState {
  return {
    taskTitle: '飞书任务',
    taskSummary: null,
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: ['none'],
    blockedReason: null,
  }
}

function isFeishuTool(toolName: string): boolean {
  return toolName.startsWith('feishu_')
}

function resolveFeishuStepTitle(toolName: string): string {
  const titles: Record<string, string> = {
    feishu_doc_read: '读取飞书文档',
    feishu_doc_create: '创建飞书文档',
    feishu_doc_update: '更新飞书文档',
    feishu_doc_list: '列出飞书文档',
    feishu_message_send: '发送飞书消息',
    feishu_message_get_context: '读取消息上下文',
    feishu_message_reply: '回复飞书消息',
    feishu_calendar_list_events: '读取飞书日历',
    feishu_calendar_create_event: '创建飞书日历事件',
    feishu_calendar_update_event: '更新飞书日历事件',
    feishu_calendar_delete_event: '删除飞书日历事件',
    feishu_chat_list: '列出飞书群聊',
    feishu_chat_get_members: '读取群成员',
    feishu_chat_get_info: '读取群信息',
    feishu_file_upload: '上传飞书文件',
    feishu_file_download: '下载飞书文件',
  }
  return titles[toolName] || toolName
}

function pickFeishuIdentifier(payload: Record<string, unknown> | null): string | null {
  const keys = ['msg_id', 'message_id', 'event_id', 'calendar_id', 'doc_token', 'file_token', 'chat_id', 'id']
  for (const key of keys) {
    if (typeof payload?.[key] === 'string' && String(payload[key] || '').trim()) {
      return String(payload[key]).trim()
    }
  }
  return null
}

function buildSummary(message: string, identifier: string | null): string {
  const normalized = message.trim() || '飞书操作已完成'
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

export class FeishuDomainAdapter implements DomainAdapter {
  readonly id = 'feishu'

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'feishu'
  }

  prepare(params: Parameters<DomainAdapter['prepare']>[0]): DomainAdapterPrepareResult {
    return {
      allowedToolNames: filterAllowedToolNamesByPrefixes(params.allowedToolNames, TOOL_PREFIXES),
      sessionMessages: params.hasTools ? [{ role: 'user', content: INSTRUCTION }] : [],
      domainState: createInitialFeishuState(),
    }
  }

  dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): ReturnType<DomainAdapter['dispatch']> {
    return { domainState: params.domainState }
  }

  applyResult(params: Parameters<DomainAdapter['applyResult']>[0]): ReturnType<DomainAdapter['applyResult']> {
    const previousState = (params.domainState as FeishuAdapterState | null) || createInitialFeishuState()
    if (params.phase !== 'tool_batch') {
      return { domainState: previousState }
    }

    let nextState = previousState
    for (const executedTool of params.toolBatch?.executedTools || []) {
      if (!isFeishuTool(executedTool.toolName)) continue
      const payload = readExecutedToolPayload(executedTool)
      const message = typeof payload?.message === 'string' ? payload.message : executedTool.resultText
      const summary = buildSummary(message, pickFeishuIdentifier(payload))
      const blocked = isBlocked(message)
      const nextStep = {
        id: executedTool.toolName,
        title: resolveFeishuStepTitle(executedTool.toolName),
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
    const state = (params.domainState as FeishuAdapterState | null) || createInitialFeishuState()
    if (!state.taskSummary) return null
    return {
      module: 'feishu',
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
