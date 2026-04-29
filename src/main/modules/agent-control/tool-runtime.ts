import { classifyExecutionError, type ErrorClassifierResult } from '../claude-bridge/error-classifier'
import { buildRecoveryPlan } from '../claude-bridge/recovery-router'
import { logAgentMetric } from './metrics'
import { TOOL_ERROR_METRICS } from './tool-error-metrics'
import { isTerminalInfrastructureError } from '../tools/tool-errors'
import type { SidecarManager } from './sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { ConversationScope } from './types'
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { ToolDefinition } from './tool-definition'
import { defaultToolRegistry } from './tool-registry'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import type { RecoveryRecord, RunBudgetSeed, RunBudgetUsage } from './run-contracts'
import { groupParallelSafeToolCalls, type ParallelToolCall } from './tool-parallelism-policy'
import {
  canUseParallelToolGroup,
  getBudgetUsagePercent,
  getBudgetWarningLevel,
  getRemainingToolCallBudget,
} from './run-budget-policy'
import type { ToolExecutionHooks } from './tool-execution-hooks'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
  type ToolExecutionResultLike,
} from './tool-result-types'
import { toToolExecutorContext } from './tool-runtime-context-builder'
import { resolveToolExecutionTimeoutMsForProfile } from '../tools/tool-execution-timeout-policy'
import {
  buildToolNotAllowedMessage,
  buildUnknownToolMessage,
  normalizeAllowedToolSet,
} from '../tools/tool-not-allowed-message'

export interface ToolRuntimeContext {
  browserController?: BrowserController | null
  sidecarManager?: SidecarManager | null
  runtime?: AgentControlRuntime | null
  scope?: ConversationScope | null
  allowedToolNames?: Set<string> | string[] | null
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  abortSignal?: AbortSignal
  sessionId?: string
  scopeId?: string
  runId?: string
  taskId?: string
  parentTaskId?: string
  parentStepId?: string
  taskProjectionId?: string
  frameSkillId?: string | null
  registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
  agentContext?: AgentSpawnContext | null
}

export interface ToolRuntimeExecutionResult {
  id: string
  name: string
  input: Record<string, unknown>
  result: ToolExecutionOutput
}

export interface ToolRuntimeBatchResult {
  results: ToolRuntimeExecutionResult[]
  budgetLimited: boolean
  recoveryHistory: RecoveryRecord[]
}

type KnownExecutionErrorResult = ErrorClassifierResult & {
  kind: Exclude<ErrorClassifierResult['kind'], 'unknown'>
}

interface TrackedCleanup {
  drained: boolean
  run: () => Promise<void>
}

interface ToolRuntimeAttemptContext extends ToolRuntimeContext {
  __trackedCleanups: TrackedCleanup[]
}

export class ToolRuntime {
  constructor(private readonly deps: {
    log: (message: string) => void
    sleep?: (delayMs: number) => Promise<void>
    now?: () => string
    executeToolCall?: (
      toolName: string,
      args: Record<string, unknown>,
      context: ReturnType<typeof toToolExecutorContext>,
    ) => Promise<ToolExecutionResultLike>
    resolveTimeoutMs?: (definition: ToolDefinition | null, toolCall: ParallelToolCall) => number
  }) {}

