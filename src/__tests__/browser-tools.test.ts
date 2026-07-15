import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { __resetBrowserAgentPageMapForTests } from '../main/modules/tools/browser-observe-tools'
import { __setBrowserCollectionConsentStoreForTests } from '../main/modules/tools/browser-collection-tools'
import { BrowserTaskPlanner } from '../main/modules/agent-control/domain-adapters/browser-task-planner'
import {
  __resetSessionContinuityForTests,
  __setSessionContinuityStoragePathForTests,
} from '../main/modules/agent-control/session/session-continuity'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type {
  BrowserCollectionConsentKind,
  BrowserCollectionConsentVia,
  PendingBrowserCollectionConsentRequest,
} from '../main/modules/browser-engine/browser-collection-consent'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/contracts/run-contracts'

const TEST_CONTINUITY_PATH = join(tmpdir(), 'ready-browser-tools-continuity.json')

function createConsentStoreMock() {
  const consents = new Set<string>()
  const pending = new Map<string, PendingBrowserCollectionConsentRequest>()
  const key = (kind: BrowserCollectionConsentKind, scopeId: string, sourceTaskId: string, host = '') => [kind, scopeId || 'global', sourceTaskId, host].join(':')
  return {
    hasConsent: (kind: BrowserCollectionConsentKind, scopeId: string, sourceTaskId: string, host = '') => consents.has(key(kind, scopeId, sourceTaskId, host)),
    readConsent: () => null,
    createPendingRequest: (input: {
      scopeId: string
      sourceTaskId: string
      consentKind: BrowserCollectionConsentKind
      targetHost?: string
      warningText?: string
      ttlMs?: number
    }) => {
      const request: PendingBrowserCollectionConsentRequest = {
        requestId: `browser-consent-test-${pending.size + 1}`,
        scopeId: input.scopeId,
        sourceTaskId: input.sourceTaskId,
        consentKind: input.consentKind,
        createdAt: new Date(0).toISOString(),
        ...(input.targetHost ? { targetHost: input.targetHost } : {}),
        ...(input.warningText ? { warningText: input.warningText } : {}),
      }
      pending.set(request.requestId, request)
      return request
    },
    readPendingRequest: (requestId: string) => pending.get(requestId) || null,
    confirmPendingRequest: (requestId: string, confirmedVia: BrowserCollectionConsentVia) => {
      const request = pending.get(requestId)
      if (!request) return null
      consents.add(key(request.consentKind, request.scopeId, request.sourceTaskId, request.targetHost || ''))
      return {
        scopeId: request.scopeId,
        sourceTaskId: request.sourceTaskId,
        consentKind: request.consentKind,
        targetHost: request.targetHost,
        warningText: request.warningText,
        confirmedVia,
        confirmedAt: new Date(0).toISOString(),
      }
    },
  } as never
}

function createRuntimeProjectionStore() {
  const records = new Map<string, TaskProjectionRecord>()
  const store: Pick<TaskProjectionStore, 'create' | 'update' | 'get'> = {
    create(record) {
      records.set(record.taskId, record)
    },
    update(taskId, patch) {
      const current = records.get(taskId)
      records.set(taskId, { ...(current as TaskProjectionRecord), ...patch })
    },
    get(taskId) {
      return records.get(taskId) || null
    },
  }
  return {
    records,
    runtime: {
      getTaskProjectionStore: () => store,
    },
  }
}

beforeEach(() => {
  __resetBrowserAgentPageMapForTests()
  __setSessionContinuityStoragePathForTests(TEST_CONTINUITY_PATH)
  __resetSessionContinuityForTests()
  __setBrowserCollectionConsentStoreForTests(createConsentStoreMock())
})

afterEach(() => {
  __resetBrowserAgentPageMapForTests()
  __resetSessionContinuityForTests()
  __setSessionContinuityStoragePathForTests(null)
  __setBrowserCollectionConsentStoreForTests(null)
  rmSync(TEST_CONTINUITY_PATH, { force: true })
})

type MockedController = Partial<BrowserController> & {
  calls: {
    normalized?: Array<{ x: number; y: number }>
    mouse: Array<Record<string, unknown>>
    key: Array<Record<string, unknown>>
    typed: Array<{ text: string; options?: { useShiftEnterForNewline?: boolean } }>
  }
}

// Browser tools migrated many failure / handle branches from JSON-string
// returns to structured ToolExecutionOutput (C09). parseTool reads either
// shape so a test asserting the JSON payload works regardless of which a
// branch returns (string -> parse; ToolExecutionOutput -> its .data / .text).
const rawJsonParse = JSON.parse.bind(JSON) as (text: string) => unknown
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseTool(out: unknown): any {
  if (typeof out === 'string') return rawJsonParse(out)
  if (out && typeof out === 'object') {
    const o = out as { data?: unknown; text?: unknown }
    if (o.data !== undefined && o.data !== null) return o.data
    if (typeof o.text === 'string') return rawJsonParse(o.text)
  }
  return rawJsonParse(String(out))
}

// Text form of a tool result for substring/regex assertions: the JSON string
// for a ToolExecutionOutput (whose .text carries the message field), or the
// raw string when a branch still returns a plain string.
function toolText(out: unknown): string {
  if (typeof out === 'string') return out
  if (out && typeof out === 'object' && 'text' in out) {
    const t = (out as { text?: unknown }).text
    if (typeof t === 'string') return t
  }
  return String(out)
}

function createControllerMock(overrides?: Partial<BrowserController>): BrowserController & MockedController {
  const calls = {
    normalized: [] as Array<{ x: number; y: number }>,
    mouse: [] as Array<Record<string, unknown>>,
    key: [] as Array<Record<string, unknown>>,
    typed: [] as Array<{ text: string; options?: { useShiftEnterForNewline?: boolean } }>,
  }

  const mock: MockedController = {
    calls,
    getTabList: () => [{ id: 'tab-1', title: 'Gemini', url: 'https://gemini.google.com', active: true }],
    createTab: async () => ({ success: true, tabId: 'tab-1' }),
    navigate: async () => ({ success: true }),
    normalizedToCss: async (_tabId, x, y) => {
      calls.normalized?.push({ x: Number(x), y: Number(y) })
      return { x: 120, y: 340, width: 1000, height: 800 }
    },
    dispatchMouse: async (_tabId, payload) => {
      calls.mouse.push(payload as unknown as Record<string, unknown>)
    },
    dispatchKey: async (_tabId, payload) => {
      calls.key.push(payload as unknown as Record<string, unknown>)
    },
    typeTextDirectly: async (_tabId, text, options) => {
      calls.typed.push({ text: String(text), options })
    },
    screenshotAdvanced: async () => 'base64-image',
    getViewportMetrics: async () => ({ width: 1000, height: 800, pageX: 0, pageY: 0, scale: 1 }),
    executeJS: async (_tabId, code) => {
      const source = String(code || '')
      if (source.includes('window.location.href')) return 'https://gemini.google.com/app'
      if (source.includes("document.readyState === 'interactive'")) return true
      if (source.includes('readyState') && source.includes('bodyTextLen')) {
        return { readyState: 'complete', bodyTextLen: 200, matched: true }
      }
      if (source.includes('out.sort((a, b) => b.score - a.score)')) {
        return [{ x: 520, y: 880, score: 99, reason: 'prompt textarea' }]
      }
      if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
        return { label: '', inputLabel: 'Prompt', password: false, editable: true }
      }
      if (source.includes('responseDetected')) {
        return {
          responseDetected: true,
          responseText: '今晚可以吃番茄牛肉面。',
          loginRequired: false,
          captchaRequired: false,
          editableCount: 2,
        }
      }
      if (source.includes('Smart target not found: no editable element')) {
        return 'Smart target not found: no editable element'
      }
      return null
    },
  }

  const baseExecuteJS = mock.executeJS
  Object.assign(mock, overrides || {})
  if (overrides?.executeJS) {
    const customExecuteJS = overrides.executeJS
    mock.executeJS = async (tabId, code) => {
      const result = await customExecuteJS(tabId, code)
      if (result !== null && result !== undefined) return result
      // Readiness-only fallthrough: settleAfterAction's real-timer waits
      // (waitForLoadingStop 8s + waitForReady 6s) otherwise burn wall-clock
      // (~28s per browser_click_text) when an override stubs only its own probe
      // and returns null for the page-readiness probes the default stubs.
      const source = String(code || '')
      if (source.includes("document.readyState === 'interactive'")) return true
      if (source.includes('readyState') && source.includes('bodyTextLen')) {
        return { readyState: 'complete', bodyTextLen: 200, matched: true }
      }
      return result
    }
  }

  return mock as BrowserController & MockedController
}

