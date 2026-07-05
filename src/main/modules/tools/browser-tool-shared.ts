/**
 * P3 Phase B4（2026-07-04，纯移动拆分）— browser-tools 共享叶子 helper。
 *
 * 从 browser-tools.ts 逐字搬出被 Power 工具组与非 Power case 同时引用的
 * 工具函数：truncate / activeBrowserToolUrl(Title) / 交易确认页面态判定链。
 * browser-tools 会 import browser-power-tools，本模块作为两侧共同的下游，
 * 绝不 import 上述两个模块，防循环依赖。行为零变更。
 *
 * P3 Phase B5（2026-07-05，纯移动拆分）追加：采集/内容任务组拆出
 * browser-collection-tools.ts 后，被两侧同时引用的高风控 agent tab 解析链
 * （resolveHighControlAgentTab / resolvePrimaryBrowserTargetUrl /
 * activePageLikelyMatchesTarget）同法落此。行为零变更。
 *
 * P3 Phase B6（2026-07-05，纯移动拆分）追加：观察/感知组拆出
 * browser-observe-tools.ts 后，被两侧同时引用的 browserStructuredErrorOutput /
 * uniqueStrings / resolveToolContextMeta / listSubframesSafe / getPageIdentity /
 * locateActionTargets（含 ActionTargetCandidate 类型）同法落此。行为零变更。
 *
 * P3 Phase B7（2026-07-05，纯移动拆分）追加：行动/导航组拆出
 * browser-act-tools.ts 后，被 facade attach 签名与行动组同时引用的
 * BrowserActionFollowedTab 类型同法落此。行为零变更。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { AgentBrowserStructuredError } from '../browser-engine/agent-browser-errors'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { createBrowserStructuredOutput as browserStructuredOutput } from './browser-failure-output'
import {
  createBrowserTransactionConfirmation,
  type BrowserTransactionConfirmation,
} from '../browser-engine/browser-action-session'
import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'
import { domainsLikelyMatch } from '../agent-control/domain-adapters/browser-action-heuristics'
import { waitForReady } from './browser-input-actions'
import { createRotatingLogger } from '../../utils/rotating-logger'

const logger = createRotatingLogger('ready-tools.log')
function log(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* silent-catch: 日志写入失败不影响主流程。 */ }
}

const MAX_RESULT_LENGTH = 20_000

