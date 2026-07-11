import type {
  BrowserPlanStep,
  BrowserTaskDecision,
  BrowserTaskProjectionPayload,
  BrowserTaskPlanContinuity,
} from '../../../../shared/browser-agent-task'
import type { BrowserSiteExperienceHint } from '../../../../shared/browser-site-experience'
import type { RunBudgetHint } from '../contracts/run-contracts'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import { BrowserAgentRunner, type BrowserAgentRunResult } from '../../tools/browser-agent-runner'
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

interface BrowserTaskEvidence {
  kind: 'page_observed' | 'page_target_matched' | 'upload_complete' | 'prompt_complete' | 'submit_confirmed'
  toolName: string
  summary: string
}

export interface BrowserExecutionDispatch {
  kind: 'none' | 'clarify' | 'deterministic' | 'tool_loop'
  continuityInstruction: string | null
  responseText: string | null
  toolLoopMessage: string | null
  fallbackLog: string | null
}

interface BrowserSiteExperienceStoreLike {
  queryHints(params: { url: string; taskKind?: string; highControlPlatform?: boolean }): BrowserSiteExperienceHint[]
}

function resolveBrowserTaskTitle(decision: BrowserTaskDecision): string {
  if (decision.reason === 'live_information_lookup') {
    return '最新信息查询'
  }
  if (decision.mode === 'browser_upload_workflow') {
    return decision.plan?.taskGoal || '浏览器上传流程'
  }
  return decision.plan?.taskGoal || '浏览器任务'
}

function resolveBrowserStepTitle(step: BrowserPlanStep): string {
  return String(step.goal || step.id || '执行步骤').trim()
}

function compactRecentEvidence(recentEvidence: string[] | null | undefined): string[] {
  const deduped: string[] = []
  for (const item of recentEvidence || []) {
    const normalized = String(item || '').replace(/\s+/g, ' ').trim()
    if (!normalized) continue
    if (deduped.includes(normalized)) continue
    deduped.push(normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized)
    if (deduped.length >= 4) break
  }
  return deduped
}

function parseToolJson(text: string): Record<string, unknown> | null {
  const trimmed = String(text || '').trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function isSuccessfulToolRecord(record: Record<string, unknown> | null): record is Record<string, unknown> {
  if (!record || record.ok === false || typeof record.errorKind === 'string') return false
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : ''
  return status !== 'error' && status !== 'failed'
}

function hasPositiveEvidenceValue(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasPositiveEvidenceValue)
  }
  return false
}

function recordHasPositiveEvidence(record: Record<string, unknown>, keys: RegExp): boolean {
  for (const [key, value] of Object.entries(record)) {
    if (keys.test(key) && hasPositiveEvidenceValue(value)) return true
    if (typeof value === 'string' && keys.test(value)) return true
    if (Array.isArray(value) && value.some((item) =>
      (typeof item === 'string' && keys.test(item)) ||
      (item && typeof item === 'object' && recordHasPositiveEvidence(item as Record<string, unknown>, keys))
    )) return true
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (recordHasPositiveEvidence(value as Record<string, unknown>, keys)) return true
    }
  }
  return false
}