describe('browser-tools v2', () => {
  it('browser_read_page_map returns a generation, targets, and ambiguity groups', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_AGENT_PAGE_MAP__')) {
          return {
            identity: { url: 'https://example.com/form', title: 'Example Form' },
            viewport: { width: 1000, height: 800 },
            bodyText: 'Search Search',
            rawRoots: [
              {
                role: 'generic',
                // ≥5 目标：低于 5 会触发 D12 settle 重采（generation +1），
                // 本测试钉的是首采 generation/歧义组合同，不测重采。
                children: [
                  { role: 'button', name: 'Search', backendDOMNodeId: 1, frameId: '0' },
                  { role: 'button', name: 'Search', backendDOMNodeId: 2, frameId: '0' },
                  { role: 'textbox', name: 'Query', backendDOMNodeId: 3, frameId: '0' },
                  { role: 'button', name: 'Filler A', backendDOMNodeId: 4, frameId: '0' },
                  { role: 'button', name: 'Filler B', backendDOMNodeId: 5, frameId: '0' },
                ],
              },
            ],
            riskFlags: { fileInputCount: 0, externalLinkCount: 1 },
          }
        }
        return null
      },
    })

    const result = await executeBrowserTool('browser_read_page_map', {}, controller)
    const payload = parseTool(result) as {
      pageIdentity: { generation: number; title: string }
      pageMap: {
        targets: Array<{ targetId: string; name: string }>
        structureHints: { iframes: unknown[]; shadowRoots: unknown[]; hiddenLoaded: unknown[] }
      }
      ambiguityGroups: Array<{ name: string; targetIds: string[] }>
      riskFlags: { externalLinkCount?: number }
      evidence: { generation: number; targetSource: string; targetCount: number; truncated: boolean }
    }

    assert.strictEqual(payload.pageIdentity.generation, 1)
    assert.strictEqual(payload.pageIdentity.title, 'Example Form')
    assert.strictEqual(payload.pageMap.targets.length, 5)
    assert.strictEqual(payload.pageMap.targets[0]?.targetId, '1:0:1')
    assert.deepStrictEqual(payload.pageMap.structureHints, { iframes: [], shadowRoots: [], hiddenLoaded: [] })
    assert.strictEqual(payload.ambiguityGroups.length, 1)
    assert.strictEqual(payload.ambiguityGroups[0]?.name, 'Search')
    assert.deepStrictEqual(payload.ambiguityGroups[0]?.targetIds, ['1:0:1', '1:0:2'])
    assert.strictEqual(payload.riskFlags.externalLinkCount, 1)
    assert.deepStrictEqual(payload.evidence, {
      generation: 1,
      targetSource: 'dom-target-library',
      targetCount: 5,
      truncated: false,
    })
  })

  it('browser_probe_readonly requires a fresh page-map generation before probing', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_AGENT_PAGE_MAP__')) {
          return {
            identity: { url: 'https://example.com/form', title: 'Example Form' },
            viewport: { width: 1000, height: 800 },
            rawRoots: [{
              role: 'generic',
              children: [
                { role: 'textbox', name: 'Query', backendDOMNodeId: 1, frameId: '0' },
                { role: 'button', name: 'Filler A', backendDOMNodeId: 2, frameId: '0' },
                { role: 'button', name: 'Filler B', backendDOMNodeId: 3, frameId: '0' },
                { role: 'button', name: 'Filler C', backendDOMNodeId: 4, frameId: '0' },
                { role: 'button', name: 'Filler D', backendDOMNodeId: 5, frameId: '0' },
              ],
            }],
            riskFlags: {},
          }
        }
        if (source.includes('__READY_READONLY_PROBE__')) {
          return {
            ok: true,
            generation: 1,
            query: 'query',
            scope: 'forms',
            riskDecision: 'allowed',
            summary: 'scope=forms returned=1',
            counts: {
              totalCandidates: 1,
              returned: 1,
              hiddenLoaded: 0,
              forms: 1,
              fileInputs: 0,
              links: 0,
              media: 0,
              frames: 0,
              shadowRoots: 0,
            },
            nodes: [{ kind: 'input', text: 'Query', inputType: 'text' }],
            failureKind: null,
            nextAllowedActions: ['read map again'],
          }
        }
        return null
      },
    })

    const stale = await executeBrowserTool('browser_probe_readonly', { generation: 1, query: 'query', scope: 'forms' }, controller)
    const stalePayload = parseTool(stale) as { ok: boolean; errorCode: string }
    assert.strictEqual(stalePayload.ok, false)
    assert.strictEqual(stalePayload.errorCode, 'stale_page_map')

    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool('browser_probe_readonly', { generation: 1, query: 'query', scope: 'forms' }, controller)
    const payload = parseTool(result) as { ok: boolean; scope: string; nodes: Array<{ text: string }> }
    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.scope, 'forms')
    assert.strictEqual(payload.nodes[0]?.text, 'Query')
  })

  it('browser_act_on_target rejects a target that belongs to an ambiguity group without disambiguation', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_AGENT_PAGE_MAP__')) {
          return {
            identity: { url: 'https://example.com/form', title: 'Example Form' },
            viewport: { width: 1000, height: 800 },
            rawRoots: [
              {
                role: 'generic',
                children: [
                  { role: 'button', name: 'Search', backendDOMNodeId: 1, frameId: '0' },
                  { role: 'button', name: 'Search', backendDOMNodeId: 2, frameId: '0' },
                  { role: 'button', name: 'Filler A', backendDOMNodeId: 3, frameId: '0' },
                  { role: 'button', name: 'Filler B', backendDOMNodeId: 4, frameId: '0' },
                  { role: 'button', name: 'Filler C', backendDOMNodeId: 5, frameId: '0' },
                ],
              },
            ],
            riskFlags: {},
          }
        }
        if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
          return { matchCount: 1, disabled: false, target: { role: 'button', name: 'Search' } }
        }
        return null
      },
    })

    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool('browser_act_on_target', { target_id: '1:0:1', action: 'click' }, controller)
    const payload = parseTool(result) as { ok: boolean; errorCode: string; detail?: Record<string, unknown> }

    assert.strictEqual(payload.ok, false)
    assert.strictEqual(payload.errorCode, 'ambiguous_target')
    assert.deepStrictEqual(payload.detail?.ambiguityGroup, { role: 'button', name: 'Search', targetIds: ['1:0:1', '1:0:2'] })
  })

  it('browser_act_on_target requires a fresh page map and then performs a target action', async () => {
    const calls: string[] = []
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        calls.push(source)
        if (source.includes('__READY_AGENT_PAGE_MAP__')) {
          return {
            identity: { url: 'https://example.com/form', title: 'Example Form' },
            viewport: { width: 1000, height: 800 },
            rawRoots: [{
              role: 'generic',
              children: [
                { role: 'textbox', name: 'Query', backendDOMNodeId: 1, frameId: '0' },
                { role: 'button', name: 'Filler A', backendDOMNodeId: 2, frameId: '0' },
                { role: 'button', name: 'Filler B', backendDOMNodeId: 3, frameId: '0' },
                { role: 'button', name: 'Filler C', backendDOMNodeId: 4, frameId: '0' },
                { role: 'button', name: 'Filler D', backendDOMNodeId: 5, frameId: '0' },
              ],
            }],
            riskFlags: {},
          }
        }
        if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
          return { matchCount: 1, disabled: false, target: { role: 'textbox', name: 'Query' } }
        }
        if (source.includes('__READY_AGENT_ACT_ON_TARGET__')) {
          return { ok: true, action: 'fill', target: { role: 'textbox', name: 'Query' } }
        }
        if (source.includes('bodyText: String(document.body')) {
          return { url: 'https://example.com/form', title: 'Example Form', bodyText: 'filled' }
        }
        return null
      },
    })

    const stale = await executeBrowserTool('browser_act_on_target', { target_id: '1:0:1', action: 'fill', value: 'hello' }, controller)
    const stalePayload = parseTool(stale) as { ok: boolean; errorCode: string }
    assert.strictEqual(stalePayload.ok, false)
    assert.strictEqual(stalePayload.errorCode, 'stale_page_map')

    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool('browser_act_on_target', { target_id: '1:0:1', action: 'fill', value: 'hello' }, controller)
    const payload = parseTool(result) as { ok: boolean; action: string; readBack: string; changed: boolean; failureKind: string | null; result: { ok?: boolean } }

    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.action, 'fill')
    assert.strictEqual(payload.readBack, 'delta')
    assert.strictEqual(payload.changed, false)
    assert.strictEqual(payload.failureKind, null)
    assert.strictEqual(payload.result.ok, true)
    assert.ok(calls.some((source) => source.includes('__READY_AGENT_ACT_ON_TARGET__')))
  })

  // D18（真机第十二轮实锚，XHS 发布按钮 closed shadow root）：合成点击对
  // closed shadow 内部监听器不可达且回读 changed 恒真（delta vs map 形状
  // 必不同）。合同：click 判无效果 → 同一次调用内自动升级可信指针点击
  // （dispatchMouse 通道），升级点击与 browser_click_at 的破坏性闸门同构。
  it('browser_act_on_target escalates an ineffective click to a trusted pointer click', async () => {
    let deltaCalls = 0
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_AGENT_PAGE_MAP__')) {
          return {
            identity: { url: 'https://example.com/publish', title: 'Publish' },
            viewport: { width: 1000, height: 800 },
            rawRoots: [{
              role: 'generic',
              children: [
                { role: 'clickable', name: '发布', backendDOMNodeId: 1, frameId: '0' },
                { role: 'button', name: 'Filler A', backendDOMNodeId: 2, frameId: '0' },
                { role: 'button', name: 'Filler B', backendDOMNodeId: 3, frameId: '0' },
                { role: 'button', name: 'Filler C', backendDOMNodeId: 4, frameId: '0' },
                { role: 'button', name: 'Filler D', backendDOMNodeId: 5, frameId: '0' },
              ],
            }],
            riskFlags: {},
          }
        }
        if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
          return { matchCount: 1, disabled: false, target: { role: 'clickable', name: '发布' } }
        }
        if (source.includes('__READY_AGENT_ACT_ON_TARGET__')) {
          return {
            ok: true,
            action: 'click',
            target: { role: 'clickable', name: '发布' },
            clickPoint: { x: 500, y: 780, vw: 1000, vh: 800 },
          }
        }
        if (source.includes('bodyText: String(document.body')) {
          deltaCalls += 1
          return deltaCalls <= 2
            ? { url: 'https://example.com/publish', title: 'Publish', bodyText: 'form' }
            : { url: 'https://example.com/success', title: 'Done', bodyText: 'published' }
        }
        return null
      },
    })

    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool('browser_act_on_target', { target_id: '1:0:1', action: 'click' }, controller)
    const payload = parseTool(result) as {
      ok: boolean
      changed: boolean
      escalation?: { attempted?: boolean; mode?: string; changed?: boolean }
    }

    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.changed, true)
    assert.strictEqual(payload.escalation?.attempted, true)
    assert.strictEqual(payload.escalation?.mode, 'trusted_pointer')
    assert.strictEqual(payload.escalation?.changed, true)
    assert.ok(controller.calls.mouse.length >= 3, 'trusted pointer input must go through dispatchMouse')
    assert.deepStrictEqual(controller.calls.normalized?.[0], { x: 500, y: 975 })
  })

  // D18-b（第十三轮实锚）：动态页面（占位符轮换/轮播）让 delta 恒变，
  // changed:true 假信号压制升级。合同：closed/无 shadowRoot 的自定义 host
  // 无条件升级（合成点击对它必然 no-op，双击风险不存在）。
  it('browser_act_on_target force-escalates a closed-shadow host even when the page delta changed', async () => {
    let deltaCalls = 0
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_AGENT_PAGE_MAP__')) {
          return {
            identity: { url: 'https://example.com/publish', title: 'Publish' },
            viewport: { width: 1000, height: 800 },
            rawRoots: [{
              role: 'generic',
              children: [
                { role: 'clickable', name: '发布', backendDOMNodeId: 1, frameId: '0' },
                { role: 'button', name: 'Filler A', backendDOMNodeId: 2, frameId: '0' },
                { role: 'button', name: 'Filler B', backendDOMNodeId: 3, frameId: '0' },
                { role: 'button', name: 'Filler C', backendDOMNodeId: 4, frameId: '0' },
                { role: 'button', name: 'Filler D', backendDOMNodeId: 5, frameId: '0' },
              ],
            }],
            riskFlags: {},
          }
        }
        if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
          return { matchCount: 1, disabled: false, target: { role: 'clickable', name: '发布' } }
        }
        if (source.includes('__READY_AGENT_ACT_ON_TARGET__')) {
          return {
            ok: true,
            action: 'click',
            target: { role: 'clickable', name: '发布' },
            clickPoint: { x: 500, y: 780, vw: 1000, vh: 800, hostShadow: 'closed_or_none' },
          }
        }
        if (source.includes('bodyText: String(document.body')) {
          deltaCalls += 1
          // 每次 delta 都不同——模拟占位符轮换的动态页面
          return { url: 'https://example.com/publish', title: 'Publish', bodyText: `dyn-${deltaCalls}` }
        }
        return null
      },
    })

    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool('browser_act_on_target', { target_id: '1:0:1', action: 'click' }, controller)
    const payload = parseTool(result) as {
      ok: boolean
      escalation?: { attempted?: boolean; reason?: string }
    }

    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.escalation?.attempted, true)
    assert.strictEqual(payload.escalation?.reason, 'closed_shadow_host')
    assert.ok(controller.calls.mouse.length >= 3, 'closed-shadow host must always get the trusted pointer click')
  })

  it('browser_act_on_target does not escalate when the synthetic click already changed the page', async () => {
    let deltaCalls = 0
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_AGENT_PAGE_MAP__')) {
          return {
            identity: { url: 'https://example.com/publish', title: 'Publish' },
            viewport: { width: 1000, height: 800 },
            rawRoots: [{
              role: 'generic',
              children: [
                { role: 'button', name: '发布', backendDOMNodeId: 1, frameId: '0' },
                { role: 'button', name: 'Filler A', backendDOMNodeId: 2, frameId: '0' },
                { role: 'button', name: 'Filler B', backendDOMNodeId: 3, frameId: '0' },
                { role: 'button', name: 'Filler C', backendDOMNodeId: 4, frameId: '0' },
                { role: 'button', name: 'Filler D', backendDOMNodeId: 5, frameId: '0' },
              ],
            }],
            riskFlags: {},
          }
        }
        if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
          return { matchCount: 1, disabled: false, target: { role: 'button', name: '发布' } }
        }
        if (source.includes('__READY_AGENT_ACT_ON_TARGET__')) {
          return {
            ok: true,
            action: 'click',
            target: { role: 'button', name: '发布' },
            clickPoint: { x: 500, y: 780, vw: 1000, vh: 800 },
          }
        }
        if (source.includes('bodyText: String(document.body')) {
          deltaCalls += 1
          return deltaCalls === 1
            ? { url: 'https://example.com/publish', title: 'Publish', bodyText: 'form' }
            : { url: 'https://example.com/success', title: 'Done', bodyText: 'published' }
        }
        return null
      },
    })

    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool('browser_act_on_target', { target_id: '1:0:1', action: 'click' }, controller)
    const payload = parseTool(result) as { ok: boolean; changed: boolean; escalation?: unknown }

    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.changed, true)
    assert.strictEqual(payload.escalation, undefined)
    assert.strictEqual(controller.calls.mouse.length, 0)
  })

  it('browser_act_on_target escalation keeps the destructive-target gate loud', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_AGENT_PAGE_MAP__')) {
          return {
            identity: { url: 'https://example.com/checkout', title: 'Checkout' },
            viewport: { width: 1000, height: 800 },
            rawRoots: [{
              role: 'generic',
              children: [
                { role: 'clickable', name: '继续', backendDOMNodeId: 1, frameId: '0' },
                { role: 'button', name: 'Filler A', backendDOMNodeId: 2, frameId: '0' },
                { role: 'button', name: 'Filler B', backendDOMNodeId: 3, frameId: '0' },
                { role: 'button', name: 'Filler C', backendDOMNodeId: 4, frameId: '0' },
                { role: 'button', name: 'Filler D', backendDOMNodeId: 5, frameId: '0' },
              ],
            }],
            riskFlags: {},
          }
        }
        if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
          return { matchCount: 1, disabled: false, target: { role: 'clickable', name: '继续' } }
        }
        if (source.includes('__READY_AGENT_ACT_ON_TARGET__')) {
          return {
            ok: true,
            action: 'click',
            target: { role: 'clickable', name: '继续' },
            clickPoint: { x: 500, y: 780, vw: 1000, vh: 800 },
          }
        }
        // 升级点击的坐标探针发现点下真实覆盖着支付确认控件 → 闸门必须响。
        if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
          return { label: '确认支付', inputLabel: '', password: false, editable: false }
        }
        if (source.includes('bodyText: String(document.body')) {
          return { url: 'https://example.com/checkout', title: 'Checkout', bodyText: 'form' }
        }
        return null
      },
    })

    await executeBrowserTool('browser_read_page_map', {}, controller)
    await assert.rejects(
      executeBrowserTool('browser_act_on_target', { target_id: '1:0:1', action: 'click' }, controller),
      (error: unknown) => (error as { errorKind?: string }).errorKind === 'grant_required',
    )
    assert.strictEqual(controller.calls.mouse.length, 0, 'gated escalation must not dispatch mouse input')
  })

  // D18-c（真机第十四轮实锚）：closed shadow host 的包围盒横跨整个按钮组
  // （xhs-publish-btn 盖住「暂存离开」+「发布」），rect 中心落在两按钮之间
  // 死区，可信升级点击点空（css=(569,851) escalatedChanged=false）。合同：
  // 升级前经 CDP 组合树命中测试在 host rect 内扫描真实内部按钮，与 map
  // 目标名唯一匹配 → 点匹配按钮的坐标而不是 rect 中心。
  function createShadowScanControllerMock(opts: {
    targetName: string
    deltaAfterEscalation?: boolean
  }): ReturnType<typeof createControllerMock> {
    let deltaCalls = 0
    const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
    // host rect [400, 740]：左半是「暂存离开」按钮 [400,500)，中间 [500,570)
    // 是 host 空隙（rect 中心 570 恰在死区边缘），右侧 [570,740) 是「发布」。
    const zoneOf = (x: number): { id: number; text: string; tag: string; interactive: boolean; isHost: boolean } => {
      if (x < 500) return { id: 11, text: '暂存离开', tag: 'button', interactive: true, isHost: false }
      if (x < 570) return { id: 12, text: '', tag: 'xhs-publish-btn', interactive: false, isHost: true }
      return { id: 13, text: '发布', tag: 'button', interactive: true, isHost: false }
    }
    const describeByObject = new Map<string, Record<string, unknown>>()
    const controller = createControllerMock({
      sendCdpCommand: async (_tabId, method, params) => {
        cdpCalls.push({ method, params })
        if (method === 'DOM.getNodeForLocation') {
          const zone = zoneOf(Number(params?.x))
          describeByObject.set(`obj-${zone.id}-${params?.x}`, {
            tag: zone.tag, role: '', text: zone.text, interactive: zone.interactive, isHost: zone.isHost,
          })
          return { backendNodeId: zone.id * 1000 + Number(params?.x) }
        }
        if (method === 'DOM.resolveNode') {
          const backendNodeId = Number(params?.backendNodeId)
          const x = backendNodeId % 1000
          const id = Math.floor(backendNodeId / 1000)
          return { object: { objectId: `obj-${id}-${x}` } }
        }
        if (method === 'Runtime.callFunctionOn') {
          return { result: { value: describeByObject.get(String(params?.objectId)) ?? null } }
        }
        return {}
      },
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_AGENT_PAGE_MAP__')) {
          return {
            identity: { url: 'https://example.com/publish', title: 'Publish' },
            viewport: { width: 1000, height: 896 },
            rawRoots: [{
              role: 'generic',
              children: [
                { role: 'clickable', name: opts.targetName, backendDOMNodeId: 1, frameId: '0' },
                { role: 'button', name: 'Filler A', backendDOMNodeId: 2, frameId: '0' },
                { role: 'button', name: 'Filler B', backendDOMNodeId: 3, frameId: '0' },
                { role: 'button', name: 'Filler C', backendDOMNodeId: 4, frameId: '0' },
                { role: 'button', name: 'Filler D', backendDOMNodeId: 5, frameId: '0' },
              ],
            }],
            riskFlags: {},
          }
        }
        if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
          return { matchCount: 1, disabled: false, target: { role: 'clickable', name: opts.targetName } }
        }
        if (source.includes('__READY_AGENT_ACT_ON_TARGET__')) {
          return {
            ok: true,
            action: 'click',
            target: { role: 'clickable', name: opts.targetName },
            clickPoint: {
              x: 570, y: 862, vw: 1000, vh: 896,
              hostShadow: 'closed_or_none',
              rect: { left: 400, top: 840, width: 340, height: 44 },
            },
          }
        }
        if (source.includes('bodyText: String(document.body')) {
          deltaCalls += 1
          if (opts.deltaAfterEscalation !== false && deltaCalls >= 3) {
            return { url: 'https://example.com/success', title: 'Done', bodyText: 'published' }
          }
          return { url: 'https://example.com/publish', title: 'Publish', bodyText: 'form' }
        }
        return null
      },
    })
    ;(controller as unknown as { cdpCalls: typeof cdpCalls }).cdpCalls = cdpCalls
    return controller
  }

  it('browser_act_on_target escalation scans the closed-shadow host and clicks the name-matched inner button', async () => {
    const controller = createShadowScanControllerMock({ targetName: '发布' })
    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool('browser_act_on_target', { target_id: '1:0:1', action: 'click' }, controller)
    const payload = parseTool(result) as {
      ok: boolean
      changed: boolean
      escalation?: {
        attempted?: boolean
        via?: string
        clickNormalized?: { x: number; y: number }
        candidates?: Array<{ text: string }>
        changed?: boolean
      }
    }
    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.escalation?.attempted, true)
    assert.strictEqual(payload.escalation?.via, 'scan_name_match')
    assert.strictEqual(payload.escalation?.changed, true)
    assert.strictEqual(payload.changed, true)
    // 点击点必须落在「发布」按钮区 [570,740)，而不是 rect 中心 570 左侧的死区/暂存离开
    assert.ok((payload.escalation?.clickNormalized?.x ?? 0) >= 580,
      `escalated click must land inside the 发布 zone, got ${JSON.stringify(payload.escalation?.clickNormalized)}`)
    assert.ok(controller.calls.mouse.length >= 3, 'trusted pointer input must go through dispatchMouse')
    const lastNormalized = controller.calls.normalized?.at(-1)
    assert.ok((lastNormalized?.x ?? 0) >= 580, `dispatch must use the scanned point, got ${JSON.stringify(lastNormalized)}`)
  })

  it('browser_act_on_target escalation refuses a blind click when shadow candidates are ambiguous', async () => {
    // 真机第十四轮实态：map 名是 tag 回退 'xhs-publish-btn'（closed root 文本
    // 不可见），两个内部按钮都无法唯一匹配 → 宁可不点（点到「暂存离开」会
    // 毁掉发布流程），把候选连坐标交回模型。
    const controller = createShadowScanControllerMock({ targetName: 'xhs-publish-btn', deltaAfterEscalation: false })
    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool('browser_act_on_target', { target_id: '1:0:1', action: 'click' }, controller)
    const payload = parseTool(result) as {
      ok: boolean
      escalation?: {
        attempted?: boolean
        skipped?: string
        candidates?: Array<{ text: string; normalized?: { x: number; y: number } }>
        hint?: string
      }
    }
    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.escalation?.attempted, false)
    assert.strictEqual(payload.escalation?.skipped, 'ambiguous_shadow_candidates')
    const texts = (payload.escalation?.candidates || []).map((c) => c.text).sort()
    assert.deepStrictEqual(texts, ['发布', '暂存离开'].sort())
    assert.ok(payload.escalation?.candidates?.every((c) => Number.isFinite(c.normalized?.x)))
    assert.ok(String(payload.escalation?.hint || '').includes('browser_click_at'))
    assert.strictEqual(controller.calls.mouse.length, 0, 'ambiguous scan must not dispatch a blind click')
  })

  it('browser_act_on_target escalation resolves ambiguity via the disambiguation text', async () => {
    const controller = createShadowScanControllerMock({ targetName: 'xhs-publish-btn' })
    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool(
      'browser_act_on_target',
      { target_id: '1:0:1', action: 'click', disambiguation: '页面底部的发布按钮，最终提交' },
      controller,
    )
    const payload = parseTool(result) as {
      ok: boolean
      escalation?: { attempted?: boolean; via?: string; clickNormalized?: { x: number } }
    }
    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.escalation?.attempted, true)
    assert.strictEqual(payload.escalation?.via, 'scan_disambiguation_match')
    assert.ok((payload.escalation?.clickNormalized?.x ?? 0) >= 580)
  })

  it('browser_click_at should clamp normalized coordinates', async () => {
    const controller = createControllerMock()
    const result = await executeBrowserTool('browser_click_at', { x: -20, y: 1800 }, controller)
    const payload = parseTool(result) as { normalized: { x: number; y: number } }

    assert.strictEqual(payload.normalized.x, 0)
    assert.strictEqual(payload.normalized.y, 999)
    assert.ok(controller.calls.mouse.length >= 3)
  })

  it('browser_click_at fails closed when coordinate target probe throws', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
          throw new Error('probe crashed')
        }
        return null
      },
    })

    await assert.rejects(
      executeBrowserTool('browser_click_at', { x: 500, y: 500 }, controller),
      (error: unknown) => {
        assert.equal(error instanceof Error ? error.name : '', 'ToolDomainError')
        assert.match(error instanceof Error ? error.message : String(error), /无法确认坐标点击目标/)
        return true
      },
    )
    assert.equal(controller.calls.mouse.length, 0)
  })

  it('browser_click_at fails closed when coordinate point resolution throws', async () => {
    const controller = createControllerMock({
      normalizedToCss: async () => {
        throw new Error('point mapping crashed')
      },
    })

    await assert.rejects(
      executeBrowserTool('browser_click_at', { x: 500, y: 500 }, controller),
      (error: unknown) => {
        assert.equal(error instanceof Error ? error.name : '', 'ToolDomainError')
        assert.match(error instanceof Error ? error.message : String(error), /无法确认坐标点击目标/)
        return true
      },
    )
    assert.equal(controller.calls.mouse.length, 0)
  })

  it('browser_click_text should locate text with JS but click through trusted mouse events', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('const target = "笔记一"')) {
          return { ok: true, text: '笔记一', cssX: 500, cssY: 320, width: 1000, height: 800 }
        }
        return null
      },
    })
    const result = await executeBrowserTool('browser_click_text', { text: '笔记一' }, controller)
    const payload = parseTool(result) as { ok: boolean; normalized: { x: number; y: number } }

    assert.strictEqual(payload.ok, true)
    assert.deepStrictEqual(payload.normalized, { x: 500, y: 400 })
    assert.ok(controller.calls.mouse.length >= 3)
  })

  it('browser_click_text follows a newly opened active tab after the click', async () => {
    let tabs = [
      { id: 'tab-1', title: '小红书', url: 'https://www.xiaohongshu.com', active: true },
    ]
    let switchedTo: string | null = null
    let controller!: BrowserController & MockedController
    controller = createControllerMock({
      getTabList: () => tabs as never,
      switchTab: (tabId) => {
        switchedTo = tabId
        tabs = tabs.map((tab) => ({ ...tab, active: tab.id === tabId }))
        return { success: true, activeTabId: tabId }
      },
      dispatchMouse: async (_tabId, payload) => {
        controller.calls.mouse.push(payload as unknown as Record<string, unknown>)
        if ((payload as { type?: string }).type === 'mouseReleased') {
          tabs = [
            { id: 'tab-1', title: '小红书', url: 'https://www.xiaohongshu.com', active: false },
            { id: 'tab-2', title: '发布笔记', url: 'https://creator.xiaohongshu.com/publish/publish?source=official', active: true },
          ]
        }
      },
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('const target = "发布"')) {
          return { ok: true, text: '发布', cssX: 500, cssY: 320, width: 1000, height: 800 }
        }
        return null
      },
    })

    const result = await executeBrowserTool('browser_click_text', { text: '发布' }, controller)
    const payload = parseTool(result) as { followedTab?: { tabId: string; reason: string; url: string }; nextSuggestedAction?: string }

    assert.equal(payload.followedTab?.tabId, 'tab-2')
    assert.equal(payload.followedTab?.reason, 'new_tab')
    assert.match(payload.followedTab?.url || '', /creator\.xiaohongshu\.com\/publish/)
    assert.equal(payload.nextSuggestedAction, 'read map again on tab tab-2')
    assert.equal(switchedTo, 'tab-2')
  })

  it('browser_click reports and follows a new tab opened by a CSS click', async () => {
    let tabs = [
      { id: 'tab-1', title: '小红书', url: 'https://www.xiaohongshu.com', active: true },
    ]
    let switchedTo: string | null = null
    const controller = createControllerMock({
      getTabList: () => tabs as never,
      switchTab: (tabId) => {
        switchedTo = tabId
        tabs = tabs.map((tab) => ({ ...tab, active: tab.id === tabId }))
        return { success: true, activeTabId: tabId }
      },
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('document.querySelector("#publish")')) {
          tabs = [
            { id: 'tab-1', title: '小红书', url: 'https://www.xiaohongshu.com', active: false },
            { id: 'tab-2', title: '发布笔记', url: 'https://creator.xiaohongshu.com/publish/publish?source=official', active: true },
          ]
          return 'Clicked: BUTTON "发布"'
        }
        return null
      },
    })

    const result = await executeBrowserTool('browser_click', { selector: '#publish' }, controller)
    const payload = parseTool(result) as { ok?: boolean; followedTab?: { tabId: string; reason: string }; nextSuggestedAction?: string }

    assert.equal(payload.ok, true)
    assert.equal(payload.followedTab?.tabId, 'tab-2')
    assert.equal(payload.followedTab?.reason, 'new_tab')
    assert.equal(payload.nextSuggestedAction, 'read map again on tab tab-2')
    assert.equal(switchedTo, 'tab-2')
  })

  it('browser_click_text prefers the largest visible matching href when a card link marker is provided', async () => {
    let locateCode = ''
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('const target = "笔记一"')) {
          locateCode = source
          return { ok: true, text: 'card anchor', clickedDirect: false, cssX: 640, cssY: 360, width: 1000, height: 800 }
        }
        return null
      },
    })
    const result = await executeBrowserTool('browser_click_text', { text: '笔记一', href_contains: 'source-1' }, controller)
    const payload = parseTool(result) as { ok: boolean; clickedDirect: boolean; normalized: { x: number; y: number } }

    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.clickedDirect, false)
    assert.ok(locateCode.includes('hrefCandidates'))
    assert.ok(locateCode.includes("matched.setAttribute('target', '_self')"))
    assert.ok(locateCode.includes('.sort((a, b) => b.area - a.area)'))
    assert.deepStrictEqual(payload.normalized, { x: 640, y: 450 })
    assert.ok(controller.calls.mouse.length >= 3)
  })

  it('browser_capture_viewport returns recovery guidance when viewport metrics are zero', async () => {
    const controller = createControllerMock({
      getViewportMetrics: async () => ({ width: 0, height: 0, pageX: 0, pageY: 0, scale: 1 }),
    })

    const result = await executeBrowserTool('browser_capture_viewport', {}, controller)
    const payload = parseTool(result) as { width: number; height: number; warning?: string; nextSuggestedAction?: string }

    assert.equal(payload.width, 0)
    assert.equal(payload.height, 0)
    assert.equal(payload.warning, 'viewport_zero_or_hidden')
    assert.match(payload.nextSuggestedAction || '', /browser_power_cdp/)
    assert.match(payload.nextSuggestedAction || '', /Page\.getFrameTree/)
  })

  it('browser_collect_images filters images that are covered by a foreground detail layer', async () => {
    let collectCode = ''
    const controller = createControllerMock({
	      executeJS: async (_tabId, code) => {
	        const source = String(code || '')
	        if (source.includes("const imgs = queryAll('img')")) {
	          collectCode = source
	          return { images: [], videos: [], scope: 'xiaohongshu-detail' }
	        }
	        return null
	      },
	    })
	    const result = await executeBrowserTool('browser_collect_images', { include_hidden: false }, controller)
	    const payload = parseTool(result) as { count: number; scope?: string }

	    assert.equal(payload.count, 0)
	    assert.equal(payload.scope, 'xiaohongshu-detail')
	    assert.ok(collectCode.includes('elementFromPoint'))
	    assert.ok(collectCode.includes('isTopHit(img, rect)'))
	    assert.ok(collectCode.includes("querySelector('.note-container')"))
	    assert.ok(collectCode.includes("const imgs = queryAll('img')"))
	  })

  it('browser_collect_images keeps all Xiaohongshu carousel images inside the detail media scope', async () => {
    const dom = new JSDOM(`
      <div class="note-container">
        <div class="media-container">
          <img id="hero" src="https://sns-webpic-qc.xhscdn.com/notes_pre_post/hero!nc_n_webp_mw_1" />
          <div style="display:none">
            <img id="second" src="https://sns-webpic-qc.xhscdn.com/notes_pre_post/second!nc_n_webp_mw_1" />
          </div>
        </div>
        <div class="comments-container">
          <img id="comment" src="https://sns-webpic-qc.xhscdn.com/comment/comment-1!nc_n_webp_mw_1" />
        </div>
      </div>
      <img id="avatar" src="https://sns-avatar-qc.xhscdn.com/avatar/user.webp" />
    `, { url: 'https://www.xiaohongshu.com/explore/69f5db6300000000360185ba' })

    try {
      for (const img of Array.from(dom.window.document.querySelectorAll('img'))) {
        Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1200 })
        Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1600 })
        img.getBoundingClientRect = () => ({
          left: 0,
          top: 0,
          right: 600,
          bottom: 800,
          width: 600,
          height: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        })
      }

      const controller = createControllerMock({
        executeJS: async (_tabId, code) => dom.window.Function('code', 'with (this) { return eval(code) }').call(dom.window, String(code || '')),
      })
      const result = await executeBrowserTool('browser_collect_images', { include_hidden: false, limit: 10 }, controller)
      const payload = parseTool(result) as { count: number; scope?: string; images: Array<{ url: string }> }
      const urls = payload.images.map((item) => item.url)

      assert.equal(payload.scope, 'xiaohongshu-detail')
      assert.equal(payload.count, 2)
      assert.deepEqual(urls, [
        'https://sns-webpic-qc.xhscdn.com/notes_pre_post/hero!nc_n_webp_mw_1',
        'https://sns-webpic-qc.xhscdn.com/notes_pre_post/second!nc_n_webp_mw_1',
      ])
    } finally {
      dom.window.close()
    }
  })

  it('browser_collect_images reports Xiaohongshu carousel total when only the active image is loaded', async () => {
    const dom = new JSDOM(`
      <div class="note-container">
        <div class="media-container">
          <img id="hero" src="https://sns-webpic-qc.xhscdn.com/notes_pre_post/hero!nc_n_webp_mw_1" />
          <div class="swiper-pagination">1 / 10</div>
        </div>
      </div>
    `, { url: 'https://www.xiaohongshu.com/explore/69f5db6300000000360185ba' })

    try {
      const img = dom.window.document.querySelector('img') as HTMLImageElement
      Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1200 })
      Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1600 })
      img.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 600,
        bottom: 800,
        width: 600,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })

      const controller = createControllerMock({
        executeJS: async (_tabId, code) => dom.window.Function('code', 'with (this) { return eval(code) }').call(dom.window, String(code || '')),
      })
      const result = await executeBrowserTool('browser_collect_images', { include_hidden: false, limit: 20 }, controller)
      const payload = parseTool(result) as { count: number; expectedImageCount?: number; images: Array<{ url: string }> }

      assert.equal(payload.count, 1)
      assert.equal(payload.expectedImageCount, 10)
      assert.deepEqual(payload.images.map((item) => item.url), [
        'https://sns-webpic-qc.xhscdn.com/notes_pre_post/hero!nc_n_webp_mw_1',
      ])
    } finally {
      dom.window.close()
    }
  })

  it('browser_collect_images reports Xiaohongshu player-only details as videos', async () => {
    const dom = new JSDOM(`
      <div class="note-container">
        <div class="media-container">
          <div class="xgplayer video-player" poster="https://sns-webpic-qc.xhscdn.com/poster.webp"></div>
        </div>
      </div>
    `, { url: 'https://www.xiaohongshu.com/explore/69df5244000000001a02a0f8' })

    try {
      const player = dom.window.document.querySelector('.xgplayer') as HTMLElement
      player.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 600,
        bottom: 800,
        width: 600,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      const controller = createControllerMock({
        executeJS: async (_tabId, code) => dom.window.Function('code', 'with (this) { return eval(code) }').call(dom.window, String(code || '')),
      })
      const result = await executeBrowserTool('browser_collect_images', { include_hidden: false, limit: 10 }, controller)
      const payload = parseTool(result) as { count: number; videoCount: number; scope?: string; videos: Array<{ posterUrl?: string }> }

      assert.equal(payload.scope, 'xiaohongshu-detail')
      assert.equal(payload.count, 0)
      assert.equal(payload.videoCount, 1)
      assert.equal(payload.videos[0]?.posterUrl, 'https://sns-webpic-qc.xhscdn.com/poster.webp')
    } finally {
      dom.window.close()
    }
  })

  it('browser_collect_images extracts Xiaohongshu video URLs already exposed in page scripts', async () => {
    const dom = new JSDOM(`
      <div class="note-container">
        <div class="media-container">
          <div class="xgplayer video-player"></div>
        </div>
      </div>
      <script>
        window.__BOOT__ = {"asset":"https:\\\\/\\\\/fe-video-qc.xhscdn.com\\\\/fe-platform\\\\/app.js"};
        window.__INITIAL_STATE__ = {"video":{"media":{"stream":{"h264":[{"masterUrl":"https:\\\\/\\\\/sns-video.xhscdn.com\\\\/video.mp4?token=abc"}]}}}};
      </script>
    `, { url: 'https://www.xiaohongshu.com/explore/69df5244000000001a02a0f8' })

    try {
      const player = dom.window.document.querySelector('.xgplayer') as HTMLElement
      player.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 600,
        bottom: 800,
        width: 600,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      const controller = createControllerMock({
        executeJS: async (_tabId, code) => dom.window.Function('code', 'with (this) { return eval(code) }').call(dom.window, String(code || '')),
      })
      const result = await executeBrowserTool('browser_collect_images', { include_hidden: false, limit: 10 }, controller)
      const payload = parseTool(result) as { videoCount: number; videos: Array<{ url?: string }> }

      assert.equal(payload.videoCount, 1)
      assert.equal(payload.videos[0]?.url, 'https://sns-video.xhscdn.com/video.mp4?token=abc')
    } finally {
      dom.window.close()
    }
  })

  it('browser_resolve_video resolves a direct page video without external parsing', async () => {
    const controller = createControllerMock({
      getTabList: () => [{ id: 'tab-1', title: '视频页', url: 'https://www.xiaohongshu.com/explore/69df5244000000001a02a0f8', active: true }],
    })
    const result = await executeBrowserTool(
      'browser_resolve_video',
      {
        video_url: 'https://sns-video.xhscdn.com/video.mp4',
        poster_url: 'https://sns-webpic-qc.xhscdn.com/poster.webp',
        title: '视频笔记',
      },
      controller,
    )
    const payload = parseTool(result) as { ok: boolean; video: { parseStatus: string; downloadUrl?: string; posterUrl?: string; platform?: string } }

    assert.equal(payload.ok, true)
    assert.equal(payload.video.parseStatus, 'not_needed')
    assert.equal(payload.video.downloadUrl, 'https://sns-video.xhscdn.com/video.mp4')
    assert.equal(payload.video.posterUrl, 'https://sns-webpic-qc.xhscdn.com/poster.webp')
    assert.equal(payload.video.platform, 'xiaohongshu')
  })

  it('browser_type_at should clear, type and send enter by default', async () => {
    const controller = createControllerMock()
    const result = await executeBrowserTool('browser_type_at', { x: 500, y: 900, text: '今晚吃什么' }, controller)
    const payload = parseTool(result) as { submitted: boolean; text_length: number }

    assert.strictEqual(payload.submitted, true)
    assert.strictEqual(payload.text_length, 5)
    assert.ok(controller.calls.typed.some((item) => item.text === '今晚吃什么'))
    assert.ok(controller.calls.key.some((item) => String(item.key || '').toLowerCase() === 'backspace'))
    assert.ok(controller.calls.key.some((item) => String(item.key || '').toLowerCase() === 'enter'))
  })

  // D18-c（真机第十四轮实锚）：type_at 的聚焦点击落在死区时焦点滞留上一个
  // 控件/回落 body，旧实现照打不误——正文全文灌进 XHS 标题框，模型盲试
  // 4 分钟。合同：点击后焦点不可编辑 → 拒绝打字、响亮报告点到了什么。
  it('browser_type_at refuses to type when the focusing click lands on a non-editable spot', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
          return { label: '', inputLabel: '', password: false, editable: false, tag: 'div' }
        }
        if (source.includes('__READY_FOCUSED_EDITABLE_PROBE__')) {
          return { kind: 'none', tag: 'body', label: '', password: false }
        }
        return null
      },
    })
    const result = await executeBrowserTool('browser_type_at', { x: 525, y: 302, text: '今天天气不错' }, controller)
    const payload = parseTool(result) as {
      ok: boolean
      errorKind?: string
      focusTarget?: { kind?: string }
      message?: string
    }
    assert.strictEqual(payload.ok, false)
    assert.strictEqual(payload.errorKind, 'type_target_not_editable')
    assert.strictEqual(payload.focusTarget?.kind, 'none')
    assert.match(String(payload.message || ''), /归一化坐标/)
    assert.strictEqual(controller.calls.typed.length, 0, 'must not feed text into a stale-focus field')
    assert.ok(controller.calls.mouse.length >= 3, 'the focusing click itself already happened')
  })

  // D18-d（真机第十六轮实锚）：typedInto 只报不拒救不了模型的坐标微调循环
  // ——64 字上限的标题框收 500 字正文必须机械拒绝。
  it('browser_type_at refuses to feed long text into a capacity-limited field', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
          return { label: '', inputLabel: '输入标题', password: false, editable: true, tag: 'textarea' }
        }
        if (source.includes('__READY_FOCUSED_EDITABLE_PROBE__')) {
          return { kind: 'editable', tag: 'textarea', label: '输入标题', password: false, maxLength: 64, singleLine: false }
        }
        return null
      },
    })
    const longBody = '今天天气不错，' .repeat(40)
    const result = await executeBrowserTool('browser_type_at', { x: 500, y: 300, text: longBody }, controller)
    const payload = parseTool(result) as { ok: boolean; errorKind?: string; focusTarget?: { maxLength?: number }; message?: string }
    assert.strictEqual(payload.ok, false)
    assert.strictEqual(payload.errorKind, 'type_field_capacity_exceeded')
    assert.strictEqual(payload.focusTarget?.maxLength, 64)
    assert.match(String(payload.message || ''), /act fill/)
    assert.strictEqual(controller.calls.typed.length, 0, 'capacity refusal must not type')
  })

  it('browser_type_at refuses multiline text when focus is a single-line input', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
          return { label: '', inputLabel: '搜索', password: false, editable: true, tag: 'input' }
        }
        if (source.includes('__READY_FOCUSED_EDITABLE_PROBE__')) {
          return { kind: 'editable', tag: 'input', label: '搜索', password: false, maxLength: null, singleLine: true }
        }
        return null
      },
    })
    const result = await executeBrowserTool('browser_type_at', { x: 500, y: 300, text: '第一段\n\n第二段' }, controller)
    const payload = parseTool(result) as { ok: boolean; errorKind?: string }
    assert.strictEqual(payload.ok, false)
    assert.strictEqual(payload.errorKind, 'type_multiline_into_single_line')
    assert.strictEqual(controller.calls.typed.length, 0)
  })

  // D18-d：smart 评分器容量出局——上一轮它把 maxlength=64 的标题 textarea
  // (52.19 分) 排在正文 contenteditable 前，500 字正文灌进标题。JSDOM 真跑
  // 注入 JS 验证多段长文必须落 contenteditable。
  it('browser_type_smart routes multi-paragraph text past a capacity-limited textarea into the contenteditable editor', async () => {
    const dom = new JSDOM(`
      <div>
        <textarea placeholder="输入标题" maxlength="64"></textarea>
        <div id="editor" contenteditable="true" data-placeholder="输入文字，内容将自动保存"></div>
      </div>
    `, { url: 'https://creator.xiaohongshu.com/publish/publish' })
    try {
      for (const el of Array.from(dom.window.document.querySelectorAll('textarea, #editor'))) {
        ;(el as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
          left: 100, top: el.tagName === 'TEXTAREA' ? 100 : 200, right: 700, bottom: el.tagName === 'TEXTAREA' ? 160 : 600,
          width: 600, height: el.tagName === 'TEXTAREA' ? 60 : 400, x: 100, y: el.tagName === 'TEXTAREA' ? 100 : 200,
          toJSON: () => ({}),
        })
      }
      const controller = createControllerMock({
        executeJS: async (_tabId, code) => dom.window.Function('code', 'with (this) { return eval(code) }').call(dom.window, String(code || '')),
      })
      const body = '今天天气不错，风也刚好。\n\n中午云很干净。\n\n傍晚想散步。'
      const result = await executeBrowserTool('browser_type_smart', { target: '正文', text: body, press_enter: false }, controller)
      const text = toolText(result)
      assert.match(text, /Typed into smart target/)
      const editor = dom.window.document.querySelector('#editor') as { textContent?: string | null }
      const title = dom.window.document.querySelector('textarea') as HTMLTextAreaElement
      assert.ok(String(editor.textContent || '').includes('今天天气不错'), 'body must land in contenteditable')
      assert.strictEqual(String(title.value || ''), '', 'capacity-limited title textarea must stay untouched')
    } finally {
      dom.window.close()
    }
  })

  it('browser_type_at reports where the text actually landed (typedInto readback)', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
          return { label: '', inputLabel: '输入标题', password: false, editable: true, tag: 'textarea' }
        }
        if (source.includes('__READY_FOCUSED_EDITABLE_PROBE__')) {
          return { kind: 'editable', tag: 'textarea', label: '输入标题', password: false }
        }
        if (source.includes('__READY_TYPED_INTO_PROBE__')) {
          return { tag: 'textarea', label: '输入标题', password: false, textHead: '今天天气不错', textLength: 6 }
        }
        return null
      },
    })
    const result = await executeBrowserTool('browser_type_at', { x: 500, y: 300, text: '今天天气不错', press_enter: false }, controller)
    const payload = parseTool(result) as {
      ok: boolean
      focusTarget?: { kind?: string; label?: string }
      typedInto?: { label?: string; textHead?: string }
    }
    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.focusTarget?.kind, 'editable')
    assert.strictEqual(payload.typedInto?.label, '输入标题')
    assert.strictEqual(payload.typedInto?.textHead, '今天天气不错')
    assert.ok(controller.calls.typed.some((item) => item.text === '今天天气不错'))
  })

  it('browser_type_at fails closed when coordinate target probe throws', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
          throw new Error('probe crashed')
        }
        return null
      },
    })

    await assert.rejects(
      executeBrowserTool('browser_type_at', { x: 500, y: 500, text: 'secret' }, controller),
      (error: unknown) => {
        assert.equal(error instanceof Error ? error.name : '', 'ToolDomainError')
        assert.match(error instanceof Error ? error.message : String(error), /无法确认坐标输入目标/)
        return true
      },
    )
    assert.equal(controller.calls.mouse.length, 0)
    assert.equal(controller.calls.typed.length, 0)
  })

  it('browser_type_at fails closed when coordinate point resolution throws', async () => {
    const controller = createControllerMock({
      normalizedToCss: async () => {
        throw new Error('point mapping crashed')
      },
    })

    await assert.rejects(
      executeBrowserTool('browser_type_at', { x: 500, y: 500, text: 'secret' }, controller),
      (error: unknown) => {
        assert.equal(error instanceof Error ? error.name : '', 'ToolDomainError')
        assert.match(error instanceof Error ? error.message : String(error), /无法确认坐标输入目标/)
        return true
      },
    )
    assert.equal(controller.calls.mouse.length, 0)
    assert.equal(controller.calls.typed.length, 0)
  })

  it('browser_query_gemini should fallback to coordinate typing when DOM compose fails', async () => {
    const controller = createControllerMock()
    const result = await executeBrowserTool('browser_query_gemini', { text: '今晚吃什么', wait_response_ms: 5000 }, controller)
    const payload = parseTool(result) as {
      submitted: boolean
      response_detected: boolean
      attempted: string[]
      evidence: { coordinate?: unknown }
    }

    assert.strictEqual(payload.submitted, true)
    assert.strictEqual(payload.response_detected, true)
    assert.ok(payload.attempted.includes('probe-editables'))
    assert.ok(payload.evidence.coordinate)
  })

  it('browser_locate_input_targets should surface active input and nearby send targets', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes("const nodes = Array.from(document.querySelectorAll('textarea,input")) {
          return [
            {
              kind: 'prompt_input',
              label: '提示词输入框',
              x: 620,
              y: 812,
              confidence: 0.96,
              focused: true,
              textLength: 18,
              valuePreview: '温暖 日常感 打工人',
              evidence: ['active_input'],
            },
          ]
        }
        if (source.includes('nearActiveInput')) {
          return [
            {
              kind: 'send_button',
              label: '生成',
              x: 790,
              y: 860,
              confidence: 0.94,
              nearActiveInput: true,
              distanceToActiveInput: 104,
              evidence: ['near_active_input'],
            },
            {
              kind: 'send_button',
              label: '历史生成',
              x: 120,
              y: 220,
              confidence: 0.88,
              nearActiveInput: false,
              distanceToActiveInput: 760,
              evidence: ['keyword_match'],
            },
          ]
        }
        return null
      },
    })

    const result = await executeBrowserTool('browser_locate_input_targets', { target: '提示词' }, controller)
    const payload = parseTool(result) as {
      active_target?: { label?: string; focused?: boolean }
      nearby_send_targets?: Array<{ label?: string; nearActiveInput?: boolean }>
      targets: Array<{ label?: string }>
    }

    assert.strictEqual(payload.active_target?.label, '提示词输入框')
    assert.strictEqual(payload.active_target?.focused, true)
    assert.strictEqual(payload.targets[0]?.label, '提示词输入框')
    assert.strictEqual(payload.nearby_send_targets?.length, 1)
    assert.strictEqual(payload.nearby_send_targets?.[0]?.label, '生成')
    assert.strictEqual(payload.nearby_send_targets?.[0]?.nearActiveInput, true)
  })

  it('browser_extract_structured should delegate to the browser capability layer', async () => {
    const controller = createControllerMock({
      extractStructured: async (_tabId, options) => ({
        items: [
          {
            sourceUrl: 'https://example.com/feed',
            title: 'First post',
            link: 'https://example.com/posts/1',
          },
        ],
        template: options?.template || 'article_list',
      }),
    } as Partial<BrowserController>)

    const result = await executeBrowserTool('browser_extract_structured', { template: 'article_list' }, controller)
    const payload = parseTool(result) as { items: Array<{ title?: string }> }

    assert.strictEqual(payload.items.length, 1)
    assert.strictEqual(payload.items[0]?.title, 'First post')
  })

  it('browser_start_task and browser_get_task should expose persistent browser task progress', async () => {
    const controller = createControllerMock({
      startTask: async (_request) => ({
        taskId: 'task-1',
        kind: 'download_urls',
        status: 'running',
        progress: { total: 10, completed: 2, failed: 0, currentLabel: 'image-003.jpg' },
      }),
      getTask: async (_taskId) => ({
        taskId: 'task-1',
        kind: 'download_urls',
        status: 'running',
        progress: { total: 10, completed: 2, failed: 0, currentLabel: 'image-003.jpg' },
      }),
    } as Partial<BrowserController>)

    const startResult = await executeBrowserTool('browser_start_task', {
      kind: 'download_urls',
      payload: { urls: ['https://example.com/a.jpg'] },
    }, controller)
    const startPayload = parseTool(startResult) as { taskId?: string; progress?: { completed?: number } }

    const getResult = await executeBrowserTool('browser_get_task', { task_id: 'task-1' }, controller)
    const getPayload = parseTool(getResult) as { status?: string; progress?: { currentLabel?: string } }

    assert.strictEqual(startPayload.taskId, 'task-1')
    assert.strictEqual(startPayload.progress?.completed, 2)
    assert.strictEqual(getPayload.status, 'running')
    assert.strictEqual(getPayload.progress?.currentLabel, 'image-003.jpg')
  })

  it('browser_resume_task, browser_cancel_task and browser_aggregate_results should use capability-backed helpers', async () => {
    const controller = createControllerMock({
      resumeTask: async (_taskId) => ({
        taskId: 'task-1',
        kind: 'research',
        status: 'running',
        progress: { total: 3, completed: 1, failed: 0, currentLabel: 'https://example.com/page-2' },
      }),
      cancelTask: async (_taskId) => ({
        taskId: 'task-1',
        kind: 'research',
        status: 'cancelled',
        progress: { total: 3, completed: 1, failed: 0, currentLabel: null },
      }),
      aggregateResults: (_items, _options) => ([
        { sourceUrl: 'https://example.com/a', title: 'Alpha', link: 'https://example.com/1' },
      ]),
    } as Partial<BrowserController>)

    const resumeResult = await executeBrowserTool('browser_resume_task', { task_id: 'task-1' }, controller)
    const cancelResult = await executeBrowserTool('browser_cancel_task', { task_id: 'task-1' }, controller)
    const aggregateResult = await executeBrowserTool('browser_aggregate_results', {
      items: [
        { sourceUrl: 'https://example.com/a', title: 'Alpha', link: 'https://example.com/1' },
        { sourceUrl: 'https://example.com/a', title: 'Alpha', link: 'https://example.com/1' },
      ],
      merge_strategy: 'dedupe',
      sort_by: 'source',
    }, controller)

    assert.strictEqual((parseTool(resumeResult) as { status?: string }).status, 'running')
    assert.strictEqual((parseTool(cancelResult) as { status?: string }).status, 'cancelled')
    assert.strictEqual((parseTool(aggregateResult) as Array<{ title?: string }>).length, 1)
  })

  it('browser_resume_task never turns a completed discovery query into a write task', async () => {
    let resumedTaskId = ''
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-xhs-resume',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 2, completed: 0, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'complete',
          targetUrl: 'https://www.xiaohongshu.com/user/profile/abc',
          outputRootDir: '/tmp/ready-xhs-out',
          noteCandidates: [
            { url: 'https://www.xiaohongshu.com/explore/one', title: 'One', sourceId: 'one' },
            { url: 'https://www.xiaohongshu.com/explore/two', title: 'Two', sourceId: 'two' },
          ],
        },
      }) as never,
      startCardLoopCollection: async () => {
        throw new Error('query/resume must not start a downstream collection')
      },
      resumeTask: async (taskId: string) => {
        resumedTaskId = taskId
        return {
          taskId,
          kind: 'visible_collect',
          status: 'completed',
          progress: { total: 2, completed: 0, failed: 0, currentLabel: null },
          result: { discoveryStatus: 'complete', outputRootDir: '/tmp/ready-xhs-out' },
        } as never
      },
    } as Partial<BrowserController>)

    const result = await executeBrowserTool(
      'browser_resume_task',
      { task_id: 'browser-task-visible-xhs-resume' },
      controller,
      undefined,
      'scope-xhs-resume',
    )

    const payload = parseTool(result) as { taskId?: string; status?: string; result?: { outputRootDir?: string; noteCandidates?: unknown[] } }
    assert.equal(payload.taskId, 'browser-task-visible-xhs-resume')
    assert.equal(payload.status, 'completed')
    assert.equal(payload.result?.outputRootDir, '/tmp/ready-xhs-out')
    assert.equal(payload.result?.noteCandidates, undefined)
    assert.equal(resumedTaskId, 'browser-task-visible-xhs-resume')
  })

  it('browser_get_task is a compact, side-effect-free query for a completed discovery task', async () => {
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-xhs-get',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 2, completed: 0, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'complete',
          targetUrl: 'https://www.xiaohongshu.com/user/profile/abc',
          outputRootDir: '/tmp/ready-xhs-out',
          noteCandidates: [
            { url: 'https://www.xiaohongshu.com/explore/one', title: 'One', sourceId: 'one' },
            { url: 'https://www.xiaohongshu.com/explore/two', title: 'Two', sourceId: 'two' },
          ],
        },
      }) as never,
      findCollectionTaskBySourceTaskId: async () => null,
      startCardLoopCollection: async () => {
        throw new Error('browser_get_task must never start a collection')
      },
    } as Partial<BrowserController>)

    const result = await executeBrowserTool(
      'browser_get_task',
      { task_id: 'browser-task-visible-xhs-get' },
      controller,
      undefined,
      'scope-xhs-get',
    )

    const payload = parseTool(result) as {
      taskId?: string
      status?: string
      result?: { outputRootDir?: string; collectedCount?: number; noteCandidates?: unknown[] }
      activeExecution?: unknown
    }
    assert.equal(payload.taskId, 'browser-task-visible-xhs-get')
    assert.equal(payload.status, 'completed')
    assert.equal(payload.result?.outputRootDir, '/tmp/ready-xhs-out')
    assert.equal(payload.result?.noteCandidates, undefined)
    assert.equal(payload.activeExecution, undefined)
  })

  it('browser_get_task reports an existing downstream collection without replacing the source identity', async () => {
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-xhs-existing',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 1, completed: 0, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'complete',
          targetUrl: 'https://www.xiaohongshu.com/user/profile/abc',
          noteCandidates: [
            { url: 'https://www.xiaohongshu.com/explore/one', title: 'One', sourceId: 'one' },
          ],
        },
      }) as never,
      findCollectionTaskBySourceTaskId: async () => ({
        taskId: 'browser-task-card-existing',
        kind: 'card_loop',
        status: 'running',
        progress: { total: 1, completed: 0, failed: 0, currentLabel: 'One' },
      }) as never,
      startCardLoopCollection: async () => {
        throw new Error('existing downstream collection should be reused')
      },
    } as Partial<BrowserController>)

    const result = await executeBrowserTool(
      'browser_get_task',
      { task_id: 'browser-task-visible-xhs-existing' },
      controller,
    )

    const payload = parseTool(result) as { taskId?: string; activeExecution?: { taskId?: string; status?: string } }
    assert.equal(payload.taskId, 'browser-task-visible-xhs-existing')
    assert.equal(payload.activeExecution?.taskId, 'browser-task-card-existing')
    assert.equal(payload.activeExecution?.status, 'running')
  })

  it('browser_download_gallery and browser_research_topic should offer thin task adapters for agents', async () => {
    const controller = createControllerMock({
      startTask: async (request) => {
        if ((request as { kind?: string }).kind === 'scroll_collect') {
          return {
            taskId: 'gallery-task',
            kind: 'scroll_collect',
            status: 'running',
            progress: { total: 0, completed: 0, failed: 0, currentLabel: 'https://example.com/gallery' },
          }
        }
        return {
          taskId: 'research-task',
          kind: 'research',
          status: 'running',
          progress: { total: 0, completed: 0, failed: 0, currentLabel: 'climate change adaptation' },
        }
      },
    } as Partial<BrowserController>)

    const galleryResult = await executeBrowserTool('browser_download_gallery', {
      url: 'https://example.com/gallery',
      directory: '~/Downloads/gallery',
      limit: 80,
    }, controller)
    const researchResult = await executeBrowserTool('browser_research_topic', {
      query: 'climate change adaptation',
      max_pages: 6,
      limit_per_page: 10,
    }, controller)

    assert.strictEqual((parseTool(galleryResult) as { taskId?: string }).taskId, 'gallery-task')
    assert.strictEqual((parseTool(researchResult) as { taskId?: string }).taskId, 'research-task')
  })

  it('shares recent browser actions with planner continuity so duplicate work can be suppressed across turns', async () => {
    const controller = createControllerMock({
      getActiveTab: () => [{ id: 'tab-1', title: '搜索结果', url: 'https://duckduckgo.com/?q=广州天气', active: true }][0],
      getPageContent: async () => '广州天气搜索结果',
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('out.sort((a, b) => b.score - a.score)')) return []
        if (source.includes('window.location.href')) return 'https://duckduckgo.com/?q=广州天气'
        if (source.includes("document.readyState === 'interactive'")) return true
        if (source.includes('readyState') && source.includes('bodyTextLen')) {
          return { readyState: 'complete', bodyTextLen: 200, matched: true }
        }
        return []
      },
    })

    await executeBrowserTool('browser_search', { query: '广州天气' }, controller, undefined, 'scope-shared')

    const planner = new BrowserTaskPlanner({
      getSessionAttachmentHints: () => ({ count: 0 }),
      getIncomingAttachmentHints: () => ({ count: 0 }),
      getActiveTab: () => ({
        id: 'tab-1',
        url: 'https://duckduckgo.com/?q=广州天气',
        title: '搜索结果',
        domain: 'duckduckgo.com',
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
        url: 'https://duckduckgo.com/?q=广州天气',
        title: '搜索结果',
        heading: '广州天气',
        selection: '',
        excerpt: '广州天气搜索结果',
        capturedAt: Date.now(),
        domain: 'duckduckgo.com',
      }),
    })

    const decision = planner.decideTask({
      userText: '明天广州天气怎么样',
      sessionMessages: [],
      sessionId: 'scope-shared',
    })
    const continuity = await planner.buildContinuityContext({
      userText: '继续看广州天气',
      sessionId: 'scope-shared',
      decision,
    })

    assert.deepEqual(
      continuity?.recentActions.map((item) => `${item.kind}:${item.value}`),
      ['search:广州天气'],
    )
  })
})

