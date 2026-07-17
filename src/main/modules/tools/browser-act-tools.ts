/**
 * P3 Phase B7（2026-07-05，纯移动拆分）— browser-tools 行动/导航组。
 *
 * 从 browser-tools.ts 逐字搬出十六个 case 的实现体（browser_navigate /
 * browser_search / browser_click/browser_type / browser_click / browser_click /
 * browser_type / browser_type / browser_type /
 * browser_find / browser_upload /
 * browser_click / browser_type / browser_scroll / browser_press_key /
 * browser_request_takeover / browser_navigate(action=back)，经 executeBrowserActTool 统一
 * 入口分发）与本组独占 helper（tab 跟随快照、动作前后 delta 回读、搜索引擎
 * URL 与结果解析、click-by-text 帧穿透定位、scope 附件上传的选择/验证/恢复、
 * recentScopeUploads 单例）。runWorkflowStep（与 browser_search /
 * browser_click 同组共享的守卫执行层）随组迁入并 export，browser-tools
 * 侧 import 回引后继续注入 power/collection ctx（零环、最少注入面）。
 * browser_click/browser_type 的 D18 升级块逐字节未动，页面地图 generation/
 * ambiguity 经 act→observe 单向 import 回读。attachBrowserActionSessionOutput
 * （sitePermissionNotices 排空合同红线）留在 browser-tools，经
 * BrowserActToolContext 注入回接；BrowserActionFollowedTab 类型因 facade 的
 * attach 签名同时使用而移入 browser-tool-shared.ts。本模块零反向 import。
 * 行为零变更。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import { existsSync } from 'fs'
import { analyzeViewportWithVision } from './browser-vision'
import { captureBrowserActionReceipt, type BrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import { AgentRepository } from '../repositories/agent-repository'
import { createRotatingLogger } from '../../utils/rotating-logger'
import {
  findRecentBrowserAction,
  rememberBrowserAction,
} from '../agent-control/session/session-continuity'
import { agentBrowserError, isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import { ToolDomainError } from './tool-errors'
import type { BrowserTransactionConfirmation } from '../browser-engine/browser-action-session'
import {
  argsCarryPasswordCue,
  matchBrowserDestructiveTarget,
} from '../agent-control/safety/action-confirmation-policy'
import { ACTION_CONFIRMATION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
import { parseTargetId } from '../browser-engine/agent-browser-page-map'
import { browserSnapshotService } from '../browser-engine/browser-snapshot-service'
import { gateActOnTarget, type AgentBrowserAction, type AgentBrowserReadBack } from '../browser-engine/agent-browser-act'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import {
  createBrowserStructuredOutput as browserStructuredOutput,
  stringifyBrowserJsonOrFailure,
} from './browser-failure-output'
import {
  buildFocusedEditableProbeJs,
  buildBrowserTargetProbeJs,
  buildTargetSemanticsLibraryJs,
  buildTransientNoticeProbeJs,
  throwIfLiveTargetGuardBlocked,
  buildBrowserActionDeltaJs,
} from './browser-probe'
import {
  buildSmartTypeProbeJs,
  resolveCssPoint,
  runGuardedCoordinateClick,
  runGuardedCoordinateType,
  type GuardedCoordinateTypeResult,
  runGuardedSelectorClick,
  runGuardedSelectorType,
  sendKeyStroke,
  settleAfterAction,
  sleepWithAbort,
  throwIfAborted,
  waitForReady,
} from './browser-input-actions'
import {
  describeComposedPointTarget,
  scanClosedShadowHostForClickPoint,
} from './browser-shadow-hit-test'
import {
  captureAgentPageMap,
  currentBrowserPageMapAmbiguity,
  DEFAULT_AGENT_PAGE_MAP_MAX_BYTES,
} from './browser-observe-tools'
import {
  activeBrowserToolUrl,
  activePageLikelyMatchesTarget,
  browserStructuredErrorOutput,
  detectBrowserPageTransactionConfirmation,
  getPageIdentity,
  listSubframesSafe,
  locateActionTargets,
  resolveHighControlAgentTab,
  resolveToolContextMeta,
  truncate,
  uniqueStrings,
  type ActionTargetCandidate,
  type BrowserActionFollowedTab,
} from './browser-tool-shared'

const logger = createRotatingLogger('ready-tools.log', { buffered: true })
function log(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* silent-catch: 日志写入失败不影响主流程。 */ }
}

interface BrowserToolTabSnapshot {
  id: string
  title: string
  url: string
  active: boolean
}

function browserActionResultSucceeded(result: string | ToolExecutionOutput): boolean {
  const data = typeof result === 'string' ? null : result.data
  if (data && typeof data.ok === 'boolean') return data.ok
  const text = typeof result === 'string' ? result : result.text
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; errorKind?: unknown }
    if (typeof parsed.ok === 'boolean') return parsed.ok
    if (typeof parsed.errorKind === 'string' && parsed.errorKind) return false
  } catch {
    // silent-catch: plain-text successes remain valid; explicit error prefixes fail closed.
  }
  return !/^\s*(?:error|failed|failure|错误|失败)\b/i.test(text)
}

export async function runBrowserFillFormSequence(
  fields: unknown[],
  options: { tabId?: unknown; submit: boolean },
  invoke: (operation: string, args: Record<string, unknown>) => Promise<string | ToolExecutionOutput>,
): Promise<Record<string, unknown>> {
  const results: Array<{ index: number; ok: boolean; result: string | ToolExecutionOutput }> = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      return {
        ok: false,
        errorKind: 'invalid_form_field',
        failedIndex: index,
        fields: results,
        submitted: false,
      }
    }
    const item = field as Record<string, unknown>
    const operation = typeof item.target_id === 'string'
      ? 'type_target'
      : typeof item.selector === 'string'
        ? 'type_selector'
        : 'type_smart'
    const result = await invoke(operation, {
      ...item,
      text: String(item.value ?? ''),
      target: item.label,
      tab_id: options.tabId,
      clear_first: true,
    })
    const ok = browserActionResultSucceeded(result)
    results.push({ index, ok, result })
    if (!ok) {
      return {
        ok: false,
        errorKind: 'form_field_failed',
        failedIndex: index,
        fields: results,
        submitted: false,
      }
    }
  }
  if (!options.submit) return { ok: true, fields: results, submitted: false }
  const submitResult = await invoke('press_key', { key: 'Enter', tab_id: options.tabId })
  const submitted = browserActionResultSucceeded(submitResult)
  return {
    ok: submitted,
    ...(!submitted ? { errorKind: 'form_submit_failed' } : {}),
    fields: results,
    submitResult,
    submitted,
  }
}

function snapshotBrowserTabs(controller: BrowserController): BrowserToolTabSnapshot[] {
  try {
    return (controller.getTabList?.() || [])
      .map((tab) => ({
        id: String(tab.id || ''),
        title: String(tab.title || ''),
        url: String(tab.url || ''),
        active: tab.active === true,
      }))
      .filter((tab) => tab.id.length > 0)
  } catch {
    // silent-catch: 读取 tab 列表失败按无 tab 处理。
    return []
  }
}

async function frameViewportOffset(
  controller: BrowserController,
  tabId: string | null,
  frameId: string,
): Promise<{ x: number; y: number }> {
  if (!frameId || frameId === '0') return { x: 0, y: 0 }
  try {
    const owner = await controller.sendCdpCommand(tabId, 'DOM.getFrameOwner', { frameId }) as {
      backendNodeId?: unknown
    }
    const backendNodeId = Number(owner.backendNodeId)
    if (!Number.isFinite(backendNodeId)) return { x: 0, y: 0 }
    const box = await controller.sendCdpCommand(tabId, 'DOM.getBoxModel', { backendNodeId }) as {
      model?: { content?: unknown; border?: unknown }
    }
    const quad = Array.isArray(box.model?.content)
      ? box.model.content.map(Number)
      : Array.isArray(box.model?.border)
        ? box.model.border.map(Number)
        : []
    const xs = quad.filter((_value, index) => index % 2 === 0 && Number.isFinite(quad[index]))
    const ys = quad.filter((_value, index) => index % 2 === 1 && Number.isFinite(quad[index]))
    return xs.length > 0 && ys.length > 0
      ? { x: Math.min(...xs), y: Math.min(...ys) }
      : { x: 0, y: 0 }
  } catch {
    // silent-catch: frame owner geometry is a best-effort offset; callers retain the main-frame point.
    return { x: 0, y: 0 }
  }
}

async function normalizedTargetPoint(
  controller: BrowserController,
  tabId: string | null,
  frameId: string,
  box: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null | undefined,
): Promise<{ x: number; y: number; cssX: number; cssY: number; width: number; height: number } | null> {
  const x = Number(box?.x)
  const y = Number(box?.y)
  const width = Number(box?.width)
  const height = Number(box?.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  const offset = await frameViewportOffset(controller, tabId, frameId)
  const cssX = offset.x + x + width / 2
  const cssY = offset.y + y + height / 2
  const viewport = await controller.getViewportMetrics(tabId)
  if (!(viewport.width > 0 && viewport.height > 0)) return null
  return {
    x: Math.max(0, Math.min(999, (cssX / viewport.width) * 1000)),
    y: Math.max(0, Math.min(999, (cssY / viewport.height) * 1000)),
    cssX,
    cssY,
    width: viewport.width,
    height: viewport.height,
  }
}

function pickFollowedBrowserTab(
  before: BrowserToolTabSnapshot[],
  after: BrowserToolTabSnapshot[],
  sourceTabId: string | null,
): BrowserActionFollowedTab | null {
  if (before.length === 0 || after.length === 0) return null
  const beforeIds = new Set(before.map((tab) => tab.id))
  const sourceId = sourceTabId || before.find((tab) => tab.active)?.id || null
  const newTabs = after.filter((tab) => !beforeIds.has(tab.id))
  const activeAfter = after.find((tab) => tab.active) || null
  const activeNewTab = activeAfter && !beforeIds.has(activeAfter.id) ? activeAfter : null
  const createdTab = activeNewTab || (newTabs.length === 1 ? newTabs[0] : null)
  if (createdTab) {
    return {
      tabId: createdTab.id,
      title: createdTab.title,
      url: createdTab.url,
      reason: 'new_tab',
      sourceTabId: sourceId,
    }
  }
  if (activeAfter && sourceId && activeAfter.id !== sourceId) {
    return {
      tabId: activeAfter.id,
      title: activeAfter.title,
      url: activeAfter.url,
      reason: 'active_tab_changed',
      sourceTabId: sourceId,
    }
  }
  return null
}

async function waitForActionFollowedTab(
  controller: BrowserController,
  sourceTabId: string | null,
  beforeTabs: BrowserToolTabSnapshot[],
  signal?: AbortSignal,
  timeoutMs = 2600,
): Promise<BrowserActionFollowedTab | null> {
  if (beforeTabs.length === 0) return null
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal)
    const followed = pickFollowedBrowserTab(beforeTabs, snapshotBrowserTabs(controller), sourceTabId)
    if (followed) {
      try {
        if (typeof controller.switchTab === 'function') controller.switchTab(followed.tabId)
      } catch {
        // silent-catch: tab 可能已激活或测试桩不支持切换，跟随逻辑继续。
      }
      try {
        const ready = await waitForReady(controller, followed.tabId, 3500, undefined, signal)
        return { ...followed, ready: ready.ready, elapsedMs: Date.now() - started }
      } catch {
        // silent-catch: 就绪探测失败仍返回跟随到的 tab（不带 ready 位）。
        return { ...followed, elapsedMs: Date.now() - started }
      }
    }
    await sleepWithAbort(150, signal)
  }
  return null
}

function didBrowserActionChange(before: unknown, after: unknown): boolean {
  if (before === null || after === null || before === undefined || after === undefined) return false
  try {
    return JSON.stringify(before) !== JSON.stringify(after)
  } catch {
    // silent-catch: 序列化失败按“已变化”保守处理。
    return true
  }
}