function collectBrowserTaskEvidence(
  results: Array<{ toolName: string; resultText: string }> | null | undefined,
): BrowserTaskEvidence[] {
  const evidence: BrowserTaskEvidence[] = []
  for (const item of results || []) {
    const toolName = String(item.toolName || '')
    const resultText = String(item.resultText || '')
    if (!toolName || /^(Error:|Search failed|Page content is empty)/i.test(resultText.trim())) continue
    const parsed = parseToolJson(resultText)
    if (!isSuccessfulToolRecord(parsed)) continue
    if (toolName === 'browser_read_page_map' && parsed.pageIdentity) {
      evidence.push({ kind: 'page_observed', toolName, summary: 'page map captured' })
      if (recordHasPositiveEvidence(parsed, /^targetMatched$/i)) {
        evidence.push({ kind: 'page_target_matched', toolName, summary: 'target page matched' })
      }
      continue
    }
    if (toolName === 'browser_probe_readonly' && parsed.ok === true) {
      evidence.push({ kind: 'page_observed', toolName, summary: String(parsed.summary || 'readonly probe captured') })
      if (recordHasPositiveEvidence(parsed, /^targetMatched$/i)) {
        evidence.push({ kind: 'page_target_matched', toolName, summary: 'target page matched' })
      }
      if (recordHasPositiveEvidence(parsed, /^(input_has_files|attachment_name_matched|fileInput)$/i)) {
        evidence.push({ kind: 'upload_complete', toolName, summary: 'upload evidence in readonly probe' })
      }
      if (recordHasPositiveEvidence(parsed, /^(prompt_matched|prompt_filled)$/i)) {
        evidence.push({ kind: 'prompt_complete', toolName, summary: 'prompt/input evidence in readonly probe' })
      }
      if (recordHasPositiveEvidence(parsed, /^(submit_confirmed|running_state|page_processing_state)$/i)) {
        evidence.push({ kind: 'submit_confirmed', toolName, summary: 'post-submit state confirmed' })
      }
      continue
    }
    if (toolName === 'browser_upload_scope_attachment') {
      if (parsed.ok === true && recordHasPositiveEvidence(parsed, /^(input_has_files|attachment_name_matched|fileInput)$/i)) {
        evidence.push({ kind: 'upload_complete', toolName, summary: resultText.slice(0, 160) })
      }
      continue
    }
    if (toolName === 'browser_act_on_target' && parsed.ok === true && parsed.changed === true) {
      const action = String(parsed.action || '')
      if ((action === 'fill' || action === 'choose') && recordHasPositiveEvidence(parsed, /^(prompt_matched|prompt_filled)$/i)) {
        evidence.push({ kind: 'prompt_complete', toolName, summary: `target action ${action}` })
      }
      if (recordHasPositiveEvidence(parsed, /^(submit_confirmed|running_state|page_processing_state)$/i)) {
        evidence.push({ kind: 'submit_confirmed', toolName, summary: 'post-action submit state confirmed' })
      }
      continue
    }
    if (['browser_type', 'browser_type_smart', 'browser_compose_message'].includes(toolName)) {
      if (parsed.ok === true && recordHasPositiveEvidence(parsed, /^(prompt_matched|prompt_filled)$/i)) {
        evidence.push({ kind: 'prompt_complete', toolName, summary: resultText.slice(0, 160) })
      }
      continue
    }
    if (['browser_navigate', 'browser_search', 'browser_read_page'].includes(toolName)) {
      if (parsed.ok === true) {
        evidence.push({ kind: 'page_observed', toolName, summary: resultText.slice(0, 160) })
      }
    }
  }
  return evidence
}

function evidenceSatisfiesStep(step: BrowserPlanStep, evidence: BrowserTaskEvidence[]): boolean {
  if (evidence.length === 0) return false
  const text = `${step.id} ${step.goal} ${step.verify.join(' ')}`.toLowerCase()
  const has = (kind: BrowserTaskEvidence['kind']) => evidence.some((item) => item.kind === kind)
  if (/(resolve|target|match|确认目标|目标页|页面匹配)/i.test(text)) return has('page_target_matched')
  if (/(upload|attachment|file|附件|上传|素材|文件)/i.test(text)) return has('upload_complete')
  if (/(prompt|input|fill|提示词|输入|填写)/i.test(text)) return has('prompt_complete')
  if (/(submit|send|running|提交|发送|运行态|生成中)/i.test(text)) return has('submit_confirmed')
  if (/(navigate|page|页面|打开|进入)/i.test(text)) return has('page_observed')
  return false
}

