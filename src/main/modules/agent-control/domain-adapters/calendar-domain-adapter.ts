import {
  filterAllowedToolNamesByPrefixes,
  logPrefixNarrowing,
  readStructuredToolResultRecord,
  type DomainAdapter,
  type DomainAdapterPrepareResult,
} from './domain-adapter'
import type { ScopeRunTaskStep } from '../types'

// R2: See skill-domain-adapter.ts for why prefix narrowing is a second gate.
// Calendar intentionally strips skill_* tools (including skill_calendar_*
// if it ever gets introduced — unlike RSS) to keep deterministic calendar
// handlers in charge. Adjust TOOL_PREFIXES only if a calendar skill pipeline
// actually lands.
const TOOL_PREFIXES = ['calendar_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走日程执行路径。优先使用 calendar_* 工具完成任务，不要改走无关工具。'
const CALENDAR_WRITE_TRIGGER_PATTERN = /(日程|日历|会议|提醒).*(创建|修改|删除|改期)|创建日程|修改日程/i

interface CalendarAdapterState {
  steps: ScopeRunTaskStep[]
  taskSummary: string | null
  currentStepId: string | null
  dispatchedAt: string | null
}

function createState(domainState: unknown): CalendarAdapterState {
  if (
    domainState
    && typeof domainState === 'object'
    && 'steps' in domainState
    && Array.isArray((domainState as CalendarAdapterState).steps)
  ) {
    const record = domainState as CalendarAdapterState
    return {
      steps: record.steps,
      taskSummary: record.taskSummary ?? null,
      currentStepId: record.currentStepId ?? null,
      dispatchedAt: record.dispatchedAt ?? null,
    }
  }
  return {
    steps: [],
    taskSummary: null,
    currentStepId: null,
    dispatchedAt: null,
  }
}

function hasAnyDomainTool(allowedToolNames: string[] | null | undefined): boolean {
  if (!allowedToolNames || allowedToolNames.length === 0) return false
  return allowedToolNames.some((name) => name.startsWith('calendar_'))
}

function buildStepId(existingSteps: ScopeRunTaskStep[], toolName: string): string {
  const repeats = existingSteps.filter((step) => step.id === toolName || step.id.startsWith(`${toolName}#`)).length
  return repeats === 0 ? toolName : `${toolName}#${repeats + 1}`
}

function buildSummary(record: Record<string, unknown> | null, toolName: string, input: Record<string, unknown>): string {
  const action = typeof record?.action === 'string' && record.action.trim() ? record.action.trim() : toolName
  const message = typeof record?.message === 'string' && record.message.trim() ? record.message.trim() : '已执行'
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : null
  return title ? `${action}（${title}）：${message}` : `${action}：${message}`
}

export class CalendarDomainAdapter implements DomainAdapter {
  readonly id = 'calendar'

  contributePromptFragment(): ReturnType<DomainAdapter['contributePromptFragment']> {
    return [
      {
        id: 'calendar-write',
        label: '日程写入操作',
        priority: 0,
        matches: ({ userText }) => CALENDAR_WRITE_TRIGGER_PATTERN.test(userText),
        blocking: true,
        refs: [
          { path: 'docs/calendar-rules.md', title: '日程写入规则', summary: '日历冲突和时间歧义规则' },
        ],
      },
    ]
  }

  arbitrateRunCapabilities(
    _params: Parameters<DomainAdapter['arbitrateRunCapabilities']>[0],
  ): ReturnType<DomainAdapter['arbitrateRunCapabilities']> {
    return null
  }

  decorateUserText(
    text: string,
    _params: Parameters<DomainAdapter['decorateUserText']>[1],
  ): string {
    return text
  }

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'calendar'
  }

  prepare(params: Parameters<DomainAdapter['prepare']>[0]): DomainAdapterPrepareResult {
    const narrowed = filterAllowedToolNamesByPrefixes(params.allowedToolNames, TOOL_PREFIXES)
    if (params.host?.log) {
      logPrefixNarrowing(params.host.log, 'calendar', params.allowedToolNames, narrowed, TOOL_PREFIXES)
    }
    return {
      allowedToolNames: narrowed,
      sessionMessages: params.hasTools ? [{ role: 'user', content: INSTRUCTION }] : [],
      domainState: createState(null),
    }
  }

  dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): ReturnType<DomainAdapter['dispatch']> {
    const state = createState(params.domainState)
    if (params.hasTools && !hasAnyDomainTool(params.allowedToolNames)) {
      return {
        domainState: state,
        projection: {
          phase: 'blocked',
          summary: '本轮没有可用的日程工具',
          waitingFor: 'none',
          resumableActions: ['retry', 'cancel'],
          blockedReason: '未解析到可用的 calendar_* 工具',
        },
        finish: { status: 'done', success: false },
      }
    }
    return {
      domainState: {
        ...state,
        dispatchedAt: state.dispatchedAt || new Date().toISOString(),
      },
    }
  }

  applyResult(params: Parameters<DomainAdapter['applyResult']>[0]): ReturnType<DomainAdapter['applyResult']> {
    const state = createState(params.domainState)
    if (params.phase === 'tool_batch') {
      let nextState = state
      for (const executedTool of params.toolBatch?.executedTools || []) {
        if (!executedTool.name.startsWith('calendar_')) continue
        const record = readStructuredToolResultRecord(executedTool.result)
        const stepId = buildStepId(nextState.steps, executedTool.name)
        nextState = {
          steps: [
            ...nextState.steps,
            {
              id: stepId,
              title: executedTool.name,
              status: 'done',
              detail: buildSummary(record, executedTool.name, executedTool.input),
              updatedAt: new Date().toISOString(),
            },
          ],
          currentStepId: stepId,
          taskSummary: buildSummary(record, executedTool.name, executedTool.input),
          dispatchedAt: nextState.dispatchedAt,
        }
      }
      return { domainState: nextState }
    }

    if (params.phase === 'no_tool_call' && state.currentStepId) {
      return {
        domainState: state,
        projection: {
          phase: 'done',
          summary: state.taskSummary || '日程任务已执行',
          waitingFor: 'none',
          resumableActions: ['cancel'],
          blockedReason: null,
        },
      }
    }

    if (params.phase === 'budget_limit' && state.currentStepId) {
      return {
        domainState: state,
        projection: {
          phase: 'blocked',
          summary: state.taskSummary || '日程任务达到本轮执行上限',
          waitingFor: 'none',
          resumableActions: ['retry', 'cancel'],
          blockedReason: '已达到本轮执行上限',
        },
      }
    }

    return { domainState: state }
  }

  buildProjectionPatch(params: Parameters<DomainAdapter['buildProjectionPatch']>[0]): Record<string, unknown> | null {
    const state = createState(params.domainState)
    if (!state.currentStepId) return null
    return {
      module: 'calendar',
      taskTitle: '日程任务',
      taskSummary: params.projection.summary,
      steps: state.steps,
      currentStepId: state.currentStepId,
      waitingFor: params.projection.waitingFor ?? 'none',
      resumableActions: params.projection.resumableActions ?? ['cancel'],
      blockedReason: typeof params.projection.blockedReason === 'undefined' ? null : params.projection.blockedReason,
    }
  }
}