async function readBrowserActionDeltaBestEffort(
  controller: BrowserController,
  tabId: string | null,
  phase: 'before' | 'after',
): Promise<unknown> {
  try {
    return await controller.executeJS(tabId, buildBrowserActionDeltaJs())
  } catch (error) {
    log(`browser action delta ${phase} readback failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * R18（真机第十七轮实锚）：delta bodyText 只取前 1000 字符，body 末尾的
 * 瞬时校验 toast 完全不可见——"点了没变化"里可能藏着页面已给出的拒绝理由。
 * 点击判无效后补读一次可见提示层，机械采集，失败按无提示处理。
 */
async function readTransientPageNotices(
  controller: BrowserController,
  tabId: string | null,
): Promise<string[]> {
  try {
    const result = await controller.executeJS(tabId, buildTransientNoticeProbeJs())
    return Array.isArray(result)
      ? result.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5)
      : []
  } catch {
    // silent-catch: 提示嗅探是增值回读，失败按无提示处理不影响点击主流程
    return []
  }
}

type SearchEngine = 'auto' | 'google' | 'duckduckgo' | 'bing' | 'baidu'

function searchUrl(engine: SearchEngine, query: string): string {
  const q = encodeURIComponent(query)
  switch (engine) {
    case 'google':
      return `https://www.google.com/search?q=${q}`
    case 'duckduckgo':
      return `https://duckduckgo.com/?q=${q}`
    case 'bing':
      return `https://www.bing.com/search?q=${q}`
    case 'baidu':
      return `https://www.baidu.com/s?wd=${q}`
    default:
      return `https://duckduckgo.com/?q=${q}`
  }
}


async function extractSearchResults(
  controller: BrowserController,
  tabId: string | null,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const js = `
    (() => {
      const selectors = [
        'a h3',
        'h3 a',
        'article h2 a',
        '.result__a',
        '.b_algo h2 a',
        '.c-container h3 a',
      ]
      const links = new Map()
      for (const sel of selectors) {
        for (const node of Array.from(document.querySelectorAll(sel))) {
          const anchor = node.closest('a') || node
          if (!(anchor instanceof HTMLAnchorElement)) continue
          const href = anchor.href || ''
          const title = (node.textContent || anchor.textContent || '').trim()
          if (!href || !title) continue
          if (!/^https?:/i.test(href)) continue
          if (/google\\.com\\/search\\?|duckduckgo\\.com\\/\\?|bing\\.com\\/search\\?|baidu\\.com\\/s\\?/i.test(href)) continue
          if (!links.has(href)) {
            const block = anchor.closest('article,li,div') || anchor.parentElement || anchor
            const snippetNode = block.querySelector('p, .snippet, .result__snippet, .b_caption p, .c-abstract, .content')
            const snippet = (snippetNode?.textContent || '').trim().slice(0, 280)
            links.set(href, { title: title.slice(0, 120), url: href, snippet })
          }
          if (links.size >= 8) break
        }
        if (links.size >= 8) break
      }
      return Array.from(links.values())
    })()
  `
  const result = await controller.executeJS(tabId, js)
  if (!Array.isArray(result)) return []
  return result
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const row = item as Record<string, unknown>
      return {
        title: String(row.title || ''),
        url: String(row.url || ''),
        snippet: String(row.snippet || ''),
      }
    })
    .filter((row) => row.title && row.url)
}

// --- D10 frame 穿透（2026-07-04）---------------------------------------
// 定位器 JS 经 executeJS 只达主帧；创作类页面（XHS creator 等）把交互 UI
// 渲染在 iframe/OOPIF 内，click_text/read_page_map 永远看不见。这里给
// 定位器一条"主帧 miss 后逐子帧尝试"的通道；坐标类动作不走此路（子帧
// 内坐标系与顶层视口不同构）。

function isClickByTextMiss(result: unknown): boolean {
  return typeof result === 'string' && result.startsWith('Element by text not found')
}

/**
 * 主帧 miss 后逐子帧做只读定位；命中后把 frame 坐标换算到顶层视口，
 * 再经同一个可信指针通道点击。
 */
async function clickByTextAcrossFrames(
  controller: BrowserController,
  tabId: string | null,
  text: string,
  exact: boolean,
  signal?: AbortSignal,
): Promise<{ result: unknown; frameKey: string | null; framesSearched: number }> {
  const js = buildLocateTextTargetJs(text, exact)
  const clickLocated = async (raw: unknown, frameKey: string | null): Promise<unknown> => {
    if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return raw
    const located = raw as { cssX?: unknown; cssY?: unknown; width?: unknown; height?: unknown; text?: unknown; href?: unknown }
    const localX = Number(located.cssX)
    const localY = Number(located.cssY)
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) return raw
    const offset = frameKey ? await frameViewportOffset(controller, tabId, frameKey) : { x: 0, y: 0 }
    const metrics = await controller.getViewportMetrics(tabId)
    const x = ((offset.x + localX) / Math.max(1, metrics.width)) * 1000
    const y = ((offset.y + localY) / Math.max(1, metrics.height)) * 1000
    const clicked = await runGuardedCoordinateClick(controller, tabId, x, y, signal)
    return {
      ok: true,
      trustedInput: true,
      text: located.text || text,
      href: located.href,
      point: { x: clicked.cssX, y: clicked.cssY },
    }
  }
  const mainLocated = await controller.executeJS(tabId, js)
  if (mainLocated && typeof mainLocated === 'object' && (mainLocated as { ok?: unknown }).ok === true) {
    return { result: await clickLocated(mainLocated, null), frameKey: null, framesSearched: 0 }
  }
  const frames = listSubframesSafe(controller, tabId)
  if (typeof controller.executeJSInFrame === 'function') {
    for (const frame of frames) {
      try {
        const located = await controller.executeJSInFrame(tabId, frame.frameKey, js)
        if (located && typeof located === 'object' && (located as { ok?: unknown }).ok === true) {
          return {
            result: await clickLocated(located, frame.frameKey),
            frameKey: frame.frameKey,
            framesSearched: frames.length,
          }
        }
      } catch {
        // silent-catch: 单帧执行失败（帧销毁/导航中）不阻断其余帧尝试。
        continue
      }
    }
  }
  const missText = `Element by text not found: ${text}（已搜索主帧与 ${frames.length} 个子帧）`
  return { result: missText, frameKey: null, framesSearched: frames.length }
}

function buildLocateTextTargetJs(text: string, exact: boolean, hrefContains = ''): string {
  return `
    (() => {
      const target = ${JSON.stringify(text)}
      const exact = ${exact ? 'true' : 'false'}
      const hrefContains = ${JSON.stringify(hrefContains)}
      const normalize = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const queue = [document]
      const visited = new Set()
      const all = []
      while (queue.length) {
        const root = queue.shift()
        if (!root || visited.has(root)) continue
        visited.add(root)
        let nodes = []
        try {
          nodes = Array.from(root.querySelectorAll('*'))
        } catch {
          nodes = []
        }
        for (const node of nodes) {
          all.push(node)
          const shadow = node?.shadowRoot
          if (shadow && !visited.has(shadow)) queue.push(shadow)
        }
      }

      const visible = (el) => {
        try {
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) return false
          const style = window.getComputedStyle(el)
          if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') <= 0) return false
          return true
        } catch {
          return false
        }
      }

      const isClickable = (el) => {
        const tag = (el.tagName || '').toLowerCase()
        if (['a', 'button', 'summary'].includes(tag)) return true
        if (el instanceof HTMLInputElement && ['button', 'submit'].includes((el.type || '').toLowerCase())) return true
        const role = (el.getAttribute('role') || '').toLowerCase()
        if (['button', 'link', 'menuitem', 'option', 'tab'].includes(role)) return true
        if (typeof el.onclick === 'function') return true
        if (el.hasAttribute('onclick') || el.hasAttribute('data-testid')) return true
        return false
      }
      const hrefMatches = (el) => {
        if (!hrefContains) return true
        const anchor = el.closest ? el.closest('a[href]') : null
        const href = String((anchor || el).getAttribute?.('href') || '')
        return href.includes(hrefContains)
      }

      const candidates = all.filter((el) => el instanceof HTMLElement && visible(el) && isClickable(el))
      let matched = null
      if (hrefContains) {
        const hrefCandidates = all
          .filter((el) => el instanceof HTMLElement && visible(el) && (el.tagName || '').toLowerCase() === 'a')
          .filter((el) => String(el.getAttribute('href') || '').includes(hrefContains))
          .map((el) => {
            const rect = el.getBoundingClientRect()
            return { el, area: Math.max(0, rect.width) * Math.max(0, rect.height) }
          })
          .filter((item) => item.area > 16)
          .sort((a, b) => b.area - a.area)
        matched = hrefCandidates[0]?.el || null
      }
      const fallback = []
      if (!matched) {
        for (const el of candidates) {
          const txt = normalize(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '')
          if (!txt) continue
          if ((exact && txt === target) || (!exact && txt.includes(target))) {
            if (hrefMatches(el)) {
              matched = el
              break
            }
            fallback.push(el)
          }
        }
      }
      if (!matched && !hrefContains) matched = fallback[0] || null
      if (!matched && !hrefContains) {
        // D10-c：委托型控件回退——文本命中的可见叶子向上爬 cursor:pointer
        // owner，返回其中心坐标交给可信坐标点击（比 JS 派发更真实）。
        for (const el of all) {
          if (!(el instanceof HTMLElement) || el.children.length > 0 || !visible(el)) continue
          const txt = normalize(el.textContent || '')
          if (!txt) continue
          if (!((exact && txt === target) || (!exact && txt.includes(target)))) continue
          let owner = el
          for (let i = 0; i < 8 && owner; i++) {
            let cursor = ''
            try { cursor = window.getComputedStyle(owner).cursor } catch { cursor = '' }
            if (cursor === 'pointer') { matched = owner; break }
            // D14：跨 shadow 边界跳 host，继续寻找可见的指针 owner。
            owner = owner.parentElement || ((owner.getRootNode && owner.getRootNode().host) || null)
          }
          if (matched) break
        }
      }
      if (!matched) return { ok: false, error: 'Element by text not found: ' + target }
      if (hrefContains) {
        const anchor = matched.closest ? matched.closest('a[href]') : null
        if (anchor instanceof HTMLElement && visible(anchor)) matched = anchor
      }
      matched.scrollIntoView({ block: 'center', behavior: 'instant' })
      const rect = matched.getBoundingClientRect()
      const x = Math.max(0, Math.min(window.innerWidth, rect.left + rect.width / 2))
      const y = Math.max(0, Math.min(window.innerHeight, rect.top + rect.height / 2))
      if (hrefContains) {
        if (matched instanceof HTMLAnchorElement) {
          matched.setAttribute('target', '_self')
        }
      }
      const href = matched instanceof HTMLAnchorElement && matched.href ? matched.href : ''
      return {
        ok: true,
        text: normalize(matched.textContent || matched.getAttribute('aria-label') || matched.getAttribute('title') || matched.tagName),
        href,
        clickedDirect: false,
        cssX: x,
        cssY: y,
        width: window.innerWidth || 1,
        height: window.innerHeight || 1,
      }
    })()
  `
}

