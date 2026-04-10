import type {
  BrowserPlanStep,
  BrowserTaskDecision,
  BrowserTaskPlanContinuity,
} from '../../../shared/browser-agent-task'
import type { RunBudgetHint } from './run-contracts'
import type { BrowserController } from '../browser-engine/ipc-handler'
import { BrowserAgentRunner, type BrowserAgentRunResult } from '../tools/browser-agent-runner'
import { BrowserTaskPlanner } from './browser-task-planner'

export interface BrowserExecutionPreparation {
  browserDecision: BrowserTaskDecision
  browserContinuity: BrowserTaskPlanContinuity | null
  browserContinuityInstruction: string | null
  clarifyText: string | null
  shouldInspectAmbiguousModeEntry: boolean
  canUseDeterministicBrowserRunner: boolean
}

export interface BrowserToolLoopState {
  isBrowserTask: boolean
  steps: BrowserPlanStep[]
  stepIndex: number
  browserToolCallCount: number
}

export interface BrowserToolLoopProgress {
  state: BrowserToolLoopState
  advancedStepIndex: number | null
  checkpointMessage: string | null
}

export interface BrowserExecutionDispatch {
  kind: 'none' | 'clarify' | 'deterministic' | 'tool_loop'
  continuityInstruction: string | null
  responseText: string | null
  toolLoopMessage: string | null
  fallbackLog: string | null
}

export class BrowserDomainOrchestrator {
  constructor(private readonly planner: BrowserTaskPlanner) {}

  createToolLoopState(decision: BrowserTaskDecision): BrowserToolLoopState {
    return {
      isBrowserTask: decision.mode === 'browser_workflow' || decision.mode === 'browser_upload_workflow',
      steps: decision.plan?.steps || [],
      stepIndex: 0,
      browserToolCallCount: 0,
    }
  }

  async prepareBrowserExecution(params: {
    hasTools: boolean
    browserControllerAvailable: boolean
    browserAgentEnabled: boolean
    userText: string
    pureUserInput: string
    sessionMessages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
    sessionId?: string
    refineDecision?: (decision: BrowserTaskDecision) => Promise<BrowserTaskDecision>
  }): Promise<BrowserExecutionPreparation> {
    let browserDecision = params.hasTools && params.browserControllerAvailable && params.browserAgentEnabled
      ? this.planner.decideTask({
        userText: params.pureUserInput,
        sessionMessages: params.sessionMessages,
        sessionId: params.sessionId,
      })
      : ({ mode: 'free_tool_loop', reason: 'browser_disabled' } as BrowserTaskDecision)

    if (params.hasTools && browserDecision.mode === 'browser_upload_workflow' && params.refineDecision) {
      browserDecision = await params.refineDecision(browserDecision)
    }

    const browserContinuity = params.hasTools && params.browserControllerAvailable && (browserDecision.mode === 'browser_upload_workflow' || browserDecision.mode === 'browser_workflow')
      ? await this.planner.buildContinuityContext({
        userText: params.userText,
        sessionId: params.sessionId,
        decision: browserDecision,
      })
      : null

    if (browserContinuity) {
      browserDecision = this.planner.applyContinuityToDecision(browserDecision, browserContinuity)
    }

    const clarifyText = params.hasTools && params.browserControllerAvailable && browserDecision.mode === 'clarify_first'
      ? this.planner.buildClarifyMessage(browserDecision)
      : null

    const shouldInspectAmbiguousModeEntry = this.planner.shouldInspectAmbiguousCreativeEntry(browserDecision.plan)
    const canUseDeterministicBrowserRunner =
      params.hasTools &&
      params.browserControllerAvailable &&
      this.planner.shouldUseDeterministicRunner(browserDecision)

    return {
      browserDecision,
      browserContinuity,
      browserContinuityInstruction: this.planner.buildContinuityInstruction(browserContinuity),
      clarifyText,
      shouldInspectAmbiguousModeEntry,
      canUseDeterministicBrowserRunner,
    }
  }

