import type { ToolPolicy } from './execution-tool-config'
import type { DomainAdapter, DomainAdapterApplyResult, DomainAdapterDispatchResult, DomainAdapterPrepareResult } from './domain-adapter'
import type { DocumentToolLoopState } from './document-tool-loop-orchestrator'
import type { DocumentChatSessionLike } from './document-domain-helpers'

interface DocumentDomainOrchestratorLike {
  tryDeterministicSectionFormatFlow: (params: {
    agentName: string
    userText: string
    toolContext: unknown
    onAssistantSummary?: (summary: string) => void
  }) => Promise<boolean>
  tryDeterministicSectionRewriteFlow: (params: {
    agentName: string
    session: DocumentChatSessionLike
    config: unknown
    baseUrl: string
    provider: unknown
    signal: AbortSignal
    isKimi: boolean
    isKimiCoding: boolean
    useAnthropicProtocol: boolean
    userText: string
    toolContext: unknown
    onAssistantSummary: (summary: string) => void
  }) => Promise<boolean>
}

interface DocumentToolLoopOrchestratorLike {
  createState: (initial?: Partial<DocumentToolLoopState>) => DocumentToolLoopState
  applyToolInspection: (state: DocumentToolLoopState, inspection: any) => DocumentToolLoopState
  handleNoToolCall: (params: {
    state: DocumentToolLoopState
    forceDocumentTool: boolean
    responseText?: string
    toolTransport?: 'native' | 'text'
  }) => {
    state: DocumentToolLoopState
    nextUserMessage?: string
    finalText?: string
    preserveAssistantText?: boolean
  }
  handleIterationResult: (params: {
    state: DocumentToolLoopState
    forceDocumentTool: boolean
    documentWidgetTaskKind?: string | null
    executedDocActionCount: number
    executedMutatingDocActionCount: number
    executedInspectionDocActionCount: number
    executedSaveDocActionCount: number
    documentToolResultsThisIteration: string[]
  }) => {
    state: DocumentToolLoopState
    nextUserMessage?: string
    completionText?: string
  }
  buildStructuredTaskPayload: (params: {
    taskTitle: string
    taskSummary: string
    state: DocumentToolLoopState
    phase: 'blocked' | 'done'
  }) => Record<string, unknown>
  getBudgetHint: (params: {
    forceDocumentTool: boolean
    state: DocumentToolLoopState
  }) => { maxIterations?: number; reserveToolCalls?: number } | null
}

interface DocumentAdapterState {
  toolLoopState: DocumentToolLoopState
  taskTitle: string
}

interface DocumentTaskPipelineExecutorLike {
  tryExecute: (params: {
    route: Parameters<DomainAdapter['dispatch']>[0]['route']
    executionIntentContext: Parameters<DomainAdapter['dispatch']>[0]['executionIntentContext']
    hasTools: boolean
    requestModuleToolAction?: Parameters<DomainAdapter['dispatch']>[0]['host']['requestModuleToolAction']
    signal: Parameters<DomainAdapter['dispatch']>[0]['request']['abortSignal']
    session: Parameters<DomainAdapter['dispatch']>[0]['session']
    providerContext: Parameters<DomainAdapter['dispatch']>[0]['host']['providerContext']
    emitStructuredTaskPayload: Parameters<DomainAdapter['dispatch']>[0]['emitStructuredTaskPayload']
    scopeId?: Parameters<DomainAdapter['dispatch']>[0]['request']['sessionId']
    parentTaskId?: Parameters<DomainAdapter['dispatch']>[0]['request']['taskId']
    parentRunId?: Parameters<DomainAdapter['dispatch']>[0]['request']['runId']
    toolPolicy: Parameters<DomainAdapter['dispatch']>[0]['toolPolicy']
    domainState?: unknown
  }) => Promise<{
    handled: boolean
    result?: DomainAdapterDispatchResult
  }>
}

