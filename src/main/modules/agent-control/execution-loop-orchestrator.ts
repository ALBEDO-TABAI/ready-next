import type { ExecutionFallbackInfo } from '../claude-bridge/execution-fallback-policy'
import { annotateFallbackResult, resolveFallbackPlan } from '../claude-bridge/execution-fallback-policy'
import { classifyExecutionError, type ErrorClassifierResult } from '../claude-bridge/error-classifier'
import { buildRecoveryPlan } from '../claude-bridge/recovery-router'
import { groupParallelSafeToolCalls, type ParallelToolCall } from './tool-parallelism-policy'
import { canUseParallelToolGroup, getRemainingToolCallBudget } from './run-budget-policy'
import type { RecoveryRecord, RunBudgetSeed, RunBudgetUsage } from './run-contracts'

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
  recoveryHistory: RecoveryRecord[]
}

type KnownExecutionErrorResult = ErrorClassifierResult & {
  kind: Exclude<ErrorClassifierResult['kind'], 'unknown'>
}

export class ExecutionLoopOrchestrator {
  constructor(private readonly deps: {
    log: (message: string) => void
    sleep?: (delayMs: number) => Promise<void>
    now?: () => string
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
    compressContext?: () => Promise<boolean> | boolean
    onBeforeRetry?: (result: ErrorClassifierResult, attempt: number) => Promise<void> | void
    buildVideoFrameFallbackMessages: () => Promise<unknown>
    assignFallbackMessages: (messages: unknown) => void
  }): Promise<APIResponseLike & { recoveryHistory?: RecoveryRecord[] }> {
    if (params.useAnthropicProtocol) {
      const runtimeResult = await this.runModelRequestWithRecovery({
        request: params.callAnthropicWithTools,
        compressContext: params.compressContext,
        onBeforeRetry: params.onBeforeRetry,
      })
      if (runtimeResult.value) {
        return this.annotateRecoveryHistory(runtimeResult.value, runtimeResult.recoveryHistory)
      }
      {
        const error = runtimeResult.error
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
        return this.annotateRecoveryHistory(annotateFallbackResult(await params.callAnthropicWithTools(), {
          kind: 'video_frames',
          attempts: 1,
        }), runtimeResult.recoveryHistory)
      }
    }

    const runtimeResult = await this.runModelRequestWithRecovery({
      request: params.callOpenAIWithTools,
      compressContext: params.compressContext,
      onBeforeRetry: params.onBeforeRetry,
    })
    if (runtimeResult.value) {
      return this.annotateRecoveryHistory(runtimeResult.value, runtimeResult.recoveryHistory)
    }
    {
      const error = runtimeResult.error
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
      return this.annotateRecoveryHistory(annotateFallbackResult(await params.callOpenAIWithTools(), {
        kind: 'video_frames',
        attempts: 1,
      }), runtimeResult.recoveryHistory)
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
    const recoveryHistory: RecoveryRecord[] = []
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
        const settled = await Promise.allSettled(limitedToolCalls.map((toolCall) =>
          this.executeToolCallWithRecovery(toolCall, params.executeTool)))
        const firstRejected = settled.find((item) => item.status === 'rejected')
        if (firstRejected?.status === 'rejected') {
          throw firstRejected.reason
        }
        for (const item of settled as Array<PromiseFulfilledResult<ToolExecutionResult & { recoveryHistory: RecoveryRecord[] }>>) {
          results.push({
            id: item.value.id,
            name: item.value.name,
            input: item.value.input,
            result: item.value.result,
          })
          recoveryHistory.push(...item.value.recoveryHistory)
        }
        continue
      }

      for (const toolCall of limitedToolCalls) {
        const executedTool = await this.executeToolCallWithRecovery(toolCall, params.executeTool)
        results.push({
          id: executedTool.id,
          name: executedTool.name,
          input: executedTool.input,
          result: executedTool.result,
        })
        recoveryHistory.push(...executedTool.recoveryHistory)
      }
    }

