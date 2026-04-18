import {
  filterAllowedToolNamesByPrefixes,
  readStructuredToolResultRecord,
  type DomainAdapter,
  type DomainAdapterPrepareResult,
} from './domain-adapter'
import type { ScopeRunTaskStep } from './types'

const TOOL_PREFIXES = ['rss_', 'skill_rss_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走 RSS 执行路径。优先使用 rss_* 或 skill_rss_* 工具完成任务，不要改走无关工具。'

interface RSSAdapterState {
  steps: ScopeRunTaskStep[]
  taskSummary: string | null
  currentStepId: string | null
  dispatchedAt: string | null
}

function createState(domainState: unknown): RSSAdapterState {
  if (
    domainState
    && typeof domainState === 'object'
    && 'steps' in domainState
    && Array.isArray((domainState as RSSAdapterState).steps)
  ) {
    const record = domainState as RSSAdapterState
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
  return allowedToolNames.some((name) => name.startsWith('rss_') || name.startsWith('skill_rss_'))
}

function buildStepId(existingSteps: ScopeRunTaskStep[], toolName: string): string {
  const repeats = existingSteps.filter((step) => step.id === toolName || step.id.startsWith(`${toolName}#`)).length
  return repeats === 0 ? toolName : `${toolName}#${repeats + 1}`
}

function formatInputMeta(input: Record<string, unknown>): string | null {
  const candidate = ['title', 'id', 'itemId', 'name']
    .map((key) => input[key])
    .find((value) => typeof value === 'string' && value.trim().length > 0)
  return typeof candidate === 'string' ? candidate.trim() : null
}

function buildSummary(record: Record<string, unknown> | null, toolName: string, input: Record<string, unknown>): string {
  const action = typeof record?.action === 'string' && record.action.trim() ? record.action.trim() : toolName
  const message = typeof record?.message === 'string' && record.message.trim() ? record.message.trim() : '已执行'
  const inputMeta = formatInputMeta(input)
  return inputMeta ? `${action}（${inputMeta}）：${message}` : `${action}：${message}`
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
          summary: '本轮没有可用的 RSS 工具',
          waitingFor: 'none',
          resumableActions: ['retry', 'cancel'],
          blockedReason: '未解析到可用的 rss_* 工具',
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
        if (!executedTool.name.startsWith('rss_') && !executedTool.name.startsWith('skill_rss_')) continue
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
          summary: state.taskSummary || 'RSS 任务已执行',
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
          summary: state.taskSummary || 'RSS 任务达到本轮执行上限',
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
      module: 'rss',
      taskTitle: 'RSS 任务',
      taskSummary: params.projection.summary,
      steps: state.steps,
      currentStepId: state.currentStepId,
      waitingFor: params.projection.waitingFor ?? 'none',
      resumableActions: params.projection.resumableActions ?? ['cancel'],
      blockedReason: typeof params.projection.blockedReason === 'undefined' ? null : params.projection.blockedReason,
    }
  }
}
