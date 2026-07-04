import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { BrowserAutomationService } from '../main/modules/browser-engine/automation-service'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-frame-penetration declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-frame-penetration transitive sqlite load')
})

// D10 frame 穿透（2026-07-04）：真机 R1 实锚——XHS 创作页"写长文"tab 在
// iframe 内，click_text/read_page_map/act_on_target 全部主帧单帧执行导致
// 永远 not found。本文件钉住：帧枚举/帧内执行原语、map 子帧合并（targetId
// 带 frameKey）、act 按 frameKey 路由、click_text 主帧 miss 后子帧回退。

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
    identity: { url: PAGE, title: 'Creator' },
    viewport: { width: 1000, height: 800 },
    bodyText: '上传视频',
    rawRoots: [{ role: 'generic', name: '', children: [
      { role: 'button', name: '上传视频', backendDOMNodeId: 1, frameId: '0' },
    ] }],
    structureHints: { iframes: [], shadowRoots: [], hiddenLoaded: [] },
    riskFlags: {},
  }
}

function frameProbePayload() {
  return {
    identity: { url: 'https://example.com/embed', title: 'embed' },
    viewport: { width: 900, height: 700 },
    bodyText: '写长文',
    rawRoots: [{ role: 'generic', name: '', children: [
      { role: 'tab', name: '写长文', backendDOMNodeId: 1, frameId: '0' },
    ] }],
    structureHints: { iframes: [], shadowRoots: [], hiddenLoaded: [] },
    riskFlags: {},
  }
}

interface FrameCall { frameKey: string; marker: string }

function makeFrameAwareController(options?: {
  frameGone?: boolean
}): { controller: BrowserController; frameCalls: FrameCall[] } {
  const frameCalls: FrameCall[] = []
  const markerOf = (code: string): string => {
    if (code.includes('__READY_AGENT_PAGE_MAP__')) return 'page_map'
    if (code.includes('__READY_AGENT_TARGET_PROBE__')) return 'target_probe'
    if (code.includes('__READY_AGENT_ACT_ON_TARGET__')) return 'act_on_target'
    if (code.includes('Clicked by text')) return 'click_by_text'
    return 'other'
  }
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'T', url: PAGE, active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'T', url: PAGE, active: true }],
    getPageContent: async () => '上传视频',
    executeJS: async (_tabId: string | null, code: string) => {
      const marker = markerOf(code)
      if (marker === 'page_map') return mainProbePayload()
      if (marker === 'click_by_text') return 'Element by text not found: 写长文'
      if (code.includes('readyState')) return 'complete'
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
      if (marker === 'target_probe') return { matchCount: 1, disabled: false, target: { role: 'tab', name: '写长文' } }
      if (marker === 'act_on_target') return { ok: true, did: 'click' }
      if (marker === 'click_by_text') return 'Clicked by text: 写长文'
      return null
    },
  } as unknown as BrowserController
  return { controller, frameCalls }
}

function parseToolJson(out: unknown): Record<string, unknown> {
  if (typeof out === 'string') return JSON.parse(out) as Record<string, unknown>
  return (out as { data?: unknown }).data as Record<string, unknown>
}

test('browser_read_page_map 合并子帧目标：targetId 带 frameKey，图上出现 iframe 分组', async () => {
  const { controller, frameCalls } = makeFrameAwareController()
  const out = await executeBrowserTool('browser_read_page_map', {}, controller)
  const parsed = parseToolJson(out)
  const pageMap = parsed.pageMap as { text: string; targets: Array<{ targetId: string; name: string }> }
  assert.ok(frameCalls.some((c) => c.marker === 'page_map' && c.frameKey === '7-21'), '子帧应被 probe')
  const frameTarget = pageMap.targets.find((t) => t.name === '写长文')
  assert.ok(frameTarget, '子帧内目标必须进入 map')
  assert.match(frameTarget.targetId, /^\d+:7-21:1$/)
  assert.match(pageMap.text, /- iframe "https:\/\/example\.com\/embed"/)
  const evidence = parsed.evidence as { frames?: Array<{ frameKey: string; targetCount: number }> }
  assert.equal(evidence.frames?.[0]?.frameKey, '7-21')
  assert.equal(evidence.frames?.[0]?.targetCount, 1)
})

test('browser_act_on_target 按 targetId 的 frameKey 把 probe 与 act 路由回子帧', async () => {
  const { controller, frameCalls } = makeFrameAwareController()
  const mapOut = await executeBrowserTool('browser_read_page_map', {}, controller)
  const pageMap = parseToolJson(mapOut).pageMap as { targets: Array<{ targetId: string; name: string }> }
  const targetId = pageMap.targets.find((t) => t.name === '写长文')!.targetId
  const out = await executeBrowserTool('browser_act_on_target', { target_id: targetId, action: 'click', read_back: 'none' }, controller)
  const parsed = parseToolJson(out)
  assert.equal(parsed.ok, true)
  const probeCall = frameCalls.find((c) => c.marker === 'target_probe')
  const actCall = frameCalls.find((c) => c.marker === 'act_on_target')
  assert.equal(probeCall?.frameKey, '7-21', 'live probe 必须在目标所属帧执行')
  assert.equal(actCall?.frameKey, '7-21', 'act 必须在目标所属帧执行')
})

test('browser_act_on_target 帧已消失时收 stale_page_map，提示重读 map', async () => {
  const alive = makeFrameAwareController()
  const mapOut = await executeBrowserTool('browser_read_page_map', {}, alive.controller)
  const pageMap = parseToolJson(mapOut).pageMap as { targets: Array<{ targetId: string; name: string }> }
  const targetId = pageMap.targets.find((t) => t.name === '写长文')!.targetId
  // 同一 controller 引用保持 map generation，之后帧消失
  ;(alive.controller as unknown as { executeJSInFrame: unknown }).executeJSInFrame = async () => {
    throw Object.assign(new Error('Frame 7-21 is no longer present on this page'), { code: 'FRAME_NOT_FOUND' })
  }
  const out = await executeBrowserTool('browser_act_on_target', { target_id: targetId, action: 'click', read_back: 'none' }, alive.controller)
  const parsed = parseToolJson(out)
  assert.ok(isAgentBrowserError(parsed), '应返回结构化错误')
  assert.equal((parsed as { errorCode?: string }).errorCode, 'stale_page_map')
  assert.match(String((parsed as { message?: string }).message || ''), /read_page_map/)
})

test('browser_click_text 主帧 miss 后子帧 JS click 命中，输出带 frame 字段', async () => {
  const { controller, frameCalls } = makeFrameAwareController()
  const out = await executeBrowserTool('browser_click_text', { text: '写长文' }, controller)
  const parsed = parseToolJson(out)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.clickedDirect, true)
  assert.equal(parsed.frame, '7-21')
  assert.ok(frameCalls.some((c) => c.marker === 'click_by_text' && c.frameKey === '7-21'))
})

test('browser_click_text 全帧 miss：错误文案标注已搜索的帧数', async () => {
  const { controller } = makeFrameAwareController()
  ;(controller as unknown as { executeJSInFrame: unknown }).executeJSInFrame = async () => 'Element by text not found: 写长文'
  const out = await executeBrowserTool('browser_click_text', { text: '写长文' }, controller)
  assert.match(String(out), /Element by text not found/)
  assert.match(String(out), /1 个子帧/)
})
