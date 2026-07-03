/**
 * P3 Phase B2（2026-07-03，纯移动拆分）— browser-tools 输入/键鼠动作簇。
 *
 * 从 browser-tools.ts 1522-2048 逐字搬出：abort/sleep 守卫、归一化坐标
 * 解析、CDP 鼠标/键盘分发（click/type 的 selector 与 coordinate 双路）、
 * 按键合成（keyToCode/VirtualCode）、聚焦输入清空、加载停止等待与动作
 * 后稳定化。行为零变更；上层工具经 browser-tools 回接使用。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import { ToolDomainError } from './tool-errors'
import { ACTION_CONFIRMATION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
import { matchBrowserDestructiveTarget } from '../agent-control/safety/action-confirmation-policy'
import {
  buildFocusedFieldProbeJs,
  buildInputGuardSnippetJs,
  buildTargetSemanticsLibraryJs,
  probeCoordinateTargetOrThrow,
  throwIfLiveTargetGuardBlocked,
} from './browser-probe'

export const BROWSER_V2_STOP_LOADING_TIMEOUT_MS = 15_000
const BROWSER_V3_ACTION_SETTLE_MS = 220

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function createAbortError(): Error {
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  return error
}

export function isBrowserAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return
  if (!signal) {
    await sleep(ms)
    return
  }
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function clampNormalized(value: number, fallback = 500): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(999, Math.round(value)))
}

export function normalizeErrorCode(error: unknown): string {
  const maybeCode = (error as { code?: string })?.code
  if (typeof maybeCode === 'string' && maybeCode.trim()) return maybeCode
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('No active tab')) return 'NO_ACTIVE_TAB'
  if (message.includes('Tab not found')) return 'TAB_NOT_FOUND'
  if (message.includes('Debugger attach failed')) return 'DEBUGGER_ATTACH_FAILED'
  return 'CDP_COMMAND_FAILED'
}

export async function resolveCssPoint(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
): Promise<{ cssX: number; cssY: number; width: number; height: number; nx: number; ny: number }> {
  const nx = clampNormalized(x)
  const ny = clampNormalized(y)
  const mapped = await controller.normalizedToCss(tabId, nx, ny)
  return {
    cssX: mapped.x,
    cssY: mapped.y,
    width: mapped.width,
    height: mapped.height,
    nx,
    ny,
  }
}

async function resolveCoordinateProbePointOrThrow(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
  action: 'click' | 'type',
): Promise<{ cssX: number; cssY: number; width: number; height: number; nx: number; ny: number } | null> {
  try {
    return await resolveCssPoint(controller, tabId, x, y)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const actionLabel = action === 'click' ? '点击' : '输入'
    throw new ToolDomainError(
      ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code,
      `无法确认坐标${actionLabel}目标是否安全，已拒绝执行。请改用明确 selector/target_id，或引导用户亲自完成。`,
      {
        x,
        y,
        reason: 'coordinate_target_point_resolution_failed',
        probeError: message,
      },
    )
  }
}

function modifiersToMask(value: unknown): number {
  if (!value) return 0
  const input = Array.isArray(value) ? value : [value]
  let mask = 0
  for (const raw of input) {
    const token = String(raw || '').toLowerCase()
    if (token === 'alt' || token === 'option') mask |= 1
    if (token === 'ctrl' || token === 'control') mask |= 2
    if (token === 'meta' || token === 'cmd' || token === 'command') mask |= 4
    if (token === 'shift') mask |= 8
  }
  return mask
}

function keyToCode(key: string): string {
  if (!key) return ''
  if (key.length === 1) {
    const upper = key.toUpperCase()
    if (/^[A-Z]$/.test(upper)) return `Key${upper}`
    if (/^[0-9]$/.test(upper)) return `Digit${upper}`
  }
  const table: Record<string, string> = {
    enter: 'Enter',
    escape: 'Escape',
    esc: 'Escape',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    space: 'Space',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
  }
  const resolved = table[key.toLowerCase()]
  return resolved || key
}

function keyToVirtualCode(key: string): number {
  const normalized = key.toLowerCase()
  const table: Record<string, number> = {
    enter: 13,
    tab: 9,
    escape: 27,
    esc: 27,
    backspace: 8,
    delete: 46,
    arrowup: 38,
    arrowdown: 40,
    arrowleft: 37,
    arrowright: 39,
    home: 36,
    end: 35,
    pageup: 33,
    pagedown: 34,
    shift: 16,
    control: 17,
    ctrl: 17,
    alt: 18,
    meta: 91,
    cmd: 91,
    command: 91,
    space: 32,
  }
  if (table[normalized]) return table[normalized]
  if (key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0)
    if (Number.isFinite(code)) return code
  }
  return 0
}

function normalizeKeyLabel(key: string): string {
  const normalized = key.toLowerCase()
  if (normalized === 'ctrl') return 'Control'
  if (normalized === 'cmd' || normalized === 'command') return 'Meta'
  if (normalized === 'esc') return 'Escape'
  if (key.length === 1) return key
  return key.charAt(0).toUpperCase() + key.slice(1)
}

export async function dispatchClickAt(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
): Promise<{ nx: number; ny: number; cssX: number; cssY: number; width: number; height: number }> {
  const point = await resolveCssPoint(controller, tabId, x, y)
  await controller.dispatchMouse(tabId, { type: 'mouseMoved', x: point.cssX, y: point.cssY, button: 'none', buttons: 0 })
  await controller.dispatchMouse(tabId, { type: 'mousePressed', x: point.cssX, y: point.cssY, button: 'left', buttons: 1, clickCount: 1 })
  await controller.dispatchMouse(tabId, { type: 'mouseReleased', x: point.cssX, y: point.cssY, button: 'left', buttons: 0, clickCount: 1 })
  return point
}

// EP1-I3 live-target net — ONE guarded entry per primitive action, shared by
// the top-level tools AND the workflow substeps (browser_run_workflow is not
// in the dispatch confirmation policy, so its inner click/type carry no
// semantics the gate can see — they MUST re-check at the execution layer).

/** Guarded CSS-selector click: judges the clickable owner's label (the click
 * bubbles), refuses destructive-grant targets without clicking. */
