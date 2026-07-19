import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { BrowserAutomationService } from '../main/modules/browser-engine/automation-service'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import { parseBrowserSnapshotRef } from '../main/modules/browser-engine/browser-snapshot-service'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-frame-penetration declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-frame-penetration transitive sqlite load')
})

// Frame traversal contract: every child frame gets its own lifecycle identity,
// snapshot references route back to that frame, and stale frames fail closed.

// ---------- automation-service 原语 ----------

interface FakeFrame {
  processId: number
  routingId: number
  url: string
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>
}

function makeService(subframes: FakeFrame[], mainExec: (code: string) => Promise<unknown>) {
  const mainFrame = {
    processId: 1,
    routingId: 1,
    url: 'https://top.example/',
    executeJavaScript: async (code: string) => mainExec(code),
    framesInSubtree: [] as unknown[],
  }
  mainFrame.framesInSubtree = [mainFrame, ...subframes]
  const view = {
    webContents: {
      mainFrame,
      executeJavaScript: async (code: string) => mainExec(code),
    },
  }
  return new BrowserAutomationService({
    resolveTabView: () => ({ tabId: 'tab-1', tab: { id: 'tab-1', url: 'https://top.example/', title: 'T' }, view: view as never }),
    createBrowserError: (code, message) => Object.assign(new Error(message), { code }),
    getViewBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  })
}

function makeFrame(processId: number, routingId: number, url: string, log: string[]): FakeFrame {
  return {
    processId,
    routingId,
    url,
    executeJavaScript: async (code: string) => {
      log.push(`${processId}-${routingId}:${code.slice(0, 30)}`)
      return `ran-in-${processId}-${routingId}`
    },
  }
}

test('listContentFrames：主帧 key=0，子帧 pid-rid，含 url', () => {
  const log: string[] = []
  const service = makeService([makeFrame(7, 21, 'https://embed.example/app', log)], async () => 'main')
  const frames = service.listContentFrames('tab-1')
  assert.deepEqual(frames, [
    { frameKey: '0', url: 'https://top.example/', main: true },
    { frameKey: '7-21', url: 'https://embed.example/app', main: false },
  ])
})

test('executeJSInFrame：0 走主帧路径，pid-rid 路由到对应子帧', async () => {
  const log: string[] = []
  const service = makeService([makeFrame(7, 21, 'https://embed.example/app', log)], async () => 'main-ran')
  assert.equal(await service.executeJSInFrame('tab-1', '0', '1+1'), 'main-ran')
  assert.equal(await service.executeJSInFrame('tab-1', '7-21', '2+2'), 'ran-in-7-21')
  assert.equal(log.length, 1)
  assert.match(log[0], /^7-21:/)
})

test('executeJSInFrame：帧不存在抛 FRAME_NOT_FOUND', async () => {
  const service = makeService([], async () => 'main-ran')
  await assert.rejects(
    () => service.executeJSInFrame('tab-1', '9-99', '1+1'),
    (error: Error & { code?: string }) => error.code === 'FRAME_NOT_FOUND',
  )
})

// ---------- 工具链：map 合并 / act 路由 / click_text 回退 ----------

const PAGE = 'https://example.com/creator'

function mainProbePayload() {
  return {
    identity: { url: PAGE, title: 'Creator', frameDocumentToken: 'document-main' },
    viewport: { width: 1000, height: 800 },
    bodyText: '上传视频',
    rawRoots: [{ role: 'generic', name: '', children: [
      { role: 'button', name: '上传视频', stableNodeToken: 'h1', frameId: '0', frameDocumentToken: 'document-main' },
    ] }],
    structureHints: { iframes: [], shadowRoots: [], hiddenLoaded: [] },
    riskFlags: {},
  }
}

function frameProbePayload() {
  return {
    identity: { url: 'https://example.com/embed', title: 'embed', frameDocumentToken: 'document-frame' },
    viewport: { width: 900, height: 700 },
    bodyText: '写长文',
    rawRoots: [{ role: 'generic', name: '', children: [
      { role: 'tab', name: '写长文', stableNodeToken: 'h1', frameId: '0', frameDocumentToken: 'document-frame' },
      { role: 'textbox', name: '查询', stableNodeToken: 'h2', frameId: '0', frameDocumentToken: 'document-frame' },
    ] }],
    structureHints: { iframes: [], shadowRoots: [], hiddenLoaded: [] },
    riskFlags: {},
  }
}