export function truncate(s: string, max = MAX_RESULT_LENGTH): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... (truncated, ${s.length} total chars)`
}

export function activeBrowserToolUrl(controller: BrowserController, tabId: string | null): string | null {
  const tabs = controller.getTabList?.() || []
  const tab = (tabId ? tabs.find((item) => item.id === tabId) : null)
    || tabs.find((item) => item.active)
    || controller.getActiveTab?.()
    || null
  return typeof tab?.url === 'string' ? tab.url : null
}

function activeBrowserToolTitle(controller: BrowserController, tabId: string | null): string | null {
  const tabs = controller.getTabList?.() || []
  const tab = (tabId ? tabs.find((item) => item.id === tabId) : null)
    || tabs.find((item) => item.active)
    || controller.getActiveTab?.()
    || null
  return typeof tab?.title === 'string' ? tab.title : null
}

function browserTransactionResourceIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const candidates = parsed.pathname.split('/').filter(Boolean).reverse()
    return candidates.find((segment) => /^[A-Za-z0-9_-]{8,}$/.test(segment)) || null
  } catch {
    // silent-catch: URL 解析失败即无交易资源 id。
    return null
  }
}

function looksLikeEditorUrl(url: string | null | undefined): boolean {
  const value = String(url || '')
  return /(?:draft|edit|editor|compose|create|publish|upload|creator|post\/edit|note\/edit)/i.test(value)
}

export function normalizeTransactionText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function detectTransactionConfirmationFromPageState(pageState: {
  url?: string | null
  title?: string | null
  text?: string | null
}): BrowserTransactionConfirmation | null {
  const text = normalizeTransactionText([pageState.title, pageState.text].filter(Boolean).join(' '))
  const successText = text.match(/(?:发布成功|提交成功|发送成功|已发布|发布完成|提交完成|posted|published|success(?:fully)?)/i)?.[0] || null
  if (successText && !/(?:草稿|draft|自动保存|autosave|保存成功)/i.test(text)) {
    return createBrowserTransactionConfirmation({
      source: 'page_text',
      signal: successText,
      url: pageState.url || null,
      text,
    })
  }
  const url = String(pageState.url || '')
  const resourceId = browserTransactionResourceIdFromUrl(url)
  if (url && resourceId && !looksLikeEditorUrl(url)) {
    return createBrowserTransactionConfirmation({
      source: 'public_url',
      signal: 'public_resource_url',
      url,
      resourceId,
    })
  }
  return null
}

export async function detectBrowserPageTransactionConfirmation(
  controller: BrowserController,
  tabId: string | null,
): Promise<BrowserTransactionConfirmation | null> {
  const url = activeBrowserToolUrl(controller, tabId)
  const title = activeBrowserToolTitle(controller, tabId)
  try {
    const page = await controller.executeJS(tabId, `
      (() => ({
        url: String(location.href || ''),
        title: String(document.title || ''),
        text: String(document.body?.innerText || '').slice(0, 4000)
      }))()
    `) as { url?: string; title?: string; text?: string } | null
    return detectTransactionConfirmationFromPageState({
      url: page?.url || url,
      title: page?.title || title,
      text: page?.text || '',
    })
  } catch {
    // silent-catch: 网络侧探测失败回退到页面状态判定。
    return detectTransactionConfirmationFromPageState({ url, title, text: '' })
  }
}

function resolvePrimaryBrowserTargetUrl(
  args: Record<string, unknown>,
  controller: BrowserController,
): string {
  if (typeof args.url === 'string' && args.url.trim()) return args.url.trim()
  const tabId = typeof args.tab_id === 'string' ? args.tab_id : ''
  try {
    if (tabId) {
      const tab = controller.getTabList?.().find((item) => item.id === tabId)
      if (tab?.url) return tab.url
    }
  } catch { /* silent-catch: optional controller tab lookup may be unavailable in tests. */ }
  try {
    return controller.getActiveTab?.()?.url || ''
  } catch {
    // silent-catch: optional active-tab lookup may be unavailable in tests.
    return ''
  }
}

export async function resolveHighControlAgentTab(
  controller: BrowserController,
  args: Record<string, unknown>,
  options?: { navigateToTarget?: boolean; signal?: AbortSignal },
): Promise<{ tabId: string | null; redirected: boolean }> {
  const requestedTabId = typeof args.tab_id === 'string' ? args.tab_id : null
  const collectionSurface = typeof args.collection_surface === 'string' ? args.collection_surface : ''
  const targetUrl = resolvePrimaryBrowserTargetUrl(args, controller)
  if (!isHighControlPlatformText(targetUrl)) {
    return { tabId: requestedTabId, redirected: false }
  }

  if (requestedTabId && collectionSurface === 'user-view') {
    try {
      controller.switchTab?.(requestedTabId)
    } catch (error) {
      log(`resolveHighControlAgentTab switchTab failed tabId=${requestedTabId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { tabId: requestedTabId, redirected: false }
  }

  try {
    const requestedTab = requestedTabId
      ? controller.getTabList?.().find((item) => item.id === requestedTabId)
      : null
    if (requestedTab?.owner === 'agent') {
      return { tabId: requestedTabId, redirected: false }
    }
  } catch { /* silent-catch: optional controller tab lookup may be unavailable in tests. */ }

  const ensureAgentTab = (controller as { ensureAgentTab?: () => Promise<string> }).ensureAgentTab
  if (typeof ensureAgentTab !== 'function') {
    return { tabId: requestedTabId, redirected: false }
  }

  const agentTabId = await ensureAgentTab.call(controller)
  if (options?.navigateToTarget !== false && targetUrl) {
    const agentTab = controller.getTabList?.().find((item) => item.id === agentTabId)
    if (!activePageLikelyMatchesTarget(agentTab?.url, targetUrl)) {
      const nav = await controller.navigate(agentTabId, targetUrl)
      if (!nav.success) throw new Error(nav.error || 'failed to navigate agent tab')
      await waitForReady(controller, agentTabId, 10_000, undefined, options?.signal).catch(() => null)
    }
  }
  return { tabId: agentTabId, redirected: true }
}

