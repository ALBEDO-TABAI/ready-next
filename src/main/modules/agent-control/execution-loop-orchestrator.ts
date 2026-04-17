import type { ExecutionFallbackInfo } from '../claude-bridge/execution-fallback-policy'
import { annotateFallbackResult, resolveFallbackPlan } from '../claude-bridge/execution-fallback-policy'
import { classifyExecutionError, type ErrorClassifierResult } from '../claude-bridge/error-classifier'
import { buildRecoveryPlan } from '../claude-bridge/recovery-router'
import type { RecoveryRecord, RunBudgetSeed, RunBudgetUsage } from './run-contracts'
import type { ParallelToolCall } from './tool-parallelism-policy'
import { ToolRuntime, type ToolRuntimeBatchResult } from './tool-runtime'
import type { ToolExecutionOutput } from './tool-result-types'

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

type KnownExecutionErrorResult = ErrorClassifierResult & {
  kind: Exclude<ErrorClassifierResult['kind'], 'unknown'>
}

export class ExecutionLoopOrchestrator {
  private readonly toolRuntime: ToolRuntime

  constructor(private readonly deps: {
    log: (message: string) => void
    sleep?: (delayMs: number) => Promise<void>
    now?: () => string
  }) {
    this.toolRuntime = new ToolRuntime({
      log: deps.log,
      sleep: deps.sleep,
      now: deps.now,
    })
  }

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
    executeTool: (toolCall: ParallelToolCall) => Promise<ToolExecutionOutput | string>
    onGroupStart?: (group: { mode: 'parallel' | 'serial'; toolCalls: ParallelToolCall[] }) => void
    budget?: RunBudgetSeed
    budgetState?: RunBudgetUsage
    signal?: AbortSignal
  }): Promise<ToolRuntimeBatchResult> {
    return this.toolRuntime.executeBatch({
      toolCalls: params.toolCalls,
      executeTool: params.executeTool,
      onGroupStart: params.onGroupStart,
      budget: params.budget,
      budgetState: params.budgetState,
      signal: params.signal,
    })
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

        if (plan.shouldRetry && nextAttempt <= plan.maxAttempts) {
          retryCounts[classified.kind] = nextAttempt
          pendingRecoveries.push({ result: classified as KnownExecutionErrorResult, attempt: nextAttempt })
          await params.onBeforeRetry?.(classified, nextAttempt)
          const retryDelayMs = Math.max(0, this.resolveRetryDelayMs(plan, nextAttempt))
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

  private resolveRetryDelayMs(
    plan: ReturnType<typeof buildRecoveryPlan>,
    attempt: number,
  ): number {
    const baseDelayMs = Math.max(0, plan.retryDelayMs || 0)
    if (baseDelayMs <= 0) return 0
    if (plan.backoff !== 'exponential_jitter') {
      return baseDelayMs
    }
    const exponential = Math.min(8_000, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)))
    const jitterFloor = Math.max(350, Math.round(exponential * 0.75))
    const jitterRange = Math.max(1, exponential - jitterFloor)
    return Math.min(8_000, jitterFloor + Math.floor(Math.random() * jitterRange))
  }

}
