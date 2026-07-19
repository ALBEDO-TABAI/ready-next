/**
 * P3 Phase B7（2026-07-05，纯移动拆分）— browser-tools 行动/导航组。
 *
 * 从 browser-tools.ts 逐字搬出十六个 case 的实现体（browser_navigate /
 * browser_search / browser_click/browser_type / browser_click / browser_click /
 * browser_type / browser_type / browser_type /
 * browser_find / browser_upload /
 * browser_click / browser_type / browser_scroll / browser_press_key /
 * browser_request_takeover / browser_navigate(action=back)，经 executeBrowserActTool 统一
 * 入口分发）与本组独占 helper（tab 跟随快照、动作前后 delta 回读、
 * click-by-text 帧穿透定位、scope 附件上传的选择/验证/恢复、
 * recentScopeUploads 单例）。
 * browser_click/browser_type 的 D18 升级块逐字节未动，页面地图 generation/
 * ambiguity 经 act→observe 单向 import 回读。attachBrowserToolOutput
 * （sitePermissionNotices 精确任务范围合同）留在 browser-tools，经
 * BrowserActToolContext 注入回接；BrowserActionFollowedTab 类型因 facade 的
 * attach 签名同时使用而移入 browser-tool-shared.ts。本模块零反向 import。
 * 行为零变更。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { BrowserMutationBoundary } from './browser-action-executor'
import type { BrowserPowerEffect } from '../../../shared/browser-power'
import { createHash } from 'node:crypto'
import { existsSync } from 'fs'
import { captureBrowserActionReceipt, type BrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import { AgentRepository } from '../repositories/agent-repository'
import { createRotatingLogger } from '../../utils/rotating-logger'
import {
  findRecentBrowserAction,
  rememberBrowserAction,
} from '../agent-control/session/session-continuity'
import { agentBrowserError, isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import { parseTargetId } from '../browser-engine/agent-browser-page-map'
import type { BrowserTargetFingerprint } from '../browser-engine/agent-browser-page-map'
import { browserSnapshotService, parseBrowserSnapshotRef } from '../browser-engine/browser-snapshot-service'
import { gateActOnTarget, type AgentBrowserAction, type AgentBrowserReadBack } from '../browser-engine/agent-browser-act'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import {
  createBrowserStructuredOutput as browserStructuredOutput,
  stringifyBrowserJsonOrFailure,
} from './browser-failure-output'
import {
  buildBrowserBlockingChallengeProbeJs,
  buildFocusedEditableProbeJs,
  buildBrowserTargetFormSubmitJs,
  buildBrowserTargetProbeJs,
  buildTargetSemanticsLibraryJs,
  buildTransientNoticeProbeJs,
  throwIfLiveTargetGuardBlocked,
  buildBrowserActionDeltaJs,
  normalizeBrowserBlockingChallengeProbe,
  probeCoordinateTargetOrThrow,
  callBrowserBackendTarget,
} from './browser-probe'
import { browserInputEnvironmentReadiness } from '../browser-engine/browser-input-readiness'
import {
  buildSmartTypeProbeJs,
  resolveCssPoint,
  runGuardedCoordinateClick,
  runGuardedCoordinateType,
  runGuardedTargetType,
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
  getPageIdentity,
  listSubframesSafe,
  locateActionTargets,
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

async function retainCompositeTrustedInputSequence(
  controller: BrowserController,
  tabId: string | null,
): Promise<() => void> {
  return typeof controller.retainTrustedInputSequence === 'function'
    ? controller.retainTrustedInputSequence(tabId)
    : () => undefined
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

function targetFingerprint(value: unknown): BrowserTargetFingerprint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const source = record.fingerprint && typeof record.fingerprint === 'object'
    ? record.fingerprint as Record<string, unknown>
    : record
  return {
    role: String(source.role ?? record.role ?? ''),
    name: String(source.name ?? record.name ?? '').replace(/\s+/g, ' ').trim(),
    href: String(source.href ?? record.href ?? ''),
    inputType: String(source.inputType ?? record.inputType ?? '').toLowerCase(),
    autocomplete: String(source.autocomplete ?? record.autocomplete ?? '').toLowerCase(),
    formAction: String(source.formAction ?? record.formAction ?? ''),
    ancestorContext: String(source.ancestorContext ?? record.ancestorContext ?? '').replace(/\s+/g, ' ').trim(),
  }
}

function sameTargetFingerprint(captured: unknown, live: unknown): boolean {
  const before = targetFingerprint(captured)
  const after = targetFingerprint(live)
  if (!before || !after) return false
  return JSON.stringify(before) === JSON.stringify(after)
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
  options: { allowUnpresented?: boolean } = {},
): Promise<{ x: number | null; y: number | null; cssX: number; cssY: number; width: number; height: number } | null> {
  const x = Number(box?.x)
  const y = Number(box?.y)
  const width = Number(box?.width)
  const height = Number(box?.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  const offset = await frameViewportOffset(controller, tabId, frameId)
  const viewport = await controller.getViewportMetrics(tabId)
  const left = offset.x + x
  const top = offset.y + y
  if (!(viewport.width > 0 && viewport.height > 0)) {
    return options.allowUnpresented
      ? {
          x: null,
          y: null,
          cssX: left + width / 2,
          cssY: top + height / 2,
          width: viewport.width,
          height: viewport.height,
        }
      : null
  }
  const visibleLeft = Math.max(0, left)
  const visibleTop = Math.max(0, top)
  const visibleRight = Math.min(viewport.width, left + width)
  const visibleBottom = Math.min(viewport.height, top + height)
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null
  const cssX = (visibleLeft + visibleRight) / 2
  const cssY = (visibleTop + visibleBottom) / 2
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
  const activeBefore = before.find((tab) => tab.active) || null
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
  if (activeAfter && activeBefore && sourceId && activeAfter.id !== activeBefore.id && activeAfter.id !== sourceId) {
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
      const rect = matched.getBoundingClientRect()
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
        return { ok: false, errorKind: 'target_outside_viewport' }
      }
      const x = Math.max(0, Math.min(window.innerWidth, rect.left + rect.width / 2))
      const y = Math.max(0, Math.min(window.innerHeight, rect.top + rect.height / 2))
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
    confirmPasswordFill?: (target: string) => Promise<boolean>
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
    inputType?: unknown
  }
  const width = Number(located.width)
  const height = Number(located.height)
  if (!(width > 0 && height > 0)) return { ok: false, output: 'Smart input target has no visible viewport.' }
  let allowPasswordFill = options.allowPasswordFill
  if (String(located.inputType || '').toLowerCase() === 'password' && !allowPasswordFill) {
    allowPasswordFill = await options.confirmPasswordFill?.(String(located.target || options.target)) === true
    if (!allowPasswordFill) {
      return {
        ok: false,
        output: JSON.stringify({
          ok: false,
          errorKind: 'credential_confirmation_required',
          liveTargetKind: 'password',
        }),
      }
    }
  }
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
      allowPasswordFill,
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

interface ScopeAttachmentCandidate {
  attachmentId: string
  name: string
  path: string
  type: string
  size: number
  ext: string
  createdAt: string
}

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

function selectScopeAttachments(
  attachments: ScopeAttachmentCandidate[],
  args: Record<string, unknown>,
): { selected?: ScopeAttachmentCandidate[]; ambiguous?: ScopeAttachmentCandidate[]; reason?: string } {
  if (attachments.length === 0) {
    return { reason: '当前会话没有可用附件。' }
  }
  const attachmentId = String(args.attachment_id || '').trim()
  const attachmentIds = Array.isArray(args.attachment_ids)
    ? Array.from(new Set(args.attachment_ids.map((value) => String(value || '').trim()).filter(Boolean)))
    : []
  const attachmentName = String(args.attachment_name || '').trim().toLowerCase()

  if (attachmentId) {
    const match = attachments.find((item) => item.attachmentId === attachmentId)
    return match ? { selected: [match] } : { reason: `未找到附件: ${attachmentId}` }
  }

  if (attachmentIds.length > 0) {
    const byId = new Map(attachments.map((item) => [item.attachmentId, item]))
    const missing = attachmentIds.filter((id) => !byId.has(id))
    if (missing.length > 0) return { reason: `未找到附件: ${missing.join(', ')}` }
    return { selected: attachmentIds.map((id) => byId.get(id)!) }
  }

  if (attachmentName) {
    const matches = attachments.filter((item) => item.name.toLowerCase().includes(attachmentName))
    if (matches.length === 1) return { selected: matches }
    if (matches.length > 1) return { ambiguous: matches }
    return { reason: `未找到名称匹配的附件: ${attachmentName}` }
  }

  if (args.latest === true) return { selected: [attachments[0]!] }
  return { reason: '请明确指定 attachment_id、attachment_ids、attachment_name 或 latest=true。' }
}

export interface BrowserActToolContext {
  controller: BrowserController
  abortSignal?: AbortSignal
  sessionId?: string
  mutationBoundary: BrowserMutationBoundary
  requestPowerConfirmation?: (details: {
    toolName: string
    effects: BrowserPowerEffect[]
    purpose: string
    origin: string | null
    objectRef: string
    inputHash: string
  }) => Promise<boolean>
  createHumanTakeoverIntent?: () => Promise<{ takeoverId: string }>
  attachBrowserToolOutput: (
    result: string | ToolExecutionOutput,
    params: {
      toolName: string
      args: Record<string, unknown>
      controller: BrowserController
      sessionId?: string
      tabId?: string | null
      followedTab?: BrowserActionFollowedTab | null
      confirmation?: unknown
      nextSuggestedAction?: string | null
      frameId?: string | null
      changeReceipt?: BrowserActionReceipt | null
    },
  ) => string | ToolExecutionOutput
}

async function confirmLivePasswordFill(
  ctx: BrowserActToolContext,
  tabId: string | null,
  objectRef: string,
  text: string,
): Promise<boolean> {
  if (!ctx.requestPowerConfirmation) return false
  const url = activeBrowserToolUrl(ctx.controller, tabId)
  const origin = (() => {
    try { return url ? new URL(url).origin : null } catch {
      // silent-catch: malformed page URLs cannot authorize credential use.
      return null
    }
  })()
  return ctx.requestPowerConfirmation({
    toolName: 'browser_type',
    effects: ['credential_use'],
    purpose: 'Fill the structurally verified live password field once.',
    origin,
    objectRef,
    inputHash: createHash('sha256').update(JSON.stringify({ tabId, objectRef, text })).digest('hex'),
  })
}

async function invokeTargetFormSubmit(
  controller: BrowserController,
  mutationBoundary: BrowserMutationBoundary,
  tabId: string | null,
  target: {
    nodeId: string
    frameId: string
    frameDocumentToken: string
    backendNodeId?: number
    roleHint?: string
  },
): Promise<Record<string, unknown>> {
  if (target.frameId !== '0' && typeof controller.executeJSInFrame !== 'function') {
    return {
      ok: false,
      errorKind: 'stale_page_map',
      reason: 'frame_not_reachable',
      delivery: 'not_delivered',
    }
  }
  const raw = await mutationBoundary.invokeTransport(() => {
    browserSnapshotService.markDirty(controller, tabId)
    if (target.frameId === '0' && target.backendNodeId) {
      return callBrowserBackendTarget(controller, tabId, target.backendNodeId, 'submit', {
        roleHint: target.roleHint || '',
      })
    }
    const script = buildBrowserTargetFormSubmitJs(target.nodeId, target.frameDocumentToken)
    return target.frameId === '0'
      ? controller.executeJS(tabId, script)
      : controller.executeJSInFrame!(tabId, target.frameId, script)
  })
  const result = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : { ok: false, reason: 'submit_result_unavailable', delivery: 'unknown' }
  const delivery = result.delivery === 'delivered' || result.delivery === 'not_delivered'
    ? result.delivery
    : 'unknown'
  mutationBoundary.recordMechanicalFact({ delivery })
  return {
    ...result,
    ok: result.ok === true && delivery === 'delivered',
    delivery,
  }
}

async function submitResolvedTargetForm(
  controller: BrowserController,
  mutationBoundary: BrowserMutationBoundary,
  tabId: string,
  targetId: string,
): Promise<Record<string, unknown>> {
  const resolved = await browserSnapshotService.resolveRef(controller, tabId, targetId)
  if (!resolved.ok) {
    return {
      ok: false,
      errorKind: 'stale_page_map',
      reason: resolved.errorCode,
      delivery: 'not_delivered',
    }
  }
  const parsed = parseTargetId(resolved.rawTargetId)
  if (!parsed) return { ok: false, errorKind: 'target_not_found', delivery: 'not_delivered' }
  const backendNodeId = /^b(\d+)$/.exec(parsed.node)?.[1]
  return invokeTargetFormSubmit(controller, mutationBoundary, tabId, {
    nodeId: parsed.node,
    frameId: parsed.frameId || '0',
    frameDocumentToken: resolved.frameDocumentToken,
    ...(backendNodeId ? { backendNodeId: Number(backendNodeId) } : {}),
    roleHint: String(resolved.target.role || ''),
  })
}

export async function executeBrowserActTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserActToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId,  mutationBoundary, attachBrowserToolOutput } = ctx
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
        const navTabId = (args.tab_id as string) || null
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
        const confirmation = null
        return attachBrowserToolOutput(
          `Navigated to ${url}\nCurrent page: ${target?.title || 'Loading...'} (${target?.url || url})`,
          {
            toolName,
            args,
            controller,
            sessionId,
            tabId: target?.id || navTabId,
            confirmation,
            nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
          },
        )
      }

      case 'search': {
        const query = String(args.query || '')
        if (!query.normalize('NFC').replace(/\r\n?/g, '\n').trim()) return 'Error: query is required'
        const searchTabId = typeof args.tab_id === 'string' && args.tab_id.trim()
          ? args.tab_id.trim()
          : controller.getActiveTab?.()?.id || null
        if (!searchTabId) return browserStructuredOutput({ ok: false, errorKind: 'search_live_tab_required' })

        const state = normalizeBrowserBlockingChallengeProbe(
          await controller.executeJS(searchTabId, buildBrowserBlockingChallengeProbeJs()),
        )
        if (state.blocked) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'challenge_required',
            waitingHuman: true,
            evidence: [`visible_blocker:${state.blockerCount}`, ...state.matchedKinds.map((kind) => `challenge:${kind}`)],
          })
        }
        if (state.pageError || state.emptyShell) {
          return browserStructuredOutput({
            ok: false,
            errorKind: state.pageError ? 'page_error' : 'page_content_empty',
          })
        }

        type SearchTarget = {
          targetId?: string
          role?: string
          name?: string
          states?: Record<string, unknown>
          box?: { width?: number; height?: number }
          fingerprint?: { formAction?: string }
          rendered?: boolean
          visible?: boolean
          enabled?: boolean
          editable?: boolean
        }
        const requestedRefs = {
          input: typeof args.input_target_id === 'string' ? args.input_target_id.trim() : '',
          submit: typeof args.submit_target_id === 'string' ? args.submit_target_id.trim() : '',
          result: typeof args.result_target_id === 'string' ? args.result_target_id.trim() : '',
          empty: typeof args.empty_target_id === 'string' ? args.empty_target_id.trim() : '',
        }
        for (const kind of ['input', 'submit', 'result', 'empty'] as const) {
          const ref = requestedRefs[kind]
          if (!ref) continue
          const resolved = await browserSnapshotService.resolveRef(controller, searchTabId, ref)
          if (!resolved.ok) {
            return browserStructuredOutput({
              ok: false,
              errorKind: 'stale_page_map',
              targetKind: kind,
              targetId: ref,
              reason: resolved.errorCode,
              writesPerformed: 0,
            })
          }
        }

        const before = await captureAgentPageMap(controller, searchTabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES, { force: true })
        const targets = Array.isArray((before.pageMap as { targets?: unknown } | null)?.targets)
          ? (before.pageMap as { targets: SearchTarget[] }).targets
          : []
        for (const kind of ['input', 'submit', 'result', 'empty'] as const) {
          const ref = requestedRefs[kind]
          if (!ref) continue
          const oldRef = parseBrowserSnapshotRef(ref)
          const oldTarget = oldRef ? parseTargetId(oldRef.rawTargetId) : null
          const currentRef = targets.find((target) => {
            const freshRef = typeof target.targetId === 'string' ? parseBrowserSnapshotRef(target.targetId) : null
            const freshTarget = freshRef ? parseTargetId(freshRef.rawTargetId) : null
            return Boolean(oldRef && oldTarget && freshRef && freshTarget
              && freshRef.tabId === oldRef.tabId
              && freshRef.physicalTargetToken === oldRef.physicalTargetToken
              && freshRef.frameId === oldRef.frameId
              && freshRef.frameDocumentToken === oldRef.frameDocumentToken
              && freshTarget.frameId === oldTarget.frameId
              && freshTarget.node === oldTarget.node)
          })?.targetId || ''
          if (!currentRef) {
            return browserStructuredOutput({
              ok: false,
              errorKind: 'stale_page_map',
              targetKind: kind,
              targetId: ref,
              reason: 'target_missing_after_refresh',
              writesPerformed: 0,
            })
          }
          requestedRefs[kind] = currentRef
        }

        const structuralInputs = targets.filter((target) => {
          const role = String(target.role || '').toLowerCase()
          const enabled = target.enabled !== false && target.states?.disabled !== true
          const rendered = target.rendered !== false
            && (!target.box || (Number(target.box.width || 0) > 0 && Number(target.box.height || 0) > 0))
          return enabled && rendered && target.editable !== false && ['searchbox', 'textbox', 'combobox'].includes(role)
        })
        const explicitInput = requestedRefs.input
          ? targets.find((target) => target.targetId === requestedRefs.input) || { targetId: requestedRefs.input }
          : null
        const preferredInputs = structuralInputs.filter((target) => String(target.role || '').toLowerCase() === 'searchbox')
        const candidates = preferredInputs.length > 0 ? preferredInputs : structuralInputs
        const inputTarget = explicitInput || (candidates.length === 1 ? candidates[0] : null)
        if (!inputTarget?.targetId) {
          return browserStructuredOutput({
            ok: false,
            errorKind: candidates.length === 0 ? 'search_input_target_missing' : 'search_input_target_ambiguous',
            query,
            tabId: searchTabId,
            pageIdentity: before.pageIdentity,
            count: candidates.length,
            matches: candidates.slice(0, 12),
            writesPerformed: 0,
          })
        }

        const explicitSubmitTarget = requestedRefs.submit
          ? targets.find((target) => target.targetId === requestedRefs.submit) || null
          : null
        const structuralSubmitAvailable = requestedRefs.submit
          ? Boolean(String(explicitSubmitTarget?.fingerprint?.formAction || '').trim())
          : Boolean(String(inputTarget.fingerprint?.formAction || '').trim())
        const fillReadiness = browserInputEnvironmentReadiness(controller, searchTabId, 'direct_text')
        if (!fillReadiness.ready) {
          return browserStructuredOutput({
            ok: false,
            errorKind: fillReadiness.reason === 'foreground_required' ? 'foreground_required' : 'browser_surface_required',
            reason: fillReadiness.reason,
            phase: 'not_submitted',
            submitted: false,
            writesPerformed: 0,
            readiness: fillReadiness,
          })
        }
        if (!structuralSubmitAvailable) {
          const submitReadiness = browserInputEnvironmentReadiness(
            controller,
            searchTabId,
            requestedRefs.submit ? 'trusted_pointer' : 'trusted_keyboard',
          )
          if (!submitReadiness.ready) {
            return browserStructuredOutput({
              ok: false,
              errorKind: submitReadiness.reason === 'foreground_required' ? 'foreground_required' : 'browser_surface_required',
              reason: submitReadiness.reason,
              phase: 'not_submitted',
              submitted: false,
              writesPerformed: 0,
              readiness: submitReadiness,
            })
          }
        }

        const fillStep = await mutationBoundary.runSearchStep('fill', () => executeBrowserActTool('type_target', {
          target_id: inputTarget.targetId,
          text: query,
          clear_first: true,
          submit: false,
          tab_id: searchTabId,
        }, ctx))
        const outputData = (value: string | ToolExecutionOutput): Record<string, unknown> | null => {
          const text = typeof value === 'string' ? value : value.text
          try {
            const parsed = JSON.parse(text) as unknown
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
          } catch {
            // silent-catch: non-JSON tool output cannot prove a successful fill.
            return null
          }
        }
        const fillData = outputData(fillStep.value)
        const fillResult = fillData?.result && typeof fillData.result === 'object' && !Array.isArray(fillData.result)
          ? fillData.result as Record<string, unknown>
          : null
        const typed = fillResult?.typed && typeof fillResult.typed === 'object' && !Array.isArray(fillResult.typed)
          ? fillResult.typed as Record<string, unknown>
          : null
        const typedInto = typed?.typedInto && typeof typed.typedInto === 'object' && !Array.isArray(typed.typedInto)
          ? typed.typedInto as Record<string, unknown>
          : null
        const fillVerified = Boolean(
          fillStep.settlement
          && fillData?.ok !== false
          && typed?.typed === true
          && typed?.textDelivery === 'delivered'
          && typedInto?.textMatchesExpected === true,
        )
        if (!fillVerified) {
          const actionIds = mutationBoundary.searchActionIds()
          return browserStructuredOutput({
            ok: false,
            errorKind: 'search_fill_readback_mismatch',
            phase: 'not_submitted',
            submitted: false,
            delivery: 'not_delivered',
            effectObserved: false,
            needsObservation: false,
            searchActionId: actionIds.searchActionId,
            fillActionId: actionIds.fillActionId,
            submitActionId: null,
            fill: fillData,
          })
        }

        let submitTargetId = requestedRefs.submit
        if (structuralSubmitAvailable || submitTargetId) {
          const refreshed = await captureAgentPageMap(controller, searchTabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES, { force: true })
          const refreshedTargets = Array.isArray((refreshed.pageMap as { targets?: unknown } | null)?.targets)
            ? (refreshed.pageMap as { targets: SearchTarget[] }).targets
            : []
          const refreshTargetId = (oldTargetId: string): string => {
            const oldRef = parseBrowserSnapshotRef(oldTargetId)
            return refreshedTargets.find((target) => {
              const freshRef = typeof target.targetId === 'string' ? parseBrowserSnapshotRef(target.targetId) : null
              const oldRawTarget = oldRef ? parseTargetId(oldRef.rawTargetId) : null
              const freshRawTarget = freshRef ? parseTargetId(freshRef.rawTargetId) : null
              return Boolean(oldRef && freshRef
                && oldRawTarget && freshRawTarget
                && freshRef.tabId === oldRef.tabId
                && freshRef.physicalTargetToken === oldRef.physicalTargetToken
                && freshRef.frameId === oldRef.frameId
                && freshRef.frameDocumentToken === oldRef.frameDocumentToken
                && freshRawTarget.frameId === oldRawTarget.frameId
                && freshRawTarget.node === oldRawTarget.node)
            })?.targetId || ''
          }
          submitTargetId = refreshTargetId(
            structuralSubmitAvailable && !requestedRefs.submit
              ? inputTarget.targetId
              : requestedRefs.submit,
          )
          if (!submitTargetId) {
            const actionIds = mutationBoundary.searchActionIds()
            return browserStructuredOutput({
              ok: false,
              errorKind: 'search_submit_target_stale_after_fill',
              phase: 'not_submitted',
              submitted: false,
              searchActionId: actionIds.searchActionId,
              fillActionId: actionIds.fillActionId,
              submitActionId: null,
            })
          }
        }
        const submitStep = await mutationBoundary.runSearchStep('submit', async () => {
          if (structuralSubmitAvailable && submitTargetId) {
            const result = await submitResolvedTargetForm(controller, mutationBoundary, searchTabId, submitTargetId)
            await settleAfterAction(controller, searchTabId, abortSignal)
            return browserStructuredOutput(result)
          }
          return executeBrowserActTool(
            submitTargetId ? 'click_target' : 'press_key',
            submitTargetId
              ? { target_id: submitTargetId, action: 'click', tab_id: searchTabId }
              : { key: 'Enter', tab_id: searchTabId },
            ctx,
          )
        })
        const submitData = outputData(submitStep.value)
        const submitOutcome = submitStep.settlement?.outcome || null
        const submitDelivery = submitOutcome?.delivery || 'unknown'
        const effectObserved = submitOutcome?.effect === 'observed'
        const submitted = submitDelivery === 'delivered'
        if (submitted) rememberBrowserAction(sessionId, 'search', `${searchTabId}:${query}`)
        const actionIds = mutationBoundary.searchActionIds()
        return browserStructuredOutput({
          ok: submitted,
          query,
          tabId: searchTabId,
          searchTarget: { targetId: inputTarget.targetId, role: inputTarget.role, name: inputTarget.name },
          submitTargetId: submitTargetId || null,
          expectedEffectTargets: {
            resultTargetId: requestedRefs.result || null,
            emptyTargetId: requestedRefs.empty || null,
          },
          phase: effectObserved ? 'effect_observed' : submitted ? 'submitted_needs_observation' : 'not_submitted',
          submitted,
          delivery: submitDelivery,
          effectObserved,
          needsObservation: submitted && !effectObserved,
          mayHaveCommitted: !submitted && submitDelivery === 'unknown',
          searchActionId: actionIds.searchActionId,
          fillActionId: actionIds.fillActionId,
          submitActionId: actionIds.submitActionId,
          fill: fillData,
          submit: submitData,
        })
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
        const releaseInputSequence = await retainCompositeTrustedInputSequence(controller, tabId)
        try {
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
        } finally {
          releaseInputSequence()
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
        const releaseInputSequence = await retainCompositeTrustedInputSequence(controller, tabId)
        try {
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
        } finally {
          releaseInputSequence()
        }
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
        const resolvedRef = await browserSnapshotService.resolveRef(controller, tabId, targetId)
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
        const backendNodeId = /^b(\d+)$/.exec(parsed.node)?.[1]
        let backendFocusAllowPasswordFill = false
        const runInTargetFrame = async (code: string): Promise<unknown> => {
          if (targetFrameKey === '0' && backendNodeId) {
            const id = Number(backendNodeId)
            if (code.includes('__READY_AGENT_TARGET_PROBE__')) {
              return callBrowserBackendTarget(controller, tabId, id, 'probe', {
                roleHint: String(resolvedRef.target.role || ''),
              })
            }
            if (code.includes('__READY_AGENT_TARGET_FOCUS__')) {
              return callBrowserBackendTarget(controller, tabId, id, 'focus', {
                allowPasswordFill: backendFocusAllowPasswordFill,
                roleHint: String(resolvedRef.target.role || ''),
              })
            }
            if (code.includes('__READY_AGENT_TARGET_SELECT_ALL__')) {
              return callBrowserBackendTarget(controller, tabId, id, 'select_all', {
                roleHint: String(resolvedRef.target.role || ''),
              })
            }
            if (code.includes('__READY_AGENT_TARGET_READ__')) {
              return callBrowserBackendTarget(controller, tabId, id, 'read', {
                roleHint: String(resolvedRef.target.role || ''),
              })
            }
          }
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
          liveProbe = await runInTargetFrame(buildBrowserTargetProbeJs(parsed.node, resolvedRef.frameDocumentToken)) as {
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
        const stableTarget = resolvedRef.target.unstable !== true
          && /^(?:h[0-9a-z]+|b\d+)$/i.test(parsed.node)
        if (stableTarget && !sameTargetFingerprint(resolvedRef.target, liveProbe?.target)) {
          return browserStructuredErrorOutput(agentBrowserError(
            'stale_page_map',
            `Target ${targetId} still resolves to a node, but its live identity no longer matches the captured target. Read browser_snapshot again.`,
            { targetId, captured: targetFingerprint(resolvedRef.target), live: targetFingerprint(liveProbe?.target) },
          ))
        }
        const gated = gateActOnTarget(
          { targetId, action, value, disambiguation, readBack },
          {
            currentGeneration,
            matchCount: Number(liveProbe?.matchCount || 0),
            candidates: liveProbe?.target ? [liveProbe.target] : [],
            ambiguityGroup: currentBrowserPageMapAmbiguity(controller, tabId, activeTargetId),
            resolvedRef: parsed,
            stableTarget,
            target: liveProbe?.target && typeof liveProbe.target === 'object'
              ? liveProbe.target as {
                  role?: unknown
                  name?: unknown
                  editable?: unknown
                  states?: Record<string, unknown>
                }
              : null,
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
              inputType?: string
              formAction?: string
              states?: Record<string, unknown>
              box?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
              rendered?: boolean
            }
          : null
        if (targetRecord?.states?.fileInput === true) {
          return browserStructuredErrorOutput(agentBrowserError(
            'script_blocked',
            `Target ${targetId} is a file input. Use browser_upload for file upload.`,
            { targetId, target: liveProbe.target },
          ))
        }
        if (action === 'fill') {
          const usesExactFormSubmit = args.submit === true && Boolean(String(targetRecord?.formAction || '').trim())
          const textReadiness = browserInputEnvironmentReadiness(controller, tabId, 'direct_text')
          const submitReadiness = args.submit === true && !usesExactFormSubmit
            ? browserInputEnvironmentReadiness(controller, tabId, 'trusted_keyboard')
            : null
          const blockedReadiness = !textReadiness.ready
            ? textReadiness
            : submitReadiness && !submitReadiness.ready
              ? submitReadiness
              : null
          if (blockedReadiness) {
            return browserStructuredOutput({
              ok: false,
              errorKind: blockedReadiness.reason === 'foreground_required' ? 'foreground_required' : 'browser_surface_required',
              reason: blockedReadiness.reason,
              targetId,
              writesPerformed: 0,
              readiness: blockedReadiness,
            })
          }
        }
        const beforeTabs = snapshotBrowserTabs(controller)
        const before = readBack === 'none' ? null : await readBrowserActionDeltaBestEffort(controller, tabId, 'before')
        let actionResult: unknown
        const point = await normalizedTargetPoint(
          controller,
          tabId,
          targetFrameKey,
          targetRecord?.box,
          { allowUnpresented: action === 'fill' },
        )
        if (!point) {
          return browserStructuredErrorOutput(agentBrowserError(
            'target_not_found',
            `Target ${activeTargetId} has no visible hit point. Refresh browser_snapshot after bringing it into view.`,
            { targetId: activeTargetId, frameKey: targetFrameKey },
          ))
        }
        const presentedPoint = point.x !== null && point.y !== null
          ? { x: point.x, y: point.y }
          : null
        if (action !== 'fill' && !presentedPoint) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_surface_required',
            reason: 'host_not_presented',
            targetId: activeTargetId,
            writesPerformed: 0,
          })
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
          const passwordTarget = String(targetRecord?.inputType || '').toLowerCase() === 'password'
            || targetRecord?.states?.password === true
          const usesExactFormSubmit = args.submit === true && Boolean(String(targetRecord?.formAction || '').trim())
          const passwordConfirmed = !passwordTarget || await confirmLivePasswordFill(
            ctx,
            tabId,
            targetId,
            String(value || ''),
          )
          if (!passwordConfirmed) {
            return browserStructuredOutput({
              ok: false,
              errorKind: 'credential_confirmation_required',
              liveTargetKind: 'password',
              targetId,
            })
          }
          backendFocusAllowPasswordFill = passwordConfirmed
          const typed = await runGuardedTargetType(controller, tabId, parsed.node, resolvedRef.frameDocumentToken, point, String(value || ''), {
            clearBefore: true,
            pressEnter: args.submit === true && !usesExactFormSubmit,
            useShiftEnter: false,
            allowPasswordFill: passwordConfirmed,
          }, runInTargetFrame, abortSignal)
          const textVerified = typed.typed
            && typed.textDelivery === 'delivered'
            && (passwordTarget || typed.typedInto?.textMatchesExpected === true)
          const formSubmit = usesExactFormSubmit && textVerified
            ? await invokeTargetFormSubmit(controller, mutationBoundary, tabId, {
                nodeId: parsed.node,
                frameId: targetFrameKey,
                frameDocumentToken: resolvedRef.frameDocumentToken,
                ...(backendNodeId ? { backendNodeId: Number(backendNodeId) } : {}),
                roleHint: String(targetRecord?.role || ''),
              })
            : null
          if (formSubmit) {
            typed.submitDelivery = formSubmit.delivery === 'delivered'
              ? 'delivered'
              : formSubmit.delivery === 'not_delivered'
                ? 'not_delivered'
                : 'unknown'
          }
          const fillSucceeded = typed.typed
            && (!usesExactFormSubmit || (textVerified && formSubmit?.ok === true))
          actionResult = {
            ok: fillSucceeded,
            errorCode: fillSucceeded
              ? null
              : typed.typed
                ? String(formSubmit?.reason || 'text_delivery_unverified')
                : typed.skipReason || 'target_not_fillable',
            trustedInput: true,
            typed,
            ...(formSubmit ? { formSubmit } : {}),
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
          const releaseInputSequence = await retainCompositeTrustedInputSequence(controller, tabId)
          try {
            await runGuardedCoordinateClick(controller, tabId, presentedPoint!.x, presentedPoint!.y, abortSignal)
            await controller.typeTextDirectly(tabId, String(value || ''))
            await sendKeyStroke(controller, tabId, 'Enter')
          } finally {
            releaseInputSequence()
          }
          actionResult = { ok: true, trustedInput: true, value, clickPoint: trustedClickPoint }
        } else {
          const clicked = await runGuardedCoordinateClick(controller, tabId, presentedPoint!.x, presentedPoint!.y, abortSignal)
          actionResult = {
            ok: true,
            trustedInput: true,
            deliveryObserved: clicked.deliveryObserved,
            pointTarget: clicked.pointTarget,
            clickPoint: trustedClickPoint,
          }
        }
        await settleAfterAction(controller, tabId, abortSignal)
        let followedTab = await waitForActionFollowedTab(controller, tabId, beforeTabs, abortSignal)
        if (followedTab) mutationBoundary.recordMechanicalFact({ effect: 'popup', postActionTabId: followedTab.tabId })
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
        const rawClickPoint = !actionFailed && action === 'click' && actionResult && typeof actionResult === 'object'
          ? (actionResult as { clickPoint?: { x?: unknown; y?: unknown; vw?: unknown; vh?: unknown; hostShadow?: unknown } | null }).clickPoint
          : null
        const cpx = Number(rawClickPoint?.x)
        const cpy = Number(rawClickPoint?.y)
        const cpw = Number(rawClickPoint?.vw)
        const cph = Number(rawClickPoint?.vh)
        const clickPointValid = Number.isFinite(cpx) && Number.isFinite(cpy)
          && cpw > 0 && cph > 0 && cpx >= 0 && cpx <= cpw && cpy >= 0 && cpy <= cph
        // One public click owns exactly one physical click dispatch. A missing
        // effect is returned as unknown for a fresh observation; it is never a
        // license to click again inside the same tool call.
        if (action === 'click' && !actionFailed) {
          log(`act click outcome target=${targetId} changed=${changed} hostShadow=${String(rawClickPoint?.hostShadow ?? 'n/a')}${clickPointValid ? '' : ' clickPoint=invalid'}`)
        }
        const after = readBack === 'map'
          ? await captureAgentPageMap(controller, tabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES)
          : afterDelta
        const payload = {
          ok: !actionFailed,
          targetId: activeTargetId,
          originalTargetId: activeTargetId === targetId ? undefined : targetId,
          action,
          disambiguation: disambiguation || null,
          readBack,
          before,
          result: actionResult,
          after,
          changed,
          followedTab,
          failureKind,
          nextSuggestedAction: followedTab ? `read map again on tab ${followedTab.tabId}` : 'read map again',
        }
        const confirmation = null
        return attachBrowserToolOutput(
          actionFailed ? browserStructuredOutput(payload) : JSON.stringify(payload, null, 2),
          {
            toolName,
            args,
            controller,
            sessionId,
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
        // Resolve the live clickable owner and use the trusted input channel.
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
        if (followedTab) mutationBoundary.recordMechanicalFact({ effect: 'popup', postActionTabId: followedTab.tabId })
        const confirmation = null
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
        return attachBrowserToolOutput(output, {
          toolName,
          args,
          controller,
          sessionId,
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
            return browserStructuredOutput({
              ok: false,
              errorKind: 'target_not_found',
              message: `${missBase}（已搜索主帧与 ${frameClick.framesSearched} 个子帧）`,
            })
          }
          throwIfLiveTargetGuardBlocked(frameClick.result, { text, via: 'browser_click_frame' })
          const frameFollowedTab = await waitForActionFollowedTab(controller, tabId, frameBeforeTabs, abortSignal)
          if (frameFollowedTab) mutationBoundary.recordMechanicalFact({ effect: 'popup', postActionTabId: frameFollowedTab.tabId })
          const frameConfirmation = null
          const frameReceipt = await captureBrowserActionReceipt(controller, frameFollowedTab?.tabId || tabId, frameBeforeUrl)
          return attachBrowserToolOutput(JSON.stringify({
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
        if (followedTab) mutationBoundary.recordMechanicalFact({ effect: 'popup', postActionTabId: followedTab.tabId })
        const confirmation = null
        const clickTextReceipt = await captureBrowserActionReceipt(controller, followedTab?.tabId || tabId, clickTextBeforeUrl)
        return attachBrowserToolOutput(JSON.stringify({
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
        // An opaque selector can resolve to a password or file input. Check
        // the live structural input type before sending any text.
        const inputKind = await controller.executeJS(tabId, `(() => {
          const node = document.querySelector(${JSON.stringify(selector)})
          return node instanceof HTMLInputElement
            ? { inputType: String(node.type || 'text').toLowerCase() }
            : { inputType: '' }
        })()`).catch(() => null) as { inputType?: unknown } | null
        const liveInputType = String(inputKind?.inputType || '').toLowerCase()
        if (liveInputType === 'file') {
          return browserStructuredOutput({ ok: false, errorKind: 'file_input_requires_upload', liveTargetKind: 'file' })
        }
        const passwordConfirmed = liveInputType !== 'password'
          || await confirmLivePasswordFill(ctx, tabId, `selector:${selector}`, text)
        if (!passwordConfirmed) {
          return browserStructuredOutput({ ok: false, errorKind: 'credential_confirmation_required', liveTargetKind: 'password' })
        }
        const typeBeforeUrl = activeBrowserToolUrl(controller, tabId)
        const result = await runGuardedSelectorType(controller, tabId, selector, text, {
          clearFirst,
          allowPasswordFill: passwordConfirmed,
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
        return attachBrowserToolOutput(result, {
          toolName,
          args,
          controller,
          sessionId,
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
          allowPasswordFill: false,
          confirmPasswordFill: (resolvedTarget) => confirmLivePasswordFill(ctx, tabId, `smart:${resolvedTarget}`, text),
        }, abortSignal)
        const result = smartType.output
        const confirmation = null
        return attachBrowserToolOutput(result, {
          toolName,
          args,
          controller,
          sessionId,
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
          allowPasswordFill: false,
          confirmPasswordFill: (resolvedTarget) => confirmLivePasswordFill(ctx, tabId, `smart:${resolvedTarget}`, text),
        }, abortSignal)
        const result = composed.output
        const confirmation = null
        return attachBrowserToolOutput(result, {
          toolName,
          args,
          controller,
          sessionId,
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

      case 'upload': {
        const startedAt = Date.now()
        const uploadMetaFor = (effectiveTabId: string | null) => ({
          ...resolveToolContextMeta(controller, effectiveTabId),
          latencyMs: Date.now() - startedAt,
        })
        const attachments = await listScopeAttachmentsForTool(sessionId)
        const selection = selectScopeAttachments(attachments, args)
        if (selection.reason) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'attachment_selection_failed',
            ...uploadMetaFor(null),
            reason: selection.reason,
            candidates: attachments.slice(0, 6),
          })
        }
        if (selection.ambiguous && selection.ambiguous.length > 0) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'attachment_selection_ambiguous',
            ...uploadMetaFor(null),
            reason: '存在多个候选附件，请补充 attachment_id 或 attachment_name。',
            candidates: selection.ambiguous,
          })
        }
        const selectedAttachments = selection.selected || []
        if (selectedAttachments.length === 0) {
          return browserStructuredOutput({ ok: false, errorCode: 'attachment_not_selected', ...uploadMetaFor(null), reason: '未能选择附件。' })
        }
        const missingAttachments = selectedAttachments.filter((attachment) => !existsSync(attachment.path))
        if (missingAttachments.length > 0) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'attachment_file_missing',
            ...uploadMetaFor(null),
            reason: `附件文件不存在: ${missingAttachments.map((attachment) => attachment.path).join(', ')}`,
            attachments: missingAttachments,
          })
        }

        const tabId = (args.tab_id as string) || null
        const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
        const targetId = typeof args.target_id === 'string' ? args.target_id.trim() : ''
        const targets = await locateActionTargets(controller, tabId, 'upload')
        if (!selector && !targetId) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'upload_target_required',
            ...uploadMetaFor(tabId),
            attachments: selectedAttachments,
            candidates: targets.slice(0, 12),
            writesPerformed: 0,
          })
        }
        let targetToken: string | undefined
        let frameDocumentToken: string | undefined
        let backendDOMNodeId: number | undefined
        if (targetId) {
          const resolved = await browserSnapshotService.resolveRef(controller, tabId, targetId)
          if (!resolved.ok) {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'upload_target_stale',
              ...uploadMetaFor(tabId),
              targetId,
              reason: resolved.errorCode,
              writesPerformed: 0,
            })
          }
          const parsed = parseTargetId(resolved.rawTargetId)
          const target = resolved.target
          const fileInput = String(target.inputType || '').toLowerCase() === 'file'
            || (target.states && typeof target.states === 'object' && (target.states as Record<string, unknown>).fileInput === true)
          if (!parsed || !fileInput || parsed.frameId !== '0') {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'upload_file_input_target_required',
              ...uploadMetaFor(tabId),
              targetId,
              target,
              writesPerformed: 0,
            })
          }
          const backendMatch = /^b(\d+)$/.exec(parsed.node)
          if (backendMatch) backendDOMNodeId = Number(backendMatch[1])
          else targetToken = parsed.node
          frameDocumentToken = resolved.frameDocumentToken
        }

        const setResult = await controller.setFileInputFiles(tabId, {
          files: selectedAttachments.map((attachment) => attachment.path),
          selector: selector || undefined,
          targetToken,
          frameDocumentToken,
          backendDOMNodeId,
        })
        if (!setResult.ok) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'upload_target_not_found',
            ...uploadMetaFor(tabId),
            reason: '未找到可用的上传入口。',
            attachments: selectedAttachments,
            candidates: targets.slice(0, 8),
            target: setResult.targetDescription,
            evidenceIds: uniqueStrings(targets.flatMap((item) => item.evidence || [])),
          })
        }

        const assignedNames = Array.isArray(setResult.assignedFileNames) ? setResult.assignedFileNames : []
        const expectedNames = selectedAttachments
          .map((attachment) => attachment.name.normalize('NFC'))
          .sort((left, right) => left.localeCompare(right))
        const observedNames = assignedNames
          .map((name) => String(name || '').normalize('NFC'))
          .sort((left, right) => left.localeCompare(right))
        const fileAssigned = Boolean(setResult.filesAssigned)
          && expectedNames.length === observedNames.length
          && expectedNames.every((name, index) => name === observedNames[index])
        const payload = {
          ok: fileAssigned,
          ...(!fileAssigned ? { errorCode: 'upload_assignment_readback_failed' } : {}),
          ...uploadMetaFor(tabId),
          attachments: selectedAttachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            name: attachment.name,
            path: attachment.path,
          })),
          targetId: targetId || null,
          selector: selector || null,
          target: setResult.targetDescription,
          setResult: {
            filesAssigned: Boolean(setResult.filesAssigned),
            assignedFileNames: assignedNames,
          },
          verification: {
            success: fileAssigned,
            reason: fileAssigned ? 'exact_file_assignment_readback' : 'exact_file_assignment_missing',
          },
          evidenceIds: fileAssigned ? ['input_files_assigned_exact'] : [],
        }
        return stringifyBrowserJsonOrFailure(payload)
      }

      case 'click_coordinate': {
        const x = Number(args.x)
        const y = Number(args.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y are required numbers'
        let tabId = (args.tab_id as string) || null
        // Probe the point for grounding when possible; visual-coordinate
        // clicking remains usable if the page probe is unavailable.
        const beforeTabs = snapshotBrowserTabs(controller)
        const point = await runGuardedCoordinateClick(controller, tabId, x, y, abortSignal)
        const followedTab = await waitForActionFollowedTab(controller, tabId, beforeTabs, abortSignal)
        if (followedTab) mutationBoundary.recordMechanicalFact({ effect: 'popup', postActionTabId: followedTab.tabId })
        const confirmation = null
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
        return attachBrowserToolOutput(JSON.stringify({
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
        const pressEnter = args.submit === true || args.press_enter === true
        const clearBeforeTyping = args.clear_first !== false && args.clear_before_typing !== false
        const useShiftEnter = args.use_shift_enter_for_newline === true
        // Coordinate typing requires a structurally verified destination;
        // file and password inputs follow their explicit typed contracts.
        const probePoint = await resolveCssPoint(controller, tabId, x, y)
        const liveTarget = await probeCoordinateTargetOrThrow(
          controller,
          tabId,
          probePoint,
          { x, y, action: 'type' },
        ) as { password?: unknown; fileInput?: unknown } | null
        if (liveTarget?.fileInput === true) {
          return browserStructuredOutput({ ok: false, errorKind: 'file_input_requires_upload', liveTargetKind: 'file' })
        }
        const passwordConfirmed = liveTarget?.password !== true
          || await confirmLivePasswordFill(ctx, tabId, `coordinate:${probePoint.cssX}:${probePoint.cssY}`, text)
        if (!passwordConfirmed) {
          return browserStructuredOutput({ ok: false, errorKind: 'credential_confirmation_required', liveTargetKind: 'password' })
        }
        const point = await runGuardedCoordinateType(controller, tabId, x, y, text, {
          clearBefore: clearBeforeTyping,
          pressEnter,
          useShiftEnter,
          allowPasswordFill: passwordConfirmed,
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
          return attachBrowserToolOutput(browserStructuredOutput({
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
            tabId,
            confirmation: null,
            nextSuggestedAction: 'locate input targets, then retype',
          })
        }
        const confirmation = null
        return attachBrowserToolOutput(JSON.stringify({
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
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

      case 'scroll': {
        let tabId = (args.tab_id as string) || null
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
        const delivery = await sendKeyStroke(controller, tabId, key, args.modifiers)
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
        const confirmation = null
        return attachBrowserToolOutput(browserStructuredOutput({
          ok: delivery !== 'not_delivered',
          key,
          delivery,
          focus: keyFocus || null,
        }), {
          toolName,
          args,
          controller,
          sessionId,
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

      case 'request_takeover': {
        const callToAction = String(args.reason || args.call_to_action || '').trim()
        if (!callToAction) return 'Error: reason is required'
        if (!ctx.createHumanTakeoverIntent) {
          return browserStructuredOutput({
            ok: false,
            operationId: 'request_takeover',
            errorKind: 'browser_workflow_route_required',
          })
        }
        const details = String(args.instruction || args.details || '')
        const timeoutSec = Math.max(30, Math.min(1200, Number(args.timeout_sec || 300)))
        log(`[browser-v3][human-required] reasonLength=${callToAction.length} timeout=${timeoutSec}s`)
        const takeover = await ctx.createHumanTakeoverIntent()
        return browserStructuredOutput({
          ok: true,
          operationId: 'request_takeover',
          phase: 'human_required',
          takeoverId: takeover.takeoverId,
          suspendAfterToolResult: true,
          callToAction,
          details,
          timeoutSec,
        })
      }

      case 'navigate_back': {
        const tabId = (args.tab_id as string) || null
        const result = controller.goBack(tabId)
        if (!result.success) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_operation_failed',
            message: result.error || 'cannot go back',
          })
        }
        return 'Navigated back.'
      }

      case 'navigate_forward': {
        const tabId = (args.tab_id as string) || null
        const result = controller.goForward(tabId)
        if (!result.success) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_operation_failed',
            message: result.error || 'cannot go forward',
          })
        }
        return 'Navigated forward.'
      }

      case 'navigate_reload': {
        const tabId = (args.tab_id as string) || null
        const result = controller.reload(tabId)
        if (!result.success) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_operation_failed',
            message: result.error || 'cannot reload page',
          })
        }
        return 'Reloaded page.'
      }

      default:
        return `Unknown browser tool: ${toolName}`
  }
}
