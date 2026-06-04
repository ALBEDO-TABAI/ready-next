import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { BrowserTaskPlanner } from '../main/modules/agent-control/domain-adapters/browser-task-planner'
import {
  __resetSessionContinuityForTests,
  __setSessionContinuityStoragePathForTests,
} from '../main/modules/agent-control/session/session-continuity'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

const TEST_CONTINUITY_PATH = join(tmpdir(), 'ready-browser-tools-continuity.json')

beforeEach(() => {
  __setSessionContinuityStoragePathForTests(TEST_CONTINUITY_PATH)
  __resetSessionContinuityForTests()
})

afterEach(() => {
  __resetSessionContinuityForTests()
  __setSessionContinuityStoragePathForTests(null)
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
  it('browser_click_at should clamp normalized coordinates', async () => {
    const controller = createControllerMock()
    const result = await executeBrowserTool('browser_click_at', { x: -20, y: 1800 }, controller)
    const payload = JSON.parse(result) as { normalized: { x: number; y: number } }

    assert.strictEqual(payload.normalized.x, 0)
    assert.strictEqual(payload.normalized.y, 999)
    assert.ok(controller.calls.mouse.length >= 3)
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
    const controller = createControllerMock({
      startNoteCollection: async (plan: Record<string, unknown>) => {
        started.push(plan)
        return { taskId: 'task-note-1', kind: 'note_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
      },
    })
    const result = await executeBrowserTool(
      'browser_collect_notes',
      {
        target_profile_url: 'https://www.xiaohongshu.com/user/profile/abc123',
        notes: [
          { url: 'https://www.xiaohongshu.com/note/1', title: '笔记一' },
          { url: 'not-a-url' }, // dropped (no http)
          { url: 'https://www.xiaohongshu.com/note/2' },
        ],
        max_notes: 50,
      },
      controller,
    )
    const handle = JSON.parse(result) as { taskId: string }
    assert.equal(handle.taskId, 'task-note-1')
    assert.equal(started.length, 1)
    const plan = started[0] as { notes: Array<{ url: string }>; targetProfileUrl: string; outputRootDir: string; stopConditions?: { maxNotes?: number } }
    assert.equal(plan.notes.length, 2, 'the non-http note is dropped')
    assert.deepEqual(plan.notes.map((n) => n.url), ['https://www.xiaohongshu.com/note/1', 'https://www.xiaohongshu.com/note/2'])
    assert.equal(plan.stopConditions?.maxNotes, 50)
    assert.ok(plan.outputRootDir.includes('abc123'), 'derives the output folder from the profile slug')
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
})
