import { classifyExecutionError, type ErrorClassifierResult } from '../../claude-bridge/error-classifier'
import { buildRecoveryPlan } from '../../claude-bridge/recovery-router'
import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from './tool-error-metrics'
import { isTerminalInfrastructureError } from '../../tools/tool-errors'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentControlRuntime } from '../runtime'
import type { ConversationScope } from '../contracts/types'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { ToolDefinition } from './tool-definition'
import { defaultToolRegistry } from './tool-registry'
import type { AgentSpawnContext } from '../../../../shared/skill-host-contract'
import type { TurnFeatureFlags } from '../turn-feature-flags'
import {
  buildExplicitNoSkillAuthorization,
  type SkillToolAuthorization,
} from '../skills/skill-tool-authorization'
import type { RecoveryRecord, RunBudgetSeed, RunBudgetUsage, SkillRunContract } from '../contracts/run-contracts'
import { groupParallelSafeToolCalls, type ParallelToolCall } from './tool-parallelism-policy'
import {
  canUseParallelToolGroup,
  getBudgetUsagePercent,
  getBudgetWarningLevel,
  getRemainingToolCallBudget,
} from '../task-projection/run-budget-policy'
import type { ToolExecutionHooks } from './tool-execution-hooks'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
  type ToolExecutionResultLike,
} from './tool-result-types'
import { toToolExecutorContext } from './tool-runtime-context-builder'
import { resolveToolExecutionTimeoutMsForProfile } from '../../tools/tool-execution-timeout-policy'
import {
  buildToolNotAllowedMessage,
  buildUnknownToolMessage,
  normalizeAllowedToolSet,
} from '../../tools/tool-not-allowed-message'

/**
 * Phase 3 (skill-child-loop) — live, same-turn slice of the active TurnFrame
 * exposed to dependent later tools in the same batch. Where the durable
 * `framePatch` flows through the end-of-turn persistence path, this slot is
 * mutated by `applyContextModifier` immediately after each tool result is
 * normalized so the next dependent tool in the same iteration sees the fresh
 * artifact roots / handles without having to rebuild a TurnFrame.
 *
 * Shape is intentionally minimal in Phase 3 — only the three signals the
 * upcoming child runner needs:
 *   - `activeArtifactRoots`: read-only paths that `skill_read_artifact`
 *     should treat as additional allowed roots for the rest of the turn.
 *   - `runContract`: the latest `SkillRunContract` snapshot (or null) so
 *     consumers can check status / liveness without re-entering the loader.
 *   - `discoveredHandles`: opaque per-tool handle records (taskRunId,
 *     detachedTaskId, jobId, runStatePath, …) that later tools can read
 *     without the LLM having to repeat the discovery call.
 *
 * Always populated (never undefined). Empty defaults stand in when the
 * builder has no frame snapshot — see `tool-runtime-context-builder.ts`.
 */
export interface ToolRuntimeActiveFrameContext {
  activeArtifactRoots: string[]
  runContract: SkillRunContract | null
  discoveredHandles: Record<string, unknown>[]
}

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
  turnFeatureFlags?: TurnFeatureFlags
  /**
   * Phase 3 — same-turn live frame slot (see `ToolRuntimeActiveFrameContext`).
   * Mutated by `applyContextModifier` between tool calls within the same
   * batch. The end-of-turn persistence path (frame patch) is unchanged.
   */
  activeFrame: ToolRuntimeActiveFrameContext
  /**
   * Per-turn skill tool authorization (required).
   */
  authorization: SkillToolAuthorization
}

/**
 * Build the empty default `ToolRuntimeActiveFrameContext`. Used by the
 * context builder cold path and by `applyContextModifier` when the caller
 * passes a context lacking the slot (e.g. legacy tests).
 */
export function createEmptyActiveFrameContext(): ToolRuntimeActiveFrameContext {
  return {
    activeArtifactRoots: [],
    runContract: null,
    discoveredHandles: [],
  }
}

/**
 * Phase 3 — apply a tool result's `contextModifier.activeFrame` to the
 * runtime context's `activeFrame` slot, BEFORE the next dependent tool runs.
 *
 * Semantics:
 *   - `activeArtifactRoots`: union with existing list (deduplicated, order
 *     preserved by first appearance). New roots appended last.
 *   - `runContract`: last-write-wins; null leaves the existing contract.
 *   - `discoveredHandles`: appended.
 *
 * The mutation is in-place so downstream tools that read `context.activeFrame`
 * see the update without having to rebuild the runtime context.
 */
