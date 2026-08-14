import { createHash } from 'node:crypto'
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { BrowserMutationBoundary } from './browser-action-executor'
import type { BrowserPowerEffect } from '../../../shared/browser-power'
import { type BrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import { createRotatingLogger } from '../../utils/rotating-logger'
import { parseTargetId } from '../browser-engine/agent-browser-page-map'
import type { BrowserTargetFingerprint } from '../browser-engine/agent-browser-page-map'
import { browserSnapshotService } from '../browser-engine/browser-snapshot-service'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import {
  buildBrowserTargetFormSubmitJs,
  buildBrowserActionDeltaJs,
  buildTransientNoticeProbeJs,
  callBrowserBackendTarget,
} from './browser-probe'
import { sleepWithAbort, throwIfAborted, waitForReady } from './browser-input-actions'
import { activeBrowserToolUrl, type BrowserActionFollowedTab } from './browser-tool-shared'

const logger = createRotatingLogger('ready-tools.log', { buffered: true })
export function logBrowserAct(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* silent-catch: 日志写入失败不影响主流程。 */ }
}

export async function retainCompositeTrustedInputSequence(
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

export function browserActionResultSucceeded(result: string | ToolExecutionOutput): boolean {
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

export function targetFingerprint(value: unknown): BrowserTargetFingerprint | null {
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

export function sameTargetFingerprint(captured: unknown, live: unknown): boolean {
  const before = targetFingerprint(captured)
  const after = targetFingerprint(live)
  if (!before || !after) return false
  return JSON.stringify(before) === JSON.stringify(after)
}

export function snapshotBrowserTabs(controller: BrowserController): BrowserToolTabSnapshot[] {
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

export async function frameViewportOffset(
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

export async function normalizedTargetPoint(
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

export function pickFollowedBrowserTab(
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

export async function waitForActionFollowedTab(
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

export function didBrowserActionChange(before: unknown, after: unknown): boolean {
  if (before === null || after === null || before === undefined || after === undefined) return false
  try {
    return JSON.stringify(before) !== JSON.stringify(after)
  } catch {
    // silent-catch: 序列化失败按“已变化”保守处理。
    return true
  }
}

export async function readBrowserActionDeltaBestEffort(
  controller: BrowserController,
  tabId: string | null,
  phase: 'before' | 'after',
): Promise<unknown> {
  try {
    return await controller.executeJS(tabId, buildBrowserActionDeltaJs())
  } catch (error) {
    logBrowserAct(`browser action delta ${phase} readback failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * R18（真机第十七轮实锚）：delta bodyText 只取前 1000 字符，body 末尾的
 * 瞬时校验 toast 完全不可见——"点了没变化"里可能藏着页面已给出的拒绝理由。
 * 点击判无效后补读一次可见提示层，机械采集，失败按无提示处理。
 */
export async function readTransientPageNotices(
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

export interface BrowserActToolContext {
  controller: BrowserController
  abortSignal?: AbortSignal
  sessionId?: string
  messageVisibilityEpoch?: number
  mutationBoundary: BrowserMutationBoundary
  agentOwnedWorkTab?: { browserTaskId: string } | null
  requestPowerConfirmation?: (details: {
    toolName: string
    effects: BrowserPowerEffect[]
    purpose: string
    origin: string | null
    objectRef: string
    inputHash: string
  }) => Promise<boolean>
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
  invokeNested?: (operation: string, input: Record<string, unknown>) => Promise<string | ToolExecutionOutput>
  trustedPageRef?: {
    tabId: string
    physicalTargetToken: string
    mainFrameDocumentToken: string
  } | null
}
export function trustedPointerExpected(
  ctx: BrowserActToolContext,
  tabId: string | null,
): { physicalTargetToken: string; mainFrameDocumentToken: string } | null {
  const ref = ctx.trustedPageRef
  if (!ref || (tabId && ref.tabId !== tabId)) return null
  return {
    physicalTargetToken: ref.physicalTargetToken,
    mainFrameDocumentToken: ref.mainFrameDocumentToken,
  }
}

export async function confirmLivePasswordFill(
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

export async function invokeTargetFormSubmit(
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

export async function submitResolvedTargetForm(
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