async function runTrustedSmartType(
  controller: BrowserController,
  tabId: string | null,
  options: {
    target: string
    text: string
    clearFirst: boolean
    submit: boolean
    allowPasswordFill: boolean
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string }> {
  const probe = await controller.executeJS(tabId, buildSmartTypeProbeJs(options))
  throwIfLiveTargetGuardBlocked(probe, { target: options.target })
  if (!probe || typeof probe !== 'object' || (probe as { ok?: unknown }).ok !== true) {
    return { ok: false, output: typeof probe === 'string' ? probe : 'Smart input target was not found.' }
  }
  const located = probe as {
    x?: unknown
    y?: unknown
    width?: unknown
    height?: unknown
    target?: unknown
    score?: unknown
  }
  const width = Number(located.width)
  const height = Number(located.height)
  if (!(width > 0 && height > 0)) return { ok: false, output: 'Smart input target has no visible viewport.' }
  const typed = await runGuardedCoordinateType(
    controller,
    tabId,
    (Number(located.x) / width) * 1000,
    (Number(located.y) / height) * 1000,
    options.text,
    {
      clearBefore: options.clearFirst,
      pressEnter: options.submit,
      useShiftEnter: false,
      allowPasswordFill: options.allowPasswordFill,
    },
    signal,
  )
  return {
    ok: typed.typed,
    output: JSON.stringify({
      ok: typed.typed,
      trustedInput: true,
      target: String(located.target || options.target),
      score: Number(located.score || 0),
      ...typed,
    }),
  }
}

export async function runWorkflowStep(
  controller: BrowserController,
  step: Record<string, unknown>,
  fallbackTabId: string | null,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal)
  const action = String(step.action || '').trim().toLowerCase()
  const tabId = typeof step.tab_id === 'string' && step.tab_id.trim() ? step.tab_id : fallbackTabId
  if (!action) return 'Error: workflow step missing action'

  if (action === 'navigate') {
    const url = String(step.url || '').trim()
    if (!url) return 'Error: workflow navigate missing url'
    const result = await controller.navigate(tabId, url)
    if (!result.success) return `Error: ${result.error || 'navigate failed'}`
    const waitResult = await waitForReady(controller, tabId, Number(step.timeout_ms || 8000), undefined, signal)
    return `Navigated: ${url} (ready=${waitResult.ready}, elapsed=${waitResult.elapsedMs}ms)`
  }

  if (action === 'search') {
    const query = String(step.query || '').trim()
    if (!query) return 'Error: workflow search missing query'
    const engine = (String(step.engine || 'auto') as SearchEngine)
    const selected = engine === 'auto' ? 'duckduckgo' : engine
    const nav = await controller.navigate(tabId, searchUrl(selected as SearchEngine, query))
    if (!nav.success) return `Error: ${nav.error || 'search navigate failed'}`
    await waitForReady(controller, tabId, Number(step.timeout_ms || 9000), undefined, signal)
    const rows = await extractSearchResults(controller, tabId)
    if (rows.length === 0) return `Search ${selected}: no parsed results for "${query}"`
    return `Search ${selected}: ${rows.map((r, i) => `${i + 1}. ${r.title} - ${r.url}`).join('\n')}`
  }

  if (action === 'wait') {
    const timeoutMs = Number(step.timeout_ms || 8000)
    const selector = typeof step.selector === 'string' ? step.selector : undefined
    const ready = await waitForReady(controller, tabId, timeoutMs, selector, signal)
    return `Wait done: ready=${ready.ready}, selectorMatched=${ready.matchedSelector}, elapsed=${ready.elapsedMs}ms`
  }

  if (action === 'click') {
    const selector = String(step.selector || '').trim()
    if (!selector) return 'Error: workflow click missing selector'
    // EP1-I3 live-target net — internal_browser_workflow is not in the dispatch
    // confirmation policy, so the inner click is invisible to the gate; it
    // must re-check at the execution layer via the shared guarded entry.
    return await runGuardedSelectorClick(controller, tabId, selector, signal)
  }

  if (action === 'click_text') {
    const text = String(step.text || '').trim()
    if (!text) return 'Error: workflow click_text missing text'
    const exact = step.exact === true
    // The text arg itself is the semantic the model chose to click — guard
    // it directly, and the located-element owner label is re-checked inside
    // the shared trusted-input path before the click fires.
    const textHit = matchBrowserDestructiveTarget(text)
    if (textHit) {
      throw new ToolDomainError(
        'grant_required',
        `workflow click_text 目标文本「${text.slice(0, 80)}」命中浏览器破坏性动作清单（${textHit.reason}），需要用户授予该目标的 Power grant 后才能执行。`,
        { text, ruleId: textHit.ruleId },
      )
    }
    const located = await clickByTextAcrossFrames(controller, tabId, text, exact, signal)
    throwIfLiveTargetGuardBlocked(located.result, { text, via: 'workflow_click_text' })
    return located.frameKey ? `${String(located.result)} [frame ${located.frameKey}]` : String(located.result)
  }

  if (action === 'click_at') {
    const x = Number(step.x)
    const y = Number(step.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: workflow click_at requires numeric x and y'
    const point = await runGuardedCoordinateClick(controller, tabId, x, y, signal)
    return `Clicked at normalized(${point.nx},${point.ny}) css(${point.cssX},${point.cssY})`
  }

  if (action === 'type') {
    const selector = String(step.selector || '').trim()
    const text = String(step.text || '')
    if (!selector) return 'Error: workflow type missing selector'
    const clearFirst = step.clear_first !== false
    const submit = step.submit === true
    // Workflow steps are model-authored and never pass through the dispatch
    // confirmation→release path, so there is no confirmed-cue: a password
    // field always reroutes (allowPasswordFill: false).
    return await runGuardedSelectorType(controller, tabId, selector, text, {
      clearFirst,
      allowPasswordFill: false,
      submit,
    }, signal)
  }

  if (action === 'type_at') {
    const x = Number(step.x)
    const y = Number(step.y)
    const text = String(step.text || '')
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: workflow type_at requires numeric x and y'
    if (!text) return 'Error: workflow type_at missing text'
    const clearBefore = step.clear_before_typing !== false
    const pressEnter = step.press_enter !== false
    const useShiftEnter = step.use_shift_enter_for_newline === true
    const point: GuardedCoordinateTypeResult = await runGuardedCoordinateType(controller, tabId, x, y, text, {
      clearBefore,
      pressEnter,
      useShiftEnter,
      allowPasswordFill: false,
    }, signal)
    if (!point.typed) {
      const why = point.skipReason === 'text_exceeds_field_capacity'
        ? `field capacity ${point.focusTarget?.maxLength} < text length`
        : point.skipReason === 'multiline_into_single_line'
          ? 'multiline text into single-line input'
          : 'non-editable target'
      return `Error: workflow type_at refused (${why}; focus=${point.focusTarget?.tag || 'none'}${point.focusTarget?.label ? ` "${point.focusTarget.label}"` : ''})`
    }
    const typedIntoNote = point.typedInto?.label ? ` into "${point.typedInto.label}"` : ''
    return `Typed at normalized(${point.nx},${point.ny}) css(${point.cssX},${point.cssY})${typedIntoNote}`
  }

  if (action === 'scroll_at') {
    const x = Number(step.x ?? 500)
    const y = Number(step.y ?? 500)
    const direction = String(step.direction || '').toLowerCase()
    const magnitude = Math.max(40, Math.min(4000, Number(step.magnitude || 800)))
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      return 'Error: workflow scroll_at direction must be up/down/left/right'
    }
    const point = await resolveCssPoint(controller, tabId, x, y)
    const deltaY = direction === 'up' ? -magnitude : direction === 'down' ? magnitude : 0
    const deltaX = direction === 'left' ? -magnitude : direction === 'right' ? magnitude : 0
    await controller.dispatchMouse(tabId, {
      type: 'mouseWheel',
      x: point.cssX,
      y: point.cssY,
      deltaX,
      deltaY,
      button: 'none',
      buttons: 0,
    })
    return `Scrolled ${direction} at normalized(${point.nx},${point.ny})`
  }

  if (action === 'send_keys') {
    const key = String(step.key || '').trim()
    if (!key) return 'Error: workflow send_keys missing key'
    await sendKeyStroke(controller, tabId, key, step.modifiers)
    return `Sent key: ${key}`
  }

  if (action === 'read') {
    const text = await controller.getPageContent(tabId)
    return truncate(text, Number(step.max_chars || 6000))
  }

  if (action === 'compose') {
    const text = String(step.text || '')
    if (!text) return 'Error: workflow compose missing text'
    const target = String(step.target || '')
    const clearFirst = step.clear_first !== false
    const submit = step.submit !== false
    // EP1-I3 live-target net — workflow compose shares the smart-type guard;
    // workflow steps are model-authored, so there is no confirmed-cue path
    // (allowPasswordFill stays false) and markers must throw, not stringify.
    const composed = await runTrustedSmartType(controller, tabId, {
      target,
      text,
      clearFirst,
      submit,
      allowPasswordFill: false,
    }, signal)
    return composed.output
  }

  return `Error: unknown workflow action "${action}"`
}

interface ScopeAttachmentCandidate {
  attachmentId: string
  name: string
  path: string
  type: string
  size: number
  ext: string
  createdAt: string
}

interface ScopeUploadMemory {
  attachmentId: string
  attachmentPath: string
  pageKey: string
  uploadedAt: number
}

const recentScopeUploads = new Map<string, ScopeUploadMemory>()
const RECENT_SCOPE_UPLOAD_TTL_MS = 2 * 60 * 1000

async function listScopeAttachmentsForTool(sessionId?: string): Promise<ScopeAttachmentCandidate[]> {
  const scopeId = String(sessionId || '').trim()
  if (!scopeId) return []
  const repository = new AgentRepository()
  return repository
    .listConversationAttachments(scopeId)
    .then((items) => items
    .filter((item) => item.path && existsSync(item.path))
    .map((item) => ({
      attachmentId: item.attachment_id,
      name: item.name,
      path: item.path,
      type: String(item.type || 'other'),
      size: Number(item.size || 0),
      ext: String(item.ext || ''),
      createdAt: item.created_at,
    })))
}

function selectScopeAttachment(
  attachments: ScopeAttachmentCandidate[],
  args: Record<string, unknown>,
): { attachment?: ScopeAttachmentCandidate; ambiguous?: ScopeAttachmentCandidate[]; reason?: string } {
  if (attachments.length === 0) {
    return { reason: '当前会话没有可用附件。' }
  }
  const attachmentId = String(args.attachment_id || '').trim()
  const attachmentName = String(args.attachment_name || '').trim().toLowerCase()
  const latest = args.latest !== false

  if (attachmentId) {
    const match = attachments.find((item) => item.attachmentId === attachmentId)
    return match ? { attachment: match } : { reason: `未找到附件: ${attachmentId}` }
  }

  if (attachmentName) {
    const matches = attachments.filter((item) => item.name.toLowerCase().includes(attachmentName))
    if (matches.length === 1) return { attachment: matches[0] }
    if (matches.length > 1) return { ambiguous: matches }
    return { reason: `未找到名称匹配的附件: ${attachmentName}` }
  }

  if (latest) return { attachment: attachments[0] }
  return { ambiguous: attachments.slice(0, 6) }
}

function buildScopeUploadKey(sessionId: string | undefined, pageIdentity: { title: string; url: string }): string {
  let normalizedPage = pageIdentity.title || 'unknown'
  try {
    const parsed = new URL(pageIdentity.url)
    normalizedPage = `${parsed.origin}${parsed.pathname}` || normalizedPage
  } catch {
    normalizedPage = pageIdentity.url || normalizedPage
  }
  return `${sessionId || 'global'}::${normalizedPage}`
}

function pickBestActionTarget(
  targets: ActionTargetCandidate[],
  preferredKinds: ActionTargetCandidate['kind'][],
): ActionTargetCandidate | null {
  if (targets.length === 0) return null
  const ranked = [...targets].sort((a, b) => {
    const aKind = preferredKinds.includes(a.kind) ? 1 : 0
    const bKind = preferredKinds.includes(b.kind) ? 1 : 0
    if (aKind !== bKind) return bKind - aKind
    return Number(b.confidence || 0) - Number(a.confidence || 0)
  })
  return ranked[0] || null
}

async function clickActionTarget(
  controller: BrowserController,
  tabId: string | null,
  target: ActionTargetCandidate,
  abortSignal?: AbortSignal,
): Promise<{ ok: boolean; method: string }> {
  const selector = typeof target.selectorHint === 'string' ? target.selectorHint : ''
  const canUseSelector = selector.length > 0 &&
    (selector.startsWith('#') || selector.includes('['))
  if (canUseSelector) {
    const result = await runGuardedSelectorClick(controller, tabId, selector, abortSignal)
    try {
      const parsed = JSON.parse(result) as { ok?: unknown }
      if (parsed.ok === true) return { ok: true, method: 'trusted_selector_click' }
    } catch {
      // silent-catch: malformed selector-probe output falls through to the already-resolved coordinate candidate.
    }
  }
  if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
    await runGuardedCoordinateClick(controller, tabId, Number(target.x), Number(target.y), abortSignal)
    return { ok: true, method: 'trusted_coordinate_click' }
  }
  return { ok: false, method: 'no_clickable_target' }
}

async function attemptRecoverPageState(
  controller: BrowserController,
  tabId: string | null,
  signal?: AbortSignal,
): Promise<{ recovered: boolean; method: string }> {
  try {
    await sendKeyStroke(controller, tabId, 'Escape')
    await sleepWithAbort(160, signal)
    return { recovered: true, method: 'escape' }
  } catch {
    // continue
  }

  const closeTargets = await locateActionTargets(controller, tabId, 'close')
  const closeTarget = pickBestActionTarget(closeTargets, ['close_button', 'icon_button'])
  if (closeTarget) {
    const clicked = await clickActionTarget(controller, tabId, closeTarget, signal)
    if (clicked.ok) return { recovered: true, method: clicked.method }
  }

  const backTargets = await locateActionTargets(controller, tabId, 'back')
  const backTarget = pickBestActionTarget(backTargets, ['back_button', 'icon_button'])
  if (backTarget) {
    const clicked = await clickActionTarget(controller, tabId, backTarget, signal)
    if (clicked.ok) return { recovered: true, method: clicked.method }
  }

  const goBack = controller.goBack(tabId)
  if (goBack.success) {
    await settleAfterAction(controller, tabId, signal)
    return { recovered: true, method: 'browser_navigate(action=back)' }
  }

  return { recovered: false, method: 'recover_failed' }
}

function chooseUploadTarget(
  targets: ActionTargetCandidate[],
  args: Record<string, unknown>,
): ActionTargetCandidate | null {
  if (targets.length === 0) return null
  const selector = String(args.selector || '').trim()
  const targetText = String(args.target || '').trim().toLowerCase()
  if (selector) {
    const bySelector = targets.find((item) => item.selectorHint === selector || item.associatedInputSelector === selector)
    if (bySelector) return bySelector
  }
  if (targetText) {
    const byLabel = targets
      .filter((item) => item.label.toLowerCase().includes(targetText))
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    if (byLabel[0]) return byLabel[0]
  }
  return pickBestActionTarget(targets, ['input', 'launcher', 'dropzone'])
}