  recordToolLoopProgress(params: {
    state: BrowserToolLoopState
    responseText?: string | null
    executedBrowserToolsThisIteration: number
  }): BrowserToolLoopProgress {
    if (!params.state.isBrowserTask || params.executedBrowserToolsThisIteration <= 0) {
      return {
        state: params.state,
        advancedStepIndex: null,
        checkpointMessage: null,
      }
    }

    let stepIndex = params.state.stepIndex
    let browserToolCallCount = params.state.browserToolCallCount
    let advancedStepIndex: number | null = null

    if (params.responseText) {
      const stepCompleteMatch = params.responseText.match(/步骤\s*(\d+)\s*完成/)
      if (stepCompleteMatch) {
        const completedStep = parseInt(stepCompleteMatch[1], 10) - 1
        if (completedStep >= stepIndex && completedStep < params.state.steps.length) {
          stepIndex = completedStep + 1
          advancedStepIndex = stepIndex
        }
      }
    }

    browserToolCallCount += params.executedBrowserToolsThisIteration
    if (browserToolCallCount < 2 || stepIndex >= params.state.steps.length) {
      return {
        state: {
          ...params.state,
          stepIndex,
          browserToolCallCount,
        },
        advancedStepIndex,
        checkpointMessage: null,
      }
    }

    browserToolCallCount = 0
    const currentStep = params.state.steps[stepIndex]
    const nextStep = params.state.steps[stepIndex + 1]
    return {
      state: {
        ...params.state,
        stepIndex,
        browserToolCallCount,
      },
      advancedStepIndex,
      checkpointMessage: [
        `[系统检查点] 当前进度：`,
        currentStep ? `当前步骤: ${stepIndex + 1}/${params.state.steps.length} — ${currentStep.id}: ${currentStep.goal}` : '',
        currentStep ? `验证条件: ${currentStep.verify.join('；')}` : '',
        nextStep ? `下一步骤: ${nextStep.id}: ${nextStep.goal}` : '已是最后步骤',
        ``,
        `请确认当前步骤的验证条件是否已满足。如果满足，明确说"步骤 ${stepIndex + 1} 完成"并继续下一步。`,
        `如果未满足且还有重试机会，继续尝试。`,
        `如果未满足且无法继续，报告失败原因。`,
      ].filter(Boolean).join('\n'),
    }
  }

  buildToolLoopLimitMessage(state: BrowserToolLoopState): string | null {
    if (!state.isBrowserTask || state.stepIndex >= state.steps.length) {
      return null
    }
    return `[系统] 工具调用次数已达上限，但任务计划尚未完成到最后一步（当前在步骤 ${state.stepIndex + 1}/${state.steps.length}）。请总结当前进度和未完成的步骤。`
  }

  buildToolLoopMessage(decision: BrowserTaskDecision): string | null {
    return typeof (this.planner as { buildToolLoopInstruction?: unknown }).buildToolLoopInstruction === 'function'
      ? this.planner.buildToolLoopInstruction(decision)
      : null
  }

  getBudgetHint(params: {
    userText: string
    decision: BrowserTaskDecision
    baseMaxToolIterations: number
  }): RunBudgetHint | null {
    const recommended = this.getRecommendedToolLoopIterations(
      params.userText,
      params.decision,
      params.baseMaxToolIterations,
    )
    if (recommended <= params.baseMaxToolIterations) {
      return null
    }
    return { maxIterations: recommended }
  }

  resolveExecutionDispatch(params: {
    hasTools: boolean
    browserControllerAvailable: boolean
    browserDecision: BrowserTaskDecision
    browserContinuityInstruction?: string | null
    clarifyText: string | null
    canUseDeterministicBrowserRunner: boolean
    shouldInspectAmbiguousModeEntry: boolean
  }): BrowserExecutionDispatch {
    const continuityInstruction = params.browserContinuityInstruction || null
    if (params.clarifyText) {
      return {
        kind: 'clarify',
        continuityInstruction,
        responseText: params.clarifyText,
        toolLoopMessage: null,
        fallbackLog: null,
      }
    }

    if (params.canUseDeterministicBrowserRunner && params.browserControllerAvailable) {
      return {
        kind: 'deterministic',
        continuityInstruction,
        responseText: null,
        toolLoopMessage: null,
        fallbackLog: null,
      }
    }

    const shouldUseBrowserToolLoop =
      params.hasTools &&
      params.browserControllerAvailable &&
      (params.browserDecision.mode === 'browser_upload_workflow' || params.browserDecision.mode === 'browser_workflow')

    if (!shouldUseBrowserToolLoop) {
      return {
        kind: 'none',
        continuityInstruction,
        responseText: null,
        toolLoopMessage: null,
        fallbackLog: null,
      }
    }

    return {
      kind: 'tool_loop',
      continuityInstruction,
      responseText: null,
      toolLoopMessage: this.buildToolLoopMessage(params.browserDecision) || this.buildToolLoopFallbackMessage(params.browserDecision),
      fallbackLog:
        params.browserDecision.mode === 'browser_upload_workflow'
          ? params.shouldInspectAmbiguousModeEntry
            ? 'browserDecision mode=browser_upload_workflow fallback to tool loop because current page looks like a mode-selection entry'
            : 'browserDecision mode=browser_upload_workflow fallback to tool loop because target page is unresolved'
          : null,
    }
  }

