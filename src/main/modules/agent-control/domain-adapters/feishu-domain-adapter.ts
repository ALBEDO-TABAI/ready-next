import {
  filterAllowedToolNamesByPrefixes,
  logPrefixNarrowing,
  readStructuredToolResultRecord,
  type DomainAdapter,
  type DomainAdapterPrepareResult,
} from './domain-adapter'
import type { ScopeRunTaskStep } from '../contracts/types'

// R2: See skill-domain-adapter.ts for why prefix narrowing is a second gate.
// Feishu intentionally strips skill_* tools to keep deterministic feishu sidecar
// in charge. A skill-pipeline that wants to end in feishu must hand off via
// the planner / tool_loop chain, not by running under the feishu adapter.
const TOOL_PREFIXES = ['feishu_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走飞书执行路径。优先使用 feishu_* 工具完成任务，不要改走无关工具。'
const FEISHU_DOC_TRIGGER_PATTERN = /(飞书).*(文档|doc)|创建飞书文档|改写飞书文档|写入飞书/i
const FEISHU_IMAGE_TRIGGER_PATTERN = /(飞书).*(图片|插图|上传)/i

interface FeishuAdapterState {
  steps: ScopeRunTaskStep[]
  taskSummary: string | null
  currentStepId: string | null
  dispatchedAt: string | null
  failureReason: string | null
}

function createState(domainState: unknown): FeishuAdapterState {
  if (
    domainState
    && typeof domainState === 'object'
    && 'steps' in domainState
    && Array.isArray((domainState as FeishuAdapterState).steps)
  ) {
    const record = domainState as FeishuAdapterState
    return {
      steps: record.steps,
      taskSummary: record.taskSummary ?? null,
      currentStepId: record.currentStepId ?? null,
      dispatchedAt: record.dispatchedAt ?? null,
      failureReason: record.failureReason ?? null,
    }
  }
  return {
    steps: [],
    taskSummary: null,
    currentStepId: null,
    dispatchedAt: null,
    failureReason: null,
  }
}

function hasAnyDomainTool(allowedToolNames: string[] | null | undefined): boolean {
  if (!allowedToolNames || allowedToolNames.length === 0) return false
  return allowedToolNames.some((name) => name.startsWith('feishu_'))
}

function buildStepId(existingSteps: ScopeRunTaskStep[], toolName: string): string {
  const repeats = existingSteps.filter((step) => step.id === toolName || step.id.startsWith(`${toolName}#`)).length
  return repeats === 0 ? toolName : `${toolName}#${repeats + 1}`
}

function buildSummary(record: Record<string, unknown> | null, toolName: string, input: Record<string, unknown>): string {
  const action = typeof record?.action === 'string' && record.action.trim() ? record.action.trim() : toolName
  const message = typeof record?.message === 'string' && record.message.trim() ? record.message.trim() : '已执行'
  const target = ['chat_id', 'doc_token', 'event_id', 'file_token']
    .map((key) => input[key])
    .find((value) => typeof value === 'string' && value.trim().length > 0)
  return typeof target === 'string' ? `${action}（${target.trim()}）：${message}` : `${action}：${message}`
}

function readFailureReason(record: Record<string, unknown> | null): string | null {
  const failed = record?.ok === false || (typeof record?.errorKind === 'string' && record.errorKind.trim().length > 0)
  if (!failed) return null
  const errorKind = typeof record?.errorKind === 'string' && record.errorKind.trim()
    ? record.errorKind.trim()
    : 'feishu_operation_failed'
  const message = typeof record?.message === 'string' && record.message.trim()
    ? record.message.trim()
    : '飞书操作失败'
  return `${errorKind}: ${message}`
}

export class FeishuDomainAdapter implements DomainAdapter {
  readonly id = 'feishu'

  contributePromptFragment(): ReturnType<DomainAdapter['contributePromptFragment']> {
    return [
      {
        id: 'feishu-doc',
        label: '飞书文档操作',
        priority: 0,
        matches: ({ userText }) => FEISHU_DOC_TRIGGER_PATTERN.test(userText),
        blocking: true,
        refs: [
          { path: 'docs/feishu-rules.md', title: '飞书文档规则', summary: '飞书文档创建与改写规则' },
          {
            path: 'docs/accounts.md',
            title: '飞书账号索引',
            summary: '飞书账号和租户索引',
            sensitive: true,
          },
        ],
      },
      {
        id: 'feishu-image',
        label: '飞书插图操作',
        priority: 0,
        matches: ({ userText }) => FEISHU_IMAGE_TRIGGER_PATTERN.test(userText),
        blocking: true,
        refs: [
          { path: 'docs/feishu-rules.md', title: '飞书插图规则', summary: '飞书图片上传和插入规则' },
          {
            path: 'docs/accounts.md',
            title: '飞书账号索引',
            summary: '飞书账号和租户索引',
            sensitive: true,
          },
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
    return params.route.executor === 'feishu'
  }

  prepare(params: Parameters<DomainAdapter['prepare']>[0]): DomainAdapterPrepareResult {
    const narrowed = filterAllowedToolNamesByPrefixes(params.allowedToolNames, TOOL_PREFIXES)
    if (params.host?.log) {
      logPrefixNarrowing(params.host.log, 'feishu', params.allowedToolNames, narrowed, TOOL_PREFIXES)
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
          summary: '本轮没有可用的飞书工具',
          waitingFor: 'none',
          resumableActions: ['retry', 'cancel'],
          blockedReason: '未解析到可用的 feishu_* 工具',
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
        if (!executedTool.name.startsWith('feishu_')) continue
        const record = readStructuredToolResultRecord(executedTool.result)
        const failureReason = readFailureReason(record)
        const stepId = buildStepId(nextState.steps, executedTool.name)
        nextState = {
          steps: [
            ...nextState.steps,
            {
              id: stepId,
              title: executedTool.name,
              status: failureReason ? 'error' : 'done',
              detail: buildSummary(record, executedTool.name, executedTool.input),
              updatedAt: new Date().toISOString(),
            },
          ],
          currentStepId: stepId,
          taskSummary: buildSummary(record, executedTool.name, executedTool.input),
          dispatchedAt: nextState.dispatchedAt,
          failureReason: nextState.failureReason || failureReason,
        }
      }
      return { domainState: nextState }
    }

    if (params.phase === 'no_tool_call' && state.currentStepId) {
      if (state.failureReason) {
        return {
          domainState: state,
          projection: {
            phase: 'blocked',
            summary: state.taskSummary || '飞书任务执行失败',
            waitingFor: 'none',
            resumableActions: ['retry', 'cancel'],
            blockedReason: state.failureReason,
          },
        }
      }
      return {
        domainState: state,
        projection: {
          phase: 'done',
          summary: state.taskSummary || '飞书任务已执行',
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
          summary: state.taskSummary || '飞书任务达到本轮执行上限',
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
      module: 'feishu',
      taskTitle: '飞书任务',
      taskSummary: params.projection.summary,
      steps: state.steps,
      currentStepId: state.currentStepId,
      waitingFor: params.projection.waitingFor ?? 'none',
      resumableActions: params.projection.resumableActions ?? ['cancel'],
      blockedReason: typeof params.projection.blockedReason === 'undefined' ? null : params.projection.blockedReason,
    }
  }
}