describe('browser_collect_notes (background sub-agent dispatch)', () => {
  it('parses the planned notes and dispatches startNoteCollection with a valid plan', async () => {
    const started: Array<Record<string, unknown>> = []
    const synthetic: Array<Record<string, unknown>> = []
    const controller = createControllerMock({
      createSyntheticVisibleCollection: async (payload: Record<string, unknown>) => {
        synthetic.push(payload)
        return {
          taskId: 'browser-task-synthetic-1',
          kind: 'visible_collect',
          status: 'completed',
          progress: { total: 2, completed: 0, failed: 0, currentLabel: null },
          result: { discoveryStatus: 'complete', noteCandidates: payload.targets },
        } as never
      },
      startNoteCollection: async (plan: Record<string, unknown>) => {
        started.push(plan)
        return { taskId: 'task-note-1', kind: 'note_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
      },
    })
    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/user/profile/abc123',
        notes: [
          { url: 'https://example.com/note/1', title: '笔记一' },
          { url: 'not-a-url' }, // dropped (no http)
          { url: 'https://example.com/note/2' },
        ],
        max_notes: 50,
      },
      controller,
      undefined,
      undefined,
      undefined,
      '请采集 https://example.com/note/1 和 https://example.com/note/2',
      undefined,
      {
        ownerAgentId: 'analyst',
        ownerRunId: 'run-note-1',
        parentTaskId: 'task-agent-note-1',
      },
    )
    const handle = parseTool(result) as { taskId: string }
    assert.equal(handle.taskId, 'task-note-1')
    assert.equal(synthetic.length, 1)
    assert.equal(started.length, 1)
    const plan = started[0] as { notes: Array<{ url: string }>; targetProfileUrl: string; outputRootDir: string; sourceTaskId?: string; stopConditions?: { maxNotes?: number }; ownerAgentId?: string; ownerRunId?: string; parentTaskId?: string }
    assert.equal(plan.sourceTaskId, 'browser-task-synthetic-1')
    assert.equal(plan.notes.length, 2, 'the non-http note is dropped')
    assert.deepEqual(plan.notes.map((n) => n.url), ['https://example.com/note/1', 'https://example.com/note/2'])
    assert.equal(plan.stopConditions?.maxNotes, 50)
    assert.ok(plan.outputRootDir.includes('abc123'), 'derives the output folder from the profile slug')
    assert.equal(plan.ownerAgentId, 'analyst')
    assert.equal(plan.ownerRunId, 'run-note-1')
    assert.equal(plan.parentTaskId, 'task-agent-note-1')
    assert.equal(synthetic[0]?.ownerAgentId, 'analyst')
  })

  it('refuses direct notes when URLs cannot be proven from current user text', async () => {
    let dispatched = false
    const controller = createControllerMock({
      createSyntheticVisibleCollection: async () => {
        dispatched = true
        return {} as never
      },
      startNoteCollection: async () => {
        dispatched = true
        return {} as never
      },
    })

    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/user/profile/abc123',
        notes: [{ url: 'https://example.com/note/not-from-user', title: '笔记一' }],
      },
      controller,
      undefined,
      undefined,
      undefined,
      '请采集 https://example.com/note/other',
    )

    const parsed = parseTool(result) as { errorCode?: string; missingUrls?: string[] }
    assert.equal(parsed.errorCode, 'url_provenance_required')
    assert.deepEqual(parsed.missingUrls, ['https://example.com/note/not-from-user'])
    assert.equal(dispatched, false)
  })

  it('refuses when no valid note URL is supplied (does not dispatch a task)', async () => {
    let dispatched = false
    const controller = createControllerMock({
      startNoteCollection: async () => {
        dispatched = true
        return {} as never
      },
    })
    const result = await executeBrowserTool(
      'browser_collect_notes',
      { target_profile_url: 'https://www.xiaohongshu.com/user/profile/abc', notes: [{ url: 'ftp://x' }] },
      controller,
    )
    assert.match(toolText(result), /至少一条/)
    assert.equal(dispatched, false)
  })

  it('loads the frozen target list from source_task_id instead of relying on restated notes', async () => {
    const started: Array<Record<string, unknown>> = []
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-1',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 2, completed: 2, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'complete',
          stopReason: 'no_new_content',
          noteCandidates: [
            { url: 'https://example.com/post/one', title: 'One', sourceId: 'one' },
            { url: 'https://example.com/post/two', title: 'Two', sourceId: 'two' },
          ],
        },
      }) as never,
      startNoteCollection: async (plan: Record<string, unknown>) => {
        started.push(plan)
        return { taskId: 'task-note-2', kind: 'note_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
      },
    })

    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/profile/abc',
        source_task_id: 'browser-task-visible-1',
        expected_count: 2,
        notes: [{ url: 'https://example.com/post/one' }, { url: 'https://example.com/post/two' }],
      },
      controller,
    )

    assert.equal((parseTool(result) as { taskId: string }).taskId, 'task-note-2')
    const plan = started[0] as { notes: Array<{ url: string; canonicalUrl?: string; openUrl?: string; title?: string; sourceId?: string; order?: number }>; sourceTaskId?: string; expectedCount?: number }
    assert.equal(plan.sourceTaskId, 'browser-task-visible-1')
    assert.equal(plan.expectedCount, 2)
    assert.deepEqual(plan.notes.map((note) => ({
      url: note.url,
      canonicalUrl: note.canonicalUrl,
      openUrl: note.openUrl,
      title: note.title,
      sourceId: note.sourceId,
      order: note.order,
    })), [
      { url: 'https://example.com/post/one', canonicalUrl: 'https://example.com/post/one', openUrl: 'https://example.com/post/one', title: 'One', sourceId: 'one', order: 1 },
      { url: 'https://example.com/post/two', canonicalUrl: 'https://example.com/post/two', openUrl: 'https://example.com/post/two', title: 'Two', sourceId: 'two', order: 2 },
    ])
  })

  it('refuses source_task_id handoff from another scope or output directory', async () => {
    let dispatched = false
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-old',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 1, completed: 0, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'complete',
          stopReason: 'no_new_content',
          outputRootDir: '/tmp/old-run',
          noteCandidates: [{ url: 'https://example.com/post/one', title: 'One', sourceId: 'one' }],
        },
      }) as never,
      getTaskPayload: () => ({
        scopeId: 'old-scope',
        outputRootDir: '/tmp/old-run',
      }),
      startNoteCollection: async () => {
        dispatched = true
        return {} as never
      },
    })

    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/profile/abc',
        source_task_id: 'browser-task-visible-old',
        expected_count: 1,
        output_root_dir: '/tmp/new-run',
      },
      controller,
      undefined,
      'current-scope',
    )

    const parsed = parseTool(result) as { ok: boolean; errorCode: string }
    assert.equal(parsed.ok, false)
    assert.equal(parsed.errorCode, 'stale_source_task_scope')
    assert.equal(dispatched, false)

    const outputMismatchController = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-old',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 1, completed: 0, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'complete',
          stopReason: 'no_new_content',
          outputRootDir: '/tmp/old-run',
          noteCandidates: [{ url: 'https://example.com/post/one', title: 'One', sourceId: 'one' }],
        },
      }) as never,
      getTaskPayload: () => ({
        scopeId: 'current-scope',
        outputRootDir: '/tmp/old-run',
      }),
      startNoteCollection: async () => {
        dispatched = true
        return {} as never
      },
    })
    const outputMismatchResult = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/profile/abc',
        source_task_id: 'browser-task-visible-old',
        expected_count: 1,
        output_root_dir: '/tmp/new-run',
      },
      outputMismatchController,
      undefined,
      'current-scope',
    )
    const outputMismatch = parseTool(outputMismatchResult) as { ok: boolean; errorCode: string }
    assert.equal(outputMismatch.ok, false)
    assert.equal(outputMismatch.errorCode, 'stale_source_task_output')
    assert.equal(dispatched, false)
  })

  it('refuses source_task_id handoff when the discovery source is only partial', async () => {
    let dispatched = false
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-1',
        kind: 'visible_collect',
        status: 'paused',
        progress: { total: 60, completed: 60, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'partial',
          stopReason: 'max_items',
          continueTaskId: 'browser-task-visible-1',
          noteCandidates: [{ url: 'https://example.com/post/one', title: 'One', sourceId: 'one' }],
        },
      }) as never,
      startNoteCollection: async () => {
        dispatched = true
        return {} as never
      },
    })

    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/profile/abc',
        source_task_id: 'browser-task-visible-1',
      },
      controller,
    )

    assert.match(toolText(result), /不是完整全量/)
    assert.match(toolText(result), /browser_resume_task/)
    assert.equal(dispatched, false)
  })

  it('allows partial source_task_id handoff after confirming the pending consent request', async () => {
    const started: Array<Record<string, unknown>> = []
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-partial-consent',
        kind: 'visible_collect',
        status: 'paused',
        progress: { total: 1, completed: 0, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'partial',
          stopReason: 'max_items',
          continueTaskId: 'browser-task-visible-partial-consent',
          noteCandidates: [{ url: 'https://example.com/post/one', title: 'One', sourceId: 'one' }],
        },
      }) as never,
      startNoteCollection: async (plan: Record<string, unknown>) => {
        started.push(plan)
        return { taskId: 'task-note-after-consent', kind: 'note_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
      },
    })

    const first = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/profile/abc',
        source_task_id: 'browser-task-visible-partial-consent',
      },
      controller,
      undefined,
      'scope-consent',
    )
    const pending = (parseTool(first) as { pendingConsentRequest?: { requestId?: string } }).pendingConsentRequest
    assert.match(pending?.requestId || '', /^browser-consent-/)

    const confirmed = await executeBrowserTool(
      'browser_confirm_collection_consent',
      {
        request_id: pending?.requestId,
        confirmed_via: 'ask_user_questions',
      },
      controller,
      undefined,
      'scope-consent',
    )
    assert.equal((parseTool(confirmed) as { ok?: boolean }).ok, true)

    const second = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/profile/abc',
        source_task_id: 'browser-task-visible-partial-consent',
      },
      controller,
      undefined,
      'scope-consent',
    )

    assert.equal((parseTool(second) as { taskId?: string }).taskId, 'task-note-after-consent')
    assert.equal(started.length, 1)
    assert.equal((started[0] as { sourceTaskId?: string }).sourceTaskId, 'browser-task-visible-partial-consent')
  })

  it('refuses to start when expected_count does not match the frozen list', async () => {
    let dispatched = false
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-1',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 1, completed: 1, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'complete',
          stopReason: 'no_new_content',
          noteCandidates: [{ url: 'https://example.com/post/one', title: 'One' }],
        },
      }) as never,
      startNoteCollection: async () => {
        dispatched = true
        return {} as never
      },
    })

    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/profile/abc',
        source_task_id: 'browser-task-visible-1',
        expected_count: 2,
      },
      controller,
    )

    assert.match(toolText(result), /数量不一致/)
    assert.equal(dispatched, false)
  })

  it('refuses direct notes when a recent larger frozen collection exists', async () => {
    let dispatched = false
    const frozenNotes = Array.from({ length: 31 }, (_item, index) => ({
      url: `https://example.com/post/${index + 1}`,
      title: `Post ${index + 1}`,
    }))
    const controller = createControllerMock({
      listAgentCollectionTasks: async () => [{
        taskId: 'browser-task-visible-large',
        kind: 'visible_collect',
        status: 'cancelled',
        progress: { total: 31, completed: 31, failed: 0, currentLabel: null },
        result: { noteCandidates: frozenNotes },
        updatedAt: new Date().toISOString(),
      }] as never,
      startNoteCollection: async () => {
        dispatched = true
        return {} as never
      },
    })

    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/profile/abc',
        notes: frozenNotes.slice(0, 12),
      },
      controller,
    )

    assert.match(toolText(result), /source_task_id/)
    assert.match(toolText(result), /31/)
    assert.match(toolText(result), /12/)
    assert.equal(dispatched, false)
  })

  it('does not trust allow_partial for direct notes when a larger frozen collection exists', async () => {
    let dispatched = false
    const frozenNotes = Array.from({ length: 31 }, (_item, index) => ({
      url: `https://example.com/post/${index + 1}`,
      title: `Post ${index + 1}`,
    }))
    const controller = createControllerMock({
      listAgentCollectionTasks: async () => [{
        taskId: 'browser-task-visible-large',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 31, completed: 31, failed: 0, currentLabel: null },
        result: { noteCandidates: frozenNotes },
        updatedAt: new Date().toISOString(),
      }] as never,
      startNoteCollection: async () => {
        dispatched = true
        return {} as never
      },
    })

    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/profile/abc',
        notes: frozenNotes.slice(0, 12),
        allow_partial: true,
      },
      controller,
    )

    const parsed = parseTool(result) as {
      errorCode?: string
      allowPartialIgnored?: boolean
      pendingConsentRequest?: { requestId?: string; consentKind?: string; sourceTaskId?: string }
    }
    assert.equal(parsed.errorCode, 'partial_collection_consent_required')
    assert.equal(parsed.allowPartialIgnored, true)
    assert.match(parsed.pendingConsentRequest?.requestId || '', /^browser-consent-/)
    assert.equal(parsed.pendingConsentRequest?.consentKind, 'partial_collection')
    assert.equal(parsed.pendingConsentRequest?.sourceTaskId, 'browser-task-visible-large')
    assert.equal(dispatched, false)
  })

  it('projects pending collection consent and clears it after ui confirmation', async () => {
    const frozenNotes = Array.from({ length: 31 }, (_item, index) => ({
      url: `https://example.com/post/${index + 1}`,
      title: `Post ${index + 1}`,
    }))
    const controller = createControllerMock({
      listAgentCollectionTasks: async () => [{
        taskId: 'browser-task-visible-large',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 31, completed: 31, failed: 0, currentLabel: null },
        result: { noteCandidates: frozenNotes },
        updatedAt: new Date().toISOString(),
      }] as never,
    })
    const { records, runtime } = createRuntimeProjectionStore()

    const first = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://example.com/profile/abc',
        notes: frozenNotes.slice(0, 12),
      },
      controller,
      undefined,
      'scope-consent-ui',
      undefined,
      undefined,
      runtime as never,
    )

    const parsed = parseTool(first) as {
      pendingConsentRequest?: { requestId?: string }
    }
    const requestId = parsed.pendingConsentRequest?.requestId || ''
    assert.match(requestId, /^browser-consent-/)
    const projected = records.get('browser-task-visible-large')
    assert.equal(projected?.interactionState, 'awaiting_confirmation')
    assert.equal(projected?.waitingFor, 'confirmation')
    assert.equal(projected?.progress?.browserCollectionConsent?.requestId, requestId)
    assert.equal(projected?.progress?.browserCollectionConsent?.consentKind, 'partial_collection')

    await executeBrowserTool(
      'browser_confirm_collection_consent',
      { request_id: requestId, confirmed_via: 'ui_action' },
      controller,
      undefined,
      'scope-consent-ui',
      undefined,
      undefined,
      runtime as never,
    )

    const cleared = records.get('browser-task-visible-large')
    assert.equal(cleared?.interactionState, 'suspended')
    assert.equal(cleared?.waitingFor, 'none')
    assert.equal(cleared?.progress?.browserCollectionConsent, null)
  })

  it('rejects high-control url_batch without downgrade consent', async () => {
    let dispatched = false
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-xhs',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 1, completed: 0, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'complete',
          noteCandidates: [{ url: 'https://www.xiaohongshu.com/explore/abc', title: 'XHS Note', sourceId: 'abc' }],
        },
      }) as never,
      startNoteCollection: async () => {
        dispatched = true
        return {} as never
      },
    })

    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://www.xiaohongshu.com/user/profile/abc',
        source_task_id: 'browser-task-visible-xhs',
        strategy: 'url_batch',
      },
      controller,
      undefined,
      'scope-xhs',
    )

    const parsed = parseTool(result) as {
      errorCode?: string
      strategy?: string
      pendingConsentRequest?: { requestId?: string; consentKind?: string; sourceTaskId?: string; targetHost?: string }
    }
    assert.equal(parsed.errorCode, 'high_control_url_batch_denied')
    assert.equal(parsed.strategy, 'url_batch')
    assert.match(parsed.pendingConsentRequest?.requestId || '', /^browser-consent-/)
    assert.equal(parsed.pendingConsentRequest?.consentKind, 'high_control_url_batch_downgrade')
    assert.equal(parsed.pendingConsentRequest?.sourceTaskId, 'browser-task-visible-xhs')
    assert.equal(parsed.pendingConsentRequest?.targetHost, 'www.xiaohongshu.com')
    assert.equal(dispatched, false)
  })

  it('allows high-control url_batch after confirming downgrade consent', async () => {
    const started: Array<Record<string, unknown>> = []
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-xhs-confirm',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 1, completed: 0, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'complete',
          noteCandidates: [{ url: 'https://www.xiaohongshu.com/explore/abc', title: 'XHS Note', sourceId: 'abc' }],
        },
      }) as never,
      startNoteCollection: async (plan: Record<string, unknown>) => {
        started.push(plan)
        return { taskId: 'task-xhs-url-batch', kind: 'note_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
      },
    })

    const first = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://www.xiaohongshu.com/user/profile/abc',
        source_task_id: 'browser-task-visible-xhs-confirm',
        strategy: 'url_batch',
      },
      controller,
      undefined,
      'scope-xhs-confirm',
    )
    const pending = (parseTool(first) as { pendingConsentRequest?: { requestId?: string } }).pendingConsentRequest
    assert.match(pending?.requestId || '', /^browser-consent-/)

    await executeBrowserTool(
      'browser_confirm_collection_consent',
      {
        request_id: pending?.requestId,
        confirmed_via: 'ask_user_questions',
      },
      controller,
      undefined,
      'scope-xhs-confirm',
    )

    const second = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://www.xiaohongshu.com/user/profile/abc',
        source_task_id: 'browser-task-visible-xhs-confirm',
        strategy: 'url_batch',
      },
      controller,
      undefined,
      'scope-xhs-confirm',
    )

    assert.equal((parseTool(second) as { taskId?: string }).taskId, 'task-xhs-url-batch')
    assert.equal(started.length, 1)
    assert.equal((started[0] as { strategy?: string }).strategy, 'url_batch')
  })

  it('starts card_loop for high-control collection when requested', async () => {
    const started: Array<Record<string, unknown>> = []
    const controller = createControllerMock({
      getTask: async () => ({
        taskId: 'browser-task-visible-xhs',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 1, completed: 0, failed: 0, currentLabel: null },
        result: {
          discoveryStatus: 'complete',
          noteCandidates: [{ url: 'https://www.xiaohongshu.com/explore/abc', title: 'XHS Note', sourceId: 'abc' }],
        },
      }) as never,
      startCardLoopCollection: async (plan: Record<string, unknown>) => {
        started.push(plan)
        return { taskId: 'task-card-loop', kind: 'card_loop', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
      },
    } as Partial<BrowserController>)

    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://www.xiaohongshu.com/user/profile/abc',
        source_task_id: 'browser-task-visible-xhs',
        strategy: 'card_loop',
      },
      controller,
      undefined,
      'scope-xhs',
    )

    assert.equal((parseTool(result) as { taskId?: string }).taskId, 'task-card-loop')
    assert.equal(started.length, 1)
    assert.equal((started[0] as { strategy?: string }).strategy, 'card_loop')
  })
})

