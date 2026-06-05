import type { BrowserExecutionPreparation, BrowserToolLoopState } from './browser-domain-orchestrator'
import type { DomainAdapter, DomainAdapterApplyResult, DomainAdapterDispatchResult, DomainAdapterPrepareResult } from './domain-adapter'
import { resolveBrowserCollectionIntent } from '../../../../shared/browser-collection-intent'

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
  buildStructuredTaskPayload: (params: {
    decision: any
    state: BrowserToolLoopState
    phase: 'blocked' | 'done'
    summary: string
    blockedReason?: string | null
    waitingFor?: 'none' | 'input' | 'confirmation' | 'agent_result' | 'background' | 'clarification'
    resumableActions?: Array<'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'>
    recentEvidence?: string[] | null
  }) => Record<string, unknown>
}

interface BrowserAdapterState {
  preparedBrowserExecution: BrowserExecutionPreparation
  browserToolLoopState: BrowserToolLoopState
  recentEvidence: string[]
  liveInfoEnabled: boolean
}

interface SkillContextOrchestratorLike {
  findExplicitlyRequestedSkills?: (userText: string) => Array<{ skillId?: string }>
}

function buildUserMessage(content: string | null | undefined) {
  return content ? [{ role: 'user' as const, content }] : []
}

function isLiveInfoDecision(decision: BrowserExecutionPreparation['browserDecision']): boolean {
  return decision.reason === 'live_information_lookup'
    || /最新外部信息|最新结果页|最新信息/.test(String(decision.plan?.taskGoal || ''))
}

