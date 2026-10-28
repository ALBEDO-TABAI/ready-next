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
import {
  buildBrowserTargetFocusJs,
  buildFocusedEditableProbeJs,
  buildInputGuardSnippetJs,
  buildTargetSemanticsLibraryJs,
  buildTypedIntoProbeJs,
  probeCoordinateTargetOrThrow,
  throwIfLiveTargetGuardBlocked,
} from './browser-probe'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { createBrowserStructuredOutput } from './browser-failure-output'
import {
  browserInputEnvironmentReadiness,
  requireBrowserInputReadiness,
  type BrowserInputDocumentState,
} from '../browser-engine/browser-input-readiness'
import { browserSnapshotService } from '../browser-engine/browser-snapshot-service'

export async function requireTrustedPointerDelivery(
  controller: BrowserController,
  tabId: string | null,
): Promise<ToolExecutionOutput | null> {
  try {
    await requireBrowserInputReadiness(controller, tabId, 'trusted_pointer')
    return null
  } catch (error) {
    // silent-catch: a readiness failure is returned as a structured rejected, not-delivered browser output
    const readiness = error && typeof error === 'object' && 'readiness' in error
      ? (error as { readiness?: { reason?: string } }).readiness
      : null
    return createBrowserStructuredOutput({
      ok: false,
      errorKind: readiness?.reason === 'foreground_required' ? 'foreground_required' : 'browser_surface_required',
      dispatch: 'rejected',
      delivery: 'not_delivered',
      effect: 'not_applicable',
      mayHaveCommitted: false,
      needsObservation: false,
    })
  }
}

export type TrustedPointerExpectedIdentity = {
  physicalTargetToken?: string | null
  mainFrameDocumentToken?: string | null
}

let boundTrustedPointerExpected: TrustedPointerExpectedIdentity | null = null

export function bindTrustedPointerExpected(
  expected: TrustedPointerExpectedIdentity | null,
): () => void {
  const previous = boundTrustedPointerExpected
  boundTrustedPointerExpected = expected
  return () => {
    boundTrustedPointerExpected = previous
  }
}

function pointerDeliveryDenied(reason?: string): ToolExecutionOutput {
  return createBrowserStructuredOutput({
    ok: false,
    errorKind: reason === 'foreground_required' ? 'foreground_required' : 'browser_surface_required',
    dispatch: 'rejected',
    delivery: 'not_delivered',
    effect: 'not_applicable',
    mayHaveCommitted: false,
    needsObservation: false,
  })
}

export async function trustedInputPageDenied(
  controller: BrowserController,
  tabId: string | null,
  expected?: TrustedPointerExpectedIdentity | null,
): Promise<ToolExecutionOutput | null> {
  const resolvedExpected = expected || boundTrustedPointerExpected
  const expectedPhysical = resolvedExpected?.physicalTargetToken || null
  const expectedDocument = resolvedExpected?.mainFrameDocumentToken || null
  if (!expectedDocument && !expectedPhysical) return null
  const identity = await browserSnapshotService.documentIdentity(controller, tabId)
  if (
    (expectedDocument && identity.frameDocumentToken !== expectedDocument)
    || (expectedPhysical && identity.physicalTargetToken !== expectedPhysical)
  ) {
    return createBrowserStructuredOutput({
      ok: false,
      errorKind: 'browser_reference_stale',
      tabId,
      dispatch: 'rejected',
      delivery: 'not_delivered',
      effect: 'not_applicable',
      mayHaveCommitted: false,
      needsObservation: false,
    })
  }
  return null
}

export async function dispatchTrustedPointer(
  controller: BrowserController,
  tabId: string | null,
  event: Parameters<BrowserController['dispatchMouse']>[1],
  expected?: TrustedPointerExpectedIdentity | null,
): Promise<ToolExecutionOutput | null> {
  const resolvedExpected = expected || boundTrustedPointerExpected
  const expectedPhysical = resolvedExpected?.physicalTargetToken || null
  const before = browserInputEnvironmentReadiness(controller, tabId, 'trusted_pointer')
  if (!before.ready) return pointerDeliveryDenied(before.reason)
  if (expectedPhysical && before.physicalTargetToken !== expectedPhysical) {
    return pointerDeliveryDenied('physical_target_unavailable')
  }
  const blocked = await requireTrustedPointerDelivery(controller, tabId)
  if (blocked) return blocked
  const stale = await trustedInputPageDenied(controller, tabId, resolvedExpected)
  if (stale) return stale
  const after = browserInputEnvironmentReadiness(controller, tabId, 'trusted_pointer')
  if (!after.ready) return pointerDeliveryDenied(after.reason)
  if (
    (expectedPhysical && after.physicalTargetToken !== expectedPhysical)
    || (
      after.physicalTargetToken
      && before.physicalTargetToken
      && after.physicalTargetToken !== before.physicalTargetToken
    )
  ) {
    return pointerDeliveryDenied('physical_target_unavailable')
  }
  await controller.dispatchMouse(tabId, event)
  return null
}