interface FrameCall { frameKey: string; marker: string }

function makeFrameAwareController(options?: {
  frameGone?: boolean
}): {
  controller: BrowserController
  frameCalls: FrameCall[]
  mouse: Array<Record<string, unknown>>
  typed: string[]
} {
  const frameCalls: FrameCall[] = []
  const mouse: Array<Record<string, unknown>> = []
  const typed: string[] = []
  const markerOf = (code: string): string => {
    if (code.includes('__READY_AGENT_PAGE_MAP__')) return 'page_map'
    if (code.includes('__READY_AGENT_TARGET_SELECT_ALL__')) return 'target_select_all'
    if (code.includes('__READY_AGENT_TARGET_FOCUS__')) return 'target_focus'
    if (code.includes('__READY_AGENT_TARGET_PROBE__')) return 'target_probe'
    if (code.includes('__READY_FOCUSED_EDITABLE_PROBE__')) return 'focused_probe'
    if (code.includes('__READY_TYPED_INTO_PROBE__')) return 'typed_probe'
    if (code.includes('__readyBrowserTargetIdentityV3')) return 'document_identity'
    if (code.includes('const target = ')) return 'click_by_text'
    return 'other'
  }
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'T', url: PAGE, active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'T', url: PAGE, active: true }],
    getPhysicalTargetToken: () => 'physical-frame-test',
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: true,
      hostPresentation: 'visible',
      tabActive: true,
    }),
    getViewportMetrics: async () => ({ width: 1000, height: 800, deviceScaleFactor: 1 }),
    normalizedToCss: async (_tabId: string | null, x: number, y: number) => ({ x, y, width: 1000, height: 800 }),
    dispatchMouse: async (_tabId: string | null, event: Record<string, unknown>) => { mouse.push(event) },
    dispatchKey: async () => undefined,
    typeTextDirectly: async (_tabId: string | null, text: string) => { typed.push(text) },
    getPageContent: async () => '上传视频',
    executeJS: async (_tabId: string | null, code: string) => {
      const marker = markerOf(code)
      if (marker === 'document_identity') {
        return { url: PAGE, title: 'Creator', timeOrigin: 10, mutationRevision: 0, frameDocumentToken: 'document-main' }
      }
      if (marker === 'page_map') return mainProbePayload()
      if (marker === 'click_by_text') return { ok: false, error: 'Element by text not found: 写长文' }
      if (code.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
        return { label: '目标', inputLabel: '', password: false, fileInput: false, editable: false, tag: 'button', url: PAGE }
      }
      if (code.includes('__READY_AGENT_INPUT_DELIVERY_PROBE__')) return 'delivery-frame-test'
      if (code.includes('Number(state.count')) return 1
      if (code.includes('activeElementEditable')) return { ready: true, focused: true, activeElementEditable: true }
      if (code.includes('document.readyState')) return { readyState: 'complete', bodyTextLen: 20, matched: false }
      return { ok: false, error: 'Element by text not found: 写长文' }
    },
    listContentFrames: () => [
      { frameKey: '0', url: PAGE, main: true },
      { frameKey: '7-21', url: 'https://example.com/embed', main: false },
    ],
    executeJSInFrame: async (_tabId: string | null, frameKey: string, code: string) => {
      const marker = markerOf(code)
      frameCalls.push({ frameKey, marker })
      if (options?.frameGone) {
        throw Object.assign(new Error(`Frame ${frameKey} is no longer present on this page`), { code: 'FRAME_NOT_FOUND' })
      }
      if (marker === 'page_map') return frameProbePayload()
      if (marker === 'document_identity') {
        return { url: 'https://example.com/embed', title: 'embed', timeOrigin: 20, mutationRevision: 0, frameDocumentToken: 'document-frame' }
      }
      if (marker === 'target_probe') {
        return code.includes('const nodeId = "h2"')
          ? { matchCount: 1, disabled: false, target: { role: 'textbox', name: '查询', editable: true, visible: true, enabled: true, box: { x: 200, y: 100, width: 300, height: 40 } } }
          : { matchCount: 1, disabled: false, target: { role: 'tab', name: '写长文', editable: false, visible: true, enabled: true, box: { x: 400, y: 300, width: 100, height: 40 } } }
      }
      if (marker === 'target_focus') return { ok: true, kind: 'editable', tag: 'input', label: '查询' }
      if (marker === 'target_select_all') return { ok: true, kind: 'text_control' }
      if (marker === 'focused_probe') return { kind: 'editable', tag: 'input', label: '查询', maxLength: 100, singleLine: true }
      if (marker === 'typed_probe') return { tag: 'input', label: '查询', textHead: '北欧家具', textLength: 4, textMatchesExpected: true }
      if (marker === 'click_by_text') return { ok: true, text: '写长文', cssX: 450, cssY: 320, width: 900, height: 700 }
      return null
    },
    beginBrowserWorkflowAction: (input: Record<string, unknown>) => ({
      actionId: 'frame-action-1',
      actionSeq: 1,
      operationId: input.operationId,
      ownerRunId: input.ownerRunId,
      argsDigest: input.argsDigest,
      identity: input.identity,
      startedAt: new Date().toISOString(),
    }),
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: Record<string, unknown>) => ({
      receiptId: 'frame-action-receipt-1',
      actionId,
      actionSeq: 1,
      outcome,
    }),
    recordBrowserWorkflowObservation: (input: Record<string, unknown>) => ({
      receiptId: 'frame-observation-1',
      observationSeq: 1,
      operationId: input.operationId,
      ownerRunId: input.ownerRunId,
      observedAfterActionSeq: 0,
      identity: input.identity,
      searchActionId: null,
      queryDigest: null,
      causalActions: [],
      resultDigest: input.resultDigest,
      resourceId: 'frame-resource-1',
      observedAt: new Date().toISOString(),
    }),
  } as unknown as BrowserController
  return { controller, frameCalls, mouse, typed }
}