export function activePageLikelyMatchesTarget(activeUrl: string | undefined, target: string): boolean {
  if (!activeUrl || !target) return false
  try {
    const active = new URL(activeUrl)
    const next = new URL(target)
    if (active.origin === next.origin && active.pathname === next.pathname && active.search === next.search) return true
    return domainsLikelyMatch(activeUrl, target)
  } catch {
    return String(activeUrl).trim().toLowerCase() === String(target).trim().toLowerCase()
  }
}

export function browserStructuredErrorOutput(error: AgentBrowserStructuredError): ToolExecutionOutput {
  return browserStructuredOutput(error as unknown as Record<string, unknown>)
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

const TOOL_CONTROLLER_ID = 'primary-browser-controller'

export function resolveToolContextMeta(
  controller: BrowserController,
  tabId: string | null,
): { controllerId: string; tabRole: 'current' | 'owned' | 'required' | 'background' | 'unknown' } {
  const tabs = controller.getTabList()
  const resolved = tabId
    ? tabs.find((tab) => tab.id === tabId) || tabs.find((tab) => tab.active)
    : tabs.find((tab) => tab.active)
  if (!resolved) {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'unknown' }
  }
  if (resolved.required) {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'required' }
  }
  if (resolved.owner === 'agent') {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'owned' }
  }
  if (resolved.active) {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'current' }
  }
  return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'background' }
}

const AGENT_PAGE_MAP_MAX_SUBFRAMES = 8

export function listSubframesSafe(
  controller: BrowserController,
  tabId: string | null,
): Array<{ frameKey: string; url: string }> {
  if (typeof controller.listContentFrames !== 'function') return []
  try {
    return controller.listContentFrames(tabId)
      .filter((frame) => !frame.main && frame.url && frame.url !== 'about:blank')
      .slice(0, AGENT_PAGE_MAP_MAX_SUBFRAMES)
      .map((frame) => ({ frameKey: frame.frameKey, url: frame.url }))
  } catch {
    // silent-catch: 帧枚举失败按无子帧处理，主帧行为不受影响。
    return []
  }
}

export interface ActionTargetCandidate {
  kind: 'input' | 'launcher' | 'dropzone' | 'text_button' | 'icon_button' | 'send_button' | 'close_button' | 'back_button' | 'prompt_input'
  label: string
  selectorHint?: string
  x?: number
  y?: number
  confidence: number
  evidence: string[]
  associatedInputSelector?: string
  hidden?: boolean
  accepts?: string
  multiple?: boolean
  focused?: boolean
  textLength?: number
  valuePreview?: string
  nearActiveInput?: boolean
  distanceToActiveInput?: number
  /** R18：closed-shadow 扫描出的候选可带 disabled 状态（页面校验未过时
   * 点击必然无效，模型据此先补必填项而不是盲点） */
  disabled?: boolean
}

export async function getPageIdentity(
  controller: BrowserController,
  tabId: string | null,
): Promise<{ title: string; url: string; activeElement: string }> {
  const result = await controller.executeJS(
    tabId,
    `(() => ({
      title: document.title || '',
      url: location.href || '',
      activeElement:
        String(document.activeElement?.tagName || '').toLowerCase() +
        ':' +
        String(
          document.activeElement?.getAttribute?.('aria-label') ||
          document.activeElement?.getAttribute?.('placeholder') ||
          document.activeElement?.id ||
          ''
        ),
    }))()`,
  ) as { title?: string; url?: string; activeElement?: string } | null
  return {
    title: String(result?.title || ''),
    url: String(result?.url || ''),
    activeElement: String(result?.activeElement || ''),
  }
}