  async executeBatch(params: {
    toolCalls: ParallelToolCall[]
    context?: ToolRuntimeContext
    executeTool?: (toolCall: ParallelToolCall) => Promise<ToolExecutionResultLike>
    onGroupStart?: (group: { mode: 'parallel' | 'serial'; toolCalls: ParallelToolCall[] }) => void
    hooks?: ToolExecutionHooks
    budget?: RunBudgetSeed
    budgetState?: RunBudgetUsage
    signal?: AbortSignal
  }): Promise<ToolRuntimeBatchResult> {
    const groups = groupParallelSafeToolCalls(params.toolCalls)
    const results: ToolRuntimeExecutionResult[] = []
    const recoveryHistory: RecoveryRecord[] = []
    const batchCleanups: TrackedCleanup[] = []
    const startedToolCallIds: string[] = []
    let budgetLimited = false
    let shouldSerializeRemainingGroups = false
    let interruptedNotified = false

    const notifyInterrupted = (skippedToolCalls: ParallelToolCall[]): void => {
      if (interruptedNotified) return
      interruptedNotified = true
      params.hooks?.onBatchInterrupted?.({
        startedToolCallIds: [...startedToolCallIds],
        skippedToolCalls,
      })
    }

    const throwIfAborted = async (skippedToolCalls: ParallelToolCall[] = []): Promise<void> => {
      const signal = params.signal || params.context?.abortSignal
      if (!signal?.aborted) return
      notifyInterrupted(skippedToolCalls)
      await this.drainRegisteredCleanups(batchCleanups)
      const error = new Error('Operation aborted')
      error.name = 'AbortError'
      throw error
    }

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex]
      const futureGroupCalls = groups.slice(groupIndex + 1).flatMap((item) => item.toolCalls)
      await throwIfAborted([...group.toolCalls, ...futureGroupCalls])

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

      const budgetWarningLevel = params.budget && params.budgetState
        ? getBudgetWarningLevel(getBudgetUsagePercent(params.budget, params.budgetState))
        : 'none'
      const effectiveMode = group.mode === 'parallel'
        && !shouldSerializeRemainingGroups
        && budgetWarningLevel === 'none'
        && !(params.budget && params.budgetState && !canUseParallelToolGroup(params.budget, params.budgetState))
        ? 'parallel'
        : 'serial'

      params.onGroupStart?.({ mode: effectiveMode, toolCalls: limitedToolCalls })

      if (effectiveMode === 'parallel') {
        const maxConcurrentTools = Math.max(1, params.budget?.maxParallelToolGroups || 5)
        for (let index = 0; index < limitedToolCalls.length; index += maxConcurrentTools) {
          const pendingToolCalls = limitedToolCalls.slice(index)
          await throwIfAborted([...pendingToolCalls, ...futureGroupCalls])
          const chunk = limitedToolCalls.slice(index, index + maxConcurrentTools)
          const settled = await Promise.allSettled(chunk.map((toolCall) =>
            this.executeToolCallWithRecovery(toolCall, params, startedToolCallIds, batchCleanups)))
          const firstRejected = settled.find((item) => item.status === 'rejected')
          if (firstRejected?.status === 'rejected') {
            if (this.isAbortError(firstRejected.reason)) {
              notifyInterrupted([
                ...limitedToolCalls.slice(index + maxConcurrentTools),
                ...futureGroupCalls,
              ])
            }
            await this.drainRegisteredCleanups(batchCleanups)
            throw firstRejected.reason
          }
          for (const item of settled as Array<PromiseFulfilledResult<ToolRuntimeExecutionResult & { recoveryHistory: RecoveryRecord[] }>>) {
            results.push(item.value)
            recoveryHistory.push(...item.value.recoveryHistory)
            if (item.value.recoveryHistory.length > 0) {
              shouldSerializeRemainingGroups = true
            }
          }
        }
        continue
      }