export async function runGuardedSelectorClick(
  controller: BrowserController,
  tabId: string | null,
  selector: string,
): Promise<string> {
  const clickJs = `
    (function() {
      const __READY_DESTRUCTIVE_TARGET_CHECK__ = true;
      ${buildTargetSemanticsLibraryJs()}
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return ${JSON.stringify(`Element not found: ${selector}`)};
      const owner = readyClickableOwner(el);
      const label = readyIsEditableField(owner) ? '' : readyClickSemanticsLabel(el);
      if (label && READY_DESTRUCTIVE_TARGET_PATTERNS.some((p) => p.test(label))) {
        return { __readyDestructiveTargetBlocked: true, label: label.slice(0, 80) };
      }
      el.click();
      return 'Clicked: ' + (el.tagName || '') + (el.textContent ? ' "' + el.textContent.slice(0, 50) + '"' : '');
    })()
  `
  const result = await controller.executeJS(tabId, clickJs)
  throwIfLiveTargetGuardBlocked(result, { selector })
  return String(result)
}

/** Guarded coordinate click: probes the target under the point. Clicking a
 * non-editable target (button/link) is an action requiring a grant when it
 * matches the destructive list; clicking an editable field just focuses it
 * and is allowed (value never judged). */
export async function runGuardedCoordinateClick(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
  abortSignal?: AbortSignal,
): Promise<{ nx: number; ny: number; cssX: number; cssY: number; width: number; height: number }> {
  const probePoint = await resolveCoordinateProbePointOrThrow(controller, tabId, x, y, 'click')
  const probe = probePoint
    ? await probeCoordinateTargetOrThrow(controller, tabId, probePoint, { x, y, action: 'click' })
    : null
  if (probe && typeof probe === 'object') {
    const p = probe as { label?: unknown; editable?: unknown }
    if (p.editable !== true) {
      const destructiveHit = matchBrowserDestructiveTarget(String(p.label || ''))
      if (destructiveHit) {
        throw new ToolDomainError(
          'grant_required',
          `坐标点击目标「${String(p.label || '').slice(0, 80)}」命中浏览器破坏性动作清单（${destructiveHit.reason}），需要用户授予该目标的 Power grant 后才能执行。`,
          { x, y, ruleId: destructiveHit.ruleId },
        )
      }
    }
  }
  const point = await dispatchClickAt(controller, tabId, x, y)
  await settleAfterAction(controller, tabId, abortSignal)
  return point
}