export function applyContextModifier(
  context: ToolRuntimeContext | null | undefined,
  output: ToolExecutionOutput | null | undefined,
): void {
  if (!context || !output) return
  const modifier = output.contextModifier
  if (!modifier || !modifier.activeFrame) return

  if (!context.activeFrame) {
    context.activeFrame = createEmptyActiveFrameContext()
  }

  const patch = modifier.activeFrame

  if (Array.isArray(patch.activeArtifactRoots) && patch.activeArtifactRoots.length > 0) {
    const seen = new Set<string>(context.activeFrame.activeArtifactRoots)
    for (const root of patch.activeArtifactRoots) {
      if (typeof root !== 'string') continue
      const trimmed = root.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      context.activeFrame.activeArtifactRoots.push(trimmed)
    }
  }

  if (patch.runContract !== undefined && patch.runContract !== null) {
    context.activeFrame.runContract = patch.runContract
  }

  if (Array.isArray(patch.discoveredHandles) && patch.discoveredHandles.length > 0) {
    for (const handle of patch.discoveredHandles) {
      if (handle && typeof handle === 'object' && !Array.isArray(handle)) {
        context.activeFrame.discoveredHandles.push(handle as Record<string, unknown>)
      }
    }
  }
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
            // Phase 3 (skill-child-loop) — apply any same-turn `contextModifier`
            // BEFORE recording the result, so a later parallel-group tool in
            // this batch sees fresh `activeFrame` state. Context-mutating
            // tools are serialized by `tool-parallelism-policy`, so within a
            // single parallel chunk the order is benign.
            applyContextModifier(params.context, item.value.result)
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
        // Phase 3 (skill-child-loop) — same-turn `contextModifier` is
        // applied to the runtime context BEFORE the next dependent tool runs
        // so the next iteration's tool sees the fresh `activeFrame` state
        // (e.g. VEA's outputDir as an additional read-only artifact root).
        applyContextModifier(params.context, executedTool.result)
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
      // Stage U PR U1.1 — top-level `tool_not_registered` (see tool-executor.ts).
      return createToolExecutionOutput(buildUnknownToolMessage(toolName), {
        shape: 'json',
        data: {
          errorKind: 'tool_not_registered',
          toolName,
        },
      })
    }

    // Stage 4 W3 — preflight skips `skill_*` allowedToolNames checks so
    // `authorization_denied` from `tool-executor` admission becomes the
    // canonical denial signal for skill tools (per v6 plan §10 互斥语义:
    // 非 skill 工具 → tool_restricted_this_turn; skill 工具 → authorization_denied).
    // Non-skill tools continue to go through the preflight allowedToolNames
    // checks below — preserving the legacy errorKind for everything else.
    const isSkillTool = toolName.startsWith('skill_')
    if (!isSkillTool) {
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
    const { executeToolCall } = await import('../../tools/tool-executor')
    return await executeToolCall(toolCall.name, toolCall.input, toToolExecutorContext(effectiveContext))
  }

  private createAttemptContext(
    context: ToolRuntimeContext | undefined,
    abortSignal: AbortSignal,
    batchCleanups: TrackedCleanup[],
  ): ToolRuntimeAttemptContext {
    const trackedCleanups: TrackedCleanup[] = []

    // Stage 10 invariant — if context is provided, authorization MUST be
    // present. Typecheck enforces this for production callers; this throw
    // catches `as any` / partial-context bypass paths (e.g. tests that
    // forgot to migrate post-Stage 10).
    if (context && !context.authorization) {
      throw new Error('Stage 10 invariant: ToolRuntimeContext provided to ToolRuntime.executeBatch without authorization — caller must populate authorization explicitly')
    }

    return {
      ...(context || {}),
      abortSignal,
      // Phase 3 — `activeFrame` is non-optional on `ToolRuntimeContext`; the
      // attempt context inherits the live slot if present and falls back to
      // an empty default for legacy callers that didn't seed one.
      activeFrame: context?.activeFrame ?? createEmptyActiveFrameContext(),
      // When context is provided, authorization is guaranteed by the
      // invariant above. When context is undefined (cold path: executeBatch
      // invoked without a runtime context), synthesize explicit no-skill
      // authorization so admission has a determinate value.
      authorization: context?.authorization ?? buildExplicitNoSkillAuthorization('no_skill_signal'),
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
