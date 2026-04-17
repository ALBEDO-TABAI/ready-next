import { classifyExecutionError, type ErrorClassifierResult } from '../claude-bridge/error-classifier'
import type { SidecarManager } from './sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { ConversationScope } from './types'
import type { BrowserController } from '../browser-engine/ipc-handler'
import { defaultToolGateway } from './tool-gateway'
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
  registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
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

export class ToolRuntime {
  constructor(private readonly deps: {
    log: (message: string) => void
    sleep?: (delayMs: number) => Promise<void>
    now?: () => string
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

    const throwIfAborted = (skippedToolCalls: ParallelToolCall[] = []): void => {
      const signal = params.signal || params.context?.abortSignal
      if (!signal?.aborted) return
      notifyInterrupted(skippedToolCalls)
      const error = new Error('Operation aborted')
      error.name = 'AbortError'
      throw error
    }

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex]
      const futureGroupCalls = groups.slice(groupIndex + 1).flatMap((item) => item.toolCalls)
      throwIfAborted([...group.toolCalls, ...futureGroupCalls])

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
          throwIfAborted([...pendingToolCalls, ...futureGroupCalls])
          const chunk = limitedToolCalls.slice(index, index + maxConcurrentTools)
          const settled = await Promise.allSettled(chunk.map((toolCall) =>
            this.executeToolCallWithRecovery(toolCall, params, startedToolCallIds)))
          const firstRejected = settled.find((item) => item.status === 'rejected')
          if (firstRejected?.status === 'rejected') {
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
        throwIfAborted([...remainingCurrentCalls, ...futureGroupCalls])
        const executedTool = await this.executeToolCallWithRecovery(limitedToolCalls[toolIndex], params, startedToolCallIds)
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
    },
    startedToolCallIds: string[],
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

    try {
      const rawResult = params.executeTool
        ? await params.executeTool(toolCall)
        : await this.executeDefaultToolCall(toolCall, params.context)
      const result = normalizeToolExecutionOutput(rawResult)
      params.hooks?.onToolResult?.({ toolCall, result })
      return {
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        result,
        recoveryHistory: [],
      }
    } catch (error) {
      const classified = classifyExecutionError(error, { source: 'tool_execution' })
      if (classified.kind === 'timeout_tool' || classified.kind === 'host_unavailable' || classified.kind === 'auth') {
        const recoveryHistory = [this.buildRecoveryRecord(classified as KnownExecutionErrorResult, 1, true)]
        const result = createToolExecutionOutput(classified.message, {
          shape: 'json',
          data: {
            errorKind: classified.kind,
            recovered: true,
            source: classified.source,
            toolName: toolCall.name,
          },
        })
        params.hooks?.onToolRecovered?.({ toolCall, result, recoveryHistory })
        params.hooks?.onToolResult?.({ toolCall, result })
        return {
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          result,
          recoveryHistory,
        }
      }
      throw error
    }
  }

  private resolvePreflightResult(
    toolName: string,
    options?: {
      context?: ToolRuntimeContext
      requireRegisteredTool?: boolean
    },
  ): ToolExecutionOutput | null {
    const allowedToolNames = options?.context?.allowedToolNames instanceof Set
      ? options.context.allowedToolNames
      : Array.isArray(options?.context?.allowedToolNames)
        ? new Set(options.context.allowedToolNames)
        : null

    if (allowedToolNames && !allowedToolNames.has(toolName)) {
      return createToolExecutionOutput(`Tool not allowed in current context: ${toolName}`, {
        shape: 'json',
        data: {
          errorKind: 'host_unavailable',
          toolName,
        },
      })
    }

    if (options?.requireRegisteredTool && !defaultToolGateway.getToolDefinition(toolName)) {
      return createToolExecutionOutput(`Unknown tool: ${toolName}`, {
        shape: 'json',
        data: {
          errorKind: 'host_unavailable',
          toolName,
        },
      })
    }

    return null
  }

  private async executeDefaultToolCall(
    toolCall: ParallelToolCall,
    context?: ToolRuntimeContext,
  ): Promise<ToolExecutionResultLike> {
    if (!context) {
      throw new Error(`Tool runtime context is required for ${toolCall.name}`)
    }
    const { executeToolCall } = await import('../tools/tool-executor')
    return await executeToolCall(toolCall.name, toolCall.input, toToolExecutorContext(context))
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
}