function normalizeBrowserEvidenceSnippet(toolName: string, resultText: string): string | null {
  const normalized = String(resultText || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  if (/^(Error:|Search failed|Page content is empty|Skipped duplicate)/i.test(normalized)) {
    return null
  }
  const limit = toolName === 'browser_read_page' ? 420 : toolName === 'browser_search' ? 320 : 220
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized
}

function hasNegatedBrowserLookupSignal(text: string): boolean {
  return /(不要|不用|无需|别|不必).{0,8}(查|搜索|搜|打开|浏览器|网页|网上|资料|评价)/.test(text)
    || /(不查|别查|不要查)(网页|网上|资料|评价)?/.test(text)
}

function matchesBrowserPromptTrigger(text: string): boolean {
  if (hasNegatedBrowserLookupSignal(text)) return false
  return /(上传|发送|提交|浏览器|网页)/i.test(text)
}

function mergeRecentEvidence(
  previous: string[],
  nextItems: Array<{ toolName: string; resultText: string }> | null | undefined,
): string[] {
  const merged = [...previous]
  for (const item of nextItems || []) {
    const snippet = normalizeBrowserEvidenceSnippet(item.toolName, item.resultText)
    if (!snippet) continue
    if (merged.includes(snippet)) continue
    merged.push(snippet)
  }
  return merged.slice(-6)
}

function buildProgressSummary(state: BrowserAdapterState, fallback?: string | null): string {
  if (fallback) return fallback
  const currentStep = state.browserToolLoopState.steps[state.browserToolLoopState.stepIndex]
  const latestEvidence = state.recentEvidence.at(-1)
  if (state.browserToolLoopState.stepIndex >= state.browserToolLoopState.steps.length) {
    return state.liveInfoEnabled
      ? '已完成网页核对，正在整理最终答复'
      : (latestEvidence || '已完成网页核对')
  }
  if (currentStep) {
    return latestEvidence ? `${currentStep.goal}：${latestEvidence}` : `正在执行：${currentStep.goal}`
  }
  return latestEvidence || '正在执行浏览器任务'
}

function buildLiveInfoSynthesisPrompt(params: {
  userText: string
  recentEvidence: string[]
}): string {
  return [
    '你现在只负责把浏览器已经核对到的网页事实，整理成最终回复。',
    '要求：',
    '1. 只能根据下面的网页证据回答，不要补充猜测。',
    '2. 不要复述步骤、工具、系统提醒或纠偏信息。',
    '3. 先直接回答用户问题，再补最关键的日期/时间/来源线索。',
    '4. 如果证据不足，就明确说证据不足，不要编造。',
    '',
    `用户问题：${params.userText}`,
    '',
    '网页证据：',
    ...params.recentEvidence.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n')
}

export class BrowserDomainAdapter implements DomainAdapter {
  readonly id = 'browser'

  constructor(private readonly orchestrator: BrowserDomainOrchestratorLike) {}

  contributePromptFragment(): ReturnType<DomainAdapter['contributePromptFragment']> {
    return [
      {
        // Collection-workflow guidance: when the user wants to collect a
        // blogger's notes (每篇建文件夹下载图片), tell the agent to dispatch
        // browser_collect_notes after gathering the list — otherwise it gathers
        // links with extract_structured and "completes" without starting the
        // background task. Higher priority than browser-upload + document-write
        // so the task is labelled as collection, not document rewrite.
        id: 'browser-collect-notes',
        label: '浏览器逐篇采集',
        priority: 60,
        matches: ({ userText }) => resolveBrowserCollectionIntent(userText),
        blocking: false,
        refs: [
          {
            path: 'docs/browser-collect-rules.md',
            title: '浏览器逐篇采集流程',
            summary: '收集笔记清单后必须调用 browser_collect_notes 启动后台逐篇采集',
          },
        ],
      },
      {
        id: 'browser-upload',
        label: '浏览器上传流程',
        priority: 50,
        matches: ({ userText }) => matchesBrowserPromptTrigger(userText),
        blocking: false,
        refs: [
          {
            path: 'docs/browser-rules.md',
            title: '浏览器工作流规则',
            summary: '浏览器上传、输入、发送的阶段规则',
          },
        ],
      },
    ]
  }

  arbitrateRunCapabilities(
    params: Parameters<DomainAdapter['arbitrateRunCapabilities']>[0],
  ): ReturnType<DomainAdapter['arbitrateRunCapabilities']> {
    const route = params.route
    if (!route || route.chain === 'direct') return null
    const domainState = (params as typeof params & { domainState?: BrowserAdapterState | null }).domainState
    const isBrowserTask = Boolean(domainState?.browserToolLoopState?.isBrowserTask)
    if (route.executor !== 'browser' && !isBrowserTask) return null
    return { hideAssistantProcessText: true }
  }

  decorateUserText(
    text: string,
    _params: Parameters<DomainAdapter['decorateUserText']>[1],
  ): string {
    return text
  }

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
      hasWidgetTargetContext: params.executionIntentContext.hasWidgetTargetContext,
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
        hasWidgetTargetContext: params.executionIntentContext.hasWidgetTargetContext,
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
        recentEvidence: [],
        liveInfoEnabled: isLiveInfoDecision(preparedBrowserExecution.browserDecision),
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
        projection: {
          phase: 'blocked',
          summary: executionDispatch.responseText,
          waitingFor: 'input',
          resumableActions: ['continue', 'cancel'],
          blockedReason: executionDispatch.responseText,
        },
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
        const interactionState = browserResult.state === 'partial' && /(人工|手动|验证码|接管)/.test(browserResult.message)
          ? 'human_takeover'
          : null
        return {
          sessionMessages,
          domainState: state,
          interactionState,
          finalText: browserResult.message,
          projection: browserResult.state === 'done'
            ? {
              phase: 'done',
              summary: browserResult.message,
              resumableActions: ['none'],
            }
            : {
              phase: 'blocked',
              summary: browserResult.message,
              waitingFor: interactionState === 'human_takeover' ? 'confirmation' : 'none',
              resumableActions: interactionState === 'human_takeover' ? ['continue', 'cancel'] : ['retry', 'cancel'],
              blockedReason: interactionState === 'human_takeover' ? browserResult.message : null,
            },
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
      projection: executionDispatch.kind === 'tool_loop'
        ? {
          phase: 'blocked',
          summary: buildProgressSummary(state, '已建立浏览器任务计划，开始分步执行'),
          waitingFor: 'none',
          resumableActions: ['cancel'],
          blockedReason: null,
        }
        : null,
    }
  }

  async applyResult(params: Parameters<DomainAdapter['applyResult']>[0]): Promise<DomainAdapterApplyResult> {
    const state = params.domainState as BrowserAdapterState
    if (params.phase === 'tool_batch' && (params.toolBatch?.executedBrowserToolsThisIteration || 0) > 0) {
      const progress = this.orchestrator.recordToolLoopProgress({
        state: state.browserToolLoopState,
        responseText: params.responseText,
        executedBrowserToolsThisIteration: params.toolBatch?.executedBrowserToolsThisIteration || 0,
      })
      const nextState = {
        ...state,
        browserToolLoopState: progress.state,
        recentEvidence: mergeRecentEvidence(state.recentEvidence, params.toolBatch?.browserToolResultsThisIteration),
      } satisfies BrowserAdapterState
      return {
        domainState: nextState,
        sessionMessages: buildUserMessage(progress.checkpointMessage),
        projection: {
          phase: 'blocked',
          summary: buildProgressSummary(nextState),
          waitingFor: 'none',
          resumableActions: ['cancel'],
          blockedReason: null,
        },
      }
    }

    if (params.phase === 'no_tool_call' && state.liveInfoEnabled && state.recentEvidence.length > 0) {
      const synthesisSession = {
        ...params.session,
        systemPrompt: `${params.session.systemPrompt}\n\n你当前只负责整理已核对的网页事实，不要输出工具过程。`,
        messages: [
          {
            role: 'user' as const,
            content: buildLiveInfoSynthesisPrompt({
              userText: params.userText,
              recentEvidence: state.recentEvidence,
            }),
          },
        ],
      }
      const synthesis = await params.host.requestSimpleText({
        session: synthesisSession,
        signal: params.request.abortSignal,
        providerContext: params.host.providerContext,
        timeoutMs: 20_000,
      })
      const finalText = String(synthesis.text || '').trim() || state.recentEvidence.at(-1) || '已完成网页查询'
      return {
        domainState: state,
        finalText,
        projection: {
          phase: 'done',
          summary: '已完成网页查询',
          waitingFor: 'none',
          resumableActions: ['none'],
          blockedReason: null,
        },
      }
    }

    if (params.phase === 'budget_limit') {
      const limitMessage = this.orchestrator.buildToolLoopLimitMessage(state.browserToolLoopState)
      return {
        domainState: state,
        sessionMessages: buildUserMessage(limitMessage),
        projection: {
          phase: 'blocked',
          summary: buildProgressSummary(state, limitMessage || '已达到本轮执行上限'),
          waitingFor: 'none',
          resumableActions: ['retry', 'cancel'],
          blockedReason: limitMessage || '已达到本轮执行上限',
        },
      }
    }

    return {
      domainState: state,
    }
  }

  buildProjectionPatch(params: Parameters<DomainAdapter['buildProjectionPatch']>[0]): Record<string, unknown> | null {
    const state = params.domainState as BrowserAdapterState
    return this.orchestrator.buildStructuredTaskPayload({
      decision: state.preparedBrowserExecution.browserDecision,
      state: state.browserToolLoopState,
      phase: params.projection.phase,
      summary: params.projection.summary,
      blockedReason: params.projection.blockedReason,
      waitingFor: params.projection.waitingFor,
      resumableActions: params.projection.resumableActions,
      recentEvidence: state.recentEvidence,
    })
  }
}
