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

export function activePageLikelyMatchesTarget(activeUrl: string | undefined, target: string): boolean {
  if (!activeUrl || !target) return false
  try {
    const active = new URL(activeUrl)
    const next = new URL(target)
    return active.href === next.href
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

export function listSubframesSafe(
  controller: BrowserController,
  tabId: string | null,
): Array<{ frameKey: string; url: string }> {
  if (typeof controller.listContentFrames !== 'function') return []
  try {
    return controller.listContentFrames(tabId)
      .filter((frame) => !frame.main && frame.url && frame.url !== 'about:blank')
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
  sameFormAsActiveInput?: boolean
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
          const out = nodes.map((node, index) => {
            const rect = node.getBoundingClientRect()
            const label = extractLabel(node)
            const value = normalize(readValue(node))
            const focused = !!active && active === node
            let score = 0
            if (node.tagName.toLowerCase() === 'textarea') score += 6
            if ((node instanceof HTMLElement) && node.isContentEditable) score += 5
            if (rect.bottom > window.innerHeight * 0.4) score += 4
            if (rect.width > window.innerWidth * 0.22) score += 4
            if (rect.height >= 32) score += 2
            if (focused) score += 18
            if (value.length > 0) score += Math.min(6, value.length / 24)
            return {
              kind: 'input',
              label,
              selectorHint: node.id ? ('#' + CSS.escape(node.id)) : String(node.tagName || '').toLowerCase(),
              x: Math.max(0, Math.min(999, Math.round(((rect.left + rect.width / 2) / Math.max(1, window.innerWidth)) * 999))),
              y: Math.max(0, Math.min(999, Math.round(((rect.top + rect.height / 2) / Math.max(1, window.innerHeight)) * 999))),
              confidence: Math.min(0.92, 0.4 + score / 50),
              evidence: [
                'editable_visible',
                label ? 'accessible_label_available' : '',
                focused ? 'active_input' : '',
                node.tagName.toLowerCase() === 'textarea' || node.isContentEditable ? 'multiline_editable' : '',
                value.length > 0 ? 'has_text' : '',
              ].filter(Boolean),
              focused,
              textLength: value.length,
              valuePreview: value.slice(0, 80),
              documentOrder: index,
            }
          })
          return out
            .sort((a, b) =>
              Number(Boolean(b.focused)) - Number(Boolean(a.focused)) ||
              Number(b.confidence || 0) - Number(a.confidence || 0) ||
              Number(a.documentOrder || 0) - Number(b.documentOrder || 0)
            )
            .map(({ documentOrder, ...candidate }) => candidate)
            .slice(0, 10)
        })()
      `,
    ) as ActionTargetCandidate[] | null

    return Array.isArray(targets) ? targets : []
  }

  const targets = await controller.executeJS(
    tabId,
    `
      (() => {
        const action = ${JSON.stringify(action)}
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return false
          if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false
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
        const isDisabled = (el) => {
          if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) return true
          return 'disabled' in el && el.disabled === true
        }
        const accessibleLabel = (el) => {
          const values = [
            el.getAttribute('aria-label'),
            el.innerText,
            el.textContent,
            el.getAttribute('title'),
            el.getAttribute('alt'),
            el instanceof HTMLInputElement ? el.value : '',
            el.querySelector?.('svg title')?.textContent,
          ]
          for (const value of values) {
            const normalized = normalize(value)
            if (normalized) return normalized
          }
          return ''
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
        for (const node of Array.from(document.querySelectorAll('button,a[href],[role="button"],[role="link"],[role="tab"],[role="menuitem"],summary,input[type="submit"],input[type="button"],[onclick]'))) {
          if (!(node instanceof HTMLElement) || !visible(node) || !isClickable(node) || isDisabled(node)) continue
          const rect = node.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          const label = accessibleLabel(node)
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
          const inNavigationLikeRegion = !!node.closest('nav,aside,[role="navigation"],header')
          const dialog = node.closest('dialog[open],[role="dialog"],[aria-modal="true"]')
          const dialogRect = dialog instanceof HTMLElement ? dialog.getBoundingClientRect() : null
          if (action === 'send') {
            const hugeSurface = rect.width > window.innerWidth * 0.42 || rect.height > window.innerHeight * 0.14
            if (hugeSurface) continue
            if (activeRect && !nearActiveInput && !sameFormAsActiveInput) continue
          }
          const compactControl = rect.width <= 120 && rect.height <= 120
          const dialogTopRight = !!dialogRect && compactControl &&
            centerX >= dialogRect.left + dialogRect.width * 0.58 &&
            centerY <= dialogRect.top + Math.min(120, dialogRect.height * 0.3)
          const viewportTopRight = compactControl && rect.right > window.innerWidth * 0.72 && rect.top < window.innerHeight * 0.24
          if (action === 'close' && !dialogTopRight && !viewportTopRight) continue
          const viewportTopLeft = compactControl && rect.left < window.innerWidth * 0.28 && rect.top < window.innerHeight * 0.45
          if (action === 'back' && !viewportTopLeft) continue

          let score = 10
          if (label) score += 2
          if (action === 'send') {
            if (sameFormAsActiveInput) score += 22
            if (nearActiveInput) score += 16
            if (activeRect && Number.isFinite(distanceToActiveInput)) {
              score += Math.max(0, 10 - Number(distanceToActiveInput) / 40)
            }
            if (inNavigationLikeRegion && !sameFormAsActiveInput) score -= 8
            if (compactControl) score += 3
          }
          if (action === 'close' && dialogTopRight) score += 12
          if (action === 'close' && viewportTopRight) score += 6
          if (action === 'back' && viewportTopLeft) score += 8
          if (score <= 0) continue
          out.push({
            kind: action === 'send' ? 'send_button' : action === 'close' ? 'close_button' : action === 'back' ? 'back_button' : 'icon_button',
            label,
            selectorHint: node.id ? ('#' + CSS.escape(node.id)) : String(node.tagName || '').toLowerCase(),
            x: Math.max(0, Math.min(999, Math.round((centerX / Math.max(1, window.innerWidth)) * 999))),
            y: Math.max(0, Math.min(999, Math.round((centerY / Math.max(1, window.innerHeight)) * 999))),
            confidence: Math.min(0.92, 0.32 + Math.max(0, score) / 60),
            evidence: [
              'explicit_clickable',
              label ? 'accessible_label_available' : 'unlabeled_control',
              nearActiveInput ? 'near_active_input' : '',
              sameFormAsActiveInput ? 'same_form_as_active_input' : '',
              dialogTopRight ? 'dialog_top_right' : '',
              viewportTopRight || viewportTopLeft ? 'viewport_edge' : '',
            ].filter(Boolean),
            nearActiveInput: nearActiveInput || undefined,
            distanceToActiveInput,
            sameFormAsActiveInput: sameFormAsActiveInput || undefined,
          })
        }
        return out
          .sort((a, b) =>
            Number(Boolean(b.sameFormAsActiveInput)) - Number(Boolean(a.sameFormAsActiveInput)) ||
            Number(Boolean(b.nearActiveInput)) - Number(Boolean(a.nearActiveInput)) ||
            Number(a.distanceToActiveInput ?? Number.POSITIVE_INFINITY) - Number(b.distanceToActiveInput ?? Number.POSITIVE_INFINITY) ||
            Number(b.confidence || 0) - Number(a.confidence || 0)
          )
          .slice(0, 12)
      })()
    `,
  ) as ActionTargetCandidate[] | null

  const inPageTargets = Array.isArray(targets) ? targets : []
  if (action !== 'send') return inPageTargets
  return enrichSendTargetsWithClosedShadowHosts(controller, tabId, inPageTargets)
}

/**
 * Light-DOM traversal cannot see controls inside a closed shadow root. Scan
 * custom-element hosts near the focused editor and surface every real control
 * with its accessible text and disabled state. Semantic choice remains with
 * the model; this layer only ranks by distance and availability.
 */
async function enrichSendTargetsWithClosedShadowHosts(
  controller: BrowserController,
  tabId: string | null,
  inPageTargets: ActionTargetCandidate[],
): Promise<ActionTargetCandidate[]> {
  try {
    const probe = await controller.executeJS(
      tabId,
      `(() => {
        const out = [];
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const activeRole = active ? String(active.getAttribute('role') || '').toLowerCase() : '';
        const activeEditable = !!active && (
          active.matches('textarea,input,[contenteditable]') ||
          activeRole === 'textbox' || activeRole === 'searchbox' || activeRole === 'combobox'
        );
        if (!activeEditable) return { vw: innerWidth, vh: innerHeight, active: null, hosts: [] };
        const activeRect = active.getBoundingClientRect();
        const activeCenter = {
          x: activeRect.left + activeRect.width / 2,
          y: activeRect.top + activeRect.height / 2,
        };
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
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const distance = Math.round(Math.hypot(centerX - activeCenter.x, centerY - activeCenter.y));
          if (distance > Math.max(360, Math.min(innerWidth * 0.35, 520))) continue;
          out.push({ tag, left: rect.left, top: rect.top, width: rect.width, height: rect.height, distance });
          if (out.length >= 40) break;
        }
        out.sort((a, b) => a.distance - b.distance);
        return { vw: innerWidth, vh: innerHeight, active: activeCenter, hosts: out.slice(0, 6) };
      })()`,
    ) as {
      vw?: unknown
      vh?: unknown
      active?: { x?: unknown; y?: unknown } | null
      hosts?: Array<{ tag?: unknown; left?: unknown; top?: unknown; width?: unknown; height?: unknown; distance?: unknown }>
    } | null
    const vw = Number(probe?.vw)
    const vh = Number(probe?.vh)
    const activeX = Number(probe?.active?.x)
    const activeY = Number(probe?.active?.y)
    const hosts = Array.isArray(probe?.hosts) ? probe.hosts : []
    if (!(vw > 0) || !(vh > 0) || !Number.isFinite(activeX) || !Number.isFinite(activeY) || hosts.length === 0) return inPageTargets
    const { scanClosedShadowHostForClickPoint } = await import('./browser-shadow-hit-test')
    const shadowTargets: ActionTargetCandidate[] = []
    const seen = new Set(inPageTargets.map((t) => `${t.label}|${t.x}|${t.y}`))
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
        const x = Math.max(0, Math.min(999, Math.round((c.cssX / Math.max(1, vw)) * 999)))
        const y = Math.max(0, Math.min(999, Math.round((c.cssY / Math.max(1, vh)) * 999)))
        const candidateKey = `${c.text}|${x}|${y}`
        if (seen.has(candidateKey)) continue
        seen.add(candidateKey)
        const distanceToActiveInput = Math.round(Math.hypot(c.cssX - activeX, c.cssY - activeY))
        const nearActiveInput = distanceToActiveInput <= Math.max(240, Math.min(vw * 0.28, 360))
        const candidate: ActionTargetCandidate = {
          kind: c.text ? 'text_button' : 'icon_button',
          label: c.text,
          selectorHint: `closed-shadow:${hostTag}`,
          x,
          y,
          confidence: c.disabled ? 0.25 : nearActiveInput ? 0.72 : 0.45,
          evidence: [
            'closed_shadow_scan',
            `host:${hostTag}`,
            c.text ? 'accessible_label_available' : 'unlabeled_control',
            nearActiveInput ? 'near_active_input' : '',
            c.disabled ? 'disabled' : '',
            c.cover ? 'covered' : '',
          ].filter(Boolean),
          nearActiveInput: nearActiveInput || undefined,
          distanceToActiveInput,
          ...(c.disabled ? { disabled: true } : {}),
        }
        shadowTargets.push(candidate)
      }
    }
    if (shadowTargets.length === 0) return inPageTargets
    return [...inPageTargets, ...shadowTargets]
      .sort((a, b) =>
        Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)) ||
        Number(Boolean(b.sameFormAsActiveInput)) - Number(Boolean(a.sameFormAsActiveInput)) ||
        Number(Boolean(b.nearActiveInput)) - Number(Boolean(a.nearActiveInput)) ||
        Number(a.distanceToActiveInput ?? Number.POSITIVE_INFINITY) - Number(b.distanceToActiveInput ?? Number.POSITIVE_INFINITY) ||
        Number(b.confidence || 0) - Number(a.confidence || 0)
      )
      .slice(0, 12)
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