/** Guarded CSS-selector type: in-page field-semantics guard (no value),
 * refuses destructive-grant fields and unconfirmed password fields. */
export async function runGuardedSelectorType(
  controller: BrowserController,
  tabId: string | null,
  selector: string,
  text: string,
  opts: { clearFirst: boolean; allowPasswordFill: boolean; submit?: boolean },
): Promise<string> {
  const typeJs = `
    (function() {
      ${buildInputGuardSnippetJs(opts.allowPasswordFill)}
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return ${JSON.stringify(`Element not found: ${selector}`)};
      const guard = readyInputGuard(el);
      if (guard) return guard;
      el.focus();
      if ('value' in el) {
        ${opts.clearFirst ? 'el.value = "";' : ''}
        el.value = ${JSON.stringify(text)};
      } else {
        ${opts.clearFirst ? 'el.textContent = "";' : ''}
        el.textContent = ${JSON.stringify(text)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      ${opts.submit ? `
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        const form = el.closest && el.closest('form');
        if (form) form.requestSubmit && form.requestSubmit();
      ` : ''}
      return 'Typed "${text.slice(0, 50).replace(/"/g, '\\"')}" into ' + el.tagName + (el.name ? '[name=' + el.name + ']' : '');
    })()
  `
  const result = await controller.executeJS(tabId, typeJs)
  throwIfLiveTargetGuardBlocked(result, { selector })
  return String(result)
}

/** Guarded coordinate type: probes the field under the point. Non-editable
 * target → the focusing click is itself an action checked against the
 * destructive target list; editable field → judge by field semantics
 * (no value) + password. */
export async function runGuardedCoordinateType(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
  text: string,
  opts: { clearBefore: boolean; pressEnter: boolean; useShiftEnter: boolean; allowPasswordFill: boolean },
  abortSignal?: AbortSignal,
): Promise<{ nx: number; ny: number; cssX: number; cssY: number; width: number; height: number }> {
  const probePoint = await resolveCoordinateProbePointOrThrow(controller, tabId, x, y, 'type')
  const probe = probePoint
    ? await probeCoordinateTargetOrThrow(controller, tabId, probePoint, { x, y, action: 'type' })
    : null
  if (probe && typeof probe === 'object') {
    const p = probe as { label?: unknown; inputLabel?: unknown; password?: unknown; editable?: unknown }
    // A password field is editable by definition; treat password===true as
    // editable even if the probe failed to set the flag.
    const editable = p.editable === true || p.password === true
    if (!editable) {
      // The focusing click lands on a button/link → the click is the action.
      const clickLabel = String(p.label || '')
      const clickHit = matchBrowserDestructiveTarget(clickLabel)
      if (clickHit) {
        throw new ToolDomainError(
          'grant_required',
          `坐标输入会先点击目标「${clickLabel.slice(0, 80)}」，命中浏览器破坏性动作清单（${clickHit.reason}），需要用户授予该目标的 Power grant 后才能执行。`,
          { x, y, ruleId: clickHit.ruleId },
        )
      }
    } else {
      // Editable field: judge by field semantics (NOT its current value — a
      // draft containing「提交订单」must not false-trip), then password.
      const inputLabel = String(p.inputLabel || '')
      const fieldHit = matchBrowserDestructiveTarget(inputLabel)
      if (fieldHit) {
        throw new ToolDomainError(
          'grant_required',
          `坐标输入目标「${inputLabel.slice(0, 80)}」命中浏览器破坏性动作清单（${fieldHit.reason}），需要用户授予该目标的 Power grant 后才能执行。`,
          { x, y, ruleId: fieldHit.ruleId },
        )
      }
      if (p.password === true && !opts.allowPasswordFill) {
        throw new ToolDomainError(
          ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code,
          '坐标输入目标是密码输入框。请在调用参数中说明目标（如「登录密码输入框」），经用户确认后执行。',
          { x, y, ruleId: 'm3-login-existing-account' },
        )
      }
    }
  }
  const point = await dispatchClickAt(controller, tabId, x, y)
  if (opts.clearBefore) {
    await clearFocusedInput(controller, tabId)
  }
  await controller.typeTextDirectly(tabId, text, { useShiftEnterForNewline: opts.useShiftEnter })
  if (opts.pressEnter) {
    await sendKeyStroke(controller, tabId, 'Enter')
  }
  await settleAfterAction(controller, tabId, abortSignal)
  return point
}