function resolveDocumentTaskTitle(toolPolicy: ToolPolicy): string {
  if (toolPolicy.documentWidgetTaskKind) return '文档组件操作'
  if (toolPolicy.preferFormatOnly) return '文档格式优化'
  if (toolPolicy.preferSectionRewrite) return '章节改写'
  return '文档修改'
}

function buildUserMessage(content: string | null | undefined) {
  return content ? [{ role: 'user' as const, content }] : []
}

export class DocumentDomainAdapter implements DomainAdapter {
  readonly id = 'document'

  constructor(private readonly deps: {
    orchestrator: DocumentDomainOrchestratorLike
    toolLoopOrchestrator: DocumentToolLoopOrchestratorLike
    pipelineExecutor?: DocumentTaskPipelineExecutorLike
  }) {}

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'document'
  }

  prepare(params: Parameters<DomainAdapter['prepare']>[0]): DomainAdapterPrepareResult {
    const toolLoopState = this.deps.toolLoopOrchestrator.createState()
    return {
      budgetHint: this.deps.toolLoopOrchestrator.getBudgetHint({
        forceDocumentTool: params.toolPolicy.forceDocumentTool,
        state: toolLoopState,
      }),
      domainState: {
        toolLoopState,
        taskTitle: resolveDocumentTaskTitle(params.toolPolicy),
      } satisfies DocumentAdapterState,
    }
  }

  async dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): Promise<DomainAdapterDispatchResult> {
    const summaryRef = { value: '' }
    const toolContext = {
      browserController: params.host.browserController as never,
      sidecarManager: params.host.sidecarManager as never,
      runtime: params.host.runtime as never,
      scope: params.request.sessionId ? params.host.runtime?.getConversationScope?.(params.request.sessionId) : undefined,
      allowedToolNames: params.allowedToolNames || undefined,
      emitToolAction: (tool: string, args: Record<string, unknown>) => params.request.emitters.emitToolAction(tool, args),
      requestModuleToolAction: params.host.requestModuleToolAction,
      abortSignal: params.request.abortSignal,
      sessionId: params.request.sessionId,
      registerRunCleanup: (cleanup: () => void | Promise<void>) => {
        params.host.registerRunCleanup?.(cleanup)
      },
    }

    if (this.deps.pipelineExecutor) {
      const pipelineExecution = await this.deps.pipelineExecutor.tryExecute({
        route: params.route,
        executionIntentContext: params.executionIntentContext,
        hasTools: params.hasTools,
        requestModuleToolAction: params.host.requestModuleToolAction,
        signal: params.request.abortSignal,
        session: params.session,
        providerContext: params.host.providerContext,
        emitStructuredTaskPayload: params.emitStructuredTaskPayload,
        scopeId: params.request.sessionId,
        parentTaskId: params.request.taskId,
        parentRunId: params.request.runId,
        toolPolicy: params.toolPolicy,
        domainState: params.domainState,
      })
      if (pipelineExecution.handled) {
        return {
          ...(pipelineExecution.result || {}),
          domainState: pipelineExecution.result?.domainState ?? params.domainState,
        }
      }
    }

    if (params.hasTools && params.executionIntentContext.hasDocumentEnvironment && params.toolPolicy.forceDocumentTool && params.toolPolicy.preferFormatOnly) {
      const handled = await this.deps.orchestrator.tryDeterministicSectionFormatFlow({
        agentName: params.request.agentName,
        userText: params.userText,
        toolContext,
        onAssistantSummary: (summary: string) => {
          summaryRef.value = summary
        },
      })
      if (handled) {
        return {
          domainState: params.domainState,
          finalText: summaryRef.value || null,
          finish: {
            status: 'done',
            success: true,
          },
        }
      }
    }

    if (params.hasTools && params.executionIntentContext.hasDocumentEnvironment && params.toolPolicy.forceDocumentTool && params.toolPolicy.preferSectionRewrite) {
      const handled = await this.deps.orchestrator.tryDeterministicSectionRewriteFlow({
        agentName: params.request.agentName,
        session: params.session as DocumentChatSessionLike,
        config: params.host.providerContext.config,
        baseUrl: params.host.providerContext.baseUrl,
        provider: params.host.providerContext.provider,
        signal: params.request.abortSignal,
        isKimi: params.host.providerContext.isKimi,
        isKimiCoding: params.host.providerContext.isKimiCoding,
        useAnthropicProtocol: params.host.providerContext.useAnthropicProtocol,
        userText: params.userText,
        toolContext,
        onAssistantSummary: (summary: string) => {
          summaryRef.value = summary
        },
      })
      if (handled) {
        return {
          domainState: params.domainState,
          finalText: summaryRef.value || null,
          finish: {
            status: 'done',
            success: true,
          },
        }
      }
    }

    return {
      domainState: params.domainState,
    }
  }

  applyResult(params: Parameters<DomainAdapter['applyResult']>[0]): DomainAdapterApplyResult {
    let state = params.domainState as DocumentAdapterState
    if (params.phase === 'tool_batch') {
      for (const inspection of params.toolBatch?.documentToolInspections || []) {
        state = {
          ...state,
          toolLoopState: this.deps.toolLoopOrchestrator.applyToolInspection(state.toolLoopState, inspection),
        }
      }
      const decision = this.deps.toolLoopOrchestrator.handleIterationResult({
        state: state.toolLoopState,
        forceDocumentTool: params.toolPolicy.forceDocumentTool,
        documentWidgetTaskKind: params.toolPolicy.documentWidgetTaskKind || undefined,
        executedDocActionCount: params.toolBatch?.executedDocActionCount || 0,
        executedMutatingDocActionCount: params.toolBatch?.executedMutatingDocActionCount || 0,
        executedInspectionDocActionCount: params.toolBatch?.executedInspectionDocActionCount || 0,
        executedSaveDocActionCount: params.toolBatch?.executedSaveDocActionCount || 0,
        documentToolResultsThisIteration: params.toolBatch?.documentToolResultsThisIteration || [],
      })
      state = { ...state, toolLoopState: decision.state }
      if (decision.nextUserMessage) {
        return {
          domainState: state,
          nextUserMessage: decision.nextUserMessage,
          projection: {
            phase: 'blocked',
            summary: decision.nextUserMessage,
          },
        }
      }
      if (decision.completionText) {
        return {
          domainState: state,
          finalText: decision.completionText,
          projection: {
            phase: 'done',
            summary: decision.completionText,
          },
        }
      }
      return {
        domainState: state,
      }
    }

    if (params.phase === 'no_tool_call') {
      const decision = this.deps.toolLoopOrchestrator.handleNoToolCall({
        state: state.toolLoopState,
        forceDocumentTool: params.toolPolicy.forceDocumentTool,
        responseText: params.responseText || undefined,
        toolTransport: params.toolTransport,
      })
      state = { ...state, toolLoopState: decision.state }
      if (decision.nextUserMessage) {
        return {
          domainState: state,
          nextUserMessage: decision.nextUserMessage,
          preserveAssistantText: decision.preserveAssistantText,
          projection: {
            phase: 'blocked',
            summary: decision.nextUserMessage,
          },
        }
      }
      if (decision.finalText) {
        return {
          domainState: state,
          finalText: decision.finalText,
          projection: {
            phase: 'done',
            summary: decision.finalText,
          },
        }
      }
    }

    return {
      domainState: state,
    }
  }

  buildProjectionPatch(params: Parameters<DomainAdapter['buildProjectionPatch']>[0]): Record<string, unknown> | null {
    return this.deps.toolLoopOrchestrator.buildStructuredTaskPayload({
      taskTitle: (params.domainState as DocumentAdapterState).taskTitle,
      taskSummary: params.projection.summary,
      state: (params.domainState as DocumentAdapterState).toolLoopState,
      phase: params.projection.phase,
    })
  }
}