describe('high-control browser tools (agent tab routing)', () => {
  const profileUrl = 'https://www.xiaohongshu.com/user/profile/abc'

  it('routes high-control navigation to the agent tab instead of the user tab', async () => {
    const navigations: Array<{ tabId: string | null; url: string }> = []
    let ensured = 0
    const controller = createControllerMock({
      getActiveTab: () => ({ id: 'tab-4', title: 'XHS', url: profileUrl, active: true, owner: 'manual' }) as never,
      getTabList: () => [
        { id: 'tab-4', title: 'XHS', url: profileUrl, active: true, owner: 'manual' },
        { id: 'agent-tab', title: 'Agent', url: 'https://example.com/blank', active: false, owner: 'agent' },
      ] as never,
      ensureAgentTab: async () => {
        ensured += 1
        return 'agent-tab'
      },
      navigate: async (tabId, url) => {
        navigations.push({ tabId: tabId || null, url })
        return { success: true }
      },
    } as Partial<BrowserController>)

    await executeBrowserTool('browser_navigate', { url: profileUrl, tab_id: 'tab-4' }, controller)

    assert.equal(ensured, 1)
    assert.deepEqual(navigations, [{ tabId: 'agent-tab', url: profileUrl }])
  })

  it('routes high-control visual reads from a user tab through the agent tab', async () => {
    const navigations: Array<{ tabId: string | null; url: string }> = []
    let screenshotTabId: string | null = null
    const controller = createControllerMock({
      getActiveTab: () => ({ id: 'tab-4', title: 'XHS', url: profileUrl, active: true, owner: 'manual' }) as never,
      getTabList: () => [
        { id: 'tab-4', title: 'XHS', url: profileUrl, active: true, owner: 'manual' },
        { id: 'agent-tab', title: 'Agent', url: 'https://example.com/blank', active: false, owner: 'agent' },
      ] as never,
      ensureAgentTab: async () => 'agent-tab',
      navigate: async (tabId, url) => {
        navigations.push({ tabId: tabId || null, url })
        return { success: true }
      },
      screenshotAdvanced: async (tabId) => {
        screenshotTabId = tabId
        return 'base64-image'
      },
    } as Partial<BrowserController>)

    await executeBrowserTool('browser_capture_viewport', { tab_id: 'tab-4' }, controller)

    assert.deepEqual(navigations, [{ tabId: 'agent-tab', url: profileUrl }])
    assert.equal(screenshotTabId, 'agent-tab')
  })

  it('keeps user-view high-control collection clicks on the requested visible tab', async () => {
    let ensured = 0
    const switched: string[] = []
    const controller = createControllerMock({
      getActiveTab: () => ({ id: 'tab-4', title: 'XHS', url: profileUrl, active: true, owner: 'manual' }) as never,
      getTabList: () => [
        { id: 'tab-4', title: 'XHS', url: profileUrl, active: true, owner: 'manual' },
      ] as never,
      ensureAgentTab: async () => {
        ensured += 1
        return 'agent-tab'
      },
      switchTab: (tabId: string) => {
        switched.push(tabId)
        return { success: true }
      },
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (source.includes('buildLocateTextTargetJs')) return null
        if (source.includes('hrefContains')) {
          return { ok: true, text: '笔记一', clickedDirect: false, cssX: 120, cssY: 220, width: 1000, height: 800 }
        }
        if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
          return { label: '笔记一', editable: false }
        }
        if (source.includes('readyState') && source.includes('bodyTextLen')) {
          return { readyState: 'complete', bodyTextLen: 200, matched: true }
        }
        return null
      },
    } as Partial<BrowserController>)

    await executeBrowserTool(
      'browser_click_text',
      {
        text: '笔记一',
        href_contains: 'source-1',
        tab_id: 'tab-4',
        collection_surface: 'user-view',
      },
      controller,
    )

    assert.equal(ensured, 0)
    assert.deepEqual(switched, ['tab-4'])
    assert.ok(controller.calls.mouse.length >= 3)
  })

  it('routes high-control URL extraction through the agent tab task surface', async () => {
    const navigations: Array<{ tabId: string | null; url: string }> = []
    let extractedTabId: string | null = null
    let extractFromUrlCalled = false
    const controller = createControllerMock({
      getActiveTab: () => ({ id: 'tab-4', title: 'XHS', url: profileUrl, active: true, owner: 'manual' }) as never,
      getTabList: () => [
        { id: 'tab-4', title: 'XHS', url: profileUrl, active: true, owner: 'manual' },
        { id: 'agent-tab', title: 'Agent', url: 'https://example.com/blank', active: false, owner: 'agent' },
      ] as never,
      ensureAgentTab: async () => 'agent-tab',
      navigate: async (tabId, url) => {
        navigations.push({ tabId: tabId || null, url })
        return { success: true }
      },
      extractStructuredFromUrl: async () => {
        extractFromUrlCalled = true
        return { items: [], template: 'card_list' } as never
      },
      extractStructured: async (tabId, options) => {
        extractedTabId = tabId
        return { items: [], template: options?.template || 'card_list' }
      },
    } as Partial<BrowserController>)

    await executeBrowserTool('browser_extract_structured', { url: profileUrl, template: 'card_list' }, controller)

    assert.deepEqual(navigations, [{ tabId: 'agent-tab', url: profileUrl }])
    assert.equal(extractedTabId, 'agent-tab')
    assert.equal(extractFromUrlCalled, false)
  })
})