function parseToolJson(out: unknown): Record<string, unknown> {
  if (typeof out === 'string') return JSON.parse(out) as Record<string, unknown>
  return (out as { data?: unknown }).data as Record<string, unknown>
}

function executeFrameTool(
  toolName: string,
  args: Record<string, unknown>,
  controller: BrowserController,
) {
  return executeBrowserTool(
    toolName,
    args,
    controller,
    undefined,
    'scope-frame-test',
    undefined,
    undefined,
    null,
    {
      ownerRunId: 'run-frame-test',
      browserTaskId: 'browser-task-frame-test',
      parentTaskId: 'parent-frame-test',
      inputSource: 'model',
    },
  )
}

test('browser_snapshot 合并子帧目标：ref 绑定 frameKey，图上出现 iframe 分组', async () => {
  const { controller, frameCalls } = makeFrameAwareController()
  const out = await executeFrameTool('browser_snapshot', {}, controller)
  const parsed = parseToolJson(out)
  const pageMap = parsed.pageMap as { text: string; targets: Array<{ targetId: string; name: string }> }
  assert.ok(frameCalls.some((c) => c.marker === 'page_map' && c.frameKey === '7-21'), '子帧应被 probe')
  const frameTarget = pageMap.targets.find((t) => t.name === '写长文')
  assert.ok(frameTarget, '子帧内目标必须进入 map')
  assert.equal(parseBrowserSnapshotRef(frameTarget.targetId)?.rawTargetId.endsWith(':7-21:h1'), true)
  assert.match(pageMap.text, /- iframe "https:\/\/example\.com\/embed"/)
  const evidence = parsed.evidence as { frames?: Array<{ frameKey: string; targetCount: number }> }
  assert.equal(evidence.frames?.[0]?.frameKey, '7-21')
  assert.equal(evidence.frames?.[0]?.targetCount, 2)
})

test('browser_click 按 target ref 的 frameKey 探测子帧并走可信输入', async () => {
  const { controller, frameCalls, mouse } = makeFrameAwareController()
  const mapOut = await executeFrameTool('browser_snapshot', {}, controller)
  const pageMap = parseToolJson(mapOut).pageMap as { targets: Array<{ targetId: string; name: string }> }
  const targetId = pageMap.targets.find((t) => t.name === '写长文')!.targetId
  const out = await executeFrameTool('browser_click', { target_id: targetId }, controller)
  const parsed = parseToolJson(out)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  const probeCall = frameCalls.find((c) => c.marker === 'target_probe')
  assert.equal(probeCall?.frameKey, '7-21', 'live probe 必须在目标所属帧执行')
  assert.deepEqual(mouse.map((event) => event.type).slice(0, 3), ['mouseMoved', 'mousePressed', 'mouseReleased'])
})

