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
  buildFocusedEditableProbeJs,
  buildFocusedFieldProbeJs,
  buildInputGuardSnippetJs,
  buildTargetSemanticsLibraryJs,
  buildTypedIntoProbeJs,
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
): Promise<{
  nx: number
  ny: number
  cssX: number
  cssY: number
  width: number
  height: number
  /** D18-b：点下真实元素的语义标签（第十三轮实锚：模型把 CSS 像素当归一
   * 化坐标传给 click_at，点偏后自己看不出来——把"点到了什么"回给它闭环自纠）。
   * D18-c 补 tag：空 label 的命中可能是无名编辑器而非脱靶。
   * R18 补 rect：dash-tag host 命中时调用方对 host rect 做组合树扫描。 */
  pointTarget: {
    label: string
    editable: boolean
    tag: string
    rect?: { left: number; top: number; width: number; height: number } | null
  } | null
}> {
  const probePoint = await resolveCoordinateProbePointOrThrow(controller, tabId, x, y, 'click')
  const probe = probePoint
    ? await probeCoordinateTargetOrThrow(controller, tabId, probePoint, { x, y, action: 'click' })
    : null
  let pointTarget: {
    label: string
    editable: boolean
    tag: string
    rect?: { left: number; top: number; width: number; height: number } | null
  } | null = null
  if (probe && typeof probe === 'object') {
    const p = probe as {
      label?: unknown
      editable?: unknown
      tag?: unknown
      rect?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | null
    }
    const rectLeft = Number(p.rect?.left)
    const rectTop = Number(p.rect?.top)
    const rectWidth = Number(p.rect?.width)
    const rectHeight = Number(p.rect?.height)
    pointTarget = {
      label: String(p.label || '').slice(0, 120),
      editable: p.editable === true,
      tag: String(p.tag || '').slice(0, 32),
      rect: Number.isFinite(rectLeft) && Number.isFinite(rectTop) && rectWidth > 0 && rectHeight > 0
        ? { left: rectLeft, top: rectTop, width: rectWidth, height: rectHeight }
        : null,
    }
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
  return { ...point, pointTarget }
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
        // D16-b：React 受控输入必须走原型原生 setter，绕过实例 valueTracker，
        // 否则 DOM 有字而框架状态为空、校验静默失败。
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
        const nativeSet = proto ? (Object.getOwnPropertyDescriptor(proto, 'value') || {}).set : null;
        ${opts.clearFirst ? 'if (nativeSet) nativeSet.call(el, ""); else el.value = "";' : ''}
        if (nativeSet) nativeSet.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
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
export interface GuardedCoordinateTypeResult {
  nx: number
  ny: number
  cssX: number
  cssY: number
  width: number
  height: number
  /** false = 聚焦点击后焦点不在可编辑控件上，已拒绝打字（响亮失败，不静默误灌） */
  typed: boolean
  skipReason: 'focus_not_editable' | 'text_exceeds_field_capacity' | 'multiline_into_single_line' | null
  /** 聚焦点击后的真实焦点身份（frame = 跨帧编辑器，无法验证，放行） */
  focusTarget: {
    kind: 'editable' | 'non_editable' | 'none' | 'frame' | 'unknown'
    tag: string
    label: string
    maxLength: number | null
  } | null
  /** 打完字的落点回读（密码框不回显内容；probe 失败为 null） */
  typedInto: { tag: string; label: string; textHead: string; textLength: number } | null
}

export async function runGuardedCoordinateType(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
  text: string,
  opts: { clearBefore: boolean; pressEnter: boolean; useShiftEnter: boolean; allowPasswordFill: boolean },
  abortSignal?: AbortSignal,
): Promise<GuardedCoordinateTypeResult> {
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
  // D18-c（真机第十四轮实锚）：聚焦点击落在死区/不可聚焦位置时，焦点滞留
  // 上一个控件或回落 body——旧实现照打不误，正文全文灌进 XHS 标题框且模型
  // 毫无感知。打字前验真实焦点：不可编辑 → 拒绝打字并回报点到了什么；
  // 跨帧（iframe 编辑器）无法验证 → 放行但标注 kind=frame。
  const focusProbe = await controller.executeJS(tabId, buildFocusedEditableProbeJs()).catch(() => null)
  let focusTarget: GuardedCoordinateTypeResult['focusTarget'] = null
  let focusSingleLine = false
  if (focusProbe && typeof focusProbe === 'object') {
    const f = focusProbe as { kind?: unknown; tag?: unknown; label?: unknown; maxLength?: unknown; singleLine?: unknown }
    const kind = ['editable', 'non_editable', 'none', 'frame'].includes(String(f.kind))
      ? String(f.kind) as 'editable' | 'non_editable' | 'none' | 'frame'
      : 'unknown'
    const maxLength = Number(f.maxLength)
    focusTarget = {
      kind,
      tag: String(f.tag || '').slice(0, 32),
      label: String(f.label || '').slice(0, 120),
      maxLength: Number.isFinite(maxLength) && maxLength > 0 ? maxLength : null,
    }
    focusSingleLine = f.singleLine === true
  }
  if (focusTarget && (focusTarget.kind === 'none' || focusTarget.kind === 'non_editable')) {
    return { ...point, typed: false, skipReason: 'focus_not_editable', focusTarget, typedInto: null }
  }
  // D18-d（第十六轮实锚）：容量硬拒——64 字上限的标题框装不下 500 字正文，
  // 打进去必然是错框；单行 input 也装不下多段文本。只报不拒已被证明救不了
  // 模型的坐标微调循环，这里必须机械拒绝。
  if (focusTarget?.maxLength != null && text.length > focusTarget.maxLength) {
    return { ...point, typed: false, skipReason: 'text_exceeds_field_capacity', focusTarget, typedInto: null }
  }
  if (focusSingleLine && text.includes('\n')) {
    return { ...point, typed: false, skipReason: 'multiline_into_single_line', focusTarget, typedInto: null }
  }
  if (opts.clearBefore) {
    await clearFocusedInput(controller, tabId)
  }
  await controller.typeTextDirectly(tabId, text, { useShiftEnterForNewline: opts.useShiftEnter })
  if (opts.pressEnter) {
    await sendKeyStroke(controller, tabId, 'Enter')
  }
  await settleAfterAction(controller, tabId, abortSignal)
  // D18-c：回读文本真实落点——"打进了哪个框、现在框里是什么"在同一次
  // 工具结果里可见，错灌一目了然（第十四轮：正文进标题烧了 4 分钟盲试）。
  const typedProbe = await controller.executeJS(tabId, buildTypedIntoProbeJs()).catch(() => null)
  let typedInto: GuardedCoordinateTypeResult['typedInto'] = null
  if (typedProbe && typeof typedProbe === 'object') {
    const t = typedProbe as { tag?: unknown; label?: unknown; textHead?: unknown; textLength?: unknown }
    typedInto = {
      tag: String(t.tag || '').slice(0, 32),
      label: String(t.label || '').slice(0, 120),
      textHead: String(t.textHead || ''),
      textLength: Number(t.textLength) || 0,
    }
  }
  return { ...point, typed: true, skipReason: null, focusTarget, typedInto }
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

export function buildSmartTypeJs(options: {
  target: string
  text: string
  clearFirst: boolean
  submit: boolean
  /** EP1-I3 live-target net — args carried a password cue (gate-confirmed). */
  allowPasswordFill?: boolean
}): string {
  const normalizedTarget = options.target.trim().toLowerCase()
  return `
    (() => {
      ${buildInputGuardSnippetJs(options.allowPasswordFill === true)}
      const target = ${JSON.stringify(normalizedTarget)}
      const text = ${JSON.stringify(options.text)}
      const clearFirst = ${options.clearFirst ? 'true' : 'false'}
      const submit = ${options.submit ? 'true' : 'false'}
      const normalize = (s) => (s || '').toLowerCase().replace(/\\s+/g, ' ').trim()
      // D18-d：富文本可编辑判定用属性而非 isContentEditable——语义等价
      // （attr 决定可编辑性），且 jsdom 等无渲染环境可测。
      const isRichEditable = (el) => {
        if (!el || !el.getAttribute) return false
        if (el.isContentEditable === true) return true
        const v = el.getAttribute('contenteditable')
        return v === '' || String(v || '').toLowerCase() === 'true'
      }

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

      const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
      const isEditable = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
        const isTextarea = el instanceof HTMLTextAreaElement
        const role = (el.getAttribute('role') || '').toLowerCase()
          const roleTextbox = role === 'textbox' || role === 'searchbox'
        const hasContentEditableAttr = el.hasAttribute('contenteditable')
        const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
        const isContentEditable =
          el.isContentEditable ||
          (hasContentEditableAttr && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
        if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
        const tag = (el.tagName || '').toLowerCase()
        if ((tag === 'html' || tag === 'body') && !hasContentEditableAttr) return false
        if (el.getAttribute('aria-disabled') === 'true') return false
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.disabled || el.readOnly) return false
        }
        return visible(el)
      }

      const candidates = all.filter(isEditable)
      if (candidates.length === 0) return 'Smart target not found: no editable element'

      const targetTokens = target.split(' ').filter(Boolean)
      const textFields = (el) => {
        const attrs = [
          el.getAttribute('placeholder') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('name') || '',
          el.getAttribute('id') || '',
          el.getAttribute('title') || '',
          el.getAttribute('data-placeholder') || '',
          el.getAttribute('data-testid') || '',
          el.getAttribute('role') || '',
        ]
        const label = (() => {
          const id = el.getAttribute('id')
          if (id) {
            try {
              const l = document.querySelector('label[for="' + CSS.escape(id) + '"]')
              if (l) return l.textContent || ''
            } catch { /* ignore */ }
          }
          const p = el.closest('label')
          return p ? (p.textContent || '') : ''
        })()
        attrs.push(label)
        return normalize(attrs.join(' | '))
      }

      const score = (el) => {
        const merged = textFields(el)
        const rect = el.getBoundingClientRect()
        let s = 0

        // D18-d（真机第十六轮实锚）：容量与形态匹配。上一轮评分器把
        // maxlength=64 的标题 textarea（52.19 分）排在正文 contenteditable
        // 前面，500 字三段正文灌进标题。装不下的字段直接出局；多段长文
        // 强偏向富文本编辑器。
        const capacity = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? Number(el.maxLength) : -1;
        if (capacity > 0 && text.length > capacity) return -1000;
        if (el instanceof HTMLInputElement && text.includes('\\n')) return -1000;
        const isMultiParagraph = text.includes('\\n') || text.length > 120;
        if (isMultiParagraph && isRichEditable(el)) s += 40;

        if (target) {
          if (merged === target) s += 120
          if (merged.includes(target)) s += 70
          let tokenHit = 0
          for (const t of targetTokens) {
            if (merged.includes(t)) tokenHit += 1
          }
          s += tokenHit * 12
        } else {
          s += 20
        }

        if (/search|message|ask|prompt|chat|gemini|输入|搜索|提问|发送/.test(merged)) s += 30
        if (el instanceof HTMLTextAreaElement) s += 18
        if (isRichEditable(el)) s += 14
        if ((el.getAttribute('role') || '').toLowerCase() === 'searchbox') s += 18

        const area = Math.max(1, rect.width * rect.height)
        s += Math.min(28, area / 18000)
        const fromBottom = Math.max(0, window.innerHeight - rect.bottom)
        s += Math.max(0, 10 - Math.min(10, fromBottom / 70))
        return s
      }

      let best = null
      let bestScore = -1
      for (const el of candidates) {
        const sc = score(el)
        if (sc > bestScore) {
          best = el
          bestScore = sc
        }
      }

      if (!best) return 'Smart target not found: score failed'

      // EP1-I3 live-target net — the scorer may have resolved a captcha or
      // password field the args never named.
      const __readyGuard = readyInputGuard(best)
      if (__readyGuard) return __readyGuard

      const focusAndClick = (el) => {
        try { el.scrollIntoView({ block: 'center', behavior: 'instant' }) } catch { /* ignore */ }
        try { el.focus({ preventScroll: true }) } catch { /* ignore */ }
        try { el.click?.() } catch { /* ignore */ }
      }

      const readText = (el) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return String(el.value || '')
        }
        return String(el.innerText || el.textContent || '')
      }

      const setText = (el, value) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const current = String(el.value || '')
          if (normalize(current) === normalize(value)) return
          // D16-b：原生 setter 绕过 React valueTracker（同 buildTypeJs）。
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const nativeSet = (Object.getOwnPropertyDescriptor(proto, 'value') || {}).set
          if (clearFirst) { if (nativeSet) nativeSet.call(el, ''); else el.value = '' }
          if (nativeSet) nativeSet.call(el, value)
          else el.value = value
          return
        }
        if (isRichEditable(el)) {
          const current = String(el.innerText || el.textContent || '')
          if (normalize(current) === normalize(value)) return
          if (clearFirst) el.textContent = ''
          let inserted = false
          try {
            const selection = window.getSelection()
            if (selection) {
              const range = document.createRange()
              range.selectNodeContents(el)
              range.collapse(false)
              selection.removeAllRanges()
              selection.addRange(range)
            }
            inserted = document.execCommand('insertText', false, value)
          } catch {
            inserted = false
          }
          if (!inserted) {
            el.textContent = (clearFirst ? '' : (el.textContent || '')) + value
          }
          return
        }
        el.textContent = value
      }

      focusAndClick(best)
      const currentText = normalize(readText(best))
      const normalizedText = normalize(text)
      const alreadyHasSameText = Boolean(currentText && normalizedText && currentText === normalizedText)
      if (!alreadyHasSameText) {
        setText(best, text)
        try {
          best.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        } catch {
          best.dispatchEvent(new Event('input', { bubbles: true }))
        }
        best.dispatchEvent(new Event('change', { bubbles: true }))
      }

      if (submit) {
        const keyOpts = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }
        const down = new KeyboardEvent('keydown', keyOpts)
        const notCanceled = best.dispatchEvent(down)
        best.dispatchEvent(new KeyboardEvent('keypress', keyOpts))
        best.dispatchEvent(new KeyboardEvent('keyup', keyOpts))
        if (notCanceled) {
          const form = best.closest('form')
          if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit()
          }
        }
      }

      const idName = best.getAttribute('name') || best.getAttribute('id') || best.getAttribute('aria-label') || best.tagName
      if (alreadyHasSameText) {
        return 'Smart target already has same text: ' + idName
      }
      return 'Typed into smart target: ' + idName + ' (score=' + bestScore.toFixed(2) + ')'
    })()
  `
}
