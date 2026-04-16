import type { CapabilityRuntimeSnapshot } from '../../../shared/ai-capability-runtime'
import { classifyIntent } from './intent-classifier'
import { restoreContinuationTaskBudgetRuntime } from './run-budget-policy'
import type {
  TaskExecutionRoute,
  TaskProjectionRecord,
  TaskStep,
  TaskTypeResolution,
} from './run-contracts'
import type { RequestEnvelope } from './request-envelope'

const EXECUTOR_RUNTIME_POLICIES: Partial<Record<TaskExecutionRoute['executor'], {
  toolPrefixes: string[]
  instruction: string
}>> = {
  skill: {
    toolPrefixes: ['skill_', 'memory_', 'session_'],
    instruction: '系统执行器：本轮走 skill 执行路径。优先使用 skill_* 工具推进，不要退回无关的通用工具。',
  },
  rss: {
    toolPrefixes: ['rss_', 'skill_rss_', 'memory_', 'session_'],
    instruction: '系统执行器：本轮走 RSS 执行路径。优先使用 rss_* 或 skill_rss_* 工具完成任务，不要改走无关工具。',
  },
  calendar: {
    toolPrefixes: ['calendar_', 'memory_', 'session_'],
    instruction: '系统执行器：本轮走日程执行路径。优先使用 calendar_* 工具完成任务，不要改走无关工具。',
  },
  feishu: {
    toolPrefixes: ['feishu_', 'memory_', 'session_'],
    instruction: '系统执行器：本轮走飞书执行路径。优先使用 feishu_* 工具完成任务，不要改走无关工具。',
  },
}

function buildPlannerSteps(params: {
  envelope: RequestEnvelope
  maxIterations: number
}): TaskStep[] {
  const intent = classifyIntent(params.envelope)
  const primaryInstruction = params.envelope.primaryInstruction || params.envelope.pureUserText || '完成当前任务'
  const domains = Array.from(new Set([intent.primaryDomain, ...intent.mentionedDomains].filter((item) => item !== 'generic')))
  const stepCount = domains.length >= 2 ? Math.min(3, domains.length + 1) : 3
  const perStepBudget = Math.max(6, Math.ceil(params.maxIterations / stepCount))

  if (domains.length >= 2) {
    const steps: TaskStep[] = domains.slice(0, stepCount - 1).map((domain, index) => ({
      id: `step-${index + 1}`,
      title: index === 0 ? `处理${domain}输入` : `衔接${domain}能力`,
      description: index === 0
        ? `先从 ${domain} 获取或整理完成任务所需的核心输入`
        : `把中间结果接到 ${domain}，继续推进最终交付`,
      toolHints: [domain],
      budget: perStepBudget,
      dependsOn: index === 0 ? [] : [`step-${index}`],
    }))
    steps.push({
      id: `step-${steps.length + 1}`,
      title: '汇总交付',
      description: `整理前面步骤的结果，完成最终输出：${primaryInstruction.slice(0, 80)}`,
      toolHints: domains,
      budget: perStepBudget,
      dependsOn: steps.length > 0 ? [steps[steps.length - 1].id] : [],
    })
    return steps
  }

  return [
    {
      id: 'step-1',
      title: '确认输入',
      description: '整理当前任务需要的输入和上下文',
      toolHints: ['memory', intent.primaryDomain].filter(Boolean) as string[],
      budget: perStepBudget,
      dependsOn: [],
    },
    {
      id: 'step-2',
      title: '执行任务',
      description: `围绕当前目标推进主要执行：${primaryInstruction.slice(0, 80)}`,
      toolHints: [intent.primaryDomain],
      budget: perStepBudget,
      dependsOn: ['step-1'],
    },
    {
      id: 'step-3',
      title: '整理结果',
      description: '校对结果并输出给用户',
      toolHints: [],
      budget: perStepBudget,
      dependsOn: ['step-2'],
    },
  ]
}

