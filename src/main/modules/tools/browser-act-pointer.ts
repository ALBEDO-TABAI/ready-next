import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { createBrowserStructuredOutput as browserStructuredOutput, stringifyBrowserJsonOrFailure } from './browser-failure-output'
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { BrowserActToolContext } from './browser-act-shared'
import {
  confirmLivePasswordFill,
  didBrowserActionChange,
  frameViewportOffset,
  invokeTargetFormSubmit,
  logBrowserAct,
  normalizedTargetPoint,
  readBrowserActionDeltaBestEffort,
  readTransientPageNotices,
  retainCompositeTrustedInputSequence,
  sameTargetFingerprint,
  snapshotBrowserTabs,
  submitResolvedTargetForm,
  trustedPointerExpected,
  waitForActionFollowedTab,
} from './browser-act-shared'
import { existsSync } from 'fs'
import { createHash } from 'node:crypto'
import { captureBrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import { AgentRepository } from '../repositories/agent-repository'
import {
  findRecentBrowserAction,
  rememberBrowserAction,
} from '../agent-control/session/session-continuity'
import { agentBrowserError, isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import { parseTargetId } from '../browser-engine/agent-browser-page-map'
import { browserSnapshotService, parseBrowserSnapshotRef } from '../browser-engine/browser-snapshot-service'
import { gateActOnTarget, type AgentBrowserAction, type AgentBrowserReadBack } from '../browser-engine/agent-browser-act'
import {
  buildBrowserBlockingChallengeProbeJs,
  buildFocusedEditableProbeJs,
  buildBrowserTargetProbeJs,
  throwIfLiveTargetGuardBlocked,
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
  runGuardedSelectorClick,
  runGuardedSelectorType,
  sendKeyStroke,
  settleAfterAction,
  sleepWithAbort,
  throwIfAborted,
  dispatchTrustedPointer,
  dispatchTrustedText,
  pointerPhaseFailure,
  pointerPhaseOutput,
  trustedInputPageDenied,
  TrustedPointerBlockedError,
  waitForReady,
} from './browser-input-actions'
import { buildBrowserEnvironmentSummary } from '../browser-engine/browser-action-receipt'
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
  listSubframesSafe,
  locateActionTargets,
  resolveToolContextMeta,
  uniqueStrings,
} from './browser-tool-shared'

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

export async function executeBrowserActPointer(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserActToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId, mutationBoundary, attachBrowserToolOutput } = ctx
  switch (toolName) {
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
        const blocked = await dispatchTrustedPointer(controller, tabId, {
          type: 'mouseMoved',
          x: point.cssX,
          y: point.cssY,
          button: 'none',
          buttons: 0,
        }, trustedPointerExpected(ctx, tabId))
        if (blocked) return blocked
        const tab = tabId
          ? controller.getTabList?.().find((item) => item.id === tabId) || null
          : null
        return browserStructuredOutput({
          ok: true,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          environmentSummary: buildBrowserEnvironmentSummary({
            targetTabId: tabId,
            url: tab?.url,
            title: tab?.title,
          }),
        })
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
        const pointerExpected = trustedPointerExpected(ctx, tabId)
        let pressed = false
        try {
          const start = await dispatchTrustedPointer(controller, tabId, {
            type: 'mouseMoved',
            x: source.cssX,
            y: source.cssY,
            button: 'left',
            buttons: 0,
          }, pointerExpected)
          if (start) return start
          try {
            const press = await dispatchTrustedPointer(controller, tabId, {
              type: 'mousePressed',
              x: source.cssX,
              y: source.cssY,
              button: 'left',
              buttons: 1,
              clickCount: 1,
            }, pointerExpected)
            if (press) return press
            pressed = true
          } catch {
            return pointerPhaseFailure(true)
          }
          for (let step = 1; step <= 8; step += 1) {
            const moved = await dispatchTrustedPointer(controller, tabId, {
              type: 'mouseMoved',
              x: source.cssX + ((target.cssX - source.cssX) * step) / 8,
              y: source.cssY + ((target.cssY - source.cssY) * step) / 8,
              button: 'left',
              buttons: 1,
            }, pointerExpected)
            if (moved) return pointerPhaseOutput(moved, true)
          }
          const released = await dispatchTrustedPointer(controller, tabId, {
            type: 'mouseReleased',
            x: target.cssX,
            y: target.cssY,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          }, pointerExpected)
          if (released) return pointerPhaseOutput(released, true)
        } catch (error) {
          if (pressed) return pointerPhaseFailure(true)
          if (error instanceof TrustedPointerBlockedError) return error.output
          return pointerPhaseFailure(false)
        } finally {
          releaseInputSequence()
        }
        return browserStructuredOutput({ ok: true, source: { x: source.cssX, y: source.cssY }, target: { x: target.cssX, y: target.cssY } })
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
        logBrowserAct(`click_at resolved input=(${x},${y}) normalized=(${point.nx},${point.ny}) css=(${Math.round(point.cssX)},${Math.round(point.cssY)}) pointTarget=${JSON.stringify(point.pointTarget?.label ?? null)}${composedTarget ? ` composed=${JSON.stringify(composedTarget)}` : ''}${shadowCandidates ? ` shadowCandidates=${JSON.stringify(shadowCandidates.map((c) => c.text))}` : ''}${clickPageNotices.length > 0 ? ` notices=${JSON.stringify(clickPageNotices)}` : ''}`)
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
        const blocked = await dispatchTrustedPointer(controller, tabId, {
          type: 'mouseWheel',
          x: point.cssX,
          y: point.cssY,
          deltaX,
          deltaY,
          button: 'none',
          buttons: 0,
        }, trustedPointerExpected(ctx, tabId))
        if (blocked) return blocked
        return `Scrolled ${direction} at normalized(${point.nx},${point.ny})`
      }

    default:
      return `Unknown browser tool: ${toolName}`
  }
}