test('browser_type 在隐藏子帧中聚焦 target 后输入，不依赖鼠标命中', async () => {
  const { controller, frameCalls, mouse, typed } = makeFrameAwareController()
  const mapOut = await executeFrameTool('browser_snapshot', {}, controller)
  const pageMap = parseToolJson(mapOut).pageMap as { targets: Array<{ targetId: string; name: string }> }
  const targetId = pageMap.targets.find((target) => target.name === '查询')!.targetId
  const out = await executeFrameTool('browser_type', {
    target_id: targetId,
    text: '北欧家具',
  }, controller)
  const parsed = parseToolJson(out)

  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.deepEqual(typed, ['北欧家具'])
  assert.equal(mouse.length, 0, 'target fill must not require an off-window pointer click')
  for (const marker of ['target_focus', 'target_select_all', 'focused_probe', 'typed_probe']) {
    assert.ok(frameCalls.some((call) => call.marker === marker && call.frameKey === '7-21'), `${marker} must run in the target frame`)
  }
})

test('browser_type 在输入环境预检前拒绝明确不可编辑的 target', async () => {
  const { controller, mouse, typed } = makeFrameAwareController()
  const mapOut = await executeFrameTool('browser_snapshot', {}, controller)
  const pageMap = parseToolJson(mapOut).pageMap as { targets: Array<{ targetId: string; name: string }> }
  const targetId = pageMap.targets.find((target) => target.name === '写长文')!.targetId
  ;(controller as unknown as {
    getBrowserInputEnvironment: () => {
      mainWindowForeground: boolean
      hostPresentation: 'hidden'
      tabActive: boolean
    }
  }).getBrowserInputEnvironment = () => ({
    mainWindowForeground: false,
    hostPresentation: 'hidden',
    tabActive: false,
  })

  const out = await executeFrameTool('browser_type', {
    target_id: targetId,
    text: '北欧家具',
  }, controller)
  const parsed = parseToolJson(out)

  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorCode, 'target_not_editable')
  assert.match(String(parsed.message || ''), /editable field is true/)
  assert.equal(mouse.length, 0)
  assert.equal(typed.length, 0)
})

test('browser_click 帧已消失时收 stale_page_map，提示重读 snapshot', async () => {
  const alive = makeFrameAwareController()
  const mapOut = await executeFrameTool('browser_snapshot', {}, alive.controller)
  const pageMap = parseToolJson(mapOut).pageMap as { targets: Array<{ targetId: string; name: string }> }
  const targetId = pageMap.targets.find((t) => t.name === '写长文')!.targetId
  // 同一 controller 引用保持 map generation，之后帧消失
  ;(alive.controller as unknown as { executeJSInFrame: unknown }).executeJSInFrame = async () => {
    throw Object.assign(new Error('Frame 7-21 is no longer present on this page'), { code: 'FRAME_NOT_FOUND' })
  }
  const out = await executeFrameTool('browser_click', { target_id: targetId }, alive.controller)
  const parsed = parseToolJson(out)
  assert.ok(isAgentBrowserError(parsed), '应返回结构化错误')
  assert.equal((parsed as { errorCode?: string }).errorCode, 'stale_page_map')
  assert.match(String((parsed as { message?: string }).message || ''), /browser_snapshot/)
})

test('browser_click text 主帧 miss 后子帧定位并走可信输入', async () => {
  const { controller, frameCalls } = makeFrameAwareController()
  await executeFrameTool('browser_snapshot', {}, controller)
  const out = await executeFrameTool('browser_click', { text: '写长文' }, controller)
  const parsed = parseToolJson(out)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.clickedDirect, true)
  assert.equal(parsed.frame, '7-21')
  assert.ok(frameCalls.some((c) => c.marker === 'click_by_text' && c.frameKey === '7-21'))
})

test('browser_click text 全帧 miss：错误文案标注已搜索的帧数', async () => {
  const { controller } = makeFrameAwareController()
  await executeFrameTool('browser_snapshot', {}, controller)
  ;(controller as unknown as { executeJSInFrame: unknown }).executeJSInFrame = async () => 'Element by text not found: 写长文'
  const out = await executeFrameTool('browser_click', { text: '写长文' }, controller)
  const parsed = parseToolJson(out)
  assert.match(JSON.stringify(parsed), /Element by text not found/)
  assert.match(JSON.stringify(parsed), /1 个子帧/)
})