      for (let toolIndex = 0; toolIndex < limitedToolCalls.length; toolIndex += 1) {
        const remainingCurrentCalls = limitedToolCalls.slice(toolIndex)
        await throwIfAborted([...remainingCurrentCalls, ...futureGroupCalls])
        let executedTool: ToolRuntimeExecutionResult & { recoveryHistory: RecoveryRecord[] }
        try {
          executedTool = await this.executeToolCallWithRecovery(
            limitedToolCalls[toolIndex],
            params,
            startedToolCallIds,
            batchCleanups,
          )
        } catch (error) {
          if (this.isAbortError(error)) {
            notifyInterrupted([
              ...remainingCurrentCalls.slice(1),
              ...futureGroupCalls,
            ])
          }
          await this.drainRegisteredCleanups(batchCleanups)
          throw error
        }
        results.push(executedTool)
        recoveryHistory.push(...executedTool.recoveryHistory)
        if (executedTool.recoveryHistory.length > 0) {
          shouldSerializeRemainingGroups = true
        }
      }
    }

    return {
      results,
      budgetLimited,
      recoveryHistory,
    }
  }

  private async executeToolCallWithRecovery(
    toolCall: ParallelToolCall,
    params: {
      context?: ToolRuntimeContext
      executeTool?: (toolCall: ParallelToolCall) => Promise<ToolExecutionResultLike>
      hooks?: ToolExecutionHooks
      signal?: AbortSignal
    },
    startedToolCallIds: string[],
    batchCleanups: TrackedCleanup[],
  ): Promise<ToolRuntimeExecutionResult & { recoveryHistory: RecoveryRecord[] }> {
    const preflight = this.resolvePreflightResult(toolCall.name, {
      context: params.context,
      requireRegisteredTool: !params.executeTool,
    })
    if (preflight) {
      return {
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        result: preflight,
        recoveryHistory: [],
      }
    }

    startedToolCallIds.push(toolCall.id)
    params.hooks?.onToolStart?.({ toolCall })
    const toolDefinition = defaultToolRegistry.getToolDefinitionForExecution(toolCall.name)
    const timeoutMs = this.resolveTimeoutMs(toolDefinition, toolCall)
    const pendingRecoveries: Array<{ result: KnownExecutionErrorResult; attempt: number }> = []
    let attempt = 0

    while (true) {
      attempt += 1
      const attemptGuard = this.createAttemptGuard({
        toolName: toolCall.name,
        timeoutMs,
        signals: [params.signal, params.context?.abortSignal],
      })
      const attemptContext = this.createAttemptContext(params.context, attemptGuard.signal, batchCleanups)

      try {
        const rawResult = params.executeTool
          ? await this.runGuardedOperation(attemptGuard, () => params.executeTool?.(toolCall) as Promise<ToolExecutionResultLike>)
          : await this.runGuardedOperation(attemptGuard, () =>
            this.executeDefaultToolCall(toolCall, params.context, attemptContext))
        const result = normalizeToolExecutionOutput(rawResult)
        const recoveryHistory = pendingRecoveries.map(({ result: pendingResult, attempt: pendingAttempt }) =>
          this.buildRecoveryRecord(pendingResult, pendingAttempt, true))
        if (recoveryHistory.length > 0) {
          params.hooks?.onToolRecovered?.({ toolCall, result, recoveryHistory })
        }
        params.hooks?.onToolResult?.({ toolCall, result })
        return {
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          result,
          recoveryHistory,
        }
      } catch (error) {
        // Terminal infrastructure (AbortError, ToolHostUnavailableError) must
        // bubble so the batch runner can cancel remaining work. Everything
        // else is surfaced to the model as a structured tool_result — the
        // dispatch layer already converts domain throws to structured results,
        // so unknown-kind errors reaching here are the rare residual and are
        // safer fed back than used to kill the turn.
        if (isTerminalInfrastructureError(error)) {
          throw error
        }
        const classified = classifyExecutionError(error, { source: 'tool_execution' })
        const plan = buildRecoveryPlan(classified)
        const nextAttempt = attempt

        if (plan.shouldRetry && nextAttempt <= plan.maxAttempts && classified.kind !== 'context_overflow') {
          await this.drainRegisteredCleanups(attemptContext.__trackedCleanups)
          pendingRecoveries.push({ result: classified as KnownExecutionErrorResult, attempt: nextAttempt })
          const retryDelayMs = Math.max(0, this.resolveRetryDelayMs(plan, nextAttempt))
          if (retryDelayMs > 0) {
            await this.sleep(retryDelayMs)
          }
          continue
        }

        await this.drainRegisteredCleanups(attemptContext.__trackedCleanups)
        const recoveredKinds = new Set<ErrorClassifierResult['kind']>(['timeout_tool', 'host_unavailable', 'auth'])
        const isKnownKind = classified.kind !== 'unknown'
        const recovered = isKnownKind && recoveredKinds.has(classified.kind)
        const recoveryHistory = pendingRecoveries.map(({ result: pendingResult, attempt: pendingAttempt }) =>
          this.buildRecoveryRecord(pendingResult, pendingAttempt, false))
        if (isKnownKind) {
          recoveryHistory.push(this.buildRecoveryRecord(classified as KnownExecutionErrorResult, nextAttempt, recovered))
        } else {
          logAgentMetric(TOOL_ERROR_METRICS.unknownSurfaced, {
            toolName: toolCall.name,
            message: classified.message.slice(0, 200),
          })
        }
        const result = createToolExecutionOutput(classified.message, {
          shape: 'json',
          data: {
            errorKind: classified.kind,
            recovered,
            source: classified.source,
            toolName: toolCall.name,
          },
        })
        if (recoveryHistory.length > 0) {
          params.hooks?.onToolRecovered?.({ toolCall, result, recoveryHistory })
        }
        params.hooks?.onToolResult?.({ toolCall, result })
        return {
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          result,
          recoveryHistory,
        }
      } finally {
        attemptGuard.dispose()
      }
    }
  }

  private resolvePreflightResult(
    toolName: string,
    options?: {
      context?: ToolRuntimeContext
      requireRegisteredTool?: boolean
    },
  ): ToolExecutionOutput | null {
    // Check registration first (when required) so the model gets an "unknown
    // tool" signal for fabricated names, not an "allowed list" signal that
    // would invite retry. Matches tool-executor.ts for a unified contract.
    if (options?.requireRegisteredTool && !defaultToolRegistry.getToolDefinitionForExecution(toolName)) {
      return createToolExecutionOutput(buildUnknownToolMessage(toolName), {
        shape: 'json',
        data: {
          errorKind: 'host_unavailable',
          reason: 'tool_not_registered',
          toolName,
        },
      })
    }

    const allowedToolNames = normalizeAllowedToolSet(options?.context?.allowedToolNames)
    if (defaultToolRegistry.getToolDefinitionForExecution(toolName)?.requiresExplicitAllowlist && !allowedToolNames?.has(toolName)) {
      return createToolExecutionOutput(buildToolNotAllowedMessage(toolName, allowedToolNames || new Set()), {
        shape: 'json',
        data: {
          errorKind: 'host_unavailable',
          reason: 'tool_restricted_this_turn',
          toolName,
        },
      })
    }
    if (allowedToolNames && !allowedToolNames.has(toolName)) {
      return createToolExecutionOutput(buildToolNotAllowedMessage(toolName, allowedToolNames), {
        shape: 'json',
        data: {
          errorKind: 'host_unavailable',
          reason: 'tool_restricted_this_turn',
          toolName,
        },
      })
    }

    return null
  }

  private async executeDefaultToolCall(
    toolCall: ParallelToolCall,
    context?: ToolRuntimeContext,
    attemptContext?: ToolRuntimeAttemptContext,
  ): Promise<ToolExecutionResultLike> {
    const effectiveContext = attemptContext || context
    if (!effectiveContext) {
      throw new Error(`Tool runtime context is required for ${toolCall.name}`)
    }
    if (this.deps.executeToolCall) {
      return await this.deps.executeToolCall(toolCall.name, toolCall.input, toToolExecutorContext(effectiveContext))
    }
    const { executeToolCall } = await import('../tools/tool-executor')
    return await executeToolCall(toolCall.name, toolCall.input, toToolExecutorContext(effectiveContext))
  }

  private createAttemptContext(
    context: ToolRuntimeContext | undefined,
    abortSignal: AbortSignal,
    batchCleanups: TrackedCleanup[],
  ): ToolRuntimeAttemptContext {
    const trackedCleanups: TrackedCleanup[] = []

    return {
      ...(context || {}),
      abortSignal,
      registerRunCleanup: (cleanup) => {
        const trackedCleanup = this.trackCleanup(cleanup)
        trackedCleanups.push(trackedCleanup)
        batchCleanups.push(trackedCleanup)
        context?.registerRunCleanup?.(trackedCleanup.run)
      },
      __trackedCleanups: trackedCleanups,
    }
  }

  private trackCleanup(cleanup: () => void | Promise<void>): TrackedCleanup {
    const entry: TrackedCleanup = {
      drained: false,
      run: async () => {
        if (entry.drained) return
        entry.drained = true
        await Promise.resolve(cleanup())
      },
    }
    return entry
  }

  private async drainRegisteredCleanups(cleanups: TrackedCleanup[]): Promise<void> {
    if (cleanups.length === 0) return
    await Promise.allSettled(cleanups.map((cleanup) => cleanup.run()))
  }

  private createAttemptGuard(params: {
    toolName: string
    timeoutMs: number
    signals: Array<AbortSignal | undefined>
  }): {
    signal: AbortSignal
    abortPromise: Promise<never>
    dispose: () => void
  } {
    const controller = new AbortController()
    const cleanupFns: Array<() => void> = []
    const timeoutMs = Math.max(1, params.timeoutMs)
    let timedOut = false

    const abortWith = (reason?: unknown): void => {
      if (controller.signal.aborted) return
      controller.abort(reason)
    }

    for (const signal of params.signals) {
      if (!signal) continue
      if (signal.aborted) {
        abortWith(signal.reason)
        continue
      }
      const handleAbort = (): void => {
        abortWith(signal.reason)
      }
      signal.addEventListener('abort', handleAbort, { once: true })
      cleanupFns.push(() => signal.removeEventListener('abort', handleAbort))
    }

    const timeoutId = setTimeout(() => {
      timedOut = true
      abortWith(this.buildToolTimeoutError(timeoutMs, params.toolName))
    }, timeoutMs)

    const abortPromise = new Promise<never>((_, reject) => {
      const rejectOnAbort = (): void => {
        if (timedOut) {
          reject(this.buildToolTimeoutError(timeoutMs, params.toolName))
          return
        }
        const error = new Error('Operation aborted')
        error.name = 'AbortError'
        reject(error)
      }
      if (controller.signal.aborted) {
        rejectOnAbort()
        return
      }
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
      cleanupFns.push(() => controller.signal.removeEventListener('abort', rejectOnAbort))
    })

    return {
      signal: controller.signal,
      abortPromise,
      dispose: () => {
        clearTimeout(timeoutId)
        while (cleanupFns.length > 0) {
          cleanupFns.pop()?.()
        }
      },
    }
  }

  private async runGuardedOperation<T>(
    guard: {
      signal: AbortSignal
      abortPromise: Promise<never>
    },
    operation: () => Promise<T>,
  ): Promise<T> {
    if (guard.signal.aborted) {
      return await guard.abortPromise
    }
    return await Promise.race([
      operation(),
      guard.abortPromise,
    ])
  }

  private buildToolTimeoutError(timeoutMs: number, toolName: string): Error {
    return new Error(`Tool execution timed out after ${timeoutMs}ms (${toolName})`)
  }

  private resolveTimeoutMs(
    definition: ToolDefinition | null,
    toolCall: ParallelToolCall,
  ): number {
    if (this.deps.resolveTimeoutMs) {
      return Math.max(1, this.deps.resolveTimeoutMs(definition, toolCall))
    }
    if (definition?.executionTimeoutMs) {
      return Math.max(1, definition.executionTimeoutMs)
    }
    return resolveToolExecutionTimeoutMsForProfile(definition?.timeoutProfile || 'default')
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

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString()
  }

  private async sleep(delayMs: number): Promise<void> {
    if (delayMs <= 0) return
    if (this.deps.sleep) {
      await this.deps.sleep(delayMs)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
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

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
  }
}