describe('browser_visible_collect (agent pane dispatch)', () => {
  it('dispatches visible collection through the agent-tab entrypoint with output dir', async () => {
    const started: Array<{ payload: Record<string, unknown>; scopeId?: string }> = []
    const controller = createControllerMock({
      getActiveTab: () => ({ id: 'tab-1', title: 'XHS', url: 'https://www.xiaohongshu.com/user/profile/abc', active: true }) as never,
      getTabList: () => [{ id: 'tab-1', title: 'XHS', url: 'https://www.xiaohongshu.com/user/profile/abc', active: true }] as never,
      startVisibleCollection: async (payload: Record<string, unknown>, scopeId?: string) => {
        started.push({ payload, scopeId })
        return { taskId: 'browser-task-visible-1', kind: 'visible_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
      },
    } as Partial<BrowserController>)

    const result = await executeBrowserTool(
      'browser_visible_collect',
      {
        url: 'https://www.xiaohongshu.com/user/profile/abc',
        template: 'article_list',
        output_root_dir: '/tmp/ao-i',
      },
      controller,
      undefined,
      'scope-collection-1',
      undefined,
      undefined,
      undefined,
      {
        ownerAgentId: 'analyst',
        ownerRunId: 'run-collection-1',
        parentTaskId: 'task-agent-1',
      },
    )

    const handle = parseTool(result) as { taskId: string }
    assert.equal(handle.taskId, 'browser-task-visible-1')
    assert.equal(started.length, 1)
    assert.equal(started[0]?.scopeId, 'scope-collection-1')
    assert.equal(started[0]?.payload.outputRootDir, '/tmp/ao-i')
    assert.equal(started[0]?.payload.highControl, true)
    assert.equal(started[0]?.payload.ownerAgentId, 'analyst')
    assert.equal(started[0]?.payload.ownerRunId, 'run-collection-1')
    assert.equal(started[0]?.payload.parentTaskId, 'task-agent-1')
  })
})

describe('browser_download_collected_media', () => {
  it('downloads media from a completed image_gallery source task with the source page as Referer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ready-collected-media-'))
    const calls: Array<{ url: string; sourcePageUrl?: string | null; suggestedName?: string | null }> = []
    try {
      const controller = createControllerMock({
        getTask: async () => ({
          taskId: 'browser-task-gallery-1',
          kind: 'visible_collect',
          status: 'completed',
          progress: { total: 2, completed: 0, failed: 0, currentLabel: null },
          result: {
            template: 'image_gallery',
            discoveryStatus: 'complete',
            targetUrl: 'https://www.xiaohongshu.com/explore/source-note',
            mediaCandidates: ['https://sns-img.xhscdn.com/a.webp', 'https://sns-img.xhscdn.com/b.webp'],
          },
        }) as never,
        getTaskPayload: () => ({ scopeId: 'scope-media', template: 'image_gallery' }),
        downloadUrlToDirectory: async (payload: { url: string; sourcePageUrl?: string | null; suggestedName?: string | null }) => {
          calls.push(payload)
          return { success: true, savePath: join(dir, `${payload.suggestedName}.webp`), filename: `${payload.suggestedName}.webp` }
        },
      })

      const out = await executeBrowserTool(
        'browser_download_collected_media',
        { source_task_id: 'browser-task-gallery-1', directory: dir },
        controller,
        undefined,
        'scope-media',
      )
      const parsed = (typeof out === 'string'
        ? parseTool(out)
        : out.data || parseTool(out.text)) as { ok?: boolean; success?: number; mediaCandidateCount?: number }

      assert.equal(parsed.ok, true)
      assert.equal(parsed.success, 2)
      assert.equal(parsed.mediaCandidateCount, 2)
      assert.deepEqual(calls.map((call) => call.url), ['https://sns-img.xhscdn.com/a.webp', 'https://sns-img.xhscdn.com/b.webp'])
      assert.equal(calls[0]?.sourcePageUrl, 'https://www.xiaohongshu.com/explore/source-note')
      assert.equal(calls[0]?.suggestedName, 'image-1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses non-image-gallery and empty source tasks', async () => {
    const controller = createControllerMock({
      getTask: async (taskId: string) => ({
        taskId,
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 0, completed: 0, failed: 0, currentLabel: null },
        result: taskId === 'browser-task-empty'
          ? { template: 'image_gallery', discoveryStatus: 'complete', mediaCandidates: [] }
          : { template: 'card_list', discoveryStatus: 'complete', noteCandidates: [{ url: 'https://example.com/1' }] },
      }) as never,
      getTaskPayload: (taskId: string) => ({ template: taskId === 'browser-task-empty' ? 'image_gallery' : 'card_list' }),
    })

    const wrongKind = parseTool(await executeBrowserTool(
      'browser_download_collected_media',
      { source_task_id: 'browser-task-not-gallery', directory: '/tmp/out' },
      controller,
    )) as { errorCode?: string }
    const empty = parseTool(await executeBrowserTool(
      'browser_download_collected_media',
      { source_task_id: 'browser-task-empty', directory: '/tmp/out' },
      controller,
    )) as { errorCode?: string }

    assert.equal(wrongKind.errorCode, 'source_task_not_image_gallery')
    assert.equal(empty.errorCode, 'source_task_has_no_media')
  })
})