    return {
      results,
      budgetLimited,
      recoveryHistory,
    }
  }

  private async runModelRequestWithRecovery<T>(params: {
    request: () => Promise<T>
    compressContext?: () => Promise<boolean> | boolean
    onBeforeRetry?: (result: ErrorClassifierResult, attempt: number) => Promise<void> | void
  }): Promise<{ value?: T; error?: unknown; recoveryHistory: RecoveryRecord[] }> {
    const recoveryHistory: RecoveryRecord[] = []
    const pendingRecoveries: Array<{ result: KnownExecutionErrorResult; attempt: number }> = []
    const retryCounts: Partial<Record<ErrorClassifierResult['kind'], number>> = {}
    let contextCompressed = false

    while (true) {
      try {
        const value = await params.request()
        recoveryHistory.push(...pendingRecoveries.map(({ result, attempt }) =>
          this.buildRecoveryRecord(result, attempt, true)))
        return { value, recoveryHistory }
      } catch (error) {
        const classified = classifyExecutionError(error, { source: 'model_request' })
        const plan = buildRecoveryPlan(classified)
        const nextAttempt = (retryCounts[classified.kind] || 0) + 1

        if (classified.kind === 'context_overflow' && plan.shouldCompressContext && !contextCompressed && params.compressContext) {
          const compressed = await params.compressContext()
          retryCounts[classified.kind] = nextAttempt
          if (compressed) {
            contextCompressed = true
            pendingRecoveries.push({ result: classified as KnownExecutionErrorResult, attempt: nextAttempt })
            await params.onBeforeRetry?.(classified, nextAttempt)
            continue
          }
          recoveryHistory.push(this.buildRecoveryRecord(classified as KnownExecutionErrorResult, nextAttempt, false))
          return { error, recoveryHistory }
        }

        const maxRetries = classified.kind === 'timeout_model' ? 1 : 3
        if (plan.shouldRetry && nextAttempt <= maxRetries) {
          retryCounts[classified.kind] = nextAttempt
          pendingRecoveries.push({ result: classified as KnownExecutionErrorResult, attempt: nextAttempt })
          await params.onBeforeRetry?.(classified, nextAttempt)
          const retryDelayMs = Math.max(0, plan.retryDelayMs || 0)
          if (retryDelayMs > 0) {
            await this.sleep(retryDelayMs)
          }
          continue
        }

        recoveryHistory.push(...pendingRecoveries.map(({ result, attempt }) =>
          this.buildRecoveryRecord(result, attempt, false)))
        if (classified.kind !== 'unknown') {
          recoveryHistory.push(this.buildRecoveryRecord(classified as KnownExecutionErrorResult, nextAttempt, false))
        }
        return { error, recoveryHistory }
      }
    }
  }

  private async executeToolCallWithRecovery(
    toolCall: ParallelToolCall,
    executeTool: (toolCall: ParallelToolCall) => Promise<string>,
  ): Promise<ToolExecutionResult & { recoveryHistory: RecoveryRecord[] }> {
    try {
      return {
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        result: await executeTool(toolCall),
        recoveryHistory: [],
      }
    } catch (error) {
      const classified = classifyExecutionError(error, { source: 'tool_execution' })
      if (classified.kind === 'timeout_tool' || classified.kind === 'host_unavailable' || classified.kind === 'auth') {
          return {
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
            result: classified.message,
            recoveryHistory: [this.buildRecoveryRecord(classified as KnownExecutionErrorResult, 1, true)],
          }
      }
      throw error
    }
  }

  private buildRecoveryRecord(
    result: KnownExecutionErrorResult,
    attempt: number,
    recovered: boolean,
  ): RecoveryRecord {
    return {
      kind: result.kind,
      source: result.source,
      message: result.message,
      attempt,
      recovered,
      timestamp: this.now(),
    }
  }

  private annotateRecoveryHistory<T extends APIResponseLike>(
    result: T,
    recoveryHistory: RecoveryRecord[],
  ): T & { recoveryHistory?: RecoveryRecord[] } {
    if (recoveryHistory.length === 0) {
      return result
    }
    return {
      ...result,
      recoveryHistory,
    }
  }

  private async sleep(delayMs: number): Promise<void> {
    if (delayMs <= 0) return
    if (this.deps.sleep) {
      await this.deps.sleep(delayMs)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString()
  }
}