export async function sendKeyStroke(
  controller: BrowserController,
  tabId: string | null,
  key: string,
  modifiers?: unknown,
): Promise<void> {
  const keyLabel = normalizeKeyLabel(key)
  const code = keyToCode(key)
  const vk = keyToVirtualCode(keyLabel)
  const mask = modifiersToMask(modifiers)
  const text = keyLabel.length === 1 ? keyLabel : keyLabel.toLowerCase() === 'enter' ? '\r' : undefined

  // EP1-I3 live-target net — send-keys is a keyboard bypass: a printable
  // keystroke lands in whatever field already has FOCUS, so character-by-
  // character typing could feed a captcha/password field no argument ever
  // named. Guard text-producing keys: a single char with NO command modifier
  // (Alt/Ctrl/Meta = bits 1|2|4) inserts a character — Shift (bit 8) is a
  // text modifier (Shift+a → 'A') so it must STILL be guarded. Command-key
  // combos (Ctrl+c / Meta+v / etc.) are shortcuts, and Enter/Tab/Escape are
  // navigation — those pass (pressing Enter after the USER typed their
  // credential is the user's own action completing). Both the
  // browser_send_keys tool and the workflow send_keys substep funnel through
  // here. Best-effort probe: empty/failed probe proceeds (visual channel).
  const COMMAND_MODIFIER_MASK = 0b0111 // Alt | Control | Meta
  if (keyLabel.length === 1 && (mask & COMMAND_MODIFIER_MASK) === 0) {
    const focusedProbe = await controller.executeJS(tabId, buildFocusedFieldProbeJs()).catch(() => null)
    if (focusedProbe && typeof focusedProbe === 'object') {
      const probed = focusedProbe as { inputLabel?: unknown; password?: unknown }
      const inputLabel = String(probed.inputLabel || '')
      const destructiveHit = matchBrowserDestructiveTarget(inputLabel)
      if (destructiveHit) {
        throw new ToolDomainError(
          'grant_required',
          `当前焦点字段「${inputLabel.slice(0, 80)}」命中浏览器破坏性动作清单（${destructiveHit.reason}），需要用户授予该目标的 Power grant 后才能逐键输入。`,
          { key: keyLabel, ruleId: destructiveHit.ruleId },
        )
      }
      if (probed.password === true) {
        throw new ToolDomainError(
          ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code,
          '当前焦点是密码输入框，不能逐键代输。请改用 browser_type 并在参数中说明目标（如「登录密码输入框」），经用户确认后执行。',
          { key: keyLabel, ruleId: 'm3-login-existing-account' },
        )
      }
    }
  }

  const modifierTriples: Array<{ key: string; code: string; vk: number; bit: number }> = [
    { key: 'Alt', code: 'AltLeft', vk: 18, bit: 1 },
    { key: 'Control', code: 'ControlLeft', vk: 17, bit: 2 },
    { key: 'Meta', code: 'MetaLeft', vk: 91, bit: 4 },
    { key: 'Shift', code: 'ShiftLeft', vk: 16, bit: 8 },
  ]

  for (const modifier of modifierTriples) {
    if ((mask & modifier.bit) !== modifier.bit) continue
    await controller.dispatchKey(tabId, {
      type: 'keyDown',
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.vk,
      nativeVirtualKeyCode: modifier.vk,
      isKeypad: false,
    })
  }

  await controller.dispatchKey(tabId, {
    type: 'keyDown',
    key: keyLabel,
    code,
    windowsVirtualKeyCode: vk || undefined,
    nativeVirtualKeyCode: vk || undefined,
    text,
    modifiers: mask,
    isKeypad: false,
    unmodifiedText: text,
  })
  await controller.dispatchKey(tabId, {
    type: 'keyUp',
    key: keyLabel,
    code,
    windowsVirtualKeyCode: vk || undefined,
    nativeVirtualKeyCode: vk || undefined,
    modifiers: mask,
    isKeypad: false,
  })

  for (let i = modifierTriples.length - 1; i >= 0; i -= 1) {
    const modifier = modifierTriples[i]
    if ((mask & modifier.bit) !== modifier.bit) continue
    await controller.dispatchKey(tabId, {
      type: 'keyUp',
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.vk,
      nativeVirtualKeyCode: modifier.vk,
      isKeypad: false,
    })
  }
}

