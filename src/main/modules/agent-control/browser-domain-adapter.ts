import type { BrowserExecutionPreparation, BrowserToolLoopState } from './browser-domain-orchestrator'
import type { DomainAdapter, DomainAdapterApplyResult, DomainAdapterDispatchResult, DomainAdapterPrepareResult } from './domain-adapter'

interface BrowserDomainOrchestratorLike {
  prepareBrowserExecution: (params: Record<string, unknown>) => Promise<BrowserExecutionPreparation>
  refineUploadDecision: (params: {
    decision: any
    sessionId?: string
    userText: string
    explicitSkillRequested: boolean
    requestPromptDraft: (planningPrompt: string) => Promise<string>
    onRefineSkipped?: (reason: string) => void
  }) => Promise<any>
  resolveExecutionDispatch: (params: Record<string, unknown>) => {
    kind: 'none' | 'clarify' | 'deterministic' | 'tool_loop'
    continuityInstruction: string | null
    responseText: string | null
    toolLoopMessage: string | null
    fallbackLog: string | null
  }
  runDeterministicExecution: (params: Record<string, unknown>) => Promise<{
    handled: boolean
    state: 'done' | 'failed' | 'cancelled' | 'partial'
    message: string
  }>
  createToolLoopState: (decision: unknown) => BrowserToolLoopState
  recordToolLoopProgress: (params: Record<string, unknown>) => {
    state: BrowserToolLoopState
    advancedStepIndex: number | null
    checkpointMessage: string | null
  }
  buildToolLoopLimitMessage: (state: BrowserToolLoopState) => string | null
  getBudgetHint: (params: Record<string, unknown>) => { maxIterations?: number; reserveToolCalls?: number } | null
}

interface BrowserAdapterState {
  preparedBrowserExecution: BrowserExecutionPreparation
  browserToolLoopState: BrowserToolLoopState
}

interface SkillContextOrchestratorLike {
  findExplicitlyRequestedSkills?: (userText: string) => Array<{ skillId?: string }>
}

function buildUserMessage(content: string | null | undefined) {
  return content ? [{ role: 'user' as const, content }] : []
}

export class BrowserDomainAdapter implements DomainAdapter {
  readonly id = 'browser'