async function verifyUploadState(
  controller: BrowserController,
  tabId: string | null,
  fileName: string,
): Promise<{ success: boolean; reason: string; evidence?: string[] }> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const wanted = ${JSON.stringify(fileName.toLowerCase())}
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
        const hasSelectedFile = inputs.some((input) => {
          if (!(input instanceof HTMLInputElement)) return false
          const files = Array.from(input.files || [])
          return files.some((file) => normalize(file.name).includes(wanted))
        })
        const pageText = normalize(document.body?.innerText || '')
        const hasMention = wanted ? pageText.includes(wanted) : false
        const viewportW = Math.max(1, window.innerWidth || 0)
        const viewportH = Math.max(1, window.innerHeight || 0)
        const previewLike = Array.from(document.querySelectorAll('img,video,[role="img"],canvas,.thumbnail,[class*="thumb"],[class*="preview"],[data-testid*="upload" i],[data-testid*="preview" i]'))
          .some((node) => {
            if (!(node instanceof HTMLElement)) return false
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            if (rect.width < 16 || rect.height < 16) return false
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false
            const meta = normalize([
              node.getAttribute('aria-label'),
              node.getAttribute('title'),
              node.getAttribute('data-testid'),
              node.getAttribute('class'),
              node.textContent,
            ].filter(Boolean).join(' '))
            const looksLikeNamedPreview = !wanted || meta.includes(wanted) || /preview|thumbnail|附件|已上传|upload/.test(meta)
            const smallPreviewCluster =
              rect.width >= 24 &&
              rect.height >= 24 &&
              rect.width <= Math.min(220, viewportW * 0.28) &&
              rect.height <= Math.min(220, viewportH * 0.28) &&
              rect.top >= viewportH * 0.55
            return looksLikeNamedPreview || smallPreviewCluster
          })
        const removeChip = Array.from(document.querySelectorAll('button,[role="button"],span,div'))
          .some((node) => {
            if (!(node instanceof HTMLElement)) return false
            const meta = normalize([
              node.textContent,
              node.getAttribute('aria-label'),
              node.getAttribute('title'),
              node.getAttribute('data-testid'),
              node.getAttribute('class'),
            ].filter(Boolean).join(' '))
            return /remove|delete|删除|移除|clear|close/.test(meta) && (!wanted || pageText.includes(wanted))
          })
        const evidence = [
          hasSelectedFile ? 'input_files_changed' : '',
          hasMention ? 'page_text_updated' : '',
          previewLike ? 'preview_detected' : '',
          removeChip ? 'remove_chip_detected' : '',
        ].filter(Boolean)
        return {
          success: evidence.length > 0,
          reason:
            hasSelectedFile ? 'input_files_changed'
              : previewLike ? 'preview_detected'
                : removeChip ? 'remove_chip_detected'
                  : hasMention ? 'page_text_updated'
                    : 'no_upload_evidence',
          evidence,
        }
      })()
    `,
  ) as { success?: boolean; reason?: string; evidence?: string[] } | null
  return {
    success: Boolean(result?.success),
    reason: String(result?.reason || 'unknown'),
    evidence: Array.isArray(result?.evidence) ? result?.evidence : [],
  }
}

export interface BrowserActToolContext {
  controller: BrowserController
  abortSignal?: AbortSignal
  sessionId?: string
  currentUserText?: string
  attachBrowserActionSessionOutput: (
    result: string | ToolExecutionOutput,
    params: {
      toolName: string
      args: Record<string, unknown>
      controller: BrowserController
      sessionId?: string
      currentUserText?: string
      tabId?: string | null
      followedTab?: BrowserActionFollowedTab | null
      confirmation?: BrowserTransactionConfirmation | null
      nextSuggestedAction?: string | null
      frameId?: string | null
      changeReceipt?: BrowserActionReceipt | null
    },
  ) => string | ToolExecutionOutput
}

export async function executeBrowserActTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserActToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId, currentUserText, attachBrowserActionSessionOutput } = ctx
  switch (toolName) {
      case 'tabs_open': {
        const url = String(args.url || 'about:blank')
        const created = await controller.createTab(url, {
          background: args.background === true,
          openerTabId: typeof args.opener_tab_id === 'string' ? args.opener_tab_id : null,
        })
        return JSON.stringify(created, null, 2)
      }

      case 'tabs_switch': {
        const tabId = String(args.tab_id || '')
        if (!tabId) return 'Error: tab_id is required'
        return JSON.stringify(controller.switchTab(tabId), null, 2)
      }

      case 'tabs_close': {
        const tabId = String(args.tab_id || '')
        if (!tabId) return 'Error: tab_id is required'
        return JSON.stringify(controller.closeTab(tabId), null, 2)
      }

      case 'navigate_open': {
        const url = args.url as string
        if (!url) return 'Error: url is required'
        // Tool-layer tab targeting (plan §7.8): navigate the given tab when set
        // (the scoped agent facade forces agentTabId), else the active tab.
        let navTabId = (args.tab_id as string) || null
        navTabId = (await resolveHighControlAgentTab(controller, args, {
          navigateToTarget: false,
          signal: abortSignal,
        })).tabId
        const allowRepeat = args.allow_repeat === true
        const duplicate = !allowRepeat ? findRecentBrowserAction(sessionId, 'navigate', url) : null
        const activeBefore = navTabId
          ? controller.getTabList().find((t) => t.id === navTabId)
          : controller.getActiveTab()
        if (duplicate && activePageLikelyMatchesTarget(activeBefore?.url, url)) {
          const secondsAgo = Math.max(1, Math.round((Date.now() - duplicate.updatedAt) / 1000))
          return `Skipped duplicate navigation to ${url}. The same navigation already succeeded ${secondsAgo}s ago and the current page still matches it. Read or verify the current page before navigating again.`
        }
        const result = await controller.navigate(navTabId, url)
        if (!result.success) return `Error: ${result.error}`
        rememberBrowserAction(sessionId, 'navigate', url)
        // Wait a moment for page to start loading
        await sleepWithAbort(1500, abortSignal)
        const tabs = controller.getTabList()
        const target = navTabId ? tabs.find((t) => t.id === navTabId) : tabs.find((t) => t.active)
        const confirmation = await detectBrowserPageTransactionConfirmation(controller, target?.id || navTabId)
        return attachBrowserActionSessionOutput(
          `Navigated to ${url}\nCurrent page: ${target?.title || 'Loading...'} (${target?.url || url})`,
          {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId: target?.id || navTabId,
            confirmation,
            nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
          },
        )
      }

      case 'search': {
        const query = args.query as string
        if (!query) return 'Error: query is required'
        const searchTabId = (args.tab_id as string) || null
        const allowRepeat = args.allow_repeat === true
        const duplicate = !allowRepeat ? findRecentBrowserAction(sessionId, 'search', query) : null
        // Duplicate-check must inspect the SEARCH tab, not the active tab, so a
        // targeted search (tab_id set) isn't skipped based on the user's page.
        const searchBefore = searchTabId
          ? controller.getTabList().find((t) => t.id === searchTabId)
          : controller.getActiveTab()
        if (duplicate && /search|google|bing|duckduckgo|baidu/i.test(String(searchBefore?.url || ''))) {
          const secondsAgo = Math.max(1, Math.round((Date.now() - duplicate.updatedAt) / 1000))
          return `Skipped duplicate search for "${query}". The same search already ran ${secondsAgo}s ago. Reuse the current results page or read it before searching again.`
        }
        const preferred = String(args.engine || 'auto').toLowerCase() as SearchEngine
        const engines: SearchEngine[] = preferred === 'auto'
          ? ['duckduckgo', 'google', 'bing', 'baidu']
          : [preferred, 'duckduckgo', 'google', 'bing', 'baidu']
        const uniq = Array.from(new Set(engines))

        const errors: string[] = []
        for (const engine of uniq) {
          const targetUrl = searchUrl(engine, query)
          const result = await controller.navigate(searchTabId, targetUrl)
          if (!result.success) {
            errors.push(`${engine}: ${result.error || 'navigate failed'}`)
            continue
          }
          rememberBrowserAction(sessionId, 'search', query)
          const waitResult = await waitForReady(controller, searchTabId, 10_000, undefined, abortSignal)
          const rows = await extractSearchResults(controller, searchTabId)
          if (rows.length > 0) {
            return [
              `Searched "${query}" via ${engine}`,
              `Page ready: ${waitResult.ready} (${waitResult.elapsedMs}ms)`,
              '',
              ...rows.map((row, index) => `${index + 1}. ${row.title}\n   ${row.url}${row.snippet ? `\n   ${row.snippet}` : ''}`),
            ].join('\n')
          }
          const content = await controller.getPageContent(searchTabId).catch(() => '')
          if (content.trim().length > 0) {
            return `Searched "${query}" via ${engine}\nNo structured results parsed, fallback page text:\n${truncate(content, 6000)}`
          }
          errors.push(`${engine}: no content`)
        }
        return `Search failed for "${query}". Tried: ${uniq.join(', ')}.\n${errors.join('\n')}`
      }

      case 'fill_form': {
        const fields = Array.isArray(args.fields) ? args.fields : []
        if (fields.length === 0) return 'Error: fields is required'
        const outcome = await runBrowserFillFormSequence(
          fields,
          { tabId: args.tab_id, submit: args.submit === true },
          (operation, input) => executeBrowserActTool(operation, input, ctx),
        )
        return browserStructuredOutput(outcome)
      }

      case 'select': {
        if (typeof args.target_id === 'string') {
          return executeBrowserActTool('click_target', {
            ...args,
            action: 'choose',
            value: args.value ?? (Array.isArray(args.values) ? args.values[0] : undefined),
          }, ctx)
        }
        const selector = String(args.selector || '').trim()
        const values = (Array.isArray(args.values) ? args.values.map(String) : [String(args.value || '')])
          .map((value) => value.trim())
          .filter(Boolean)
        if (!selector || values.length === 0) return 'Error: selector and value are required'
        const tabId = (args.tab_id as string) || null
        const probe = await controller.executeJS(tabId, `(() => {
          const node = document.querySelector(${JSON.stringify(selector)})
          if (!(node instanceof HTMLSelectElement)) return { ok: false, error: 'select_not_found' }
          const rect = node.getBoundingClientRect()
          return {
            ok: rect.width > 0 && rect.height > 0,
            rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            viewport: { width: innerWidth, height: innerHeight },
            multiple: node.multiple === true,
            options: Array.from(node.options).map((option, index) => ({
              index,
              value: String(option.value || ''),
              text: String(option.text || '').trim(),
              disabled: option.disabled === true,
            })),
          }
        })()`)
        const select = probe as {
          ok?: boolean
          rect?: { x?: number; y?: number; width?: number; height?: number }
          viewport?: { width?: number; height?: number }
          multiple?: boolean
          options?: Array<{ index?: number; value?: string; text?: string; disabled?: boolean }>
        } | null
        const viewportWidth = Number(select?.viewport?.width)
        const viewportHeight = Number(select?.viewport?.height)
        const rect = select?.rect
        const options = Array.isArray(select?.options) ? select.options : []
        if (!select?.ok || !rect || !(viewportWidth > 0 && viewportHeight > 0)) {
          return browserStructuredOutput({ ok: false, errorKind: 'select_not_found', selector })
        }
        const matchedIndexes = values.map((wanted) => {
          const matches = options.filter((option) => !option.disabled && (option.value === wanted || option.text === wanted))
          return matches.length === 1 ? Number(matches[0].index) : -1
        })
        if (matchedIndexes.some((index) => index < 0)) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'select_option_not_unique',
            requested: values,
            options: options.slice(0, 80),
          })
        }
        const centerX = Number(rect.x) + Number(rect.width) / 2
        const centerY = Number(rect.y) + Number(rect.height) / 2
        await runGuardedCoordinateClick(
          controller,
          tabId,
          (centerX / viewportWidth) * 999,
          (centerY / viewportHeight) * 999,
          abortSignal,
        )
        if (select.multiple === true) {
          for (const index of [...matchedIndexes].sort((a, b) => a - b)) {
            await sendKeyStroke(controller, tabId, 'Home')
            for (let cursor = 0; cursor < index; cursor += 1) {
              await sendKeyStroke(controller, tabId, 'ArrowDown')
            }
            await sendKeyStroke(controller, tabId, 'Space', ['control'])
          }
        } else {
          await sendKeyStroke(controller, tabId, 'Home')
          for (let cursor = 0; cursor < matchedIndexes[0]; cursor += 1) {
            await sendKeyStroke(controller, tabId, 'ArrowDown')
          }
          await sendKeyStroke(controller, tabId, 'Enter')
        }
        return browserStructuredOutput({ ok: true, values, trustedInput: true })
      }

      case 'hover': {
        const tabId = (args.tab_id as string) || null
        let x = Number(args.x)
        let y = Number(args.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          const payload = await captureAgentPageMap(controller, tabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES)
          const map = payload.pageMap as { viewport?: { width?: number; height?: number }; targets?: Array<{ targetId?: string; box?: { x: number; y: number; width: number; height: number } }> }
          const target = map.targets?.find((item) => item.targetId === args.target_id)
          if (target?.box && map.viewport?.width && map.viewport.height) {
            x = ((target.box.x + target.box.width / 2) / map.viewport.width) * 1000
            y = ((target.box.y + target.box.height / 2) / map.viewport.height) * 1000
          } else if (typeof args.selector === 'string') {
            const rect = await controller.executeJS(tabId, `(() => {
              const node = document.querySelector(${JSON.stringify(args.selector)})
              if (!(node instanceof Element)) return null
              const rect = node.getBoundingClientRect()
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: innerWidth, height: innerHeight }
            })()`) as { x?: number; y?: number; width?: number; height?: number } | null
            if (rect?.width && rect.height) {
              x = (Number(rect.x) / rect.width) * 1000
              y = (Number(rect.y) / rect.height) * 1000
            }
          }
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: hover target not found'
        const point = await resolveCssPoint(controller, tabId, x, y)
        await controller.dispatchMouse(tabId, { type: 'mouseMoved', x: point.cssX, y: point.cssY, button: 'none', buttons: 0 })
        return browserStructuredOutput({ ok: true, normalized: { x: point.nx, y: point.ny }, css: { x: point.cssX, y: point.cssY } })
      }

      case 'drag': {
        const tabId = (args.tab_id as string) || null
        let sourceX = Number(args.source_x)
        let sourceY = Number(args.source_y)
        let targetX = Number(args.target_x)
        let targetY = Number(args.target_y)
        if (![sourceX, sourceY, targetX, targetY].every(Number.isFinite)) {
          const payload = await captureAgentPageMap(controller, tabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES)
          const map = payload.pageMap as { viewport?: { width?: number; height?: number }; targets?: Array<{ targetId?: string; box?: { x: number; y: number; width: number; height: number } }> }
          const center = (targetId: unknown): [number, number] | null => {
            const item = map.targets?.find((target) => target.targetId === targetId)
            if (!item?.box || !map.viewport?.width || !map.viewport.height) return null
            return [
              ((item.box.x + item.box.width / 2) / map.viewport.width) * 1000,
              ((item.box.y + item.box.height / 2) / map.viewport.height) * 1000,
            ]
          }
          const source = center(args.source_target_id)
          const target = center(args.target_target_id)
          if (source) [sourceX, sourceY] = source
          if (target) [targetX, targetY] = target
        }
        if (![sourceX, sourceY, targetX, targetY].every(Number.isFinite)) return 'Error: drag source and target are required'
        const source = await resolveCssPoint(controller, tabId, sourceX, sourceY)
        const target = await resolveCssPoint(controller, tabId, targetX, targetY)
        await controller.dispatchMouse(tabId, { type: 'mouseMoved', x: source.cssX, y: source.cssY, button: 'left', buttons: 0 })
        await controller.dispatchMouse(tabId, { type: 'mousePressed', x: source.cssX, y: source.cssY, button: 'left', buttons: 1, clickCount: 1 })
        for (let step = 1; step <= 8; step += 1) {
          await controller.dispatchMouse(tabId, {
            type: 'mouseMoved',
            x: source.cssX + ((target.cssX - source.cssX) * step) / 8,
            y: source.cssY + ((target.cssY - source.cssY) * step) / 8,
            button: 'left',
            buttons: 1,
          })
        }
        await controller.dispatchMouse(tabId, { type: 'mouseReleased', x: target.cssX, y: target.cssY, button: 'left', buttons: 0, clickCount: 1 })
        return browserStructuredOutput({ ok: true, source: { x: source.cssX, y: source.cssY }, target: { x: target.cssX, y: target.cssY } })
      }

      case 'click_target':
      case 'type_target': {
        const targetId = String(args.target_id || args.targetId || '').trim()
        const action = String(toolName === 'type_target' ? 'fill' : (args.action || 'click')) as AgentBrowserAction
        const value = toolName === 'type_target'
          ? String(args.text || '')
          : args.value === undefined ? undefined : String(args.value)
        const disambiguation = String(args.disambiguation || '').trim()
        const readBack = String(args.read_back || args.readBack || 'delta') as AgentBrowserReadBack
        if (!targetId) return browserStructuredErrorOutput(agentBrowserError('target_not_found', 'target_id is required'))
        if (!['click', 'expand', 'choose', 'fill', 'hover'].includes(action)) {
          return browserStructuredErrorOutput(agentBrowserError('target_not_found', `Unsupported action: ${String(args.action || '')}`))
        }
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        let resolvedRef = await browserSnapshotService.resolveRef(controller, tabId, targetId)
        let refreshedFromStaleSnapshot = false
        if (!resolvedRef.ok && resolvedRef.errorCode === 'stale_snapshot') {
          await captureAgentPageMap(controller, tabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES, { force: true })
          resolvedRef = browserSnapshotService.rebindRef(controller, tabId, targetId)
          refreshedFromStaleSnapshot = resolvedRef.ok
        }
        if (!resolvedRef.ok) {
          return browserStructuredErrorOutput(agentBrowserError(
            resolvedRef.errorCode === 'malformed_ref' || resolvedRef.errorCode === 'wrong_tab'
              ? 'target_not_found'
              : 'stale_page_map',
            resolvedRef.errorCode === 'stale_document'
              ? 'The target belongs to an earlier document and can never be used on the current page. Read browser_snapshot again.'
              : 'The target reference is no longer current. Read browser_snapshot again and choose one of the returned candidates.',
            {
              targetId,
              reason: resolvedRef.errorCode,
              previousTarget: resolvedRef.previousTarget,
              currentDocumentEpoch: resolvedRef.currentDocumentEpoch,
              currentSnapshotRevision: resolvedRef.currentSnapshotRevision,
            },
          ))
        }
        const parsed = parseTargetId(resolvedRef.rawTargetId)
        if (!parsed) return browserStructuredErrorOutput(agentBrowserError('target_not_found', `Malformed internal target id: ${targetId}`))
        const currentGeneration = resolvedRef.snapshotRevision
        const activeTargetId = resolvedRef.target.targetId
        // D10 frame 穿透：targetId 的 frameId 槽位路由回 map 索引该目标的
        // 帧（act 靠帧内元素重枚举定位，跨帧索引不通用）。帧已消失按
        // stale_page_map 收口，提示重读 map。
        const targetFrameKey = parsed.frameId || '0'
        const runInTargetFrame = async (code: string): Promise<unknown> => {
          if (targetFrameKey === '0') return controller.executeJS(tabId, code)
          if (typeof controller.executeJSInFrame !== 'function') {
            throw Object.assign(new Error(`Frame ${targetFrameKey} is not reachable on this controller`), { code: 'FRAME_NOT_FOUND' })
          }
          return controller.executeJSInFrame(tabId, targetFrameKey, code)
        }
        const isFrameGoneError = (error: unknown): boolean =>
          Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'FRAME_NOT_FOUND')
        let liveProbe: {
          matchCount?: number
          disabled?: boolean
          target?: unknown
          clickPoint?: {
            x?: unknown
            y?: unknown
            vw?: unknown
            vh?: unknown
            hostShadow?: unknown
            rect?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | null
          } | null
        } | null
        try {
          liveProbe = await runInTargetFrame(buildBrowserTargetProbeJs(parsed.node)) as {
            matchCount?: number
            disabled?: boolean
            target?: unknown
            clickPoint?: {
              x?: unknown
              y?: unknown
              vw?: unknown
              vh?: unknown
              hostShadow?: unknown
              rect?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | null
            } | null
          } | null
        } catch (error) {
          if (isFrameGoneError(error)) {
            return browserStructuredErrorOutput(agentBrowserError(
              'stale_page_map',
              `Target ${targetId} belongs to frame ${targetFrameKey}, which is no longer present. Call browser_snapshot again.`,
              { targetId, frameKey: targetFrameKey },
            ))
          }
          throw error
        }
        const gated = gateActOnTarget(
          { targetId, action, value, disambiguation, readBack },
          {
            currentGeneration,
            matchCount: Number(liveProbe?.matchCount || 0),
            candidates: liveProbe?.target ? [liveProbe.target] : [],
            ambiguityGroup: currentBrowserPageMapAmbiguity(controller, tabId, activeTargetId),
            resolvedRef: parsed,
          },
        )
        if (isAgentBrowserError(gated)) return browserStructuredErrorOutput(gated)
        if (!liveProbe) {
          return browserStructuredErrorOutput(agentBrowserError(
            'target_not_found',
            `Target ${activeTargetId} was not found on the current page.`,
            { targetId: activeTargetId },
          ))
        }
        if (liveProbe?.disabled === true) {
          return browserStructuredErrorOutput(agentBrowserError(
            'target_not_found',
            `Target ${targetId} is disabled.`,
            { targetId, target: liveProbe.target },
          ))
        }
        const targetRecord = liveProbe?.target && typeof liveProbe.target === 'object'
          ? liveProbe.target as {
              role?: string
              name?: string
              value?: string
              states?: Record<string, unknown>
              box?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
            }
          : null
        if (targetRecord?.states?.fileInput === true) {
          return browserStructuredErrorOutput(agentBrowserError(
            'script_blocked',
            `Target ${targetId} is a file input. Use browser_upload for file upload.`,
            { targetId, target: liveProbe.target },
          ))
        }
        // EP1-I3 live-target net — the dispatch gate only saw the args; a
        // bare target_id legally carries no semantics. Re-check the REAL
        // element label against the destructive browser-target rules here,
        // where the live probe just resolved it. Matching targets require a
        // Power grant, so throw the structured domain error (browser catch
        // rethrows ToolDomainError).
        // For a fill/choose into an editable target the probe's `value` is the
        // field's CURRENT CONTENT — a draft holding「提交订单」must not
        // false-trip, so judge by name/role only; for click/expand/hover the
        // `value` is a control caption (input[type=submit]) and is included.
        const writesIntoField = action === 'fill' || action === 'choose'
        const liveLabel = (writesIntoField
          ? [targetRecord?.name, targetRecord?.role]
          : [targetRecord?.name, targetRecord?.value, targetRecord?.role]
        ).filter(Boolean).join(' ')
        const destructiveHit = matchBrowserDestructiveTarget(liveLabel)
        if (destructiveHit) {
          throw new ToolDomainError(
            'grant_required',
            `目标「${liveLabel.slice(0, 80)}」命中浏览器破坏性动作清单（${destructiveHit.reason}），需要用户授予该目标的 Power grant 后才能执行。`,
            { targetId, ruleId: destructiveHit.ruleId },
          )
        }
        // Password-field fill without a password cue in the args means the
        // dispatch gate never saw this as a login action (m3-login) — refuse
        // with reroute guidance instead of silently filling credentials. A
        // re-issued call that names the password field goes through the
        // normal confirm→release path and passes here (cue present).
        if (
          action === 'fill'
          && targetRecord?.states?.password === true
          && !argsCarryPasswordCue(JSON.stringify(args))
        ) {
          throw new ToolDomainError(
            ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code,
            `目标 ${targetId} 是密码输入框。请改用带 disambiguation 说明（如「登录密码输入框」）的调用重试，经用户确认后执行。`,
            { targetId, ruleId: 'm3-login-existing-account' },
          )
        }
        const beforeTabs = snapshotBrowserTabs(controller)
        const before = readBack === 'none' ? null : await readBrowserActionDeltaBestEffort(controller, tabId, 'before')
        let actionResult: unknown
        const point = await normalizedTargetPoint(controller, tabId, targetFrameKey, targetRecord?.box)
        if (!point) {
          return browserStructuredErrorOutput(agentBrowserError(
            'target_not_found',
            `Target ${activeTargetId} has no visible hit point. Refresh browser_snapshot after bringing it into view.`,
            { targetId: activeTargetId, frameKey: targetFrameKey },
          ))
        }
        const boxWidth = Number(targetRecord?.box?.width || 0)
        const boxHeight = Number(targetRecord?.box?.height || 0)
        const trustedClickPoint = {
          x: point.cssX,
          y: point.cssY,
          vw: point.width,
          vh: point.height,
          hostShadow: liveProbe.clickPoint?.hostShadow || null,
          rect: {
            left: point.cssX - boxWidth / 2,
            top: point.cssY - boxHeight / 2,
            width: boxWidth,
            height: boxHeight,
          },
        }
        if (action === 'fill') {
          const typed = await runGuardedCoordinateType(controller, tabId, point.x, point.y, String(value || ''), {
            clearBefore: true,
            pressEnter: false,
            useShiftEnter: false,
            allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
          }, abortSignal)
          actionResult = {
            ok: typed.typed,
            errorCode: typed.typed ? null : typed.skipReason || 'target_not_fillable',
            trustedInput: true,
            typed,
          }
        } else if (action === 'hover') {
          await controller.dispatchMouse(tabId, {
            type: 'mouseMoved',
            x: point.cssX,
            y: point.cssY,
            button: 'none',
            buttons: 0,
          })
          actionResult = { ok: true, trustedInput: true, hoverPoint: trustedClickPoint }
        } else if (action === 'choose') {
          await runGuardedCoordinateClick(controller, tabId, point.x, point.y, abortSignal)
          await controller.typeTextDirectly(tabId, String(value || ''))
          await sendKeyStroke(controller, tabId, 'Enter')
          actionResult = { ok: true, trustedInput: true, value, clickPoint: trustedClickPoint }
        } else {
          const clicked = await runGuardedCoordinateClick(controller, tabId, point.x, point.y, abortSignal)
          actionResult = { ok: true, trustedInput: true, pointTarget: clicked.pointTarget, clickPoint: trustedClickPoint }
        }
        await settleAfterAction(controller, tabId, abortSignal)
        let followedTab = await waitForActionFollowedTab(controller, tabId, beforeTabs, abortSignal)
        const actionFailed = typeof actionResult === 'object' && actionResult !== null && (actionResult as { ok?: unknown }).ok === false
        const failureKind = actionFailed
          ? String((actionResult as { errorCode?: unknown }).errorCode || 'action_failed')
          : null
        // 变更信号统一用前后 delta（url/title/bodyText）比较——旧实现在
        // readBack='map' 时拿动作前 delta 对比整张 map，形状必不同，changed
        // 恒为 true 是假信号（真机第十二轮实锚：发布按钮点了无反应，回读
        // 却报 changed:true，模型因此不升级）。
        let afterDelta = readBack === 'none' ? null : await readBrowserActionDeltaBestEffort(controller, tabId, 'after')
        let changed = didBrowserActionChange(before, afterDelta)
        // Closed-shadow hosts can expose a larger host rect than their actual
        // internal button. If the first trusted hit has no observable effect,
        // scan the composed tree once and retry another trusted coordinate.
        let escalation: Record<string, unknown> | null = null
        const rawClickPoint = !actionFailed && action === 'click' && actionResult && typeof actionResult === 'object'
          ? (actionResult as { clickPoint?: { x?: unknown; y?: unknown; vw?: unknown; vh?: unknown; hostShadow?: unknown } | null }).clickPoint
          : null
        const cpx = Number(rawClickPoint?.x)
        const cpy = Number(rawClickPoint?.y)
        const cpw = Number(rawClickPoint?.vw)
        const cph = Number(rawClickPoint?.vh)
        const clickPointValid = Number.isFinite(cpx) && Number.isFinite(cpy)
          && cpw > 0 && cph > 0 && cpx >= 0 && cpx <= cpw && cpy >= 0 && cpy <= cph
        const closedShadowHost = rawClickPoint?.hostShadow === 'closed_or_none'
        const shouldEscalate = action === 'click' && !actionFailed && readBack !== 'none'
          && !followedTab && clickPointValid
          && (closedShadowHost || !changed)
        if (action === 'click' && !actionFailed) {
          log(`act click outcome target=${targetId} changed=${changed} hostShadow=${String(rawClickPoint?.hostShadow ?? 'n/a')} escalate=${shouldEscalate}${clickPointValid ? '' : ' clickPoint=invalid'}`)
        }
        if (shouldEscalate) {
          const escalationReason = closedShadowHost ? 'closed_shadow_host' : 'no_change_after_trusted_click'
          const toNormalized = (cssX: number, cssY: number) => ({
            x: Math.max(0, Math.min(999, Math.round((cssX / cpw) * 1000))),
            y: Math.max(0, Math.min(999, Math.round((cssY / cph) * 1000))),
          })
          // D18-c（真机第十四轮实锚）：closed shadow host 的包围盒可能横跨
          // 整个按钮组（xhs-publish-btn 盖住「暂存离开」+「发布」），rect
          // 中心 css=(569,851) 落在两按钮之间死区，可信点击点空。升级前先
          // 经 CDP 组合树命中测试在 host rect 内扫描，找到与 map 目标名/
          // disambiguation 唯一匹配的真实内部按钮；多候选无法唯一判定时
          // 不盲点（点到「暂存离开」会毁掉整个发布流程），把候选连坐标
          // 交回模型自行 click_at。
          let escalationCss = { x: cpx, y: cpy }
          let escalationVia = 'rect_center'
          let scanCandidatePayload: Array<{
            text: string
            tag: string
            normalized: { x: number; y: number }
            disabled?: boolean
            cover?: string
          }> | null = null
          let escalationSkipped: string | null = null
          // R18（第十七轮实锚）：坐标全对、点击可信但按钮不响应——差的是内部
          // 状态。扫描命中的目标状态（disabled/遮挡）进决策与回传。
          let scanMatchedState: { text: string; tag: string; disabled: boolean; cover: string } | null = null
          const rawRect = (rawClickPoint as { rect?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | null } | null)?.rect
          const rectLeft = Number(rawRect?.left)
          const rectTop = Number(rawRect?.top)
          const rectWidth = Number(rawRect?.width)
          const rectHeight = Number(rawRect?.height)
          if (closedShadowHost && Number.isFinite(rectLeft) && Number.isFinite(rectTop) && rectWidth > 0 && rectHeight > 0) {
            const scan = await scanClosedShadowHostForClickPoint(
              controller,
              tabId,
              { left: rectLeft, top: rectTop, width: rectWidth, height: rectHeight },
              { vw: cpw, vh: cph },
              { targetName: String(targetRecord?.name || ''), disambiguation: String(disambiguation || '') },
            ).catch((error) => {
              log(`act escalation scan error target=${targetId} error=${error instanceof Error ? error.message : String(error)}`)
              return null
            })
            if (scan) {
              scanCandidatePayload = scan.candidates.map((c) => ({
                text: c.text,
                tag: c.tag,
                normalized: toNormalized(c.cssX, c.cssY),
                ...(c.disabled ? { disabled: true } : {}),
                ...(c.cover ? { cover: c.cover } : {}),
              }))
              log(`act escalation scan target=${targetId} candidates=${JSON.stringify(scan.candidates.map((c) => `${c.text}${c.disabled ? '[disabled]' : ''}${c.cover ? `[cover:${c.cover}]` : ''}`))} via=${scan.via ?? 'none'} matched=${JSON.stringify(scan.matchedText)} skipped=${scan.skippedReason ?? 'none'}`)
              if (scan.point) {
                const matched = scan.matchedText
                  ? scan.candidates.find((c) => c.text === scan.matchedText) ?? null
                  : null
                if (matched) {
                  scanMatchedState = {
                    text: matched.text,
                    tag: matched.tag,
                    disabled: matched.disabled,
                    cover: matched.cover,
                  }
                }
                if (matched?.disabled) {
                  // 按钮 disabled：可信点击必然无效，盲点是烧轮次。机械拒绝
                  // 并把状态交回模型（"只报不拒"对模型循环无效——第十六轮教训）。
                  escalationSkipped = 'target_disabled'
                } else {
                  escalationCss = { x: scan.point.cssX, y: scan.point.cssY }
                  escalationVia = `scan_${scan.via}`
                }
              } else if (scan.candidates.length >= 2) {
                escalationSkipped = 'ambiguous_shadow_candidates'
              }
            }
          }
          if (escalationSkipped) {
            const skipHint = escalationSkipped === 'target_disabled'
              ? `扫描确认目标按钮「${scanMatchedState?.text ?? ''}」当前为 disabled（页面校验未通过），任何点击都不会生效。先检查并补齐页面必填项（标题/正文描述/封面等），确认按钮变为可用后再点；不要重复盲点。`
              : 'shadow root 内发现多个可点按钮，无法唯一判定目标。从 candidates 里选出意图按钮，用 browser_click 按其 normalized 坐标直接点击。'
            escalation = {
              attempted: false,
              mode: 'trusted_pointer',
              reason: escalationReason,
              skipped: escalationSkipped,
              candidates: scanCandidatePayload,
              ...(scanMatchedState ? { matchedTarget: scanMatchedState } : {}),
              hint: skipHint,
            }
            log(`act escalation skipped target=${targetId} reason=${escalationSkipped} candidates=${JSON.stringify((scanCandidatePayload || []).map((c) => c.text))}`)
          } else {
            const { x: nx, y: ny } = toNormalized(escalationCss.x, escalationCss.y)
            try {
              log(`act escalation firing target=${targetId} reason=${escalationReason} via=${escalationVia} css=(${Math.round(escalationCss.x)},${Math.round(escalationCss.y)}) normalized=(${nx},${ny})`)
              const escalatedPoint = await runGuardedCoordinateClick(controller, tabId, nx, ny, abortSignal)
              const escalatedFollowedTab = await waitForActionFollowedTab(controller, tabId, beforeTabs, abortSignal)
              afterDelta = await readBrowserActionDeltaBestEffort(controller, tabId, 'after')
              let escalatedChanged = didBrowserActionChange(before, afterDelta) || Boolean(escalatedFollowedTab)
              if (escalatedFollowedTab) followedTab = escalatedFollowedTab
              // R18：仍无变化时补读瞬时提示层——delta bodyText 前 1000 字符
              // 看不见 body 末尾的校验 toast，页面可能早已说明了拒绝理由。
              const pageNotices = escalatedChanged ? [] : await readTransientPageNotices(controller, tabId)
              const stuckHint = pageNotices.length > 0
                ? `点击后页面弹出提示：${pageNotices.map((n) => `「${n}」`).join(' ')}——按提示补齐后重试。`
                : (!escalatedChanged
                  ? '可信指针点击未引起页面变化：按钮很可能被站点内部校验拦截（常见：必填项为空、内容未就绪）。先检查页面必填项（如正文描述、封面），补齐后再点。'
                  : null)
              escalation = {
                attempted: true,
                mode: 'trusted_pointer',
                reason: escalationReason,
                via: escalationVia,
                clickNormalized: { x: nx, y: ny },
                pointTarget: escalatedPoint.pointTarget,
                ...(scanCandidatePayload && scanCandidatePayload.length > 0 ? { candidates: scanCandidatePayload } : {}),
                ...(scanMatchedState ? { matchedTarget: scanMatchedState } : {}),
                ...(pageNotices.length > 0 ? { pageNotices } : {}),
                ...(stuckHint ? { hint: stuckHint } : {}),
                changed: escalatedChanged,
              }
              changed = changed || escalatedChanged
              log(`act escalation done target=${targetId} via=${escalationVia} pointTarget=${JSON.stringify(escalatedPoint.pointTarget?.label ?? null)} escalatedChanged=${escalatedChanged}${pageNotices.length > 0 ? ` notices=${JSON.stringify(pageNotices)}` : ''}`)
            } catch (error) {
              // 闸门（grant_required / 待确认拒绝）保持响亮——升级点击与
              // browser_click 的安全语义必须同构，不能因为是兜底就静默。
              if (error instanceof ToolDomainError) throw error
              escalation = {
                attempted: true,
                mode: 'trusted_pointer',
                reason: escalationReason,
                via: escalationVia,
                error: error instanceof Error ? error.message : String(error),
              }
              log(`act escalation error target=${targetId} error=${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        const after = readBack === 'map'
          ? await captureAgentPageMap(controller, tabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES)
          : afterDelta
        const payload = {
          ok: !actionFailed,
          targetId: activeTargetId,
          originalTargetId: activeTargetId === targetId ? undefined : targetId,
          refreshedFromStaleSnapshot,
          action,
          disambiguation: disambiguation || null,
          readBack,
          before,
          result: actionResult,
          after,
          changed,
          ...(escalation ? { escalation } : {}),
          followedTab,
          failureKind,
          nextSuggestedAction: followedTab ? `read map again on tab ${followedTab.tabId}` : 'read map again',
        }
        const confirmation = actionFailed
          ? null
          : await detectBrowserPageTransactionConfirmation(controller, followedTab?.tabId || tabId)
        return attachBrowserActionSessionOutput(
          actionFailed ? browserStructuredOutput(payload) : JSON.stringify(payload, null, 2),
          {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId,
            followedTab,
            confirmation,
            nextSuggestedAction: confirmation
              ? 'finish with transaction proof'
              : (followedTab ? `read map again on tab ${followedTab.tabId}` : 'read map again'),
          },
        )
      }

      case 'click_selector': {
        const selector = args.selector as string
        if (!selector) return 'Error: selector is required'
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        // EP1-I3 live-target net — a CSS selector carries no semantics the
        // dispatch gate could classify; the shared guarded entry judges the
        // real clickable owner and refuses destructive-grant targets without
        // clicking.
        const beforeTabs = snapshotBrowserTabs(controller)
        const clickBeforeUrl = activeBrowserToolUrl(controller, tabId)
        const result = await runGuardedSelectorClick(controller, tabId, selector, abortSignal)
        if (result.startsWith('Error:')) {
          return browserStructuredOutput({
            ok: false,
            errorKind: /not found|hidden|no visible viewport/i.test(result) ? 'target_not_found' : 'browser_operation_failed',
            message: result.slice('Error:'.length).trim(),
            nextSuggestedAction: 'call browser_snapshot and retry with a current target reference',
          })
        }
        await settleAfterAction(controller, tabId, abortSignal)
        const followedTab = await waitForActionFollowedTab(controller, tabId, beforeTabs, abortSignal)
        const confirmation = await detectBrowserPageTransactionConfirmation(controller, followedTab?.tabId || tabId)
        // P1-E5 — deterministic post-action change receipt so the model can skip
        // a follow-up browser_read; never fails the click if the probe errors.
        const changeReceipt = await captureBrowserActionReceipt(controller, followedTab?.tabId || tabId, clickBeforeUrl)
        const output = followedTab
          ? JSON.stringify({
            ok: true,
            result,
            followedTab,
            nextSuggestedAction: `read map again on tab ${followedTab.tabId}`,
          }, null, 2)
          : result
        return attachBrowserActionSessionOutput(output, {
          toolName,
          args,
          controller,
          sessionId,
          currentUserText,
          tabId,
          followedTab,
          confirmation,
          changeReceipt,
          nextSuggestedAction: confirmation
            ? 'finish with transaction proof'
            : (followedTab ? `read map again on tab ${followedTab.tabId}` : 'read map again'),
        })
      }

      case 'click_text': {
        const text = String(args.text || '').trim()
        if (!text) return 'Error: text is required'
        const exact = args.exact === true
        const hrefContains = String(args.href_contains || '').trim()
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const located = await controller.executeJS(tabId, buildLocateTextTargetJs(text, exact, hrefContains))
        if (!located || typeof located !== 'object') return String(located)
        const result = located as { ok?: boolean; error?: string; text?: string; href?: string; cssX?: number; cssY?: number; width?: number; height?: number }
        if (result.ok !== true) {
          // D10 frame 穿透：主帧定位 miss → 逐帧 JS click 回退（子帧坐标系
          // 与顶层视口不同构，不能换算成坐标点击）。快照先于点击副作用。
          const frameBeforeTabs = snapshotBrowserTabs(controller)
          const frameBeforeUrl = activeBrowserToolUrl(controller, tabId)
          const frameClick = await clickByTextAcrossFrames(controller, tabId, text, exact, abortSignal)
          if (isClickByTextMiss(frameClick.result)) {
            const missBase = result.error || `Element by text not found: ${text}`
            return `${missBase}（已搜索主帧与 ${frameClick.framesSearched} 个子帧）`
          }
          throwIfLiveTargetGuardBlocked(frameClick.result, { text, via: 'browser_click_frame' })
          const frameFollowedTab = await waitForActionFollowedTab(controller, tabId, frameBeforeTabs, abortSignal)
          const frameConfirmation = await detectBrowserPageTransactionConfirmation(controller, frameFollowedTab?.tabId || tabId)
          const frameReceipt = await captureBrowserActionReceipt(controller, frameFollowedTab?.tabId || tabId, frameBeforeUrl)
          return attachBrowserActionSessionOutput(JSON.stringify({
            ok: true,
            text,
            clickedDirect: true,
            frame: frameClick.frameKey,
            detail: String(frameClick.result),
            followedTab: frameFollowedTab,
            nextSuggestedAction: frameFollowedTab ? `read map again on tab ${frameFollowedTab.tabId}` : 'read map again',
          }, null, 2), {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId,
            followedTab: frameFollowedTab,
            confirmation: frameConfirmation,
            changeReceipt: frameReceipt,
            nextSuggestedAction: frameConfirmation
              ? 'finish with transaction proof'
              : (frameFollowedTab ? `read map again on tab ${frameFollowedTab.tabId}` : 'read map again'),
          })
        }
        const width = Number(result.width || 1) || 1
        const height = Number(result.height || 1) || 1
        const x = Math.round((Number(result.cssX || 0) / width) * 1000)
        const y = Math.round((Number(result.cssY || 0) / height) * 1000)
        const beforeTabs = snapshotBrowserTabs(controller)
        const clickTextBeforeUrl = activeBrowserToolUrl(controller, tabId)
        const point = await runGuardedCoordinateClick(controller, tabId, x, y, abortSignal)
        const followedTab = await waitForActionFollowedTab(controller, tabId, beforeTabs, abortSignal)
        const confirmation = await detectBrowserPageTransactionConfirmation(controller, followedTab?.tabId || tabId)
        const clickTextReceipt = await captureBrowserActionReceipt(controller, followedTab?.tabId || tabId, clickTextBeforeUrl)
        return attachBrowserActionSessionOutput(JSON.stringify({
          ok: true,
          text: result.text || text,
          href: result.href || undefined,
          clickedDirect: false,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          followedTab,
          nextSuggestedAction: followedTab ? `read map again on tab ${followedTab.tabId}` : 'read map again',
        }, null, 2), {
          toolName,
          args,
          controller,
          sessionId,
          currentUserText,
          tabId,
          followedTab,
          confirmation,
          changeReceipt: clickTextReceipt,
          nextSuggestedAction: confirmation
            ? 'finish with transaction proof'
            : (followedTab ? `read map again on tab ${followedTab.tabId}` : 'read map again'),
        })
      }

      case 'type_selector': {
        const selector = args.selector as string
        const text = args.text as string
        if (!selector || text === undefined) return 'Error: selector and text are required'
        const clearFirst = args.clear_first !== false // default true
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        // EP1-I3 live-target net — an opaque selector can resolve to a
        // password or captcha field with no cue in the args. The shared
        // guarded entry checks the REAL field semantics (no value): destructive
        // hits require a grant; unconfirmed password fills reroute — a re-issued
        // call naming the password field carries the cue and passes.
        const typeBeforeUrl = activeBrowserToolUrl(controller, tabId)
        const result = await runGuardedSelectorType(controller, tabId, selector, text, {
          clearFirst,
          allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
          submit: args.submit === true,
        }, abortSignal)
        if (result.startsWith('Error:')) {
          return browserStructuredOutput({
            ok: false,
            errorKind: /not found|hidden|no visible viewport/i.test(result) ? 'target_not_found' : 'browser_operation_failed',
            message: result.slice('Error:'.length).trim(),
            nextSuggestedAction: 'call browser_snapshot and retry with a current target reference',
          })
        }
        // P1-E5 — change receipt after typing (focus/toast/validation signal).
        const typeReceipt = await captureBrowserActionReceipt(controller, tabId, typeBeforeUrl)
        return attachBrowserActionSessionOutput(result, {
          toolName,
          args,
          controller,
          sessionId,
          currentUserText,
          tabId,
          changeReceipt: typeReceipt,
          nextSuggestedAction: 'read map again',
        })
      }

      case 'type_smart': {
        const target = String(args.target || 'input').trim()
        const text = String(args.text || '')
        if (!target || text === undefined) return 'Error: target and text are required'
        const clearFirst = args.clear_first !== false
        const submit = args.submit === true
        const tabId = (args.tab_id as string) || null
        const smartType = await runTrustedSmartType(controller, tabId, {
          target,
          text,
          clearFirst,
          submit,
          allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
        }, abortSignal)
        const result = smartType.output
        const confirmation = submit ? await detectBrowserPageTransactionConfirmation(controller, tabId) : null
        return attachBrowserActionSessionOutput(result, {
          toolName,
          args,
          controller,
          sessionId,
          currentUserText,
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

      case 'type_compose': {
        const text = String(args.text || '')
        if (!text) return 'Error: text is required'
        const target = String(args.target || '')
        const clearFirst = args.clear_first !== false
        const submit = args.submit !== false
        const tabId = (args.tab_id as string) || null
        const composed = await runTrustedSmartType(controller, tabId, {
          target,
          text,
          clearFirst,
          submit,
          allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
        }, abortSignal)
        const result = composed.output
        const confirmation = submit ? await detectBrowserPageTransactionConfirmation(controller, tabId) : null
        return attachBrowserActionSessionOutput(result, {
          toolName,
          args,
          controller,
          sessionId,
          currentUserText,
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

      case 'find_upload': {
        const tabId = (args.tab_id as string) || null
        const targets = await controller.findUploadTargets(tabId)
        return JSON.stringify({
          count: targets.length,
          targets,
        }, null, 2)
      }

      case 'upload': {
        const startedAt = Date.now()
        const uploadMetaFor = (effectiveTabId: string | null) => ({
          ...resolveToolContextMeta(controller, effectiveTabId),
          latencyMs: Date.now() - startedAt,
        })
        const attachments = await listScopeAttachmentsForTool(sessionId)
        const selected = selectScopeAttachment(attachments, args)
        if (selected.reason) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'attachment_selection_failed',
            ...uploadMetaFor(null),
            reason: selected.reason,
            candidates: attachments.slice(0, 6),
          })
        }
        if (selected.ambiguous && selected.ambiguous.length > 0) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'attachment_selection_ambiguous',
            ...uploadMetaFor(null),
            reason: '存在多个候选附件，请补充 attachment_id 或 attachment_name。',
            candidates: selected.ambiguous,
          })
        }
        const attachment = selected.attachment
        if (!attachment) {
          return browserStructuredOutput({ ok: false, errorCode: 'attachment_not_selected', ...uploadMetaFor(null), reason: '未能选择附件。' })
        }
        if (!existsSync(attachment.path)) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'attachment_file_missing',
            ...uploadMetaFor(null),
            reason: `附件文件不存在: ${attachment.path}`,
            attachment,
          })
        }

        const tabId = (args.tab_id as string) || null
        const pageIdentity = await getPageIdentity(controller, tabId)
        const uploadMemoryKey = buildScopeUploadKey(sessionId, pageIdentity)
        const rememberedUpload = recentScopeUploads.get(uploadMemoryKey)
        if (
          rememberedUpload &&
          rememberedUpload.attachmentId === attachment.attachmentId &&
          rememberedUpload.attachmentPath === attachment.path &&
          Date.now() - rememberedUpload.uploadedAt <= RECENT_SCOPE_UPLOAD_TTL_MS
        ) {
          const rememberedVerification = await verifyUploadState(controller, tabId, attachment.name)
          if (rememberedVerification.success) {
            return JSON.stringify({
              ok: true,
              ...uploadMetaFor(tabId),
              skipped: true,
              reason: 'attachment_already_uploaded_on_current_page',
              attachment: {
                attachmentId: attachment.attachmentId,
                name: attachment.name,
                path: attachment.path,
              },
              verification: rememberedVerification,
              evidenceIds: uniqueStrings(rememberedVerification.evidence || []),
            }, null, 2)
          }
        }
        const selector = typeof args.selector === 'string' ? args.selector : undefined
        const targetText = typeof args.target === 'string' ? args.target : undefined
        const hasCoords = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))
        const mappedCoords = hasCoords
          ? await resolveCssPoint(controller, tabId, Number(args.x), Number(args.y))
          : null

        let targets = await locateActionTargets(controller, tabId, 'upload')
        let chosenTarget = chooseUploadTarget(targets, args)

        if (!chosenTarget && !selector && !targetText && !mappedCoords) {
          const identity = await getPageIdentity(controller, tabId)
          const screenshot = await controller.screenshotAdvanced(tabId, { mode: 'viewport' })
          const analyzed = await analyzeViewportWithVision({
            action: 'upload',
            title: identity.title,
            url: identity.url,
            screenshotBase64: screenshot,
            domCandidates: targets,
          })
          const visionTarget = analyzed.analysis?.targets?.[0]
          if (visionTarget && Number.isFinite(visionTarget.x) && Number.isFinite(visionTarget.y)) {
            chosenTarget = {
              kind: visionTarget.kind === 'upload_launcher' ? 'launcher' : 'icon_button',
              label: visionTarget.label,
              x: visionTarget.x,
              y: visionTarget.y,
              confidence: visionTarget.confidence,
              evidence: [visionTarget.reason || 'vision_candidate'],
            }
          }
        }

        if (chosenTarget && chosenTarget.kind !== 'input') {
          const openResult = await clickActionTarget(controller, tabId, chosenTarget, abortSignal)
          if (!openResult.ok) {
            const recovered = await attemptRecoverPageState(controller, tabId, abortSignal)
            return browserStructuredOutput({
              ok: false,
              ...uploadMetaFor(tabId),
              reason: 'failed_to_open_upload_path',
              attachment,
              target: chosenTarget,
              recovery: recovered,
              evidenceIds: uniqueStrings(chosenTarget?.evidence || []),
            })
          }
          await sleepWithAbort(220, abortSignal)
          targets = await locateActionTargets(controller, tabId, 'upload')
          const inputTarget = pickBestActionTarget(targets.filter((item) => item.kind === 'input'), ['input'])
          if (inputTarget) {
            chosenTarget = inputTarget
          }
        }

        const effectiveSelector = selector
          || chosenTarget?.associatedInputSelector
          || (chosenTarget?.kind === 'input' ? chosenTarget.selectorHint : undefined)

        const effectiveCoords = chosenTarget && Number.isFinite(chosenTarget.x) && Number.isFinite(chosenTarget.y)
          ? await resolveCssPoint(controller, tabId, Number(chosenTarget.x), Number(chosenTarget.y))
          : mappedCoords

        const setResult = await controller.setFileInputFiles(tabId, {
          files: [attachment.path],
          selector: effectiveSelector,
          target: targetText,
          x: effectiveCoords?.cssX,
          y: effectiveCoords?.cssY,
        })
        if (!setResult.ok) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'upload_target_not_found',
            ...uploadMetaFor(tabId),
            reason: '未找到可用的上传入口。',
            attachment,
            candidates: targets.slice(0, 8),
            target: setResult.targetDescription,
            evidenceIds: uniqueStrings(targets.flatMap((item) => item.evidence || [])),
          })
        }

        await settleAfterAction(controller, tabId, abortSignal)
        const verification = await verifyUploadState(controller, tabId, attachment.name)
        const assignedNames = Array.isArray(setResult.assignedFileNames) ? setResult.assignedFileNames : []
        const fileAssigned = Boolean(setResult.filesAssigned) &&
          assignedNames.some((name) => String(name || '').toLowerCase().includes(attachment.name.toLowerCase()))
        const effectiveVerification = verification.success
          ? verification
          : fileAssigned
            ? {
              success: false,
              reason: 'input_files_assigned_pending_page_verification',
              evidence: uniqueStrings([...(verification.evidence || []), 'input_files_assigned']),
            }
            : verification
        if (effectiveVerification.success) {
          recentScopeUploads.set(uploadMemoryKey, {
            attachmentId: attachment.attachmentId,
            attachmentPath: attachment.path,
            pageKey: uploadMemoryKey,
            uploadedAt: Date.now(),
          })
        }
        const payload = {
          ok: effectiveVerification.success,
          ...(!effectiveVerification.success ? { errorCode: 'upload_verification_failed' } : {}),
          ...uploadMetaFor(tabId),
          attachment: {
            attachmentId: attachment.attachmentId,
            name: attachment.name,
            path: attachment.path,
          },
          chosenTarget,
          target: setResult.targetDescription,
          setResult: {
            filesAssigned: Boolean(setResult.filesAssigned),
            assignedFileNames: assignedNames,
          },
          verification: effectiveVerification,
          evidenceIds: uniqueStrings([
            ...(effectiveVerification.evidence || []),
            ...(chosenTarget?.evidence || []),
          ]),
        }
        return stringifyBrowserJsonOrFailure(payload)
      }

      case 'click_coordinate': {
        const x = Number(args.x)
        const y = Number(args.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y are required numbers'
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        // EP1-I3 live-target net — shared guarded entry probes the target
        // under the point; clicking a non-editable destructive-grant target is
        // refused before any mouse event, focusing an editable field is
        // allowed, and an unresolvable probe proceeds (visual channel stays usable).
        const beforeTabs = snapshotBrowserTabs(controller)
        const point = await runGuardedCoordinateClick(controller, tabId, x, y, abortSignal)
        const followedTab = await waitForActionFollowedTab(controller, tabId, beforeTabs, abortSignal)
        const confirmation = await detectBrowserPageTransactionConfirmation(controller, followedTab?.tabId || tabId)
        // D18-b：把"点到了什么"回给模型闭环自纠（第十三轮实锚：模型把
        // power_eval 量出的 CSS 像素直接当归一化坐标传，点偏 ~20% 却毫无
        // 感知）。label 为空≈点到了空白/容器——附坐标系提醒。
        // R18（第十七轮实锚）：dash-tag host 命中时 elementFromPoint 永远只
        // 报 host（label 空），坐标点击成了黑洞。组合树回读把"这个点真正
        // 命中了什么（含 disabled/遮挡）"、host 内候选和瞬时提示交回模型。
        const clickHostTag = String(point.pointTarget?.tag || '')
        let composedTarget: Record<string, unknown> | null = null
        let shadowCandidates: Array<Record<string, unknown>> | null = null
        let clickPageNotices: string[] = []
        if (clickHostTag.includes('-') && !followedTab) {
          // R19 收窄：点击已把同 tab 带去新页面（如「发布」成功跳转）时，
          // 旧 host rect 全是陈迹——取证纯属浪费。以点击前后 URL 对比为
          // 同页判据（pre-click 探针带 url），URL 变了整块跳过。
          const beforeUrl = String(point.pointTarget?.url || '')
          const afterUrl = beforeUrl
            ? String(await controller.executeJS(tabId, '(() => String(location.href || ""))()').catch(() => '') || '')
            : ''
          const samePageWorld = !beforeUrl || !afterUrl || beforeUrl === afterUrl
          if (samePageWorld) {
            const described = await describeComposedPointTarget(
              controller,
              tabId,
              { cssX: point.cssX, cssY: point.cssY },
            ).catch(() => null)
            if (described && described.interactive && !described.isHost) {
              composedTarget = {
                text: described.text,
                tag: described.tag,
                ...(described.disabled ? { disabled: true } : {}),
                ...(described.cover ? { cover: described.cover } : {}),
              }
            } else if (point.pointTarget?.rect) {
              const scan = await scanClosedShadowHostForClickPoint(
                controller,
                tabId,
                point.pointTarget.rect,
                { vw: point.width, vh: point.height },
                { targetName: '', disambiguation: '' },
              ).catch(() => null)
              if (scan && scan.candidates.length > 0) {
                shadowCandidates = scan.candidates.map((c) => ({
                  text: c.text,
                  tag: c.tag,
                  normalized: {
                    x: Math.max(0, Math.min(999, Math.round((c.cssX / Math.max(1, point.width)) * 1000))),
                    y: Math.max(0, Math.min(999, Math.round((c.cssY / Math.max(1, point.height)) * 1000))),
                  },
                  ...(c.disabled ? { disabled: true } : {}),
                  ...(c.cover ? { cover: c.cover } : {}),
                }))
              }
            }
            clickPageNotices = await readTransientPageNotices(controller, tabId)
          }
        }
        const composedHint = composedTarget
          ? `点击穿透 <${clickHostTag}> 命中「${String(composedTarget.text || '')}」<${String(composedTarget.tag || '')}>${composedTarget.disabled ? '——该按钮当前为 disabled（页面校验未通过），点击不会生效，先补齐页面必填项' : ''}${composedTarget.cover ? `——按钮中心被 ${String(composedTarget.cover)} 遮挡` : ''}。`
          : shadowCandidates
            ? `点击落在关闭 shadow 宿主 <${clickHostTag}> 的空白处，未命中内部按钮。内部候选见 shadowCandidates，选中意图按钮后按其 normalized 坐标重点。`
            : null
        log(`click_at resolved input=(${x},${y}) normalized=(${point.nx},${point.ny}) css=(${Math.round(point.cssX)},${Math.round(point.cssY)}) pointTarget=${JSON.stringify(point.pointTarget?.label ?? null)}${composedTarget ? ` composed=${JSON.stringify(composedTarget)}` : ''}${shadowCandidates ? ` shadowCandidates=${JSON.stringify(shadowCandidates.map((c) => c.text))}` : ''}${clickPageNotices.length > 0 ? ` notices=${JSON.stringify(clickPageNotices)}` : ''}`)
        return attachBrowserActionSessionOutput(JSON.stringify({
          ok: true,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          viewport: { width: point.width, height: point.height },
          pointTarget: point.pointTarget,
          ...(composedTarget ? { composedTarget } : {}),
          ...(shadowCandidates ? { shadowCandidates } : {}),
          ...(clickPageNotices.length > 0 ? { pageNotices: clickPageNotices } : {}),
          ...(composedHint
            ? { coordinateHint: composedHint }
            : point.pointTarget && !point.pointTarget.label && !point.pointTarget.editable
              ? { coordinateHint: `点下命中 <${point.pointTarget.tag || 'unknown'}>，无语义标签也不可编辑——很可能点到了空白/容器。注意 x/y 是 0-1000 归一化坐标（不是 CSS 像素）；若你用 getBoundingClientRect 量到像素 px，请换算 round(px / 视口宽高 * 1000) 再调用。` }
              : {}),
          followedTab,
          nextSuggestedAction: followedTab ? `read map again on tab ${followedTab.tabId}` : 'read map again',
        }, null, 2), {
          toolName,
          args,
          controller,
          sessionId,
          currentUserText,
          tabId,
          followedTab,
          confirmation,
          nextSuggestedAction: confirmation
            ? 'finish with transaction proof'
            : (followedTab ? `read map again on tab ${followedTab.tabId}` : 'read map again'),
        })
      }

      case 'type_coordinate': {
        const x = Number(args.x)
        const y = Number(args.y)
        const text = String(args.text || '')
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y are required numbers'
        if (!text) return 'Error: text is required'
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const pressEnter = args.submit === true || args.press_enter === true
        const clearBeforeTyping = args.clear_first !== false && args.clear_before_typing !== false
        const useShiftEnter = args.use_shift_enter_for_newline === true
        // EP1-I3 live-target net — shared guarded entry: non-editable
        // destructive-grant target → the focusing click is itself refused;
        // editable field → judged by field semantics (NOT its current value)
        // + password cue.
        const point = await runGuardedCoordinateType(controller, tabId, x, y, text, {
          clearBefore: clearBeforeTyping,
          pressEnter,
          useShiftEnter,
          allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
        }, abortSignal)
        // D18-c（真机第十四轮实锚）：聚焦点击落在死区时焦点滞留上一控件，
        // 正文全文灌进标题框、模型盲试 4 分钟。typed=false 响亮失败；成功
        // 也回读 typedInto（打进了哪个框、框里现在是什么）供同轮自纠。
        log(`type_at resolved input=(${x},${y}) normalized=(${point.nx},${point.ny}) css=(${Math.round(point.cssX)},${Math.round(point.cssY)}) typed=${point.typed} focus=${JSON.stringify(point.focusTarget?.label ?? point.focusTarget?.kind ?? null)} typedInto=${JSON.stringify(point.typedInto?.label ?? null)}`)
        if (!point.typed) {
          // D18-d：三类机械拒因分档回话——焦点不可编辑 / 字段容量装不下 /
          // 单行框收多段文本（后两类=第十六轮"正文灌标题"循环的硬闸）。
          const refusal = point.skipReason === 'text_exceeds_field_capacity'
            ? {
              errorKind: 'type_field_capacity_exceeded',
              message: `焦点字段「${point.focusTarget?.label || point.focusTarget?.tag || '未知'}」上限 ${point.focusTarget?.maxLength} 字，本次文本 ${text.length} 字——这是标题/短字段，不是正文编辑器。已拒绝打字。请改用 act fill 正文 contenteditable target（read map 或 browser_snapshot(scope=forms) 可见），不要再微调坐标重试。`,
            }
            : point.skipReason === 'multiline_into_single_line'
              ? {
                errorKind: 'type_multiline_into_single_line',
                message: `焦点是单行输入框「${point.focusTarget?.label || 'input'}」，本次文本含换行/多段。已拒绝打字。请定位正文编辑器（contenteditable）后用 act fill。`,
              }
              : {
                errorKind: 'type_target_not_editable',
                message: '坐标点击后焦点不在可编辑控件上，已拒绝打字（避免文字灌进错误的框）。注意 x/y 是 0-1000 归一化坐标；用 browser_find 或 read map 拿准输入框位置，或直接 act fill 编辑器 target。',
              }
          return attachBrowserActionSessionOutput(browserStructuredOutput({
            ok: false,
            errorKind: refusal.errorKind,
            normalized: { x: point.nx, y: point.ny },
            css: { x: point.cssX, y: point.cssY },
            focusTarget: point.focusTarget,
            message: refusal.message,
          }), {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId,
            confirmation: null,
            nextSuggestedAction: 'locate input targets, then retype',
          })
        }
        const confirmation = pressEnter ? await detectBrowserPageTransactionConfirmation(controller, tabId) : null
        return attachBrowserActionSessionOutput(JSON.stringify({
          ok: true,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          submitted: pressEnter,
          text_length: text.length,
          focusTarget: point.focusTarget,
          typedInto: point.typedInto,
        }, null, 2), {
          toolName,
          args,
          controller,
          sessionId,
          currentUserText,
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

      case 'scroll': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const x = Number(args.x ?? 500)
        const y = Number(args.y ?? 500)
        const inferredDirection = Number(args.delta_y) < 0
          ? 'up'
          : Number(args.delta_y) > 0
            ? 'down'
            : Number(args.delta_x) < 0
              ? 'left'
              : Number(args.delta_x) > 0
                ? 'right'
                : 'down'
        const direction = String(args.direction || inferredDirection).toLowerCase()
        if (!['up', 'down', 'left', 'right'].includes(direction)) {
          return 'Error: direction must be up/down/left/right'
        }
        const magnitude = Math.max(40, Math.min(4000, Math.abs(Number(args.amount || args.magnitude || args.delta_y || args.delta_x || 800))))
        const point = await resolveCssPoint(controller, tabId, x, y)
        const deltaY = direction === 'up' ? -magnitude : direction === 'down' ? magnitude : 0
        const deltaX = direction === 'left' ? -magnitude : direction === 'right' ? magnitude : 0
        await controller.dispatchMouse(tabId, {
          type: 'mouseWheel',
          x: point.cssX,
          y: point.cssY,
          deltaX,
          deltaY,
          button: 'none',
          buttons: 0,
        })
        return `Scrolled ${direction} at normalized(${point.nx},${point.ny})`
      }

      case 'press_key': {
        const tabId = (args.tab_id as string) || null
        const key = String(args.key || '').trim()
        if (!key) return 'Error: key is required'
        await sendKeyStroke(controller, tabId, key, args.modifiers)
        // D18-d：回报按键落点焦点——Cmd+A/Backspace 这类组合落错焦点是
        // 第十六轮正文被整段清空的元凶，落点必须当轮可见。
        const keyFocusProbe = await controller.executeJS(tabId, buildFocusedEditableProbeJs()).catch(() => null)
        const keyFocus = keyFocusProbe && typeof keyFocusProbe === 'object'
          ? (() => {
            const f = keyFocusProbe as { tag?: unknown; label?: unknown; kind?: unknown }
            const label = String(f.label || '').slice(0, 80)
            return ` (focus: ${label || String(f.kind || 'unknown')}<${String(f.tag || '?')}>)`
          })()
          : ''
        const confirmation = /^(Enter|Return)$/i.test(key)
          ? await detectBrowserPageTransactionConfirmation(controller, tabId)
          : null
        return attachBrowserActionSessionOutput(`Sent key: ${key}${keyFocus}`, {
          toolName,
          args,
          controller,
          sessionId,
          currentUserText,
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

      case 'request_takeover': {
        const callToAction = String(args.reason || args.call_to_action || '').trim()
        if (!callToAction) return 'Error: reason is required'
        if (args.action === 'complete') {
          const userConfirmed = /(?:已完成|完成了|验证好了|验证完成|登录好了|接管完了|操作好了|\bdone\b)/i.test(String(currentUserText || ''))
          if (!userConfirmed) {
            return browserStructuredOutput({
              ok: false,
              errorKind: 'takeover_completion_not_confirmed',
              takeover_state: 'submitted',
              message: 'Only the current user can confirm that takeover work is complete.',
            })
          }
          return browserStructuredOutput({
            ok: true,
            takeover_state: 'completed',
            challengeCleared: true,
            next_step: 'resume the same task from a fresh browser_snapshot',
          })
        }
        const details = String(args.instruction || args.details || '')
        const timeoutSec = Math.max(30, Math.min(1200, Number(args.timeout_sec || 300)))
        log(`[browser-v3][human-required] action=${callToAction} timeout=${timeoutSec}s`)
        return JSON.stringify({
          phase: 'human_required',
          takeover_state: 'submitted',
          call_to_action: callToAction,
          details,
          timeout_sec: timeoutSec,
          next_step: 'wait for user takeover result: submitted|skipped|timeout',
        }, null, 2)
      }

      case 'navigate_back': {
        const tabId = (args.tab_id as string) || null
        const result = controller.goBack(tabId)
        if (!result.success) return `Error: ${result.error}`
        return 'Navigated back.'
      }

      case 'navigate_forward': {
        const tabId = (args.tab_id as string) || null
        const result = controller.goForward(tabId)
        if (!result.success) return `Error: ${result.error}`
        return 'Navigated forward.'
      }

      case 'navigate_reload': {
        const tabId = (args.tab_id as string) || null
        const result = controller.reload(tabId)
        if (!result.success) return `Error: ${result.error}`
        return 'Reloaded page.'
      }

      default:
        return `Unknown browser tool: ${toolName}`
  }
}
