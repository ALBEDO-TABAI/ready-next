import type { ScopeRunMemoryCapture, ScopeRunEventPayload, ConversationScope } from './types'
import type {
  ExecutionHostRequest,
  ExecutionHostResult,
  PreparedRunPayload,
  ReflectionResultHook,
  RunCompletionHooks,
  RunCoordinatorRequest,
  RunCoordinatorResult,
  RunMessage,
  RunBudgetUsage,
} from './run-contracts'
import { createRunBudgetSeed } from './run-budget-policy'
import { buildExecutionFallbackState } from '../claude-bridge/execution-fallback-policy'

export class RunCoordinator {
  constructor(private readonly deps: {
    promptAssembly: {
      buildForScopedRun: (params: { scope: ConversationScope; message: RunMessage }) => Promise<PreparedRunPayload>
      applyToMessage: (message: RunMessage, prepared: PreparedRunPayload) => RunMessage
      recordRunOutcome: (payload: { scope: ConversationScope; finalText: string; usedTools: string[]; success: boolean }) => void
    }
    executeAndCollect: (request: ExecutionHostRequest) => Promise<ExecutionHostResult>
    emitScopeRunEvent: (payload: ScopeRunEventPayload) => void
    reflectOnConversation: (scope: ConversationScope, usedTools: string[]) => Promise<ScopeRunMemoryCapture | null>
  }) {}

  async runScoped(
    request: RunCoordinatorRequest,
    hooks?: RunCompletionHooks & ReflectionResultHook,
  ): Promise<RunCoordinatorResult> {
    return this.executeRun(request, hooks)
  }

  async runInboundChannel(
    request: RunCoordinatorRequest,
    hooks?: RunCompletionHooks & ReflectionResultHook,
  ): Promise<RunCoordinatorResult> {
    return this.executeRun(request, hooks)
  }

  private async executeRun(
    request: RunCoordinatorRequest,
    hooks?: RunCompletionHooks & ReflectionResultHook,
  ): Promise<RunCoordinatorResult> {
    const budget = request.budget || createRunBudgetSeed()
    const budgetState: RunBudgetUsage = {
      iterationsUsed: 0,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    }
    const prepared = await this.deps.promptAssembly.buildForScopedRun({
      scope: request.scope,
      message: request.message,
    })
    const messageWithBootstrap = this.deps.promptAssembly.applyToMessage(request.message, prepared)

    const planningTaskTitle = '正在理解需求'
    const planningTaskSummary = '正在整理任务边界、上下文与可用能力'

    this.deps.emitScopeRunEvent({
      type: 'started',
      scopeId: request.scope.id,
      agent: request.scope.agent,
      runId: request.requestId,
      phase: 'planning',
      module: undefined,
      latestText: planningTaskSummary,
      taskTitle: planningTaskTitle,
      taskSummary: planningTaskSummary,
      memoryRefs: prepared.memoryRefs,
      triggerHits: prepared.triggerHits,
      contextBudget: prepared.contextBudget,
      executionDiagnostics: {
        compression: prepared.compression || null,
        budget,
        fallback: buildExecutionFallbackState(null),
      },
      timestamp: new Date().toISOString(),
    })

    const result = await this.deps.executeAndCollect({
      agent: request.scope.agent,
      sessionId: request.scope.id,
      requestId: request.requestId,
      systemPrompt: prepared.systemPrompt,
      message: messageWithBootstrap,
      requestEnvelope: prepared.requestEnvelope,
      intentClassification: prepared.intentClassification,
      budget,
      budgetState,
    })

    this.deps.promptAssembly.recordRunOutcome({
      scope: request.scope,
      finalText: result.finalText,
      usedTools: result.usedTools,
      success: result.success,
    })

    this.deps.emitScopeRunEvent({
      type: 'updated',
      scopeId: request.scope.id,
      agent: request.scope.agent,
      runId: request.requestId,
      phase: result.cancelled ? 'cancelled' : result.success ? 'done' : 'error',
      executionDiagnostics: {
        compression: prepared.compression || null,
        budget: {
          ...budget,
          ...(result.budgetState || budgetState),
        },
        fallback: buildExecutionFallbackState(result.executionDiagnostics?.fallback || null),
      },
      timestamp: new Date().toISOString(),
    })

    if (!result.success) {
      await hooks?.onFailure?.(result.error || 'Agent execution failed', result)
      return { success: false, error: result.error || 'Agent execution failed' }
    }

    await hooks?.onSuccess?.(result)

    this.deps.reflectOnConversation(request.scope, result.usedTools)
      .then(async (memoryCapture) => {
        if (!memoryCapture || memoryCapture.items.length === 0) return
        this.deps.emitScopeRunEvent({
          type: 'updated',
          scopeId: request.scope.id,
          agent: request.scope.agent,
          runId: request.requestId,
          phase: 'done',
          taskSummary: `已记录 ${memoryCapture.items.length} 条常驻偏好/上下文`,
          memoryCapture,
          timestamp: new Date().toISOString(),
        })
        await hooks?.onMemoryCapture?.(memoryCapture)
      })
      .catch((error) => {
        console.error('[RunCoordinator] Reflection failed:', error)
      })

    return { success: true }
  }
}