describe('browser task id guardrails', () => {
  it('rejects chat and skill task ids for browser_get_task / browser_resume_task / browser_cancel_task with an actionable status', async () => {
    let resumeCalls = 0
    const controller = createControllerMock({
      getTask: async () => null,
      cancelTask: async () => null,
      resumeTask: async () => {
        resumeCalls += 1
        return null
      },
    })
    const getResult = await executeBrowserTool('browser_get_task', { task_id: 'task-chat-1' }, controller)
    const cancelResult = await executeBrowserTool('browser_cancel_task', { task_id: 'task-chat-1' }, controller)
    const resumeChatResult = await executeBrowserTool('browser_resume_task', { task_id: 'task-0db610cf-c6f1-4f8e-ae71-d881959d529b' }, controller)
    const resumeSkillResult = await executeBrowserTool('browser_resume_task', { task_id: 'skill-child:vez51e5su' }, controller)

    assert.equal((parseTool(getResult) as { status: string }).status, 'wrong_id_type')
    assert.equal((parseTool(cancelResult) as { status: string }).status, 'wrong_id_type')
    assert.equal((parseTool(resumeChatResult) as { status: string }).status, 'wrong_id_type')
    assert.equal((parseTool(resumeSkillResult) as { status: string }).status, 'wrong_id_type')
    assert.equal(resumeCalls, 0)
  })
})
