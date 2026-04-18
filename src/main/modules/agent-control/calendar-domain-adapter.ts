import {
  filterAllowedToolNamesByPrefixes,
  readStructuredToolResultRecord,
  type DomainAdapter,
  type DomainAdapterPrepareResult,
} from './domain-adapter'
import type { ScopeRunTaskStep } from './types'

const TOOL_PREFIXES = ['calendar_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走日程执行路径。优先使用 calendar_* 工具完成任务，不要改走无关工具。'

interface CalendarAdapterState {
  steps: ScopeRunTaskStep[]
  taskSummary: string | null
  currentStepId: string | null
}

function createState(domainState: unknown): CalendarAdapterState {
  if (
    domainState
    && typeof domainState === 'object'
    && 'steps' in domainState
    && Array.isArray((domainState as CalendarAdapterState).steps)
  ) {
    return domainState as CalendarAdapterState
  }
  return {
    steps: [],
    taskSummary: null,
    currentStepId: null,
  }
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

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'calendar'
  }

  prepare(params: Parameters<DomainAdapter['prepare']>[0]): DomainAdapterPrepareResult {
    return {
      allowedToolNames: filterAllowedToolNamesByPrefixes(params.allowedToolNames, TOOL_PREFIXES),
      sessionMessages: params.hasTools ? [{ role: 'user', content: INSTRUCTION }] : [],
      domainState: createState(null),
    }
  }

  dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): ReturnType<DomainAdapter['dispatch']> {
    return { domainState: params.domainState }
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
        }
      }
      if (nextState.currentStepId) {
        return {
          domainState: nextState,
          projection: {
            phase: 'done',
            summary: nextState.taskSummary || '日程任务已执行',
            waitingFor: 'none',
            resumableActions: ['cancel'],
            blockedReason: null,
          },
        }
      }
      return { domainState: nextState }
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