export async function dispatchTrustedKey(
  controller: BrowserController,
  tabId: string | null,
  event: Parameters<BrowserController['dispatchKey']>[1],
  expected?: TrustedPointerExpectedIdentity | null,
): Promise<void> {
  const stale = await trustedInputPageDenied(controller, tabId, expected)
  if (stale) throw new TrustedPointerBlockedError(stale)
  await controller.dispatchKey(tabId, event)
}

export async function dispatchTrustedText(
  controller: BrowserController,
  tabId: string | null,
  text: string,
  options?: { useShiftEnterForNewline?: boolean },
  expected?: TrustedPointerExpectedIdentity | null,
): Promise<void> {
  const stale = await trustedInputPageDenied(controller, tabId, expected)
  if (stale) throw new TrustedPointerBlockedError(stale)
  await controller.typeTextDirectly(tabId, text, options)
}

export class TrustedPointerBlockedError extends Error {
  readonly output: ToolExecutionOutput

  constructor(output: ToolExecutionOutput) {
    super('trusted_pointer_blocked')
    this.name = 'TrustedPointerBlockedError'
    this.output = output
  }
}

export async function assertTrustedPointerDelivery(
  controller: BrowserController,
  tabId: string | null,
): Promise<void> {
  const blocked = await requireTrustedPointerDelivery(controller, tabId)
  if (blocked) throw new TrustedPointerBlockedError(blocked)
}

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
  if (key === ' ') return 'Space'
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
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    shift: 'ShiftLeft',
    control: 'ControlLeft',
    alt: 'AltLeft',
    meta: 'MetaLeft',
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
  if (key.length === 1) return key
  const aliases: Record<string, string> = {
    alt: 'Alt',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    arrowup: 'ArrowUp',
    backspace: 'Backspace',
    cmd: 'Meta',
    command: 'Meta',
    control: 'Control',
    ctrl: 'Control',
    delete: 'Delete',
    end: 'End',
    enter: 'Enter',
    esc: 'Escape',
    escape: 'Escape',
    home: 'Home',
    meta: 'Meta',
    pagedown: 'PageDown',
    pageup: 'PageUp',
    shift: 'Shift',
    space: ' ',
    tab: 'Tab',
  }
  return aliases[normalized] || `${key.charAt(0).toUpperCase()}${key.slice(1).toLowerCase()}`
}

async function retainTrustedInputSequence(
  controller: BrowserController,
  tabId: string | null,
): Promise<() => void> {
  const retain = controller.retainTrustedInputSequence
  return typeof retain === 'function'
    ? retain.call(controller, tabId)
    : () => undefined
}

export function pointerPhaseOutput(
  blocked: ToolExecutionOutput,
  pressed: boolean,
): ToolExecutionOutput {
  if (!pressed) return blocked
  const data = blocked.data && typeof blocked.data === 'object'
    ? blocked.data as Record<string, unknown>
    : {}
  return createBrowserStructuredOutput({
    ...data,
    ok: false,
    errorKind: String(data.errorKind || 'browser_reference_stale'),
    dispatch: 'accepted',
    delivery: 'unknown',
    effect: 'unknown',
    mayHaveCommitted: true,
    needsObservation: true,
  })
}

export function pointerPhaseFailure(pressed: boolean, errorKind = 'browser_operation_failed'): ToolExecutionOutput {
  return createBrowserStructuredOutput({
    ok: false,
    errorKind,
    dispatch: pressed ? 'accepted' : 'rejected',
    delivery: pressed ? 'unknown' : 'not_delivered',
    effect: pressed ? 'unknown' : 'not_applicable',
    mayHaveCommitted: pressed,
    needsObservation: pressed,
  })
}

