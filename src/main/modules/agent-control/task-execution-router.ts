import type { CapabilityRuntimeSnapshot } from '../../../shared/ai-capability-runtime'
import { buildContinuationStateFromProjection } from './contracts/continuation-state'
import { classifyIntent } from './intent-classifier'
import { restoreContinuationTaskBudgetRuntime } from './task-projection/run-budget-policy'
import type {
  TaskExecutionRoute,
  TaskProjectionRecord,
  TaskStep,
  TaskTypeResolution,
} from './contracts/run-contracts'
import type { RequestEnvelope } from './contracts/request-envelope'

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
  continuationModule?: TaskProjectionRecord['module']
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
    const module = params.continuationModule || params.continuationProjection?.module
    if (module === 'browser' || module === 'document' || module === 'skill' || module === 'rss' || module === 'calendar' || module === 'feishu' || module === 'research' || module === 'map') {
      return module
    }
    return 'tool_loop'
  }
  if (params.preferredExecutor && params.preferredExecutor !== 'none') {
    return params.preferredExecutor
  }
  return 'tool_loop'
}

export function resolveTaskExecutionRoute(params: {
  taskId: string
  resolution: TaskTypeResolution
  envelope: RequestEnvelope
  capabilities: CapabilityRuntimeSnapshot
  /**
   * Stage 6 L4 contract: callers pass `continuationContext` with **both**
   * `state` and `projection` together (either non-null or null), so the
   * router never has to guess which side of the pair is fresh. Pass
   * `continuationContext: null` when no continuation is in flight.
   */
  continuationContext: {
    state: import('./contracts/continuation-state').ContinuationState | null
    projection: TaskProjectionRecord | null
  } | null
}): TaskExecutionRoute {
  const continuationProjection = params.continuationContext?.projection || null
  const continuationState = params.continuationContext?.state
    || (continuationProjection ? buildContinuationStateFromProjection(continuationProjection) : null)
  const executor = resolveExecutor({
    chain: params.resolution.executionChain,
    preferredExecutor: params.resolution.preferredExecutor,
    continuationProjection,
    continuationModule: continuationState?.module,
  })

  if (params.resolution.executionChain === 'continuation') {
    if (continuationState) {
      const restoredBudget = restoreContinuationTaskBudgetRuntime({
        taskType: 'continuation',
        projectionBudget: continuationProjection?.budget || null,
        projectionBudgetRuntime: null,
        continuationState,
      })
      return {
        taskId: params.taskId,
        taskType: params.resolution.taskType,
        chain: 'continuation',
        executor,
        steps: continuationState.steps || [],
        currentStepId: continuationState.currentStepId || null,
        degradationReason: params.resolution.degradationReason
          || (restoredBudget.runtime || continuationState.budgetRuntime ? null : 'continuation_budget_unavailable'),
        continuation: {
          taskId: continuationState.taskId,
          module: continuationState.module,
          continuationRef: continuationState.continuationRef || null,
          blockedReason: continuationState.blockedReason || null,
          resumableActions: continuationState.resumableActions || [],
          interactionState: continuationState.interactionState,
          currentStepId: continuationState.currentStepId || null,
          budgetRuntime: restoredBudget.runtime || continuationState.budgetRuntime || null,
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
      currentStepId: null,
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
        maxIterations: (params.resolution.taskType === 'multi_step_task' || params.resolution.taskType === 'research') ? 60 : 24,
      })
      : [],
    currentStepId: null,
    degradationReason: params.resolution.degradationReason || null,
    continuation: continuationState
      ? {
        taskId: continuationState.taskId,
        module: continuationState.module,
        continuationRef: continuationState.continuationRef || null,
        blockedReason: continuationState.blockedReason || null,
        resumableActions: continuationState.resumableActions || [],
        interactionState: continuationState.interactionState,
        currentStepId: continuationState.currentStepId || null,
      }
      : null,
  }
}