  getRecommendedToolLoopIterations(
    userText: string,
    decision: BrowserTaskDecision,
    baseMaxToolIterations: number,
  ): number {
    return this.planner.getRecommendedMaxToolIterations(userText, decision, baseMaxToolIterations)
  }

  async refineUploadDecision(params: {
    decision: BrowserTaskDecision
    sessionId?: string
    userText: string
    explicitSkillRequested: boolean
    requestPromptDraft: (planningPrompt: string) => Promise<string>
    onRefineSkipped?: (reason: string) => void
  }): Promise<BrowserTaskDecision> {
    const basePlan = this.planner.rebuildPlan(params.decision, {
      sessionId: params.sessionId,
      userText: params.userText,
    })
    if (
      params.decision.mode !== 'browser_upload_workflow' ||
      !params.decision.promptIntent ||
      !params.decision.promptIntent.raw.trim() ||
      !this.planner.promptNeedsRefinement(params.decision, {
        explicitSkillRequested: params.explicitSkillRequested,
      })
    ) {
      return { ...params.decision, plan: basePlan }
    }

    try {
      const planningPrompt = this.planner.buildPromptRefinementRequest(params.decision.attachmentSelection?.latestName)
      const draft = await params.requestPromptDraft(planningPrompt)
      const parsed = this.planner.parsePromptDraft(draft)
      if (!parsed) {
        if (this.planner.promptNeedsRefinement(params.decision)) {
          const clarifiedDecision: BrowserTaskDecision = {
            ...params.decision,
            promptIntent: {
              ...params.decision.promptIntent,
              refined: '',
              confidence: 'low',
              source: params.decision.promptIntent.source || 'none',
            },
          }
          return {
            ...clarifiedDecision,
            plan: this.planner.rebuildPlan(clarifiedDecision, {
              sessionId: params.sessionId,
              userText: params.userText,
            }),
          }
        }
        return { ...params.decision, plan: basePlan }
      }

      const refinedDecision: BrowserTaskDecision = {
        ...params.decision,
        promptIntent: {
          raw: params.decision.promptIntent.raw,
          refined: parsed.prompt,
          confidence: parsed.confidence,
          source: 'model_refiner',
        },
      }
      return {
        ...refinedDecision,
        plan: this.planner.rebuildPlan(refinedDecision, {
          sessionId: params.sessionId,
          userText: params.userText,
        }),
      }
    } catch (error) {
      params.onRefineSkipped?.(error instanceof Error ? error.message : String(error))
      return { ...params.decision, plan: basePlan }
    }
  }

  async runDeterministicExecution(params: {
    browserController: BrowserController
    abortSignal: AbortSignal
    sessionId?: string
    decision: BrowserTaskDecision
    userText: string
    emitToolEvent: (type: string, text: string) => void
    createRunner?: () => { run: (userText: string) => Promise<BrowserAgentRunResult> }
  }): Promise<BrowserAgentRunResult> {
    const runner = params.createRunner
      ? params.createRunner()
      : new BrowserAgentRunner(params.browserController, {
        abortSignal: params.abortSignal,
        sessionId: params.sessionId,
        decision: params.decision,
        emitToolEvent: params.emitToolEvent,
    })
    return runner.run(params.userText)
  }

  private buildToolLoopFallbackMessage(decision: BrowserTaskDecision): string {
    return [
      '系统任务提示：当前任务已判定为浏览器操作任务。',
      `任务目标：${decision.plan?.taskGoal || '完成用户要求的网页操作'}`,
      `预期结果：${decision.plan?.expectedOutcome || '页面操作完成'}`,
      '',
      '重要原则：',
      '- 不要看到链接就立即导航，先确认是否需要',
      '- 上传附件前，先检查页面是否已有附件',
      '- 填写 prompt 前，先确认当前焦点或目标输入框确实正确',
      '- 提交前，确保附件和 prompt 都已就位，并优先复用与输入区相邻的发送控件',
      '- 如果没有稳定输入锚点，不要先点发送按钮',
      '- 不要点击历史记录的"重新生成"按钮',
    ].join('\n')
  }
}