export class BrowserDomainOrchestrator {
  constructor(
    private readonly planner: BrowserTaskPlanner,
    private readonly siteExperienceStore?: BrowserSiteExperienceStoreLike | null,
  ) {}

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
    hasWidgetTargetContext?: boolean
    decision?: BrowserTaskDecision
    refineDecision?: (decision: BrowserTaskDecision) => Promise<BrowserTaskDecision>
  }): Promise<BrowserExecutionPreparation> {
    let browserDecision = params.decision || (
      params.hasTools && params.browserControllerAvailable && params.browserAgentEnabled
        ? this.planner.decideTask({
          userText: params.pureUserInput,
          sessionMessages: params.sessionMessages,
          sessionId: params.sessionId,
          hasWidgetTargetContext: params.hasWidgetTargetContext,
        })
        : ({ mode: 'free_tool_loop', reason: 'browser_disabled' } as BrowserTaskDecision)
    )

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
      browserContinuityInstruction: this.buildContinuityAndSiteExperienceInstruction(browserContinuity, browserDecision),
      clarifyText,
      shouldInspectAmbiguousModeEntry,
      canUseDeterministicBrowserRunner,
    }
  }

  recordToolLoopProgress(params: {
    state: BrowserToolLoopState
    responseText?: string | null
    executedBrowserToolsThisIteration: number
    browserToolResultsThisIteration?: Array<{ toolName: string; resultText: string }> | null
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
    const evidence = collectBrowserTaskEvidence(params.browserToolResultsThisIteration)

    const stepUnderReview = params.state.steps[stepIndex]
    if (stepUnderReview && evidenceSatisfiesStep(stepUnderReview, evidence)) {
      stepIndex += 1
      advancedStepIndex = stepIndex
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
        evidence.length > 0 ? `最近证据: ${evidence.map((item) => `${item.toolName}:${item.kind}`).join('；')}` : '最近证据: 暂无可推进步骤的结构化证据',
        ``,
        `请用页面地图、只读探针或动作 readBack 复查当前步骤。`,
        `如果证据已满足，继续下一步；如果未满足且还有重试机会，换一条证据路径继续尝试。`,
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

  buildStructuredTaskPayload(params: {
    decision: BrowserTaskDecision
    state: BrowserToolLoopState
    phase: 'blocked' | 'done'
    summary: string
    blockedReason?: string | null
    waitingFor?: BrowserTaskProjectionPayload['waitingFor']
    resumableActions?: BrowserTaskProjectionPayload['resumableActions']
    recentEvidence?: string[] | null
  }): BrowserTaskProjectionPayload {
    const steps = (params.state.steps || []).map((step, index) => {
      let status: BrowserTaskProjectionPayload['steps'][number]['status'] = 'pending'
      if (params.phase === 'done') {
        status = 'done'
      } else if (index < params.state.stepIndex) {
        status = 'done'
      } else if (index === params.state.stepIndex) {
        status = 'running'
      }
      return {
        id: step.id,
        title: resolveBrowserStepTitle(step),
        status,
        updatedAt: new Date().toISOString(),
      }
    })

    const currentStepId = params.phase === 'done'
      ? steps[steps.length - 1]?.id || params.state.steps[params.state.stepIndex]?.id || null
      : steps[params.state.stepIndex]?.id || params.state.steps[params.state.stepIndex]?.id || null

    return {
      module: 'browser',
      taskTitle: resolveBrowserTaskTitle(params.decision),
      taskSummary: params.summary,
      steps,
      currentStepId,
      waitingFor: params.waitingFor || 'none',
      resumableActions: params.resumableActions || (params.phase === 'done' ? ['none'] : ['cancel']),
      recentArtifacts: [],
      blockedReason: params.phase === 'done' ? null : (params.blockedReason || null),
      recentEvidence: compactRecentEvidence(params.recentEvidence),
      message: params.summary,
    }
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

  private buildContinuityAndSiteExperienceInstruction(
    continuity: BrowserTaskPlanContinuity | null,
    decision: BrowserTaskDecision,
  ): string | null {
    const base = this.planner.buildContinuityInstruction(continuity)
    const targetUrl = continuity?.activePage?.url || decision.plan?.targetUrl || ''
    if (!targetUrl || !this.siteExperienceStore) return base
    let hints: BrowserSiteExperienceHint[] = []
    try {
      hints = this.siteExperienceStore.queryHints({
        url: targetUrl,
        taskKind: decision.plan?.taskKind,
      })
    } catch {
      // silent-catch: hints are optional enrichment — lookup failure degrades to none
      hints = []
    }
    if (hints.length === 0) return base
    const siteHint = [
      '## 站点经验提示',
      '以下内容只是 hint，必须用当前页面地图、只读探针或动作复查证据验证；不能降低高风控限制。',
      ...hints.slice(0, 4).map((hint, index) => `${index + 1}. ${hint.domain} risk=${hint.riskLevel} confidence=${hint.confidence.toFixed(2)} — ${hint.hint}`),
    ].join('\n')
    return [base, siteHint].filter(Boolean).join('\n\n')
  }
}