function resolveExecutor(params: {
  chain: TaskTypeResolution['executionChain']
  preferredExecutor?: TaskTypeResolution['preferredExecutor']
  continuationProjection?: TaskProjectionRecord | null
}): TaskExecutionRoute['executor'] {
  if (params.chain === 'direct') return 'direct'
  if (params.chain === 'tool_loop') {
    if (params.preferredExecutor && params.preferredExecutor !== 'none') {
      return params.preferredExecutor
    }
    return 'tool_loop'
  }
  if (params.chain === 'planner') return 'planner'
  if (params.chain === 'continuation') {
    const module = params.continuationProjection?.module
    if (module === 'browser' || module === 'document' || module === 'skill' || module === 'rss' || module === 'calendar' || module === 'feishu') {
      return module
    }
    return 'tool_loop'
  }
  if (params.preferredExecutor && params.preferredExecutor !== 'none') {
    return params.preferredExecutor
  }
  return 'tool_loop'
}

export function buildExecutorRuntimePolicy(executor: TaskExecutionRoute['executor']): {
  toolPrefixes: string[] | null
  instruction: string | null
} {
  const policy = EXECUTOR_RUNTIME_POLICIES[executor]
  return {
    toolPrefixes: policy?.toolPrefixes || null,
    instruction: policy?.instruction || null,
  }
}

export function selectExecutorAllowedToolNames(
  executor: TaskExecutionRoute['executor'],
  allowedToolNames: Set<string> | string[] | null | undefined,
): string[] | null {
  const policy = buildExecutorRuntimePolicy(executor)
  if (!allowedToolNames || !policy.toolPrefixes || policy.toolPrefixes.length === 0) {
    return null
  }
  const names = allowedToolNames instanceof Set ? Array.from(allowedToolNames) : allowedToolNames
  const filtered = names.filter((toolName) => policy.toolPrefixes!.some((prefix) => toolName.startsWith(prefix)))
  return filtered.length > 0 ? filtered : null
}

export function resolveTaskExecutionRoute(params: {
  taskId: string
  resolution: TaskTypeResolution
  envelope: RequestEnvelope
  capabilities: CapabilityRuntimeSnapshot
  currentTaskContext?: {
    continuationTaskId?: string | null
    continuationProjection?: TaskProjectionRecord | null
  } | null
}): TaskExecutionRoute {
  const continuationProjection = params.currentTaskContext?.continuationProjection || null
  const executor = resolveExecutor({
    chain: params.resolution.executionChain,
    preferredExecutor: params.resolution.preferredExecutor,
    continuationProjection,
  })

  if (params.resolution.executionChain === 'continuation') {
    if (continuationProjection) {
      const restoredBudget = restoreContinuationTaskBudgetRuntime({
        taskType: 'continuation',
        budget: continuationProjection.budget,
      })
      return {
        taskId: params.taskId,
        taskType: params.resolution.taskType,
        chain: 'continuation',
        executor,
        steps: continuationProjection.steps || [],
        degradationReason: params.resolution.degradationReason
          || (restoredBudget.runtime ? null : 'continuation_budget_unavailable'),
        continuation: {
          taskId: continuationProjection.taskId,
          module: continuationProjection.module,
          continuationRef: continuationProjection.continuationRef || null,
          budgetRuntime: restoredBudget.runtime,
          budgetRestore: restoredBudget.diagnostics,
        },
      }
    }

    return {
      taskId: params.taskId,
      taskType: 'short_task',
      chain: 'tool_loop',
      executor: 'tool_loop',
      steps: [],
      degradationReason: params.resolution.degradationReason || 'continuation_unavailable',
      continuation: null,
    }
  }

  return {
    taskId: params.taskId,
    taskType: params.resolution.taskType,
    chain: params.resolution.executionChain,
    executor,
    steps: params.resolution.executionChain === 'planner'
      ? buildPlannerSteps({
        envelope: params.envelope,
        maxIterations: params.resolution.taskType === 'multi_step_task' ? 60 : 24,
      })
      : [],
    degradationReason: params.resolution.degradationReason || null,
    continuation: continuationProjection
      ? {
        taskId: continuationProjection.taskId,
        module: continuationProjection.module,
        continuationRef: continuationProjection.continuationRef || null,
      }
      : null,
  }
}
