import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { BrowserTaskPlanner } from '../main/modules/agent-control/browser-task-planner'
import {
  __resetSessionContinuityForTests,
  __setSessionContinuityStoragePathForTests,
  rememberBrowserWorkflowState,
} from '../main/modules/agent-control/session-continuity'

const TEST_CONTINUITY_PATH = join(tmpdir(), 'ready-browser-task-planner-continuity.json')

beforeEach(() => {
  __setSessionContinuityStoragePathForTests(TEST_CONTINUITY_PATH)
  __resetSessionContinuityForTests()
})

afterEach(() => {
  __resetSessionContinuityForTests()
  __setSessionContinuityStoragePathForTests(null)
  rmSync(TEST_CONTINUITY_PATH, { force: true })
})

function createPlanner() {
  return new BrowserTaskPlanner({
    getSessionAttachmentHints: () => ({ count: 1, latestName: 'poster.png' }),
    getIncomingAttachmentHints: () => ({ count: 1, latestName: 'poster.png' }),
    getActiveTab: () => ({
      id: 'tab-1',
      url: 'https://jimeng.example.com/workspace',
      title: '即梦工作台',
      domain: 'jimeng.example.com',
      active: true,
      owner: 'manual',
      required: false,
      activity: 'idle',
      lastAuditedAt: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
      favicon: null,
    }),
    getTabContext: async () => ({
      url: 'https://jimeng.example.com/workspace',
      title: '即梦工作台',
      heading: 'AI 创作',
      selection: '',
      excerpt: '图片生成工作区',
      capturedAt: Date.now(),
      domain: 'jimeng.example.com',
    }),
  })
}

function plannerAttachmentResource(name = 'poster.png') {
  return {
    attachmentId: `att-${name}`,
    name,
    type: 'image',
    mimeType: 'image/png',
    path: `/tmp/${name}`,
    createdAt: '2026-05-05T09:00:00.000Z',
  }
}