  constructor(private readonly orchestrator: BrowserDomainOrchestratorLike) {}

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'browser' || params.route.executor === 'tool_loop' || params.route.executor === 'planner'
  }

  async prepare(params: Parameters<DomainAdapter['prepare']>[0]): Promise<DomainAdapterPrepareResult> {
    const initialPreparation = await this.orchestrator.prepareBrowserExecution({
      hasTools: params.hasTools,
      browserControllerAvailable: Boolean(params.host.browserController),
      browserAgentEnabled: params.host.isBrowserAgentV3Enabled(),
      userText: params.userText,
      pureUserInput: params.pureUserInput,
      sessionMessages: params.session.messages,
      sessionId: params.request.sessionId,
    })
    const skillContextOrchestrator = params.host.skillContextOrchestrator as SkillContextOrchestratorLike
    const explicitSkillRequested = (skillContextOrchestrator.findExplicitlyRequestedSkills?.(params.userText) || []).length > 0
    const refinedDecision = initialPreparation.browserDecision.mode === 'browser_upload_workflow'
      ? await this.orchestrator.refineUploadDecision({
        decision: initialPreparation.browserDecision,
        sessionId: params.request.sessionId,
        userText: params.userText,
        explicitSkillRequested,
        requestPromptDraft: async (planningPrompt: string) => {
          const refinementSession = {
            ...params.session,
            messages: [
              ...params.session.messages,
              { role: 'user' as const, content: planningPrompt },
            ],
          }
          const response = await params.host.requestSimpleText({
            session: refinementSession,
            signal: params.request.abortSignal,
            providerContext: params.host.providerContext,
            timeoutMs: 20_000,
          })
          return response.text || ''
        },
        onRefineSkipped: (reason: string) => {
          params.host.log(`browser prompt refinement skipped: ${reason}`)
        },
      })
      : initialPreparation.browserDecision
    const preparedBrowserExecution = refinedDecision === initialPreparation.browserDecision
      ? initialPreparation
      : await this.orchestrator.prepareBrowserExecution({
        hasTools: params.hasTools,
        browserControllerAvailable: Boolean(params.host.browserController),
        browserAgentEnabled: params.host.isBrowserAgentV3Enabled(),
        userText: params.userText,
        pureUserInput: params.pureUserInput,
        sessionMessages: params.session.messages,
        sessionId: params.request.sessionId,
        decision: refinedDecision,
      })

    return {
      budgetHint: this.orchestrator.getBudgetHint({
        userText: params.userText,
        decision: preparedBrowserExecution.browserDecision,
        baseMaxToolIterations: params.host.maxToolIterations,
      }),
      domainState: {
        preparedBrowserExecution,
        browserToolLoopState: this.orchestrator.createToolLoopState(preparedBrowserExecution.browserDecision),
      } satisfies BrowserAdapterState,
    }
  }

  async dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): Promise<DomainAdapterDispatchResult> {
    const state = params.domainState as BrowserAdapterState
    const executionDispatch = this.orchestrator.resolveExecutionDispatch({
      hasTools: params.hasTools,
      browserControllerAvailable: Boolean(params.host.browserController),
      browserDecision: state.preparedBrowserExecution.browserDecision,
      browserContinuityInstruction: state.preparedBrowserExecution.browserContinuityInstruction,
      clarifyText: state.preparedBrowserExecution.clarifyText,
      canUseDeterministicBrowserRunner: state.preparedBrowserExecution.canUseDeterministicBrowserRunner,
      shouldInspectAmbiguousModeEntry: state.preparedBrowserExecution.shouldInspectAmbiguousModeEntry,
    })

    if (executionDispatch.fallbackLog) {
      params.host.log(executionDispatch.fallbackLog)
    }

    const sessionMessages = [
      ...buildUserMessage(executionDispatch.continuityInstruction),
      ...(executionDispatch.kind === 'tool_loop' ? buildUserMessage(executionDispatch.toolLoopMessage) : []),
    ]

    if (executionDispatch.kind === 'clarify' && executionDispatch.responseText) {
      return {
        sessionMessages,
        domainState: state,
        interactionState: 'awaiting_clarification',
        finalText: executionDispatch.responseText,
        finish: {
          status: 'done',
          success: true,
        },
      }
    }

    if (executionDispatch.kind === 'deterministic' && params.host.browserController) {
      const browserResult = await this.orchestrator.runDeterministicExecution({
        browserController: params.host.browserController,
        abortSignal: params.request.abortSignal,
        sessionId: params.request.sessionId,
        decision: state.preparedBrowserExecution.browserDecision,
        userText: params.userText,
        emitToolEvent: (type: string, text: string) => {
          params.request.emitters.emitOutput(text, type)
        },
      })
      if (browserResult.handled) {
        return {
          sessionMessages,
          domainState: state,
          interactionState: browserResult.state === 'partial' && /(人工|手动|验证码|接管)/.test(browserResult.message)
            ? 'human_takeover'
            : null,
          finalText: browserResult.message,
          finish: {
            status: browserResult.state === 'failed'
              ? 'error'
              : browserResult.state === 'cancelled'
                ? 'cancelled'
                : 'done',
            success: browserResult.state !== 'failed',
            cancelled: browserResult.state === 'cancelled',
          },
        }
      }
    }

    return {
      sessionMessages,
      domainState: state,
    }
  }

  applyResult(params: Parameters<DomainAdapter['applyResult']>[0]): DomainAdapterApplyResult {
    const state = params.domainState as BrowserAdapterState
    if (params.phase === 'tool_batch' && (params.toolBatch?.executedBrowserToolsThisIteration || 0) > 0) {
      const progress = this.orchestrator.recordToolLoopProgress({
        state: state.browserToolLoopState,
        responseText: params.responseText,
        executedBrowserToolsThisIteration: params.toolBatch?.executedBrowserToolsThisIteration || 0,
      })
      return {
        domainState: {
          ...state,
          browserToolLoopState: progress.state,
        } satisfies BrowserAdapterState,
        sessionMessages: buildUserMessage(progress.checkpointMessage),
      }
    }

    if (params.phase === 'budget_limit') {
      return {
        domainState: state,
        sessionMessages: buildUserMessage(this.orchestrator.buildToolLoopLimitMessage(state.browserToolLoopState)),
      }
    }

    return {
      domainState: state,
    }
  }

  buildProjectionPatch(): Record<string, unknown> | null {
    return null
  }
}
