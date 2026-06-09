import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserTaskDecision } from '../shared/browser-agent-task'
import { BrowserDomainOrchestrator } from '../main/modules/agent-control/domain-adapters/browser-domain-orchestrator'
import { BrowserTaskPlanner } from '../main/modules/agent-control/domain-adapters/browser-task-planner'

function createDecision(): BrowserTaskDecision {
  return {
    mode: 'browser_upload_workflow',
    reason: 'needs_browser',
    promptIntent: {
      raw: '生成',
      refined: '生成',
      confidence: 'high',
      source: 'quoted',
    },
    plan: {
      taskKind: 'upload_generate',
      taskGoal: '上传素材并提交',
      expectedOutcome: '页面进入运行态',
      resources: { attachments: [], links: [] },
      attachmentIntent: { mode: 'none' },
      promptIntent: { raw: '生成', refined: '生成', confidence: 'high' },
      steps: [
        {
          id: 'resolve_target_page',
          goal: '确认目标页',
          action: '读页',
          verify: ['页面匹配'],
          skipIf: [],
          failIf: [],
          retryLimit: 1,
          recoverWith: [],
        },
        {
          id: 'ensure_upload',
          goal: '上传附件',
          action: '上传',
          verify: ['附件已挂载'],
          skipIf: [],
          failIf: [],
          retryLimit: 1,
          recoverWith: [],
        },
      ],
      requiredStages: ['resolve_target_page', 'ensure_upload'],
      completionCriteria: [],
      skipRules: [],
      successCriteria: [],
    },
  }
}

test('BrowserDomainOrchestrator does not advance steps from narration alone', () => {
  const orchestrator = new BrowserDomainOrchestrator({} as BrowserTaskPlanner)
  const initialState = orchestrator.createToolLoopState(createDecision())

  const progress = orchestrator.recordToolLoopProgress({
    state: initialState,
    responseText: '步骤 1 完成，继续下一步',
    executedBrowserToolsThisIteration: 2,
    browserToolResultsThisIteration: [],
  })

  assert.equal(progress.state.stepIndex, 0)
  assert.equal(progress.advancedStepIndex, null)
  assert.match(progress.checkpointMessage || '', /当前步骤: 1\/2 — resolve_target_page: 确认目标页/)
  assert.match(progress.checkpointMessage || '', /最近证据: 暂无可推进步骤的结构化证据/)
})

test('BrowserDomainOrchestrator advances steps from browser tool evidence', () => {
  const orchestrator = new BrowserDomainOrchestrator({} as BrowserTaskPlanner)
  const initialState = orchestrator.createToolLoopState(createDecision())

  const progress = orchestrator.recordToolLoopProgress({
    state: initialState,
    executedBrowserToolsThisIteration: 2,
    browserToolResultsThisIteration: [{
      toolName: 'browser_read_page_map',
      resultText: JSON.stringify({ pageIdentity: { url: 'https://example.com', generation: 1 } }),
    }],
  })

  assert.equal(progress.state.stepIndex, 1)
  assert.equal(progress.advancedStepIndex, 1)
  assert.match(progress.checkpointMessage || '', /当前步骤: 2\/2 — ensure_upload: 上传附件/)
  assert.match(progress.checkpointMessage || '', /最近证据: browser_read_page_map:page_observed/)
})

test('BrowserDomainOrchestrator builds limit reminder from current browser step', () => {
  const orchestrator = new BrowserDomainOrchestrator({} as BrowserTaskPlanner)
  const state = orchestrator.createToolLoopState(createDecision())

  const reminder = orchestrator.buildToolLoopLimitMessage(state)

  assert.match(reminder || '', /工具调用次数已达上限/)
  assert.match(reminder || '', /当前在步骤 1\/2/)
})

test('BrowserDomainOrchestrator delegates tool-loop plan text and iteration budget to planner', () => {
  const planner = {
    buildToolLoopInstruction: () => 'structured plan',
    getRecommendedMaxToolIterations: () => 33,
  } as unknown as BrowserTaskPlanner
  const orchestrator = new BrowserDomainOrchestrator(planner)

  const message = orchestrator.buildToolLoopMessage(createDecision())
  const budget = orchestrator.getRecommendedToolLoopIterations('上传素材', createDecision(), 20)

  assert.equal(message, 'structured plan')
  assert.equal(budget, 33)
})

test('BrowserDomainOrchestrator injects site experience as evidence-only hints', async () => {
  const decision = createDecision()
  const planner = {
    buildContinuityContext: async () => ({
      canReuseCurrentPage: true,
      reuseReason: 'same page',
      activePage: {
        url: 'https://example.com/shop/list',
        title: 'Example Shop',
        heading: '',
        selection: '',
        excerpt: '',
        capturedAt: Date.now(),
        domain: 'example.com',
      },
      rememberedWorkflow: null,
      recentSkill: null,
      recentActions: [],
      forcedRules: ['先复查当前页面证据'],
    }),
    applyContinuityToDecision: (value: BrowserTaskDecision) => value,
    buildContinuityInstruction: () => 'base continuity',
    shouldInspectAmbiguousCreativeEntry: () => false,
    shouldUseDeterministicRunner: () => false,
  } as unknown as BrowserTaskPlanner
  const store = {
    queryHints: () => [{
      id: 'hint-1',
      domain: 'example.com',
      riskLevel: 'medium' as const,
      confidence: 0.8,
      source: 'test-fixture' as const,
      hint: 'Use site-generated product links; content not found can be a soft 404.',
      lastVerifiedAt: '2026-06-09T00:00:00.000Z',
    }],
  }
  const orchestrator = new BrowserDomainOrchestrator(planner, store)

  const prepared = await orchestrator.prepareBrowserExecution({
    hasTools: true,
    browserControllerAvailable: true,
    browserAgentEnabled: true,
    userText: '打开商品页',
    pureUserInput: '打开商品页',
    sessionMessages: [],
    decision,
  })

  assert.match(prepared.browserContinuityInstruction || '', /站点经验提示/)
  assert.match(prepared.browserContinuityInstruction || '', /必须用当前页面地图/)
  assert.match(prepared.browserContinuityInstruction || '', /site-generated product links/)
})

