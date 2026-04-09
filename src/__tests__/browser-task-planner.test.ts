import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BrowserTaskPlanner } from '../main/modules/agent-control/browser-task-planner'

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
})