export async function clearFocusedInput(controller: BrowserController, tabId: string | null): Promise<void> {
  const selectAllMask = process.platform === 'darwin' ? 4 : 2
  await controller.dispatchKey(tabId, {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: selectAllMask,
  })
  await controller.dispatchKey(tabId, {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: selectAllMask,
  })
  await sendKeyStroke(controller, tabId, 'Backspace')
}

export async function waitForLoadingStop(
  controller: BrowserController,
  tabId: string | null,
  timeoutMs = BROWSER_V2_STOP_LOADING_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal)
    try {
      const done = await controller.executeJS(
        tabId,
        `(() => (document.readyState === 'interactive' || document.readyState === 'complete'))()`,
      ) as boolean
      if (done) return true
    } catch {
      // silent-catch: 轮询 readyState 失败视为未就绪，继续等待下一轮。
    }
    await sleepWithAbort(200, signal)
  }
  return false
}

export async function settleAfterAction(
  controller: BrowserController,
  tabId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  await sleepWithAbort(BROWSER_V3_ACTION_SETTLE_MS, signal)
  await waitForLoadingStop(controller, tabId, 8_000, signal)
  await waitForReady(controller, tabId, 6_000, undefined, signal)
}

export async function waitForReady(
  controller: BrowserController,
  tabId: string | null,
  timeoutMs = 8000,
  selector?: string,
  signal?: AbortSignal,
): Promise<{ ready: boolean; matchedSelector: boolean; elapsedMs: number }> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal)
    try {
      const state = await controller.executeJS(tabId, `
        (() => {
          const hasSelectorDeep = (selector) => {
            const queue = [document]
            const visited = new Set()
            while (queue.length) {
              const root = queue.shift()
              if (!root || visited.has(root)) continue
              visited.add(root)
              try {
                if (root.querySelector?.(selector)) return true
              } catch {
                // ignore invalid selector in a specific root
              }
              let nodes = []
              try {
                nodes = Array.from(root.querySelectorAll?.('*') || [])
              } catch {
                nodes = []
              }
              for (const node of nodes) {
                const shadow = node?.shadowRoot
                if (shadow && !visited.has(shadow)) queue.push(shadow)
              }
            }
            return false
          }
          const readyState = document.readyState || 'loading'
          const bodyTextLen = (document.body?.innerText || '').trim().length
          const matched = ${selector ? `hasSelectorDeep(${JSON.stringify(selector)})` : 'false'}
          return { readyState, bodyTextLen, matched }
        })()
      `) as { readyState?: string; bodyTextLen?: number; matched?: boolean }
      const readyState = state?.readyState || 'loading'
      const bodyTextLen = Number(state?.bodyTextLen || 0)
      const matched = Boolean(state?.matched)
      const baseReady = readyState === 'interactive' || readyState === 'complete'
      if (selector) {
        if (baseReady && matched) {
          return { ready: true, matchedSelector: true, elapsedMs: Date.now() - started }
        }
      } else if (baseReady && bodyTextLen > 0) {
        return { ready: true, matchedSelector: false, elapsedMs: Date.now() - started }
      }
    } catch {
      // silent-catch: 轮询就绪状态失败按未就绪处理，继续重试到超时。
    }
    await sleepWithAbort(250, signal)
  }
  return { ready: false, matchedSelector: false, elapsedMs: Date.now() - started }
}
