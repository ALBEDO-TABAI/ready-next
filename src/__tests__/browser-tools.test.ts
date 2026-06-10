import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import {
  __resetBrowserAgentPageMapForTests,
  __setBrowserCollectionConsentStoreForTests,
  executeBrowserTool,
} from '../main/modules/tools/browser-tools'
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
    ...(overrides || {}),
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
                children: [
                  { role: 'button', name: 'Search', backendDOMNodeId: 1, frameId: '0' },
                  { role: 'button', name: 'Search', backendDOMNodeId: 2, frameId: '0' },
                  { role: 'textbox', name: 'Query', backendDOMNodeId: 3, frameId: '0' },
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
    const payload = JSON.parse(result) as {
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
    assert.strictEqual(payload.pageMap.targets.length, 3)
    assert.strictEqual(payload.pageMap.targets[0]?.targetId, '1:0:1')
    assert.deepStrictEqual(payload.pageMap.structureHints, { iframes: [], shadowRoots: [], hiddenLoaded: [] })
    assert.strictEqual(payload.ambiguityGroups.length, 1)
    assert.strictEqual(payload.ambiguityGroups[0]?.name, 'Search')
    assert.deepStrictEqual(payload.ambiguityGroups[0]?.targetIds, ['1:0:1', '1:0:2'])
    assert.strictEqual(payload.riskFlags.externalLinkCount, 1)
    assert.deepStrictEqual(payload.evidence, {
      generation: 1,
      targetSource: 'dom-target-library',
      targetCount: 3,
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
            rawRoots: [{ role: 'generic', children: [{ role: 'textbox', name: 'Query', backendDOMNodeId: 1, frameId: '0' }] }],
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
    const stalePayload = JSON.parse(stale) as { ok: boolean; errorCode: string }
    assert.strictEqual(stalePayload.ok, false)
    assert.strictEqual(stalePayload.errorCode, 'stale_page_map')

    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool('browser_probe_readonly', { generation: 1, query: 'query', scope: 'forms' }, controller)
    const payload = JSON.parse(result) as { ok: boolean; scope: string; nodes: Array<{ text: string }> }
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
    const payload = JSON.parse(result) as { ok: boolean; errorCode: string; detail?: Record<string, unknown> }

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
            rawRoots: [{ role: 'generic', children: [{ role: 'textbox', name: 'Query', backendDOMNodeId: 1, frameId: '0' }] }],
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
    const stalePayload = JSON.parse(stale) as { ok: boolean; errorCode: string }
    assert.strictEqual(stalePayload.ok, false)
    assert.strictEqual(stalePayload.errorCode, 'stale_page_map')

    await executeBrowserTool('browser_read_page_map', {}, controller)
    const result = await executeBrowserTool('browser_act_on_target', { target_id: '1:0:1', action: 'fill', value: 'hello' }, controller)
    const payload = JSON.parse(result) as { ok: boolean; action: string; readBack: string; changed: boolean; failureKind: string | null; result: { ok?: boolean } }

    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.action, 'fill')
    assert.strictEqual(payload.readBack, 'delta')
    assert.strictEqual(payload.changed, false)
    assert.strictEqual(payload.failureKind, null)
    assert.strictEqual(payload.result.ok, true)
    assert.ok(calls.some((source) => source.includes('__READY_AGENT_ACT_ON_TARGET__')))
  })

  it('browser_click_at should clamp normalized coordinates', async () => {
    const controller = createControllerMock()
    const result = await executeBrowserTool('browser_click_at', { x: -20, y: 1800 }, controller)
    const payload = JSON.parse(result) as { normalized: { x: number; y: number } }

    assert.strictEqual(payload.normalized.x, 0)
    assert.strictEqual(payload.normalized.y, 999)
    assert.ok(controller.calls.mouse.length >= 3)
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
    const payload = JSON.parse(result) as { ok: boolean; normalized: { x: number; y: number } }

    assert.strictEqual(payload.ok, true)
    assert.deepStrictEqual(payload.normalized, { x: 500, y: 400 })
    assert.ok(controller.calls.mouse.length >= 3)
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
    const payload = JSON.parse(result) as { ok: boolean; clickedDirect: boolean; normalized: { x: number; y: number } }

    assert.strictEqual(payload.ok, true)
    assert.strictEqual(payload.clickedDirect, false)
    assert.ok(locateCode.includes('hrefCandidates'))
    assert.ok(locateCode.includes("matched.setAttribute('target', '_self')"))
    assert.ok(locateCode.includes('.sort((a, b) => b.area - a.area)'))
    assert.deepStrictEqual(payload.normalized, { x: 640, y: 450 })
    assert.ok(controller.calls.mouse.length >= 3)
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
	    const payload = JSON.parse(result) as { count: number; scope?: string }

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
      const payload = JSON.parse(result) as { count: number; scope?: string; images: Array<{ url: string }> }
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
      const payload = JSON.parse(result) as { count: number; expectedImageCount?: number; images: Array<{ url: string }> }

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
      const payload = JSON.parse(result) as { count: number; videoCount: number; scope?: string; videos: Array<{ posterUrl?: string }> }

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
      const payload = JSON.parse(result) as { videoCount: number; videos: Array<{ url?: string }> }

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
    const payload = JSON.parse(result) as { ok: boolean; video: { parseStatus: string; downloadUrl?: string; posterUrl?: string; platform?: string } }

    assert.equal(payload.ok, true)
    assert.equal(payload.video.parseStatus, 'not_needed')
    assert.equal(payload.video.downloadUrl, 'https://sns-video.xhscdn.com/video.mp4')
    assert.equal(payload.video.posterUrl, 'https://sns-webpic-qc.xhscdn.com/poster.webp')
    assert.equal(payload.video.platform, 'xiaohongshu')
  })

  it('browser_type_at should clear, type and send enter by default', async () => {
    const controller = createControllerMock()
    const result = await executeBrowserTool('browser_type_at', { x: 500, y: 900, text: '今晚吃什么' }, controller)
    const payload = JSON.parse(result) as { submitted: boolean; text_length: number }

    assert.strictEqual(payload.submitted, true)
    assert.strictEqual(payload.text_length, 5)
    assert.ok(controller.calls.typed.some((item) => item.text === '今晚吃什么'))
    assert.ok(controller.calls.key.some((item) => String(item.key || '').toLowerCase() === 'backspace'))
    assert.ok(controller.calls.key.some((item) => String(item.key || '').toLowerCase() === 'enter'))
  })

  it('browser_query_gemini should fallback to coordinate typing when DOM compose fails', async () => {
    const controller = createControllerMock()
    const result = await executeBrowserTool('browser_query_gemini', { text: '今晚吃什么', wait_response_ms: 5000 }, controller)
    const payload = JSON.parse(result) as {
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
    const payload = JSON.parse(result) as {
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
    const payload = JSON.parse(result) as { items: Array<{ title?: string }> }

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
    const startPayload = JSON.parse(startResult) as { taskId?: string; progress?: { completed?: number } }

    const getResult = await executeBrowserTool('browser_get_task', { task_id: 'task-1' }, controller)
    const getPayload = JSON.parse(getResult) as { status?: string; progress?: { currentLabel?: string } }

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

    assert.strictEqual((JSON.parse(resumeResult) as { status?: string }).status, 'running')
    assert.strictEqual((JSON.parse(cancelResult) as { status?: string }).status, 'cancelled')
    assert.strictEqual((JSON.parse(aggregateResult) as Array<{ title?: string }>).length, 1)
  })

  it('browser_resume_task starts card_loop when resuming a completed high-control discovery task', async () => {
    const started: Array<Record<string, unknown>> = []
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
      startCardLoopCollection: async (plan: Record<string, unknown>, scopeId?: string) => {
        started.push({ ...plan, scopeId })
        return { taskId: 'browser-task-card-from-resume', kind: 'card_loop', status: 'running', progress: { total: 2, completed: 0, failed: 0, currentLabel: 'One' } } as never
      },
      resumeTask: async () => {
        throw new Error('completed visible discovery should not call plain resumeTask')
      },
    } as Partial<BrowserController>)

    const result = await executeBrowserTool(
      'browser_resume_task',
      { task_id: 'browser-task-visible-xhs-resume' },
      controller,
      undefined,
      'scope-xhs-resume',
    )

    assert.equal((JSON.parse(result) as { taskId?: string }).taskId, 'browser-task-card-from-resume')
    assert.equal(started.length, 1)
    const plan = started[0] as { strategy?: string; expectedCount?: number; sourceTaskId?: string; outputRootDir?: string; notes?: unknown[]; scopeId?: string }
    assert.equal(plan.strategy, 'card_loop')
    assert.equal(plan.expectedCount, 2)
    assert.equal(plan.sourceTaskId, 'browser-task-visible-xhs-resume')
    assert.equal(plan.outputRootDir, '/tmp/ready-xhs-out')
    assert.equal(plan.notes?.length, 2)
    assert.equal(plan.scopeId, 'scope-xhs-resume')
  })

  it('browser_get_task hands off a completed high-control discovery task to card_loop', async () => {
    const started: Array<Record<string, unknown>> = []
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
      startCardLoopCollection: async (plan: Record<string, unknown>, scopeId?: string) => {
        started.push({ ...plan, scopeId })
        return { taskId: 'browser-task-card-from-get', kind: 'card_loop', status: 'running', progress: { total: 2, completed: 0, failed: 0, currentLabel: 'One' } } as never
      },
    } as Partial<BrowserController>)

    const result = await executeBrowserTool(
      'browser_get_task',
      { task_id: 'browser-task-visible-xhs-get' },
      controller,
      undefined,
      'scope-xhs-get',
    )

    assert.equal((JSON.parse(result) as { taskId?: string }).taskId, 'browser-task-card-from-get')
    assert.equal(started.length, 1)
    const plan = started[0] as { strategy?: string; sourceTaskId?: string; outputRootDir?: string; scopeId?: string }
    assert.equal(plan.strategy, 'card_loop')
    assert.equal(plan.sourceTaskId, 'browser-task-visible-xhs-get')
    assert.equal(plan.outputRootDir, '/tmp/ready-xhs-out')
    assert.equal(plan.scopeId, 'scope-xhs-get')
  })

  it('browser_get_task reuses an existing downstream collection for a completed discovery task', async () => {
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

    assert.equal((JSON.parse(result) as { taskId?: string }).taskId, 'browser-task-card-existing')
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

    assert.strictEqual((JSON.parse(galleryResult) as { taskId?: string }).taskId, 'gallery-task')
    assert.strictEqual((JSON.parse(researchResult) as { taskId?: string }).taskId, 'research-task')
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
    )
    const handle = JSON.parse(result) as { taskId: string }
    assert.equal(handle.taskId, 'task-note-1')
    assert.equal(synthetic.length, 1)
    assert.equal(started.length, 1)
    const plan = started[0] as { notes: Array<{ url: string }>; targetProfileUrl: string; outputRootDir: string; sourceTaskId?: string; stopConditions?: { maxNotes?: number } }
    assert.equal(plan.sourceTaskId, 'browser-task-synthetic-1')
    assert.equal(plan.notes.length, 2, 'the non-http note is dropped')
    assert.deepEqual(plan.notes.map((n) => n.url), ['https://example.com/note/1', 'https://example.com/note/2'])
    assert.equal(plan.stopConditions?.maxNotes, 50)
    assert.ok(plan.outputRootDir.includes('abc123'), 'derives the output folder from the profile slug')
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

    const parsed = JSON.parse(result) as { errorCode?: string; missingUrls?: string[] }
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
    assert.match(result, /至少一条/)
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

    assert.equal((JSON.parse(result) as { taskId: string }).taskId, 'task-note-2')
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

    const parsed = JSON.parse(result) as { ok: boolean; errorCode: string }
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
    const outputMismatch = JSON.parse(outputMismatchResult) as { ok: boolean; errorCode: string }
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

    assert.match(result, /不是完整全量/)
    assert.match(result, /browser_resume_task/)
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
    const pending = (JSON.parse(first) as { pendingConsentRequest?: { requestId?: string } }).pendingConsentRequest
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
    assert.equal((JSON.parse(confirmed) as { ok?: boolean }).ok, true)

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

    assert.equal((JSON.parse(second) as { taskId?: string }).taskId, 'task-note-after-consent')
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

    assert.match(result, /数量不一致/)
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

    assert.match(result, /source_task_id/)
    assert.match(result, /31/)
    assert.match(result, /12/)
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

    const parsed = JSON.parse(result) as {
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

    const parsed = JSON.parse(first) as {
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

    const parsed = JSON.parse(result) as {
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
    const pending = (JSON.parse(first) as { pendingConsentRequest?: { requestId?: string } }).pendingConsentRequest
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

    assert.equal((JSON.parse(second) as { taskId?: string }).taskId, 'task-xhs-url-batch')
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

    assert.equal((JSON.parse(result) as { taskId?: string }).taskId, 'task-card-loop')
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
          assert.ok(source.includes('const directHrefClick = false'))
          return { ok: true, text: '笔记一', clickedDirect: false, cssX: 120, cssY: 220, width: 1000, height: 800 }
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
    )

    const handle = JSON.parse(result) as { taskId: string }
    assert.equal(handle.taskId, 'browser-task-visible-1')
    assert.equal(started.length, 1)
    assert.equal(started[0]?.scopeId, 'scope-collection-1')
    assert.equal(started[0]?.payload.outputRootDir, '/tmp/ao-i')
    assert.equal(started[0]?.payload.highControl, true)
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
      const parsed = JSON.parse(out) as { ok?: boolean; success?: number; mediaCandidateCount?: number }

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

    const wrongKind = JSON.parse(await executeBrowserTool(
      'browser_download_collected_media',
      { source_task_id: 'browser-task-not-gallery', directory: '/tmp/out' },
      controller,
    )) as { errorCode?: string }
    const empty = JSON.parse(await executeBrowserTool(
      'browser_download_collected_media',
      { source_task_id: 'browser-task-empty', directory: '/tmp/out' },
      controller,
    )) as { errorCode?: string }

    assert.equal(wrongKind.errorCode, 'source_task_not_image_gallery')
    assert.equal(empty.errorCode, 'source_task_has_no_media')
  })
})

describe('browser task id guardrails', () => {
  it('rejects chat task ids for browser_get_task / browser_cancel_task with an actionable status', async () => {
    const controller = createControllerMock({
      getTask: async () => null,
      cancelTask: async () => null,
    })
    const getResult = await executeBrowserTool('browser_get_task', { task_id: 'task-chat-1' }, controller)
    const cancelResult = await executeBrowserTool('browser_cancel_task', { task_id: 'task-chat-1' }, controller)

    assert.equal((JSON.parse(getResult) as { status: string }).status, 'wrong_id_type')
    assert.equal((JSON.parse(cancelResult) as { status: string }).status, 'wrong_id_type')
  })
})