test('BrowserDomainOrchestrator exposes budget hints for upload workflows without owning counters', () => {
  const planner = {
    getRecommendedMaxToolIterations: () => 36,
  } as unknown as BrowserTaskPlanner
  const orchestrator = new BrowserDomainOrchestrator(planner)

  const hint = orchestrator.getBudgetHint({
    userText: '上传素材并生成',
    decision: createDecision(),
    baseMaxToolIterations: 24,
  })

  assert.deepEqual(hint, { maxIterations: 36 })
})

test('BrowserDomainOrchestrator builds structured browser task payloads for running and done states', () => {
  const orchestrator = new BrowserDomainOrchestrator({} as BrowserTaskPlanner)
  const decision = createDecision()
  const state = {
    isBrowserTask: true,
    steps: decision.plan?.steps || [],
    stepIndex: 1,
    browserToolCallCount: 0,
  }

  const runningPayload = orchestrator.buildStructuredTaskPayload({
    decision,
    state,
    phase: 'blocked',
    summary: '正在核对上传结果',
    recentEvidence: ['附件已出现'],
  })
  const donePayload = orchestrator.buildStructuredTaskPayload({
    decision,
    state,
    phase: 'done',
    summary: '已完成网页任务',
    recentEvidence: ['附件已出现', '页面进入运行态'],
  })

  assert.equal(runningPayload.module, 'browser')
  assert.equal(runningPayload.currentStepId, 'ensure_upload')
  assert.equal(runningPayload.steps[0]?.status, 'done')
  assert.equal(runningPayload.steps[1]?.status, 'running')
  assert.deepEqual(runningPayload.recentEvidence, ['附件已出现'])

  assert.equal(donePayload.currentStepId, 'ensure_upload')
  assert.equal(donePayload.steps.every((step) => step.status === 'done'), true)
  assert.equal(donePayload.blockedReason, null)
  assert.deepEqual(donePayload.resumableActions, ['none'])
})

test('BrowserDomainOrchestrator refines upload decisions through planner callbacks', async () => {
  const planner = {
    rebuildPlan: (decision: BrowserTaskDecision) => ({ ...(decision.plan || {}), promptIntent: decision.promptIntent }),
    promptNeedsRefinement: () => true,
    buildPromptRefinementRequest: () => 'refine prompt',
    parsePromptDraft: () => ({ prompt: '更具体的提示词', confidence: 'high' }),
  } as unknown as BrowserTaskPlanner
  const orchestrator = new BrowserDomainOrchestrator(planner)

  const refined = await orchestrator.refineUploadDecision({
    decision: createDecision(),
    userText: '上传素材并生成',
    explicitSkillRequested: false,
    requestPromptDraft: async () => 'draft',
  })

  assert.equal(refined.promptIntent?.refined, '更具体的提示词')
  assert.equal(refined.promptIntent?.source, 'model_refiner')
})

test('BrowserDomainOrchestrator runs deterministic browser execution through injected runner', async () => {
  const orchestrator = new BrowserDomainOrchestrator({} as BrowserTaskPlanner)
  const events: Array<{ type: string; text: string }> = []

  const result = await orchestrator.runDeterministicExecution({
    browserController: {} as never,
    abortSignal: new AbortController().signal,
    sessionId: 'scope-1',
    decision: createDecision(),
    userText: '上传素材并提交',
    emitToolEvent: (type, text) => {
      events.push({ type, text })
    },
    createRunner: () => ({
      run: async () => ({
        handled: true,
        message: '浏览器任务已完成',
        state: 'done',
      }),
    }),
  })

  assert.equal(result.handled, true)
  assert.equal(result.message, '浏览器任务已完成')
  assert.equal(events.length, 0)
})

test('BrowserDomainOrchestrator resolves clarify and tool-loop dispatch actions', () => {
  const orchestrator = new BrowserDomainOrchestrator({} as BrowserTaskPlanner)

  const clarify = orchestrator.resolveExecutionDispatch({
    hasTools: true,
    browserControllerAvailable: true,
    browserDecision: { mode: 'clarify_first', reason: 'need_clarify' } as BrowserTaskDecision,
    clarifyText: '请先确认目标站点',
    canUseDeterministicBrowserRunner: false,
    shouldInspectAmbiguousModeEntry: false,
  })
  const toolLoop = orchestrator.resolveExecutionDispatch({
    hasTools: true,
    browserControllerAvailable: true,
    browserDecision: createDecision(),
    clarifyText: null,
    canUseDeterministicBrowserRunner: false,
    shouldInspectAmbiguousModeEntry: true,
  })

  assert.equal(clarify.kind, 'clarify')
  assert.equal(toolLoop.kind, 'tool_loop')
  assert.match(toolLoop.fallbackLog || '', /mode-selection entry/)
})
