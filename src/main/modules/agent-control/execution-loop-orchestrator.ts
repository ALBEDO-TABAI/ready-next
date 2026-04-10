import type { ExecutionFallbackInfo } from '../claude-bridge/execution-fallback-policy'
import { annotateFallbackResult, resolveFallbackPlan } from '../claude-bridge/execution-fallback-policy'
import { groupParallelSafeToolCalls, type ParallelToolCall } from './tool-parallelism-policy'
import { canUseParallelToolGroup, getRemainingToolCallBudget } from './run-budget-policy'
import type { RunBudgetSeed, RunBudgetUsage } from './run-contracts'

interface APIResponseLike {
  text: string
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
  stopReason: string
  reasoningContent?: unknown
  providerResponseId?: string
  rawText?: string
  toolTransport?: 'native' | 'text'
  fallback?: ExecutionFallbackInfo
}

interface ToolExecutionResult {
  id: string
  name: string
  input: Record<string, unknown>
  result: string
}

interface ExecuteToolCallsResult {
  results: ToolExecutionResult[]
  budgetLimited: boolean
}

export class ExecutionLoopOrchestrator {
  constructor(private readonly deps: {
    log: (message: string) => void
  }) {}

  async requestToolLoopResponse(params: {
    useAnthropicProtocol: boolean
    hasVideoInputs: boolean
    session: unknown
    config: unknown
    baseUrl: string
    provider: unknown
    signal: AbortSignal
    policy?: unknown
    callAnthropicWithTools: () => Promise<APIResponseLike>
    callOpenAIWithTools: () => Promise<APIResponseLike>
    buildVideoFrameFallbackMessages: () => Promise<unknown>
    assignFallbackMessages: (messages: unknown) => void
  }): Promise<APIResponseLike> {
    if (params.useAnthropicProtocol) {
      try {
        return await params.callAnthropicWithTools()
      } catch (error) {
        const fallbackPlan = resolveFallbackPlan({
          mode: 'video_frames',
          hasVideoInputs: params.hasVideoInputs,
          error,
        })
        if (!fallbackPlan.shouldRetry) {
          throw error
        }
        this.deps.log('Anthropic tool request with video blocks failed, retrying with extracted image frames fallback')
        const fallbackMessages = await params.buildVideoFrameFallbackMessages()
        params.assignFallbackMessages(fallbackMessages)
        return annotateFallbackResult(await params.callAnthropicWithTools(), {
          kind: 'video_frames',
          attempts: 1,
        })
      }
    }

    try {
      return await params.callOpenAIWithTools()
    } catch (error) {
      const fallbackPlan = resolveFallbackPlan({
        mode: 'video_frames',
        hasVideoInputs: params.hasVideoInputs,
        error,
      })
      if (!fallbackPlan.shouldRetry) {
        throw error
      }
      this.deps.log('OpenAI tool request with video blocks failed, retrying with extracted image frames fallback')
      const fallbackMessages = await params.buildVideoFrameFallbackMessages()
      params.assignFallbackMessages(fallbackMessages)
      return annotateFallbackResult(await params.callOpenAIWithTools(), {
        kind: 'video_frames',
        attempts: 1,
      })
    }
  }

  async executeToolCalls(params: {
    toolCalls: ParallelToolCall[]
    executeTool: (toolCall: ParallelToolCall) => Promise<string>
    onGroupStart?: (group: { mode: 'parallel' | 'serial'; toolCalls: ParallelToolCall[] }) => void
    budget?: RunBudgetSeed
    budgetState?: RunBudgetUsage
  }): Promise<ExecuteToolCallsResult> {
    const groups = groupParallelSafeToolCalls(params.toolCalls)
    const results: ToolExecutionResult[] = []
    let budgetLimited = false

    for (const group of groups) {
      const remainingToolCalls = params.budget && params.budgetState
        ? getRemainingToolCallBudget(params.budget, params.budgetState)
        : group.toolCalls.length
      if (remainingToolCalls <= 0) {
        budgetLimited = true
        break
      }
      const limitedToolCalls = group.toolCalls.slice(0, remainingToolCalls)
      if (limitedToolCalls.length < group.toolCalls.length) {
        budgetLimited = true
      }
      const effectiveMode = group.mode === 'parallel' && params.budget && params.budgetState && !canUseParallelToolGroup(params.budget, params.budgetState)
        ? 'serial'
        : group.mode
      params.onGroupStart?.({ mode: effectiveMode, toolCalls: limitedToolCalls })
      if (effectiveMode === 'parallel') {
        const settled = await Promise.allSettled(limitedToolCalls.map(async (toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          result: await params.executeTool(toolCall),
        })))
        const firstRejected = settled.find((item) => item.status === 'rejected')
        if (firstRejected?.status === 'rejected') {
          throw firstRejected.reason
        }
        results.push(...settled.map((item) => (item as PromiseFulfilledResult<ToolExecutionResult>).value))
        continue
      }

      for (const toolCall of limitedToolCalls) {
        results.push({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          result: await params.executeTool(toolCall),
        })
      }
    }

    return {
      results,
      budgetLimited,
    }
  }
}