export async function locateActionTargets(
  controller: BrowserController,
  tabId: string | null,
  action: 'upload' | 'send' | 'close' | 'back' | 'input',
): Promise<ActionTargetCandidate[]> {
  if (action === 'upload') {
    const targets = await controller.findUploadTargets(tabId)
    return targets.map((item) => ({
      kind: item.kind,
      label: item.label,
      selectorHint: item.selectorHint,
      x: item.x,
      y: item.y,
      confidence: Number(item.confidence || 0),
      evidence: Array.isArray(item.evidence) ? item.evidence : [],
      associatedInputSelector: item.associatedInputSelector,
      hidden: item.hidden,
      accepts: item.accepts,
      multiple: item.multiple,
    }))
  }

  if (action === 'input') {
    const targets = await controller.executeJS(
      tabId,
      `
        (() => {
          const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false
            const rect = el.getBoundingClientRect()
            if (!rect || rect.width < 10 || rect.height < 10) return false
            const style = getComputedStyle(el)
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false
            if (Number(style.opacity || '1') <= 0) return false
            return true
          }
          const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
          const isEditable = (el) => {
            if (!(el instanceof HTMLElement)) return false
            const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
            const isTextarea = el instanceof HTMLTextAreaElement
            const role = (el.getAttribute('role') || '').toLowerCase()
            const roleTextbox = role === 'textbox' || role === 'combobox' || role === 'searchbox'
            const hasContentEditableAttr = el.hasAttribute('contenteditable')
            const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
            const isContentEditable =
              el.isContentEditable ||
              (hasContentEditableAttr && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
            if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
            if (el.getAttribute('aria-disabled') === 'true') return false
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              if (el.disabled || el.readOnly) return false
            }
            return visible(el)
          }
          const extractLabel = (el) => {
            const attrs = [
              el.getAttribute('placeholder'),
              el.getAttribute('aria-label'),
              el.getAttribute('name'),
              el.getAttribute('id'),
              el.getAttribute('title'),
              el.getAttribute('data-testid'),
              el.getAttribute('class'),
            ].filter(Boolean)
            const id = el.getAttribute('id')
            if (id) {
              try {
                const linked = document.querySelector('label[for="' + CSS.escape(id) + '"]')
                if (linked?.textContent) attrs.push(linked.textContent)
              } catch {
                // ignore
              }
            }
            const parentLabel = el.closest('label')
            if (parentLabel?.textContent) attrs.push(parentLabel.textContent)
            return normalize(attrs.join(' '))
          }
          const active = document.activeElement instanceof HTMLElement && isEditable(document.activeElement)
            ? document.activeElement
            : null
          const readValue = (el) => {
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              return String(el.value || '')
            }
            return String(el.innerText || el.textContent || '')
          }
          const nodes = Array.from(document.querySelectorAll('textarea,input,[role="textbox"],[role="combobox"],[role="searchbox"],[contenteditable]'))
            .filter((node) => node instanceof HTMLElement)
            .filter((node) => isEditable(node))
          const out = nodes.map((node) => {
            const rect = node.getBoundingClientRect()
            const label = extractLabel(node)
            const value = normalize(readValue(node))
            const focused = !!active && active === node
            let score = 0
            if (/prompt|提示|描述|文案|内容|输入|message|chat|ask|search|搜索|生成|创作|正文/.test(label)) score += 14
            if (node.tagName.toLowerCase() === 'textarea') score += 6
            if ((node instanceof HTMLElement) && node.isContentEditable) score += 5
            if (rect.bottom > window.innerHeight * 0.4) score += 4
            if (rect.width > window.innerWidth * 0.22) score += 4
            if (rect.height >= 32) score += 2
            if (focused) score += 18
            if (value.length > 0) score += Math.min(6, value.length / 24)
            if (/时间|生成类型|操作类型|筛选|排序/.test(label)) score -= 16
            if (rect.top < window.innerHeight * 0.38) score -= 8
            return {
              kind: 'prompt_input',
              label,
              selectorHint: node.id ? ('#' + CSS.escape(node.id)) : String(node.tagName || '').toLowerCase(),
              x: Math.max(0, Math.min(999, Math.round(((rect.left + rect.width / 2) / Math.max(1, window.innerWidth)) * 999))),
              y: Math.max(0, Math.min(999, Math.round(((rect.top + rect.height / 2) / Math.max(1, window.innerHeight)) * 999))),
              confidence: Math.min(0.99, 0.35 + score / 22),
              evidence: [label ? 'editable_label_match' : 'editable_visible', focused ? 'active_input' : '', value.length > 0 ? 'has_text' : ''].filter(Boolean),
              focused,
              textLength: value.length,
              valuePreview: value.slice(0, 80),
            }
          })
          return out
            .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
            .slice(0, 10)
        })()
      `,
    ) as ActionTargetCandidate[] | null

    return Array.isArray(targets) ? targets : []
  }

  const keywordMap: Record<'upload' | 'send' | 'close' | 'back', string[]> = {
    upload: ['upload'],
    send: ['send', '发送', '提交', '发布', '继续', '生成', 'go', 'ask', 'submit'],
    close: ['close', '关闭', '取消', '退出', 'dismiss', '×', 'x'],
    back: ['back', '返回', '上一步', '撤销', 'go back', '返回上一页'],
  }

  const targets = await controller.executeJS(
    tabId,
    `
      (() => {
        const action = ${JSON.stringify(action)}
        const keywords = ${JSON.stringify(keywordMap[action])}
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return false
          const style = getComputedStyle(el)
          if (!style) return false
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (Number(style.opacity || '1') <= 0) return false
          return true
        }
        const isClickable = (el) => {
          const tag = String(el.tagName || '').toLowerCase()
          if (['button', 'a', 'summary'].includes(tag)) return true
          const role = (el.getAttribute('role') || '').toLowerCase()
          if (['button', 'link', 'tab', 'menuitem'].includes(role)) return true
          if (el instanceof HTMLInputElement && ['button', 'submit'].includes((el.type || '').toLowerCase())) return true
          return el.hasAttribute('onclick') || typeof el.onclick === 'function'
        }
        const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
        const isEditable = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
          const isTextarea = el instanceof HTMLTextAreaElement
          const role = (el.getAttribute('role') || '').toLowerCase()
          const roleTextbox = role === 'textbox' || role === 'combobox' || role === 'searchbox'
          const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
          const isContentEditable =
            el.isContentEditable ||
            (el.hasAttribute('contenteditable') && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
          if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
          if (el.getAttribute('aria-disabled') === 'true') return false
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (el.disabled || el.readOnly) return false
          }
          return visible(el)
        }
        const activeInput = action === 'send' && document.activeElement instanceof HTMLElement && isEditable(document.activeElement)
          ? document.activeElement
          : null
        const activeRect = activeInput ? activeInput.getBoundingClientRect() : null
        const activeForm = activeInput ? activeInput.closest('form') : null
        const out = []
        for (const node of Array.from(document.querySelectorAll('button,a,[role="button"],[role="link"],summary,input[type="submit"],div,span'))) {
          if (!(node instanceof HTMLElement) || !visible(node)) continue
          const rect = node.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          const explicitClickable = isClickable(node)
          const meta = normalize([
            node.textContent,
            node.getAttribute('aria-label'),
            node.getAttribute('title'),
            node.getAttribute('data-testid'),
            node.getAttribute('class'),
          ].filter(Boolean).join(' ')).toLowerCase()
          if (!explicitClickable && !meta) continue
          const distanceToActiveInput = activeRect
            ? Math.round(Math.hypot(
              centerX - (activeRect.left + activeRect.width / 2),
              centerY - (activeRect.top + activeRect.height / 2),
            ))
            : undefined
          const nearActiveInput = action === 'send' && !!activeRect
            ? (
              (centerX >= activeRect.left - 160 && centerX <= activeRect.right + 260 && centerY >= activeRect.top - 90 && centerY <= activeRect.bottom + 220) ||
              Number(distanceToActiveInput || 0) <= Math.max(240, Math.min(window.innerWidth * 0.28, 360))
            )
            : false
          const sameFormAsActiveInput = action === 'send' && !!activeForm && activeForm.contains(node)
          const inNavigationLikeRegion = !!node.closest('nav,aside,[role="navigation"],header,[data-testid*="nav" i],[class*="sidebar" i],[class*="sider" i]')
          if (action === 'send') {
            const hugeSurface = rect.width > window.innerWidth * 0.42 || rect.height > window.innerHeight * 0.14
            const hugeText = meta.length > 42
            if (hugeSurface || hugeText) continue
            const likelyLeftNav = rect.left < window.innerWidth * 0.18 && rect.top < window.innerHeight * 0.72
            const weakGenerateOnly = /^生成$/.test(meta) || /(^|\\s)生成(\\s|$)/.test(meta)
            if (likelyLeftNav && weakGenerateOnly) continue
            const browserChromeLike = rect.top < window.innerHeight * 0.14 && rect.height <= 72
            if (browserChromeLike) continue
          }
          let score = 0
          let keywordHits = 0
          for (const keyword of keywords) {
            if (meta.includes(String(keyword).toLowerCase())) {
              score += 10
              keywordHits += 1
            }
          }
          if (!score && !explicitClickable) continue
          if (action === 'send') {
            if (rect.right > window.innerWidth * 0.68) score += 4
            if (rect.bottom > window.innerHeight * 0.62) score += 4
            if (rect.width <= 88 && rect.height <= 88) score += 3
            if (nearActiveInput) score += 18
            else if (activeRect) score -= 10
            if (sameFormAsActiveInput) score += 12
            if (inNavigationLikeRegion && !nearActiveInput) score -= 16
            if (/(灵感|资产|画布|会员|首页|模板|导航)/.test(meta)) score -= 12
            if (/(重新生成|再次生成|再试一次|try again|retry|历史|history)/.test(meta)) score -= 18
            if (rect.left < window.innerWidth * 0.2) score -= 10
            if (rect.top < window.innerHeight * 0.48 && rect.left < window.innerWidth * 0.35) score -= 10
            if (activeRect && rect.top < activeRect.top - 120) score -= 8
            if (activeRect && rect.left < activeRect.left - 220) score -= 6
            if (rect.bottom < window.innerHeight * 0.45 && !/(send|发送|提交|发布|go|run|submit)/.test(meta)) score -= 8
            if (!keywordHits && !nearActiveInput && !sameFormAsActiveInput) score -= 6
          }
          if (action === 'close') {
            const topRight = rect.right > window.innerWidth * 0.62 && rect.top < window.innerHeight * 0.35
            const explicitClose = /(close|关闭|取消|退出|dismiss|×|\bx\b)/.test(meta)
            if ((!topRight && !explicitClose) || rect.width > 120 || rect.height > 120) continue
          }
          if (action === 'send' && rect.bottom > window.innerHeight * 0.55) score += 4
          if (action === 'close' && rect.top < window.innerHeight * 0.35) score += 4
          if (action === 'back' && rect.left < window.innerWidth * 0.35) score += 4
          if (/icon|arrow|chevron|close|send|upload|attach|paperclip|plus|返回|关闭|发送|上传/.test(meta)) score += 2
          if (score <= 0) continue
          out.push({
            kind: action === 'send' ? 'send_button' : action === 'close' ? 'close_button' : action === 'back' ? 'back_button' : 'icon_button',
            label: normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || ''),
            selectorHint: node.id ? ('#' + CSS.escape(node.id)) : String(node.tagName || '').toLowerCase(),
            x: Math.max(0, Math.min(999, Math.round((centerX / Math.max(1, window.innerWidth)) * 999))),
            y: Math.max(0, Math.min(999, Math.round((centerY / Math.max(1, window.innerHeight)) * 999))),
            confidence: Math.min(0.98, 0.28 + Math.max(0, score) / 28),
            evidence: [
              keywordHits > 0 ? 'keyword_match' : '',
              explicitClickable ? 'explicit_clickable' : '',
              nearActiveInput ? 'near_active_input' : '',
              sameFormAsActiveInput ? 'same_form_as_active_input' : '',
            ].filter(Boolean),
            nearActiveInput: nearActiveInput || undefined,
            distanceToActiveInput,
          })
        }
        return out
          .sort((a, b) =>
            Number(Boolean(b.nearActiveInput)) - Number(Boolean(a.nearActiveInput)) ||
            Number(b.confidence || 0) - Number(a.confidence || 0) ||
            Number(a.distanceToActiveInput ?? Number.POSITIVE_INFINITY) - Number(b.distanceToActiveInput ?? Number.POSITIVE_INFINITY)
          )
          .slice(0, 12)
      })()
    `,
  ) as ActionTargetCandidate[] | null

  const inPageTargets = Array.isArray(targets) ? targets : []
  if (action !== 'send') return inPageTargets
  return enrichSendTargetsWithClosedShadowHosts(controller, tabId, inPageTargets, keywordMap.send)
}