export async function dispatchClickAt(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
): Promise<{
  nx: number
  ny: number
  cssX: number
  cssY: number
  width: number
  height: number
  deliveryObserved: 'delivered' | 'not_delivered' | 'unknown'
}> {
  const point = await resolveCssPoint(controller, tabId, x, y)
  const deliveryToken = String(await controller.executeJS(tabId, `(() => {
    const __READY_AGENT_INPUT_DELIVERY_PROBE__ = true;
    const token = 'click-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const previous = globalThis.__readyClickDeliveryProbe;
    if (previous && typeof previous.cleanup === 'function') previous.cleanup();
    const state = { token, count: 0 };
    const onClick = () => { state.count += 1; };
    state.cleanup = () => document.removeEventListener('click', onClick, true);
    document.addEventListener('click', onClick, true);
    globalThis.__readyClickDeliveryProbe = state;
    return token;
  })()`).catch(() => '') || '')
  const moved = await dispatchTrustedPointer(controller, tabId, {
    type: 'mouseMoved',
    x: point.cssX,
    y: point.cssY,
    button: 'none',
    buttons: 0,
  })
  if (moved) {
    throw Object.assign(new Error('browser_input_not_ready:pointer'), {
      code: 'INPUT_NOT_READY',
      readiness: moved.data,
      blockedOutput: moved,
    })
  }
  const pressed = await dispatchTrustedPointer(controller, tabId, {
    type: 'mousePressed',
    x: point.cssX,
    y: point.cssY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  if (pressed) {
    throw Object.assign(new Error('browser_input_not_ready:pointer'), {
      code: 'INPUT_NOT_READY',
      readiness: pressed.data,
      blockedOutput: pressed,
    })
  }
  const released = await dispatchTrustedPointer(controller, tabId, {
    type: 'mouseReleased',
    x: point.cssX,
    y: point.cssY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  if (released) {
    throw Object.assign(new Error('browser_input_not_ready:pointer'), {
      code: 'INPUT_NOT_READY',
      readiness: released.data,
      blockedOutput: pointerPhaseOutput(released, true),
    })
  }
  const deliveryCount = deliveryToken
    ? await controller.executeJS(tabId, `(() => {
        const state = globalThis.__readyClickDeliveryProbe;
        if (!state || state.token !== ${JSON.stringify(deliveryToken)}) return null;
        if (typeof state.cleanup === 'function') state.cleanup();
        return Number(state.count || 0);
      })()`).catch(() => null)
    : null
  return {
    ...point,
    deliveryObserved: typeof deliveryCount === 'number'
      ? deliveryCount > 0 ? 'delivered' : 'not_delivered'
      : 'unknown',
  }
}

/** CSS-selector click that resolves a visible owner and uses trusted pointer
 * input. Accessible labels are returned as grounding, never policy input. */
export async function runGuardedSelectorClick(
  controller: BrowserController,
  tabId: string | null,
  selector: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const probeJs = `
    (function() {
      ${buildTargetSemanticsLibraryJs()}
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return ${JSON.stringify(`Element not found: ${selector}`)};
      const owner = readyClickableOwner(el);
      const label = readyIsEditableField(owner) ? '' : readyClickSemanticsLabel(el);
      const rect = el.getBoundingClientRect();
      return {
        ok: rect.width > 0 && rect.height > 0,
        label,
        tag: String(el.tagName || '').toLowerCase(),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: Number(window.innerWidth || 0),
        height: Number(window.innerHeight || 0)
      };
    })()
  `
  const probe = await controller.executeJS(tabId, probeJs)
  throwIfLiveTargetGuardBlocked(probe, { selector })
  if (!probe || typeof probe !== 'object' || (probe as { ok?: unknown }).ok !== true) return `Error: Element not found or hidden: ${selector}`
  const point = probe as { x?: unknown; y?: unknown; width?: unknown; height?: unknown; label?: unknown; tag?: unknown }
  const width = Number(point.width)
  const height = Number(point.height)
  if (!(width > 0 && height > 0)) return `Error: Element has no visible viewport: ${selector}`
  const clicked = await runGuardedCoordinateClick(
    controller,
    tabId,
    (Number(point.x) / width) * 1000,
    (Number(point.y) / height) * 1000,
    abortSignal,
  )
  return JSON.stringify({
    ok: true,
    selector,
    trustedInput: true,
    delivery: clicked.deliveryObserved,
    target: { label: String(point.label || ''), tag: String(point.tag || '') },
    point: { x: clicked.cssX, y: clicked.cssY },
  })
}

/** Coordinate click with best-effort structural grounding and trusted input. */
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
  deliveryObserved: 'delivered' | 'not_delivered' | 'unknown'
  /** D18-b：点下真实元素的语义标签（第十三轮实锚：模型把 CSS 像素当归一
   * 化坐标传给 click_at，点偏后自己看不出来——把"点到了什么"回给它闭环自纠）。
   * D18-c 补 tag：空 label 的命中可能是无名编辑器而非脱靶。
   * R18 补 rect：dash-tag host 命中时调用方对 host rect 做组合树扫描。 */
  pointTarget: {
    label: string
    editable: boolean
    tag: string
    rect?: { left: number; top: number; width: number; height: number } | null
    /** R19：点击前页面 URL（取证层同页判据）。 */
    url?: string
  } | null
}> {
  const releaseInputSequence = await retainTrustedInputSequence(controller, tabId)
  try {
  const probePoint = await resolveCoordinateProbePointOrThrow(controller, tabId, x, y, 'click')
  const probe = probePoint
    ? await probeCoordinateTargetOrThrow(controller, tabId, probePoint, { x, y, action: 'click' })
    : null
  let pointTarget: {
    label: string
    editable: boolean
    tag: string
    rect?: { left: number; top: number; width: number; height: number } | null
    url?: string
  } | null = null
  if (probe && typeof probe === 'object') {
    const p = probe as {
      label?: unknown
      editable?: unknown
      tag?: unknown
      rect?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | null
      url?: unknown
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
      ...(typeof p.url === 'string' && p.url ? { url: p.url } : {}),
    }
  }
  const point = await dispatchClickAt(controller, tabId, x, y)
  await settleAfterAction(controller, tabId, abortSignal)
  return { ...point, pointTarget }
  } finally {
    releaseInputSequence()
  }
}

/** CSS-selector type with structural file/password checks and trusted input. */
export async function runGuardedSelectorType(
  controller: BrowserController,
  tabId: string | null,
  selector: string,
  text: string,
  opts: { clearFirst: boolean; allowPasswordFill: boolean; submit?: boolean },
  abortSignal?: AbortSignal,
): Promise<string> {
  const probeJs = `
    (function() {
      ${buildInputGuardSnippetJs(opts.allowPasswordFill)}
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return ${JSON.stringify(`Element not found: ${selector}`)};
      const guard = readyInputGuard(el);
      if (guard) return guard;
      const rect = el.getBoundingClientRect();
      return {
        ok: rect.width > 0 && rect.height > 0,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: Number(window.innerWidth || 0),
        height: Number(window.innerHeight || 0)
      };
    })()
  `
  const probe = await controller.executeJS(tabId, probeJs)
  throwIfLiveTargetGuardBlocked(probe, { selector })
  if (!probe || typeof probe !== 'object' || (probe as { ok?: unknown }).ok !== true) return `Error: Element not found or hidden: ${selector}`
  const point = probe as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  const width = Number(point.width)
  const height = Number(point.height)
  const typed = await runGuardedCoordinateType(
    controller,
    tabId,
    (Number(point.x) / width) * 1000,
    (Number(point.y) / height) * 1000,
    text,
    {
      clearBefore: opts.clearFirst,
      pressEnter: opts.submit === true,
      useShiftEnter: false,
      allowPasswordFill: opts.allowPasswordFill,
    },
    abortSignal,
  )
  return JSON.stringify({ ok: typed.typed, selector, trustedInput: true, ...typed })
}

/** Coordinate type verifies a real editable destination and handles file and
 * password inputs by their structural type, never by visible wording. */
export interface GuardedCoordinateTypeResult {
  nx: number | null
  ny: number | null
  cssX: number
  cssY: number
  width: number
  height: number
  /** false = 聚焦点击后焦点不在可编辑控件上，已拒绝打字（响亮失败，不静默误灌） */
  typed: boolean
  textDelivery: 'delivered' | 'not_delivered' | 'unknown'
  submitDelivery: 'not_requested' | 'not_delivered' | 'delivered' | 'unknown'
  submitError?: string | null
  skipReason: 'focus_not_editable' | 'selection_unavailable' | 'text_exceeds_field_capacity' | 'multiline_into_single_line' | null
  /** 聚焦点击后的真实焦点身份（frame = 跨帧编辑器，无法验证，放行） */
  focusTarget: {
    kind: 'editable' | 'non_editable' | 'none' | 'frame' | 'unknown'
    tag: string
    label: string
    maxLength: number | null
  } | null
  /** 打完字的落点回读（密码框不回显内容；probe 失败为 null） */
  typedInto: { tag: string; label: string; textHead: string; textLength: number; textMatchesExpected: boolean | null } | null
}

type GuardedTypePoint = Pick<GuardedCoordinateTypeResult, 'nx' | 'ny' | 'cssX' | 'cssY' | 'width' | 'height'>
type GuardedTypeOptions = {
  clearBefore: boolean
  pressEnter: boolean
  useShiftEnter: boolean
  allowPasswordFill: boolean
}
type BrowserFrameScriptRunner = (code: string) => Promise<unknown>

async function runGuardedPostFocusType(
  controller: BrowserController,
  tabId: string | null,
  point: GuardedTypePoint,
  text: string,
  opts: GuardedTypeOptions,
  runProbe: BrowserFrameScriptRunner,
  requireConfirmedEditableFocus: boolean,
  focusConfirmed: boolean,
  abortSignal?: AbortSignal,
): Promise<GuardedCoordinateTypeResult> {
  const focusProbe = await runProbe(buildFocusedEditableProbeJs()).catch(() => null)
  let focusTarget: GuardedCoordinateTypeResult['focusTarget'] = null
  let focusSingleLine = false
  let inputDocumentState: BrowserInputDocumentState | undefined
  if (focusProbe && typeof focusProbe === 'object') {
    const f = focusProbe as {
      kind?: unknown
      tag?: unknown
      label?: unknown
      maxLength?: unknown
      singleLine?: unknown
      documentFocused?: unknown
      documentReady?: unknown
    }
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
    if (typeof f.documentFocused === 'boolean' && typeof f.documentReady === 'boolean') {
      inputDocumentState = {
        ready: f.documentReady,
        focused: f.documentFocused,
        activeElementEditable: kind === 'editable',
      }
    }
  }
  const uneditableFocus = focusTarget && (focusTarget.kind === 'none' || focusTarget.kind === 'non_editable')
  const unconfirmedTargetFocus = requireConfirmedEditableFocus && (!focusConfirmed || focusTarget?.kind !== 'editable')
  if (uneditableFocus || unconfirmedTargetFocus) {
    return { ...point, typed: false, textDelivery: 'not_delivered', submitDelivery: opts.pressEnter ? 'not_delivered' : 'not_requested', skipReason: 'focus_not_editable', focusTarget, typedInto: null }
  }
  if (focusTarget?.maxLength != null && text.length > focusTarget.maxLength) {
    return { ...point, typed: false, textDelivery: 'not_delivered', submitDelivery: opts.pressEnter ? 'not_delivered' : 'not_requested', skipReason: 'text_exceeds_field_capacity', focusTarget, typedInto: null }
  }
  if (focusSingleLine && text.includes('\n')) {
    return { ...point, typed: false, textDelivery: 'not_delivered', submitDelivery: opts.pressEnter ? 'not_delivered' : 'not_requested', skipReason: 'multiline_into_single_line', focusTarget, typedInto: null }
  }
  await requireBrowserInputReadiness(controller, tabId, 'direct_text', inputDocumentState)
  const textProbeToken = String(await runProbe(`(() => {
    const __READY_AGENT_INPUT_DELIVERY_PROBE__ = true;
    const token = 'text-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const previous = globalThis.__readyTextDeliveryProbe;
    if (previous && typeof previous.cleanup === 'function') previous.cleanup();
    const target = document.activeElement;
    const readValue = () => {
      if (!target) return null;
      if ('value' in target) return String(target.value ?? '');
      return String(target.textContent ?? '');
    };
    const state = { token, count: 0, target, before: readValue() };
    const onInput = (event) => { if (event && event.target === target) state.count += 1; };
    state.cleanup = () => document.removeEventListener('input', onInput, true);
    document.addEventListener('input', onInput, true);
    globalThis.__readyTextDeliveryProbe = state;
    return token;
  })()`).catch(() => '') || '')
  const submitProbeToken = opts.pressEnter
    ? String(await runProbe(`(() => {
        const __READY_AGENT_INPUT_DELIVERY_PROBE__ = true;
        const token = 'submit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        const key = '__readySubmitDeliveryProbe';
        const previous = globalThis[key];
        if (previous && typeof previous.cleanup === 'function') previous.cleanup();
        const state = { token, keydown: 0, submit: 0 };
        const onKey = (event) => { if (event && event.key === 'Enter') state.keydown += 1; };
        const onSubmit = () => { state.submit += 1; };
        state.cleanup = () => {
          document.removeEventListener('keydown', onKey, true);
          document.removeEventListener('submit', onSubmit, true);
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('submit', onSubmit, true);
        globalThis[key] = state;
        return token;
      })()`).catch(() => '') || '')
    : ''
  if (opts.clearBefore) {
    const selection = await runProbe(`(() => {
      const __READY_AGENT_TARGET_SELECT_ALL__ = true;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        try {
          el.setSelectionRange(0, String(el.value || '').length);
          return { ok: true, kind: 'text_control' };
        } catch {
          return { ok: false, reason: 'selection_failed' };
        }
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selected = window.getSelection();
          if (!selected) return { ok: false, reason: 'selection_unavailable' };
          selected.removeAllRanges();
          selected.addRange(range);
          return { ok: true, kind: 'contenteditable' };
        } catch {
          return { ok: false, reason: 'selection_failed' };
        }
      }
      return { ok: false, reason: 'exact_editable_selection_unavailable' };
    })()`).catch(() => null) as { ok?: unknown; reason?: unknown } | null
    if (selection?.ok !== true) {
      return {
        ...point,
        typed: false,
        textDelivery: 'not_delivered',
        submitDelivery: opts.pressEnter ? 'not_delivered' : 'not_requested',
        skipReason: 'selection_unavailable',
        focusTarget,
        typedInto: null,
      }
    }
  }
  await dispatchTrustedText(controller, tabId, text, { useShiftEnterForNewline: opts.useShiftEnter })
  let submitError: string | null = null
  if (opts.pressEnter) {
    try {
      // Direct text delivery may establish document focus. Keyboard readiness
      // must be read at dispatch time instead of reusing the pre-type probe.
      await sendKeyStroke(controller, tabId, 'Enter')
    } catch (error) {
      if (isBrowserAbortError(error)) throw error
      if (
        error instanceof TrustedPointerBlockedError
        && error.output.data?.mayHaveCommitted === true
      ) throw error
      const readinessReason = (error as { readiness?: { reason?: unknown } } | null)?.readiness?.reason
      submitError = typeof readinessReason === 'string' && readinessReason
        ? readinessReason
        : normalizeErrorCode(error)
    }
  }
  await settleAfterAction(controller, tabId, abortSignal)
  const typedProbe = await runProbe(buildTypedIntoProbeJs(text)).catch(() => null)
  let typedInto: GuardedCoordinateTypeResult['typedInto'] = null
  if (typedProbe && typeof typedProbe === 'object') {
    const t = typedProbe as { tag?: unknown; label?: unknown; textHead?: unknown; textLength?: unknown; textMatchesExpected?: unknown }
    typedInto = {
      tag: String(t.tag || '').slice(0, 32),
      label: String(t.label || '').slice(0, 120),
      textHead: String(t.textHead || ''),
      textLength: Number(t.textLength) || 0,
      textMatchesExpected: typeof t.textMatchesExpected === 'boolean' ? t.textMatchesExpected : null,
    }
  }
  let textDelivery: GuardedCoordinateTypeResult['textDelivery'] = 'unknown'
  if (textProbeToken) {
    const delivery = await runProbe(`(() => {
      const state = globalThis.__readyTextDeliveryProbe;
      if (!state || state.token !== ${JSON.stringify(textProbeToken)}) return null;
      if (typeof state.cleanup === 'function') state.cleanup();
      const target = state.target;
      const after = !target ? null : ('value' in target ? String(target.value ?? '') : String(target.textContent ?? ''));
      return { count: Number(state.count || 0), changed: after !== state.before };
    })()`).catch(() => null) as { count?: unknown; changed?: unknown } | null
    if (delivery) {
      textDelivery = Number(delivery.count || 0) > 0 || delivery.changed === true
        ? 'delivered'
        : 'not_delivered'
    }
  }
  let submitDelivery: GuardedCoordinateTypeResult['submitDelivery'] = opts.pressEnter ? 'unknown' : 'not_requested'
  if (submitError) {
    submitDelivery = 'not_delivered'
  } else if (opts.pressEnter && submitProbeToken) {
    const delivery = await runProbe(`(() => {
      const state = globalThis.__readySubmitDeliveryProbe;
      if (!state || state.token !== ${JSON.stringify(submitProbeToken)}) return null;
      if (typeof state.cleanup === 'function') state.cleanup();
      return { keydown: Number(state.keydown || 0), submit: Number(state.submit || 0) };
    })()`).catch(() => null) as { keydown?: unknown; submit?: unknown } | null
    if (Number(delivery?.keydown || 0) > 0 || Number(delivery?.submit || 0) > 0) submitDelivery = 'delivered'
  }
  return {
    ...point,
    typed: true,
    textDelivery,
    submitDelivery,
    ...(submitError ? { submitError } : {}),
    skipReason: null,
    focusTarget,
    typedInto,
  }
}

/**
 * Type into an already live-resolved page-map target. The target's frame is
 * responsible for focus and both readback probes; only keyboard text is sent
 * through CDP, so a parked background view does not depend on pointer focus.
 */
export async function runGuardedTargetType(
  controller: BrowserController,
  tabId: string | null,
  nodeId: string,
  frameDocumentToken: string,
  point: { x: number | null; y: number | null; cssX: number; cssY: number; width: number; height: number },
  text: string,
  opts: GuardedTypeOptions,
  runInTargetFrame: BrowserFrameScriptRunner,
  abortSignal?: AbortSignal,
): Promise<GuardedCoordinateTypeResult> {
  const resultPoint: GuardedTypePoint = {
    nx: point.x,
    ny: point.y,
    cssX: point.cssX,
    cssY: point.cssY,
    width: point.width,
    height: point.height,
  }
  const releaseInputSequence = await retainTrustedInputSequence(controller, tabId)
  try {
    const focused = await runInTargetFrame(buildBrowserTargetFocusJs(nodeId, opts.allowPasswordFill, frameDocumentToken)).catch(() => null)
    throwIfLiveTargetGuardBlocked(focused, { targetId: nodeId })
    return await runGuardedPostFocusType(
      controller,
      tabId,
      resultPoint,
      text,
      opts,
      runInTargetFrame,
      true,
      Boolean(focused && typeof focused === 'object' && (focused as { ok?: unknown }).ok === true),
      abortSignal,
    )
  } finally {
    releaseInputSequence()
  }
}

export async function runGuardedCoordinateType(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
  text: string,
  opts: GuardedTypeOptions,
  abortSignal?: AbortSignal,
): Promise<GuardedCoordinateTypeResult> {
  const releaseInputSequence = await retainTrustedInputSequence(controller, tabId)
  try {
  const probePoint = await resolveCoordinateProbePointOrThrow(controller, tabId, x, y, 'type')
  const probe = probePoint
    ? await probeCoordinateTargetOrThrow(controller, tabId, probePoint, { x, y, action: 'type' })
    : null
  if (probe && typeof probe === 'object') {
    const live = probe as { password?: unknown; fileInput?: unknown }
    if (live.fileInput === true) {
      throw new ToolDomainError('file_input_requires_upload', 'The live target is a file input; use browser_upload with a bound attachment.')
    }
    if (live.password === true && !opts.allowPasswordFill) {
      throw new ToolDomainError('credential_confirmation_required', 'The live target is a password field and requires a one-shot typed confirmation.')
    }
  }
  const point = await dispatchClickAt(controller, tabId, x, y)
  // D18-c（真机第十四轮实锚）：聚焦点击落在死区/不可聚焦位置时，焦点滞留
  // 上一个控件或回落 body——旧实现照打不误，正文全文灌进站点标题框且模型
  // 毫无感知。打字前验真实焦点：不可编辑 → 拒绝打字并回报点到了什么；
  // 跨帧（iframe 编辑器）无法验证 → 放行但标注 kind=frame。
  return await runGuardedPostFocusType(
    controller,
    tabId,
    point,
    text,
    opts,
    (code) => controller.executeJS(tabId, code),
    false,
    true,
    abortSignal,
  )
  } finally {
    releaseInputSequence()
  }
}

export async function sendKeyStroke(
  controller: BrowserController,
  tabId: string | null,
  key: string,
  modifiers?: unknown,
  documentState?: BrowserInputDocumentState,
): Promise<'delivered' | 'not_delivered' | 'unknown'> {
  const keyboardReadiness = await requireBrowserInputReadiness(controller, tabId, 'trusted_keyboard', documentState)
  const emulateFocus = keyboardReadiness.documentFocused !== true
  const keyLabel = normalizeKeyLabel(key)
  const code = keyToCode(keyLabel)
  const vk = keyToVirtualCode(keyLabel)
  const mask = modifiersToMask(modifiers)
  const commandModifierMask = 0b0111 // Alt | Control | Meta
  const text = (mask & commandModifierMask) === 0
    ? keyLabel.length === 1
      ? keyLabel
      : keyLabel.toLowerCase() === 'enter' ? '\r' : undefined
    : undefined
  const deliveryToken = String(await controller.executeJS(tabId, `(() => {
    const __READY_AGENT_INPUT_DELIVERY_PROBE__ = true;
    const token = 'key-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const previous = globalThis.__readyKeyDeliveryProbe;
    if (previous && typeof previous.cleanup === 'function') previous.cleanup();
    const state = { token, count: 0 };
    const onKey = (event) => { if (event && event.key === ${JSON.stringify(keyLabel)}) state.count += 1; };
    state.cleanup = () => document.removeEventListener('keydown', onKey, true);
    document.addEventListener('keydown', onKey, true);
    globalThis.__readyKeyDeliveryProbe = state;
    return token;
  })()`).catch(() => '') || '')

  const releaseInputSequence = await retainTrustedInputSequence(controller, tabId)
  try {
  const staleBefore = await trustedInputPageDenied(controller, tabId)
  if (staleBefore) throw new TrustedPointerBlockedError(staleBefore)

  const modifierTriples: Array<{ key: string; code: string; vk: number; bit: number }> = [
    { key: 'Alt', code: 'AltLeft', vk: 18, bit: 1 },
    { key: 'Control', code: 'ControlLeft', vk: 17, bit: 2 },
    { key: 'Meta', code: 'MetaLeft', vk: 91, bit: 4 },
    { key: 'Shift', code: 'ShiftLeft', vk: 16, bit: 8 },
  ]

  let dispatchedKeys = 0
  const send = async (
    event: Parameters<BrowserController['dispatchKey']>[1],
  ): Promise<void> => {
    await dispatchTrustedKey(controller, tabId, event)
    dispatchedKeys += 1
  }

  try {
  for (const modifier of modifierTriples) {
    if ((mask & modifier.bit) !== modifier.bit) continue
    await send({
      type: 'keyDown',
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.vk,
      nativeVirtualKeyCode: modifier.vk,
      isKeypad: false,
      emulateFocus,
    })
  }

  await send({
    type: 'keyDown',
    key: keyLabel,
    code,
    windowsVirtualKeyCode: vk || undefined,
    nativeVirtualKeyCode: vk || undefined,
    text,
    modifiers: mask,
    isKeypad: false,
    unmodifiedText: text,
    emulateFocus,
  })
  await send({
    type: 'keyUp',
    key: keyLabel,
    code,
    windowsVirtualKeyCode: vk || undefined,
    nativeVirtualKeyCode: vk || undefined,
    modifiers: mask,
    isKeypad: false,
    emulateFocus,
  })

  for (let i = modifierTriples.length - 1; i >= 0; i -= 1) {
    const modifier = modifierTriples[i]
    if ((mask & modifier.bit) !== modifier.bit) continue
    await send({
      type: 'keyUp',
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.vk,
      nativeVirtualKeyCode: modifier.vk,
      isKeypad: false,
      emulateFocus,
    })
  }
  } catch (error) {
    if (error instanceof TrustedPointerBlockedError && dispatchedKeys > 0) {
      const data = error.output.data && typeof error.output.data === 'object'
        ? error.output.data as Record<string, unknown>
        : {}
      throw new TrustedPointerBlockedError(createBrowserStructuredOutput({
        ...data,
        ok: false,
        errorKind: String(data.errorKind || 'browser_reference_stale'),
        dispatchedKeys,
        dispatch: 'accepted',
        delivery: 'unknown',
        effect: 'unknown',
        mayHaveCommitted: true,
        needsObservation: true,
      }))
    }
    throw error
  }
  const deliveryCount = deliveryToken
    ? await controller.executeJS(tabId, `(() => {
        const state = globalThis.__readyKeyDeliveryProbe;
        if (!state || state.token !== ${JSON.stringify(deliveryToken)}) return null;
        if (typeof state.cleanup === 'function') state.cleanup();
        return Number(state.count || 0);
      })()`).catch(() => null)
    : null
  return typeof deliveryCount === 'number'
    ? deliveryCount > 0 ? 'delivered' : 'not_delivered'
    : 'unknown'
  } finally {
    releaseInputSequence()
  }
}

export async function clearFocusedInput(controller: BrowserController, tabId: string | null): Promise<void> {
  const releaseInputSequence = await retainTrustedInputSequence(controller, tabId)
  try {
  const selectAllMask = process.platform === 'darwin' ? 4 : 2
  await dispatchTrustedKey(controller, tabId, {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: selectAllMask,
    isKeypad: false,
    commands: process.platform === 'darwin' ? ['selectAll'] : undefined,
  })
  await dispatchTrustedKey(controller, tabId, {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: selectAllMask,
    isKeypad: false,
  })
  await dispatchTrustedKey(controller, tabId, {
    type: 'rawKeyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
    modifiers: 0,
    isKeypad: false,
    commands: process.platform === 'darwin' ? ['deleteBackward'] : undefined,
  })
  await dispatchTrustedKey(controller, tabId, {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
    modifiers: 0,
    isKeypad: false,
  })
  } finally {
    releaseInputSequence()
  }
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

export function buildSmartTypeProbeJs(options: {
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
        return [...new Set(attrs.map(normalize).filter(Boolean))]
      }

      const describe = (el, documentOrder) => {
        const fields = textFields(el)
        const rect = el.getBoundingClientRect()
        const capacity = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? Number(el.maxLength) : -1
        const multiline = el instanceof HTMLTextAreaElement || isRichEditable(el)
        const focused = document.activeElement === el
        let structuralScore = focused ? 40 : 0
        if (multiline && (text.includes('\\n') || text.length > 120)) structuralScore += 24
        const area = Math.max(1, rect.width * rect.height)
        structuralScore += Math.min(20, area / 18000)
        const fromBottom = Math.max(0, window.innerHeight - rect.bottom)
        structuralScore += Math.max(0, 8 - Math.min(8, fromBottom / 80))
        return {
          el,
          fields,
          label: fields[0] || '',
          rect,
          capacity,
          multiline,
          focused,
          structuralScore,
          documentOrder,
          tag: String(el.tagName || '').toLowerCase(),
          role: String(el.getAttribute('role') || '').toLowerCase(),
          targetName: String(el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('aria-label') || el.tagName || ''),
        }
      }

      const described = candidates
        .map((el, index) => describe(el, index))
        .filter((candidate) => {
          if (candidate.capacity > 0 && text.length > candidate.capacity) return false
          if (!candidate.multiline && text.includes('\\n')) return false
          return true
        })

      const publicCandidate = (candidate) => ({
        label: candidate.label,
        target: candidate.targetName,
        tag: candidate.tag,
        role: candidate.role,
        focused: candidate.focused,
        multiline: candidate.multiline,
        maxLength: candidate.capacity > 0 ? candidate.capacity : null,
      })
      const rankedCandidates = [...described].sort((a, b) =>
        Number(b.focused) - Number(a.focused) ||
        b.structuralScore - a.structuralScore ||
        a.documentOrder - b.documentOrder
      )

      if (rankedCandidates.length === 0) {
        return JSON.stringify({
          ok: false,
          errorKind: 'input_target_incompatible',
          target,
          candidates: candidates.map((el, index) => publicCandidate(describe(el, index))).slice(0, 8),
        })
      }

      const matchRank = (candidate) => {
        if (!target) return { tier: 0, tokenHits: 0 }
        if (candidate.fields.some((field) => field === target)) return { tier: 3, tokenHits: targetTokens.length }
        if (candidate.fields.some((field) => field.includes(target))) return { tier: 2, tokenHits: targetTokens.length }
        const merged = candidate.fields.join(' ')
        const tokenHits = targetTokens.filter((token) => merged.includes(token)).length
        return { tier: tokenHits > 0 ? 1 : 0, tokenHits }
      }

      let best = null
      if (rankedCandidates.length === 1) {
        best = rankedCandidates[0]
      } else if (target) {
        const matched = rankedCandidates
          .map((candidate) => ({ candidate, ...matchRank(candidate) }))
          .filter((item) => item.tier > 0)
        const bestTier = Math.max(0, ...matched.map((item) => item.tier))
        const bestTokenHits = Math.max(0, ...matched.filter((item) => item.tier === bestTier).map((item) => item.tokenHits))
        const strongest = matched.filter((item) => item.tier === bestTier && item.tokenHits === bestTokenHits)
        if (strongest.length === 1) {
          best = strongest[0].candidate
        } else if (strongest.length > 1) {
          const focused = strongest.filter((item) => item.candidate.focused)
          if (focused.length === 1) best = focused[0].candidate
        }
      } else {
        const focused = rankedCandidates.filter((candidate) => candidate.focused)
        if (focused.length === 1) best = focused[0]
      }

      if (!best) {
        return JSON.stringify({
          ok: false,
          errorKind: 'ambiguous_input_target',
          target,
          candidates: rankedCandidates.map(publicCandidate).slice(0, 8),
        })
      }

      // The scorer may have resolved a structural password or file input that
      // the arguments never named.
      const __readyGuard = readyInputGuard(best.el)
      if (__readyGuard) return __readyGuard

      const rect = best.rect
      return {
        ok: rect.width > 0 && rect.height > 0,
        target: best.targetName,
        score: best.structuralScore,
        inputType: best.el instanceof HTMLInputElement ? String(best.el.type || 'text').toLowerCase() : '',
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: Number(window.innerWidth || 0),
        height: Number(window.innerHeight || 0)
      }
    })()
  `
}