describe('BrowserTaskPlanner', () => {
  it('chooses upload workflow when attachment-based generation intent is present', () => {
    const planner = createPlanner()
    const decision = planner.decideTask({
      userText: '把刚发的图放到即梦里，提示词是“做一张温暖的美食海报”',
      sessionMessages: [],
      sessionId: 'scope-1',
    })

    assert.equal(decision.mode, 'browser_upload_workflow')
    assert.equal(decision.attachmentSelection?.latestName, 'poster.png')
    assert.equal(decision.promptIntent?.refined, '做一张温暖的美食海报')
  })

  it('asks for clarification when upload intent exists but no attachment is available', () => {
    const planner = new BrowserTaskPlanner({
      getSessionAttachmentHints: () => ({ count: 0 }),
      getIncomingAttachmentHints: () => ({ count: 0 }),
      getActiveTab: () => undefined,
      getTabContext: async () => null,
    })

    const decision = planner.decideTask({
      userText: '把刚发的图上传到即梦',
      sessionMessages: [],
      sessionId: 'scope-2',
    })

    assert.equal(decision.mode, 'clarify_first')
  })

  it('reads the detailed attachment resource list when building upload plans', () => {
    const planner = new BrowserTaskPlanner({
      getSessionAttachmentHints: () => ({ count: 0 }),
      getSessionAttachmentResourceList: () => ({
        ok: true,
        resources: [plannerAttachmentResource('detailed-poster.png')],
      }),
      getIncomingAttachmentHints: () => ({ count: 0 }),
      getActiveTab: () => undefined,
      getTabContext: async () => null,
    })

    const decision = planner.decideTask({
      userText: '把刚发的图上传到即梦，提示词是“做一张温暖的美食海报”',
      sessionMessages: [],
      sessionId: 'scope-detailed-attachments',
    })

    assert.equal(decision.mode, 'browser_upload_workflow')
    assert.equal(decision.attachmentSelection?.latestName, 'detailed-poster.png')
    assert.equal(decision.plan?.resources.attachments[0]?.attachmentId, 'att-detailed-poster.png')
  })

  it('does not treat db_error attachment resource failures as zero attachments', () => {
    const planner = new BrowserTaskPlanner({
      getSessionAttachmentHints: () => ({ count: 1, latestName: 'stale-hint.png' }),
      getSessionAttachmentResourceList: () => ({
        ok: false,
        reason: 'db_error',
        message: 'database unavailable',
      }),
      getIncomingAttachmentHints: () => ({ count: 0 }),
      getActiveTab: () => undefined,
      getTabContext: async () => null,
    })

    const decision = planner.decideTask({
      userText: '把刚发的图上传到即梦',
      sessionMessages: [],
      sessionId: 'scope-db-error',
    })

    assert.equal(decision.mode, 'clarify_first')
    assert.equal(decision.reason, 'attachment_resources_unavailable')
    assert.equal(decision.plan?.taskKind, 'clarify')
    assert.match(planner.buildClarifyMessage(decision), /附件资源暂时无法读取/)
  })

  it('does not treat fs_error attachment resource failures as zero attachments', () => {
    const planner = new BrowserTaskPlanner({
      getSessionAttachmentHints: () => ({ count: 1, latestName: 'stale-hint.png' }),
      getSessionAttachmentResourceList: () => ({
        ok: false,
        reason: 'fs_error',
        message: 'file unavailable',
      }),
      getIncomingAttachmentHints: () => ({ count: 0 }),
      getActiveTab: () => undefined,
      getTabContext: async () => null,
    })

    const decision = planner.decideTask({
      userText: '用刚发的图继续生成图片',
      sessionMessages: [],
      sessionId: 'scope-fs-error',
    })

    assert.equal(decision.mode, 'clarify_first')
    assert.equal(decision.reason, 'attachment_resources_unavailable')
  })

  it('preserves the legacy array attachment resource contract when detailed API is absent', () => {
    const planner = new BrowserTaskPlanner({
      getSessionAttachmentHints: () => ({ count: 1, latestName: 'legacy-poster.png' }),
      getSessionAttachmentResources: () => [plannerAttachmentResource('legacy-poster.png')],
      getIncomingAttachmentHints: () => ({ count: 0 }),
      getActiveTab: () => undefined,
      getTabContext: async () => null,
    })

    const decision = planner.decideTask({
      userText: '把刚发的图上传到即梦，提示词是“做一张温暖的美食海报”',
      sessionMessages: [],
      sessionId: 'scope-legacy-attachments',
    })

    assert.equal(decision.mode, 'browser_upload_workflow')
    assert.equal(decision.plan?.resources.attachments[0]?.name, 'legacy-poster.png')
  })

  it('reuses the current page when continuity says the current tab already matches the workflow target', async () => {
    const planner = createPlanner()
    const baseDecision = planner.decideTask({
      userText: '继续在即梦里生成',
      sessionMessages: [],
      sessionId: 'scope-3',
    })
    const continuity = await planner.buildContinuityContext({
      userText: '继续在即梦里生成',
      sessionId: 'scope-3',
      decision: baseDecision,
    })
    const applied = planner.applyContinuityToDecision(baseDecision, continuity)

    assert.equal(continuity?.canReuseCurrentPage, true)
    assert.match(applied.reason, /reuse_current_page/)
    assert.equal(Boolean(applied.plan?.continuity?.canReuseCurrentPage), true)
  })

  it('builds prompt refinement requests and parses prompt drafts', () => {
    const planner = createPlanner()
    const prompt = planner.buildPromptRefinementRequest('poster.png')
    const parsed = planner.parsePromptDraft('{"prompt":"做一张温暖的美食海报","confidence":"high"}')

    assert.match(prompt, /当前会话最新附件名：poster\.png/)
    assert.strictEqual(parsed?.prompt, '做一张温暖的美食海报')
    assert.strictEqual(parsed?.confidence, 'high')
  })

  it('provides clarify text and recommended browser iteration budgets', () => {
    const planner = createPlanner()
    const decision = planner.decideTask({
      userText: '把刚发的图放到即梦里，提示词是“做一张温暖的美食海报”',
      sessionMessages: [],
      sessionId: 'scope-1',
    })

    assert.match(planner.buildClarifyMessage({ mode: 'clarify_first', reason: 'missing_attachment', attachmentSelection: { count: 0 } }), /当前会话里还没有可用附件/)
    assert.strictEqual(planner.getRecommendedMaxToolIterations('继续在网页里生成图片', decision, 24), 24)
  })

  it('adds resume-oriented continuity guidance when recent browser workflow can continue', async () => {
    rememberBrowserWorkflowState('scope-resume', {
      url: 'https://jimeng.example.com/workspace',
      title: '即梦工作台',
      workflowKind: 'upload_generate',
      stage: 'submit',
      attachmentName: 'poster.png',
      promptPreview: '做一张温暖的美食海报',
      evidence: ['preview_visible', 'prompt_matched'],
      running: false,
      uploadMounted: true,
      promptFilled: true,
      status: 'failed',
      canResume: true,
      lastFailureReason: '页面未确认进入运行态',
    })

    const planner = createPlanner()
    const decision = planner.decideTask({
      userText: '继续刚才在即梦里的任务',
      sessionMessages: [],
      sessionId: 'scope-resume',
    })
    const continuity = await planner.buildContinuityContext({
      userText: '继续刚才在即梦里的任务',
      sessionId: 'scope-resume',
      decision,
    })

    assert.equal(continuity?.canReuseCurrentPage, true)
    assert.match(continuity?.reuseReason || '', /优先复用当前页/)
    assert.ok((continuity?.forcedRules || []).some((rule) => rule.includes('页面未确认进入运行态')))
    assert.equal(continuity?.rememberedWorkflow?.canResume, true)
    assert.equal(continuity?.rememberedWorkflow?.lastFailureReason, '页面未确认进入运行态')
  })

  it('does not reuse the current page when persisted continuity points to a different site', async () => {
    rememberBrowserWorkflowState('scope-other-site', {
      url: 'https://chatgpt.example.com/workspace',
      title: '其他站点',
      workflowKind: 'upload_generate',
      stage: 'submit',
      attachmentName: 'poster.png',
      promptPreview: '做一张温暖的美食海报',
      evidence: ['prompt_matched'],
      running: false,
      uploadMounted: true,
      promptFilled: true,
      status: 'failed',
      canResume: true,
      lastFailureReason: '站点已切走',
    })

    const planner = createPlanner()
    const decision = planner.decideTask({
      userText: '继续刚才在即梦里的任务',
      sessionMessages: [],
      sessionId: 'scope-other-site',
    })
    const continuity = await planner.buildContinuityContext({
      userText: '继续刚才在即梦里的任务',
      sessionId: 'scope-other-site',
      decision,
    })

    assert.equal(continuity?.canReuseCurrentPage, false)
    assert.match(continuity?.reuseReason || '', /关联不足/)
  })

  it('treats live info lookup requests as browser workflows and prepares a search query', () => {
    const planner = new BrowserTaskPlanner({
      getSessionAttachmentHints: () => ({ count: 0 }),
      getIncomingAttachmentHints: () => ({ count: 0 }),
      getActiveTab: () => undefined,
      getTabContext: async () => null,
    })

    const decision = planner.decideTask({
      userText: '帮我看看今天广州天气怎么样',
      sessionMessages: [],
      sessionId: 'scope-weather',
    })

    assert.equal(decision.mode, 'browser_workflow')
    assert.equal(decision.reason, 'live_information_lookup')
    assert.equal(decision.plan?.targetSearchQuery, '今天广州天气怎么样')
  })

  it('normalizes official-source follow-up phrasing into a cleaner search query', () => {
    const planner = new BrowserTaskPlanner({
      getSessionAttachmentHints: () => ({ count: 0 }),
      getIncomingAttachmentHints: () => ({ count: 0 }),
      getActiveTab: () => undefined,
      getTabContext: async () => null,
    })

    const decision = planner.decideTask({
      userText: '那你去中国气象台帮我看看',
      sessionMessages: [],
      sessionId: 'scope-weather-followup',
    })

    assert.equal(decision.mode, 'browser_workflow')
    assert.equal(decision.plan?.targetSearchQuery, '中国气象台')
  })

  it('does not flip to browser_workflow when the caller has bound a widget target, even if the user says weather/score words', () => {
    // When the user is modifying a specific widget (hasWidgetTargetContext=true),
    // live-info topic keywords in their instruction must never promote the run
    // to browser_workflow. Arbitration tables catch the tool-plan fallout but
    // not the adapter-level decision, so the short-circuit lives here as well.
    const planner = new BrowserTaskPlanner({
      getSessionAttachmentHints: () => ({ count: 0 }),
      getIncomingAttachmentHints: () => ({ count: 0 }),
      getActiveTab: () => undefined,
      getTabContext: async () => null,
    })

    const decision = planner.decideTask({
      userText: '把这张信息卡里最近的温度数据字号调大一点',
      sessionMessages: [],
      sessionId: 'scope-widget-weather',
      hasWidgetTargetContext: true,
    })

    assert.equal(decision.mode, 'free_tool_loop')
    assert.equal(decision.reason, 'no_browser_intent')
  })

  it('treats explicit site open requests as browser workflows even without a direct url', () => {
    const planner = new BrowserTaskPlanner({
      getSessionAttachmentHints: () => ({ count: 0 }),
      getIncomingAttachmentHints: () => ({ count: 0 }),
      getActiveTab: () => undefined,
      getTabContext: async () => null,
    })

    const decision = planner.decideTask({
      userText: '帮我打开 pinterest',
      sessionMessages: [],
      sessionId: 'scope-open-pinterest',
    })

    assert.equal(decision.mode, 'browser_workflow')
    assert.equal(decision.reason, 'generic_browser_workflow')
    assert.equal(decision.plan?.targetSearchQuery, 'Pinterest official website')
  })
})