/**
 * R18（真机第十七轮实锚）：locate 的 in-page 扫描只见 light DOM——
 * `<xhs-publish-btn>` 这类 closed shadow 宿主既不匹配 tag 列表、内部按钮
 * 也不可遍历，真正的「发布」按钮对 locate 完全隐形（第十七轮 locate(send)
 * 返回 11 个目标，第一名竟是「添加商品」）。此处对视口内 dash-tag 宿主做
 * CDP 组合树扫描，把内部真实按钮（含 disabled 状态）并入候选：命中 send
 * 关键词且未 disabled 的排最前。扫描失败按无增补处理，永不比现状更差。
 */
async function enrichSendTargetsWithClosedShadowHosts(
  controller: BrowserController,
  tabId: string | null,
  inPageTargets: ActionTargetCandidate[],
  sendKeywords: string[],
): Promise<ActionTargetCandidate[]> {
  try {
    const probe = await controller.executeJS(
      tabId,
      `(() => {
        const out = [];
        const all = document.body ? document.body.getElementsByTagName('*') : [];
        for (const el of all) {
          const tag = String(el.tagName || '').toLowerCase();
          if (tag.indexOf('-') === -1) continue;
          let rect = null;
          try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
          if (!rect || rect.width < 40 || rect.height < 16 || rect.height > 220) continue;
          if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
          let cs = null;
          try { cs = getComputedStyle(el); } catch (e) { continue; }
          if (!cs || cs.display === 'none' || cs.visibility === 'hidden') continue;
          out.push({ tag, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
          if (out.length >= 40) break;
        }
        // 动作栏几乎总在页面下部：按 top 降序优先扫底部宿主
        out.sort((a, b) => b.top - a.top);
        return { vw: innerWidth, vh: innerHeight, hosts: out.slice(0, 3) };
      })()`,
    ) as { vw?: unknown; vh?: unknown; hosts?: Array<{ tag?: unknown; left?: unknown; top?: unknown; width?: unknown; height?: unknown }> } | null
    const vw = Number(probe?.vw)
    const vh = Number(probe?.vh)
    const hosts = Array.isArray(probe?.hosts) ? probe.hosts : []
    if (!(vw > 0) || !(vh > 0) || hosts.length === 0) return inPageTargets
    const { scanClosedShadowHostForClickPoint } = await import('./browser-shadow-hit-test')
    const keywordRegexps = sendKeywords.map((k) => String(k).toLowerCase())
    const extraKeywords = ['publish', 'post', '确认', '完成']
    const shadowFront: ActionTargetCandidate[] = []
    const shadowBack: ActionTargetCandidate[] = []
    const seenLabels = new Set(inPageTargets.map((t) => `${t.label}`))
    for (const host of hosts) {
      const left = Number(host.left)
      const top = Number(host.top)
      const width = Number(host.width)
      const height = Number(host.height)
      const hostTag = String(host.tag || '')
      if (!Number.isFinite(left) || !Number.isFinite(top) || !(width > 0) || !(height > 0)) continue
      const scan = await scanClosedShadowHostForClickPoint(
        controller,
        tabId,
        { left, top, width, height },
        { vw, vh },
        { targetName: '', disambiguation: '' },
      ).catch(() => null)
      if (!scan) continue
      for (const c of scan.candidates) {
        if (!c.text || seenLabels.has(c.text)) continue
        seenLabels.add(c.text)
        const lower = c.text.toLowerCase()
        const keywordHit = keywordRegexps.some((k) => lower.includes(k)) || extraKeywords.some((k) => lower.includes(k))
        const candidate: ActionTargetCandidate = {
          kind: keywordHit ? 'send_button' : 'text_button',
          label: c.text,
          selectorHint: `closed-shadow:${hostTag}`,
          x: Math.max(0, Math.min(999, Math.round((c.cssX / Math.max(1, vw)) * 999))),
          y: Math.max(0, Math.min(999, Math.round((c.cssY / Math.max(1, vh)) * 999))),
          confidence: keywordHit ? (c.disabled ? 0.5 : 0.92) : 0.4,
          evidence: [
            'closed_shadow_scan',
            `host:${hostTag}`,
            keywordHit ? 'keyword_match' : '',
            c.disabled ? 'disabled' : '',
          ].filter(Boolean),
          ...(c.disabled ? { disabled: true } : {}),
        }
        if (keywordHit && !c.disabled) shadowFront.push(candidate)
        else shadowBack.push(candidate)
      }
    }
    if (shadowFront.length === 0 && shadowBack.length === 0) return inPageTargets
    return [...shadowFront, ...inPageTargets, ...shadowBack].slice(0, 12)
  } catch {
    // silent-catch: closed-shadow 增补失败按无增补处理，in-page 结果原样返回
    return inPageTargets
  }
}

export interface BrowserActionFollowedTab {
  tabId: string
  title: string
  url: string
  reason: 'new_tab' | 'active_tab_changed'
  sourceTabId: string | null
  ready?: boolean
  elapsedMs?: number
}
