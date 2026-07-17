/**
 * P3 Phase B6（2026-07-05，纯移动拆分）— browser-tools 观察/感知组。
 *
 * 从 browser-tools.ts 逐字搬出十二个 case 的实现体（browser_tabs /
 * browser_read / browser_snapshot / browser_snapshot /
 * browser_screenshot / browser_status /
 * browser_find / browser_find /
 * browser_screenshot / browser_wait / browser_wait /
 * browser_wait 等入口，经 executeBrowserObserveTool 统一入口分发）与本组
 * 独占 helper（页面地图 generation/ambiguity 单例、captureAgentPageMap 与
 * settle-retry 感知面、截图缓存、workflow 状态探针、输入/发送目标排序）。
 * 页面地图状态随组迁移并导出，留守的 browser_click/browser_type 改从本模块
 * import 回读（facade→observe 单向）。attachBrowserActionSessionOutput
 * （sitePermissionNotices 排空合同红线）留在 browser-tools，经
 * BrowserObserveToolContext 注入回接；resolveToolContextMeta / getPageIdentity /
 * locateActionTargets / listSubframesSafe / uniqueStrings /
 * browserStructuredErrorOutput 因留守 case 同时使用而移入
 * browser-tool-shared.ts。本模块零反向 import。行为零变更。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import { BrowserAgentRuntimeAdapter } from '../browser-engine/agent-runtime-adapter'
import { BrowserPageStateService } from '../browser-engine/page-state-service'
import { BrowserEvidenceService } from '../browser-engine/evidence-service'
import { createRotatingLogger } from '../../utils/rotating-logger'
import { analyzeViewportWithVision } from './browser-vision'
import {
  buildBrowserReadonlyProbeJs,
  normalizeBrowserReadonlyProbeRequest,
} from '../../../shared/browser-readonly-probe'
import { agentBrowserError } from '../browser-engine/agent-browser-errors'
import type { BrowserTransactionConfirmation } from '../browser-engine/browser-action-session'
import { buildPageMap, parseTargetId, type PageMap, type RawAxNode } from '../browser-engine/agent-browser-page-map'
import { browserSnapshotService } from '../browser-engine/browser-snapshot-service'
import {
  getBrowserPageMapAmbiguity,
  rememberBrowserPageMapAmbiguity as rememberAmbiguity,
  resetBrowserPageMapAmbiguityForTests,
} from '../browser-engine/browser-page-map-ambiguity-cache'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import {
  createBrowserStructuredOutput as browserStructuredOutput,
  stringifyBrowserJsonOrFailure,
} from './browser-failure-output'
import { buildBrowserPageMapProbeJs, buildBrowserTargetReadJs } from './browser-probe'
import { waitForReady } from './browser-input-actions'
import {
  browserStructuredErrorOutput,
  getPageIdentity,
  listSubframesSafe,
  locateActionTargets,
  resolveHighControlAgentTab,
  resolveToolContextMeta,
  truncate,
  uniqueStrings,
  type ActionTargetCandidate,
} from './browser-tool-shared'

const logger = createRotatingLogger('ready-tools.log', { buffered: true })
function log(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* silent-catch: 日志写入失败不影响主流程。 */ }
}

export const __breaksInvariants = [
  'test-only browser page-map singleton reset mutates shared browser tool state',
]

export function __resetBrowserAgentPageMapForTests(): void {
  browserSnapshotService.resetForTests()
  resetBrowserPageMapAmbiguityForTests()
}

function resolveBrowserToolTabKey(controller: BrowserController, tabId: string | null): string {
  return tabId || controller.getActiveTab?.()?.id || '__active__'
}

function strictReadMaxChars(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(200_000, Math.floor(parsed)))
    : 20_000
}

function fitReadContent(value: unknown, maxChars: number): string {
  return String(value ?? '').slice(0, maxChars)
}

function scopedReadProbeJs(selector: string): string {
  return `(() => {
    try {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      if (nodes.length !== 1) return { matchCount: nodes.length, content: '' };
      const el = nodes[0];
      const chunks = [
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
          ? String(el.value || '')
          : '',
        String(el.innerText || ''),
        String(el.textContent || ''),
        String(el.getAttribute('aria-label') || ''),
      ].map((value) => value.replace(/\\s+/g, ' ').trim()).filter(Boolean);
      return { matchCount: 1, content: Array.from(new Set(chunks)).join('\\n') };
    } catch (error) {
      return { matchCount: 0, content: '', invalidSelector: true, message: String(error && error.message || error) };
    }
  })()`
}

export function currentBrowserPageMapGeneration(controller: BrowserController, tabId: string | null): number | null {
  return browserSnapshotService.currentState(controller, tabId)?.snapshotRevision ?? null
}

function rememberBrowserPageMapAmbiguity(
  controller: BrowserController,
  tabId: string | null,
  groups: Array<{ role: string; name: string; targetIds: string[] }>,
): void {
  rememberAmbiguity(resolveBrowserToolTabKey(controller, tabId), groups)
}

export function currentBrowserPageMapAmbiguity(
  controller: BrowserController,
  tabId: string | null,
  targetId: string,
): { role: string; name: string; targetIds: string[] } | null {
  return getBrowserPageMapAmbiguity(resolveBrowserToolTabKey(controller, tabId), targetId)
}

function buildPageMapAmbiguityGroups(targets: PageMap['targets']): Array<{ role: string; name: string; targetIds: string[] }> {
  const groups = new Map<string, { role: string; name: string; targetIds: string[] }>()
  for (const target of targets) {
    const name = String(target.name || '').trim()
    if (!name) continue
    const key = `${target.role}::${name.toLowerCase()}`
    const group = groups.get(key) || { role: target.role, name, targetIds: [] }
    group.targetIds.push(target.targetId)
    groups.set(key, group)
  }
  return Array.from(groups.values()).filter((group) => group.targetIds.length > 1)
}

/**
 * 2026-07-03 真机回归 R1 根因修复：page_map 默认体量预算。此前 model 不传
 * max_bytes 时 map 不限量——小红书发布编辑器单次 ~27k token，触发 presend
 * 单结果截断后模型信息真空。32KB（钳制区间内）≈8-11k token，留足两次读。
 */
export const DEFAULT_AGENT_PAGE_MAP_MAX_BYTES = 16_384

export async function captureAgentPageMap(
  controller: BrowserController,
  tabId: string | null,
  maxBytes?: number,
  options: { force?: boolean } = {},
): Promise<Record<string, unknown>> {
  const budget = maxBytes || DEFAULT_AGENT_PAGE_MAP_MAX_BYTES
  const payload = await browserSnapshotService.capture(controller, tabId, budget, async (generation) => {
    const raw = await controller.executeJS(tabId, buildBrowserPageMapProbeJs()) as {
    identity?: { url?: string; title?: string }
    viewport?: { width?: number; height?: number }
    bodyText?: string
    rawRoots?: RawAxNode[]
    riskFlags?: Record<string, unknown>
    structureHints?: Record<string, unknown>
    } | null
    const viewport = {
      width: Number(raw?.viewport?.width || 0) || 0,
      height: Number(raw?.viewport?.height || 0) || 0,
    }
  // D10 frame 穿透：主帧 probe 后逐子帧补采，目标打上 frameKey（进 targetId
  // 的 frameId 槽位，act 侧按它路由回同一帧执行）。单帧失败不阻断整图。
    const rawRoots: RawAxNode[] = Array.isArray(raw?.rawRoots) ? raw.rawRoots : []
    const mappedFrames: Array<{ frameKey: string; url: string; targetCount: number }> = []
    if (typeof controller.executeJSInFrame === 'function') {
      for (const frame of listSubframesSafe(controller, tabId)) {
        try {
          const frameRaw = await controller.executeJSInFrame(tabId, frame.frameKey, buildBrowserPageMapProbeJs()) as {
            rawRoots?: RawAxNode[]
          } | null
          const children = Array.isArray(frameRaw?.rawRoots?.[0]?.children) ? frameRaw.rawRoots[0].children : []
          if (children.length === 0) continue
          for (const child of children) child.frameId = frame.frameKey
          rawRoots.push({ role: 'iframe', name: frame.url.slice(0, 120), frameId: frame.frameKey, children })
          mappedFrames.push({ frameKey: frame.frameKey, url: frame.url.slice(0, 200), targetCount: children.length })
        } catch (error) {
          log(`page map subframe probe failed (${frame.frameKey}): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    // Text receives half of the unified snapshot budget. The snapshot service
    // spends the remainder on compact target metadata and keeps the complete
    // target set private for cached browser_find queries.
    const pageMap = buildPageMap(rawRoots, {
      generation,
      viewport,
      maxBytes: Math.max(512, Math.floor(budget * 0.5)),
    })
    return {
      pageIdentity: {
        url: String(raw?.identity?.url || ''),
        title: String(raw?.identity?.title || ''),
        generation,
        capturedAt: new Date().toISOString(),
      },
      summary: {
        bodyText: String(raw?.bodyText || '').slice(0, 1000),
        targetCount: pageMap.targets.length,
        truncated: pageMap.truncated,
      },
      pageMap: {
        ...pageMap,
        structureHints: raw?.structureHints || { iframes: [], shadowRoots: [], hiddenLoaded: [] },
      },
      riskFlags: raw?.riskFlags || {},
      evidence: {
        generation,
        targetSource: 'dom-target-library',
        targetCount: pageMap.targets.length,
        truncated: pageMap.truncated,
        ...(mappedFrames.length > 0 ? { frames: mappedFrames } : {}),
      },
      nextAllowedActions: ['click or type by target reference', 'wait', 'stop with reason'],
    }
  }, options)
  const transformedMap = payload.pageMap as PageMap
  const ambiguityGroups = buildPageMapAmbiguityGroups(transformedMap.targets)
  payload.ambiguityGroups = ambiguityGroups
  rememberBrowserPageMapAmbiguity(controller, tabId, ambiguityGroups)
  return payload
}

function createBrowserAgentHelpers(controller: BrowserController) {
  const runtime = new BrowserAgentRuntimeAdapter(controller)
  const pageStateService = new BrowserPageStateService(runtime)
  const evidenceService = new BrowserEvidenceService()
  return { runtime, pageStateService, evidenceService }
}

interface WorkflowUploadProbe {
  complete: boolean
  evidence: string[]
  inputHasFiles: boolean
  previewVisible: boolean
  attachmentNameMatched: boolean
  removeActionVisible: boolean
}

interface WorkflowDomStateProbe {
  inputCandidateCount: number
  sendCandidateCount: number
  uploadCandidateCount: number
  modalVisible: boolean
  bodyStateText: string
}

interface WorkflowPromptSubmissionProbe {
  promptMatched: boolean
  promptFilled: boolean
  promptText: string
  generating: boolean
  submitEvidence: string[]
  sendButtonCount: number
  sendButtonDisabled: boolean
  uploadChipVisible: boolean
}

async function probeWorkflowUploadState(
  controller: BrowserController,
  tabId: string | null,
  attachmentName?: string,
): Promise<WorkflowUploadProbe> {
  const safeName = String(attachmentName || '').trim()
  const basename = safeName.replace(/\.[a-z0-9]{1,8}$/i, '').toLowerCase()
  const result = await controller.executeJS(
    tabId,
    `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width < 12 || rect.height < 12) return false
        const style = getComputedStyle(el)
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false
        return Number(style.opacity || '1') > 0
      }
      const attachmentNeedle = ${JSON.stringify(basename)}
      const bodyText = normalize(document.body?.innerText || '')
      const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter((node) => node instanceof HTMLInputElement)
      const inputHasFiles = fileInputs.some((node) => node.files && node.files.length > 0)
      const viewportW = Math.max(1, window.innerWidth || 0)
      const viewportH = Math.max(1, window.innerHeight || 0)
      const previewNodes = Array.from(document.querySelectorAll('img,video,[role="img"],canvas,.thumbnail,[class*="thumb"],[class*="preview"],[data-testid*="upload" i],[data-testid*="preview" i]'))
        .filter((node) => visible(node))
      const removeNodes = Array.from(document.querySelectorAll('button,[role="button"],span,div,a'))
        .filter((node) => visible(node))
        .map((node) => normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || ''))
        .filter((text) => /remove|delete|clear|close|移除|删除|清除|取消|×|x/.test(text))
      const uploadMarkers = /upload|uploaded|preview|thumbnail|附件|参考图|素材|已上传|原图|参考/.test(bodyText)
      const attachmentNameMatched = Boolean(attachmentNeedle && bodyText.includes(attachmentNeedle))
      const previewVisible = previewNodes.some((node) => {
        if (!(node instanceof HTMLElement)) return false
        const rect = node.getBoundingClientRect()
        const meta = normalize([
          node.getAttribute?.('aria-label'),
          node.getAttribute?.('title'),
          node.getAttribute?.('data-testid'),
          node.getAttribute?.('class'),
          node.textContent,
        ].filter(Boolean).join(' '))
        const looksLikeNamedPreview = !attachmentNeedle || meta.includes(attachmentNeedle) || /preview|thumbnail|附件|已上传|upload|参考图|素材/.test(meta)
        const smallPreviewCluster =
          rect.width >= 24 &&
          rect.height >= 24 &&
          rect.width <= Math.min(220, viewportW * 0.28) &&
          rect.height <= Math.min(220, viewportH * 0.28) &&
          rect.top >= viewportH * 0.55
        return looksLikeNamedPreview || smallPreviewCluster || uploadMarkers || removeNodes.length > 0
      })
      const evidence = []
      if (inputHasFiles) evidence.push('file_input_has_files')
      if (attachmentNameMatched) evidence.push('attachment_name_visible')
      if (previewVisible) evidence.push('preview_or_chip_visible')
      if (removeNodes.length > 0) evidence.push('remove_action_visible')
      return {
        complete: Boolean(inputHasFiles || attachmentNameMatched || previewVisible),
        evidence,
        inputHasFiles,
        previewVisible,
        attachmentNameMatched,
        removeActionVisible: removeNodes.length > 0,
      }
    })()`,
  ) as WorkflowUploadProbe | null

  return {
    complete: Boolean(result?.complete),
    evidence: Array.isArray(result?.evidence) ? result.evidence : [],
    inputHasFiles: Boolean(result?.inputHasFiles),
    previewVisible: Boolean(result?.previewVisible),
    attachmentNameMatched: Boolean(result?.attachmentNameMatched),
    removeActionVisible: Boolean(result?.removeActionVisible),
  }
}

async function probeWorkflowDomState(
  controller: BrowserController,
  tabId: string | null,
): Promise<WorkflowDomStateProbe> {
  const result = await controller.executeJS(
    tabId,
    `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width < 10 || rect.height < 10) return false
        const style = getComputedStyle(el)
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false
        return Number(style.opacity || '1') > 0
      }
      const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"],[role="searchbox"]'))
        .filter((node) => visible(node))
      const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],label,[tabindex]'))
        .filter((node) => visible(node))
      const sendCandidateCount = buttons.filter((node) => {
        const meta = normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.getAttribute?.('data-testid') || node.getAttribute?.('class') || '')
        return /send|提交|发送|继续|generate|生成|创作|run|go|发布/.test(meta)
      }).length
      const uploadCandidateCount = buttons.filter((node) => {
        const meta = normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.getAttribute?.('data-testid') || node.getAttribute?.('class') || '')
        return /upload|上传|附件|图片|素材|参考图|file|image|plus|add|导入|拖拽/.test(meta)
      }).length
      const modalVisible = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog,.modal,.drawer,.popup'))
        .some((node) => visible(node))
      const bodyStateText = normalize(document.body?.innerText || '').slice(0, 1200)
      return {
        inputCandidateCount: editables.length,
        sendCandidateCount,
        uploadCandidateCount,
        modalVisible,
        bodyStateText,
      }
    })()`,
  ) as WorkflowDomStateProbe | null

  return {
    inputCandidateCount: Number(result?.inputCandidateCount || 0),
    sendCandidateCount: Number(result?.sendCandidateCount || 0),
    uploadCandidateCount: Number(result?.uploadCandidateCount || 0),
    modalVisible: Boolean(result?.modalVisible),
    bodyStateText: String(result?.bodyStateText || ''),
  }
}

async function probeWorkflowPromptSubmissionState(
  controller: BrowserController,
  tabId: string | null,
  expectedPrompt: string,
): Promise<WorkflowPromptSubmissionProbe> {
  const result = await controller.executeJS(
    tabId,
    `(() => {
      const expected = ${JSON.stringify(String(expectedPrompt || '').trim().toLowerCase())}
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (!rect || rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false
        return true
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
        if (el.getAttribute('aria-disabled') === 'true') return false
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.disabled || el.readOnly) return false
        }
        return visible(el)
      }
      const editableText = (el) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return String(el.value || '')
        return String(el.innerText || el.textContent || '')
      }
      const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="searchbox"]'))
        .filter(isEditable)
      const promptCandidate = editables
        .map((el) => {
          const meta = normalize([
            el.getAttribute('placeholder'),
            el.getAttribute('aria-label'),
            el.getAttribute('name'),
            el.getAttribute('id'),
            el.getAttribute('title'),
            el.getAttribute('data-testid'),
            el.getAttribute('class'),
          ].filter(Boolean).join(' '))
          const rect = el.getBoundingClientRect()
          let score = 0
          if (/prompt|提示|文案|描述|输入|message|chat|ask|生成|创作|内容/.test(meta)) score += 12
          if (el.tagName.toLowerCase() === 'textarea') score += 4
          if ((el instanceof HTMLElement) && el.isContentEditable) score += 3
          if (rect.bottom > window.innerHeight * 0.45) score += 3
          if (rect.width > window.innerWidth * 0.25) score += 2
          if (/时间|生成类型|操作类型|筛选|排序|search|搜索/.test(meta)) score -= 14
          if (rect.top < window.innerHeight * 0.38) score -= 8
          return { text: editableText(el), score }
        })
        .filter((item) => item.score >= 2)
        .sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0]

      const promptText = normalize(promptCandidate?.text || '')
      const promptMatched =
        Boolean(expected) &&
        promptText.length >= Math.min(Math.max(12, Math.floor(expected.length * 0.4)), expected.length) &&
        (promptText === expected || promptText.includes(expected) || expected.includes(promptText))
      const promptFilled = Boolean(promptText)
      const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'))
        .filter(visible)
        .map((el) => {
          const meta = normalize([
            el.textContent,
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('data-testid'),
            el.getAttribute('class'),
          ].filter(Boolean).join(' '))
          const disabled =
            (el instanceof HTMLButtonElement && el.disabled) ||
            (el instanceof HTMLInputElement && el.disabled) ||
            el.getAttribute('aria-disabled') === 'true'
          return { meta, disabled }
        })
      const sendButtons = buttons.filter((item) => /send|发送|提交|发布|继续|go|run|submit|generate|generating|生成|创作|开始/.test(item.meta))
      const sendButtonCount = sendButtons.length
      const sendButtonDisabled = sendButtons.length > 0 && sendButtons.every((item) => item.disabled)
      const bodyText = normalize(document.body?.innerText || '')
      const uploadChipVisible = /已上传|upload|preview|thumbnail|附件/.test(bodyText) && /remove|delete|移除|删除|清除/.test(bodyText)
      const submitEvidence = []
      if (/thinking|正在思考|思考中|生成中|creating|generating|uploading|上传中|处理中|responding|排队中/.test(bodyText)) {
        submitEvidence.push('page_processing_state')
      }
      return {
        promptMatched,
        promptFilled,
        promptText,
        generating: submitEvidence.length > 0,
        submitEvidence,
        sendButtonCount,
        sendButtonDisabled,
        uploadChipVisible,
      }
    })()`,
  ) as WorkflowPromptSubmissionProbe | null

  return {
    promptMatched: Boolean(result?.promptMatched),
    promptFilled: Boolean(result?.promptFilled),
    promptText: String(result?.promptText || ''),
    generating: Boolean(result?.generating),
    submitEvidence: Array.isArray(result?.submitEvidence) ? result.submitEvidence : [],
    sendButtonCount: Number(result?.sendButtonCount || 0),
    sendButtonDisabled: Boolean(result?.sendButtonDisabled),
    uploadChipVisible: Boolean(result?.uploadChipVisible),
  }
}

function pickActiveInputTarget(targets: ActionTargetCandidate[]): ActionTargetCandidate | null {
  const focusedTargets = targets.filter((item) => item.focused)
  if (focusedTargets.length === 0) return null
  return [...focusedTargets].sort((a, b) =>
    Number(b.confidence || 0) - Number(a.confidence || 0) ||
    Number(b.textLength || 0) - Number(a.textLength || 0)
  )[0] || null
}

function rankTargetsNearAnchor(
  targets: ActionTargetCandidate[],
  anchor: ActionTargetCandidate | null,
): ActionTargetCandidate[] {
  const anchorX = Number(anchor?.x)
  const anchorY = Number(anchor?.y)
  if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) {
    return [...targets].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
  }

  return [...targets]
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    .map((item) => {
      const dx = Number(item.x) - anchorX
      const dy = Number(item.y) - anchorY
      const distance = Math.round(Math.hypot(dx, dy))
      const nearAnchor =
        Boolean(item.nearActiveInput) ||
        (dx >= -140 && dx <= 260 && dy >= -80 && dy <= 220) ||
        distance <= 280 ||
        (Number(item.x) >= 760 && Number(item.y) >= 700)
      return {
        ...item,
        nearActiveInput: nearAnchor,
        distanceToActiveInput: Number.isFinite(item.distanceToActiveInput)
          ? Number(item.distanceToActiveInput)
          : distance,
      }
    })
    .sort((a, b) =>
      Number(Boolean(b.nearActiveInput)) - Number(Boolean(a.nearActiveInput)) ||
      Number(b.confidence || 0) - Number(a.confidence || 0) ||
      Number(a.distanceToActiveInput ?? Number.POSITIVE_INFINITY) - Number(b.distanceToActiveInput ?? Number.POSITIVE_INFINITY)
    )
}

/**
 * B6 注入面：attachBrowserActionSessionOutput（sitePermissionNotices 排空
 * 合同红线）的实现体留在 browser-tools.ts，以函数引用注入。本模块不反向
 * import browser-tools，防循环依赖。
 */
export interface BrowserObserveToolContext {
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
      frameId?: string | null
      confirmation?: BrowserTransactionConfirmation | null
      nextSuggestedAction?: string | null
    },
  ) => string | ToolExecutionOutput
}

export async function executeBrowserObserveTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserObserveToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId, currentUserText, attachBrowserActionSessionOutput } = ctx
  switch (toolName) {
      case 'tabs_list': {
        const tabs = controller.getTabList() as Array<ReturnType<BrowserController['getTabList']>[number] & {
          openerTabId?: string | null
        }>
        if (tabs.length === 0) return 'No tabs open.'
        const byId = new Map(tabs.map((tab) => [tab.id, tab]))
        const rootTabId = (tabId: string): string => {
          const seen = new Set<string>()
          let current = byId.get(tabId)
          while (current?.openerTabId && byId.has(current.openerTabId) && !seen.has(current.openerTabId)) {
            seen.add(current.id)
            current = byId.get(current.openerTabId)
          }
          return current?.id || tabId
        }
        const workflow = (controller as unknown as {
          getActiveForegroundBrowserWorkflowSession?: () => {
            runId: string
            taskId: string
            lane: string
            boundTabId: string
            sourceUserTabId: string | null
            status: string
          } | null
        }).getActiveForegroundBrowserWorkflowSession?.() || null
        const leaseSnapshot = (controller as unknown as {
          getBrowserLeaseSnapshot?: () => {
            surfaces?: Record<string, {
              state?: string
              heldBy?: string | null
              runId?: string | null
              tabId?: string | null
              leaseId?: string | null
            }>
          }
        }).getBrowserLeaseSnapshot?.() || null
        return browserStructuredOutput({
          ok: true,
          activeTabId: tabs.find((tab) => tab.active)?.id || null,
          tabs: tabs.map((tab) => {
            const bindings: Record<string, unknown>[] = []
            if (workflow?.boundTabId === tab.id) {
              bindings.push({
                kind: 'foreground_workflow',
                runId: workflow.runId,
                taskId: workflow.taskId,
                lane: workflow.lane,
                status: workflow.status,
                sourceUserTabId: workflow.sourceUserTabId,
              })
            }
            for (const [surface, lease] of Object.entries(leaseSnapshot?.surfaces || {})) {
              if (lease.tabId !== tab.id || lease.state === 'idle') continue
              bindings.push({
                kind: 'write_lease',
                surface,
                state: lease.state,
                taskId: lease.heldBy || null,
                runId: lease.runId || null,
                leaseId: lease.leaseId || null,
              })
            }
            return {
              ...tab,
              openerTabId: tab.openerTabId || null,
              rootTabId: rootTabId(tab.id),
              workflowBindings: bindings,
            }
          }),
        })
      }

      case 'read': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const maxChars = strictReadMaxChars(args.max_chars)
        const targetId = typeof args.target_id === 'string' ? args.target_id.trim() : ''
        const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
        if (targetId && selector) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'invalid_scope',
            message: 'target_id and selector are mutually exclusive',
          })
        }
        if (targetId) {
          const resolved = await browserSnapshotService.resolveRef(controller, tabId, targetId)
          if (!resolved.ok) {
            return browserStructuredOutput({
              ok: false,
              errorKind: resolved.errorCode === 'stale_document' || resolved.errorCode === 'stale_snapshot'
                ? 'target_stale'
                : resolved.errorCode === 'wrong_tab'
                  ? 'target_wrong_tab'
                  : 'target_not_found',
              reason: resolved.errorCode,
              targetId,
              currentDocumentEpoch: resolved.currentDocumentEpoch,
              currentSnapshotRevision: resolved.currentSnapshotRevision,
            })
          }
          const parsed = parseTargetId(resolved.rawTargetId)
          if (!parsed) {
            return browserStructuredOutput({ ok: false, errorKind: 'target_not_found', targetId })
          }
          let probe: unknown
          try {
            probe = parsed.frameId === '0'
              ? await controller.executeJS(tabId, buildBrowserTargetReadJs(parsed.node))
              : typeof controller.executeJSInFrame === 'function'
                ? await controller.executeJSInFrame(tabId, parsed.frameId, buildBrowserTargetReadJs(parsed.node))
                : null
          } catch (error) {
            // silent-catch: the structured stale-target result below carries the failure to the caller.
            return browserStructuredOutput({
              ok: false,
              errorKind: 'target_stale',
              targetId,
              message: error instanceof Error ? error.message : String(error),
            })
          }
          const record = probe && typeof probe === 'object' ? probe as Record<string, unknown> : {}
          if (Number(record.matchCount || 0) !== 1) {
            return browserStructuredOutput({ ok: false, errorKind: 'target_stale', targetId })
          }
          return fitReadContent(record.content, maxChars)
        }
        if (selector) {
          const probe = await controller.executeJS(tabId, scopedReadProbeJs(selector))
          const record = probe && typeof probe === 'object' ? probe as Record<string, unknown> : {}
          if (record.invalidSelector === true) {
            return browserStructuredOutput({
              ok: false,
              errorKind: 'invalid_selector',
              selector,
              message: String(record.message || 'Invalid selector'),
            })
          }
          const matchCount = Number(record.matchCount || 0)
          if (matchCount === 0) {
            return browserStructuredOutput({ ok: false, errorKind: 'target_not_found', selector })
          }
          if (matchCount > 1) {
            return browserStructuredOutput({ ok: false, errorKind: 'target_ambiguous', selector, matchCount })
          }
          return fitReadContent(record.content, maxChars)
        }
        const content = await controller.getPageContent(tabId)
        if (!content || content.trim().length === 0) {
          return fitReadContent('Page content is empty or still loading.', maxChars)
        }
        return fitReadContent(content, maxChars)
      }

      case 'snapshot': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const maxBytes = typeof args.max_bytes === 'number'
          ? Math.max(1024, Math.min(65_536, args.max_bytes))
          : DEFAULT_AGENT_PAGE_MAP_MAX_BYTES
        let payload = await captureAgentPageMap(controller, tabId, maxBytes)
        // D12（真机第五轮实锚）：navigate 后立即 read map 常撞上 SPA 未渲染完
        // （目标数异常少），弱模型会因此直接放弃。工具层兜一次 settle 重试，
        // 把"先等再读"的纪律下沉为工具合同。重试后必须返回最新捕获——
        // generation 已递增，返回旧图会让后续 act 全部撞 stale_page_map。
        const firstTargetCount = Array.isArray((payload.pageMap as { targets?: unknown[] } | undefined)?.targets)
          ? ((payload.pageMap as { targets: unknown[] }).targets.length)
          : 0
        if (firstTargetCount < 5) {
          await waitForReady(controller, tabId, 3000, undefined, abortSignal)
          payload = await captureAgentPageMap(controller, tabId, maxBytes, { force: true })
          payload.evidence = {
            ...(payload.evidence as Record<string, unknown>),
            settleRetried: true,
            firstAttemptTargetCount: firstTargetCount,
          }
        }
        {
          // 观测锚：map 结果概要落日志——真机诊断两轮都因看不到工具返回
          // 内容而只能排除法推根因，这一行让下一轮直接读到感知面实况。
          const mapSummary = payload.pageMap as { targets?: unknown[]; truncated?: boolean } | undefined
          const evidenceSummary = payload.evidence as { frames?: unknown[]; settleRetried?: boolean } | undefined
          log(`read_page_map result: targets=${Array.isArray(mapSummary?.targets) ? mapSummary.targets.length : 0} truncated=${mapSummary?.truncated === true} frames=${Array.isArray(evidenceSummary?.frames) ? evidenceSummary.frames.length : 0} settleRetried=${evidenceSummary?.settleRetried === true} maxBytes=${maxBytes}`)
        }
        return attachBrowserActionSessionOutput(JSON.stringify(payload, null, 2), {
          toolName,
          args,
          controller,
          sessionId,
          currentUserText,
          tabId,
          // D10-c 后 iframe 内容已直接并入本图（evidence.frames），不再
          // 引导 Power CDP 探测——那条建议曾被投影成任务卡假步骤（D11）
          // 且把模型带进被拒的 power 通道。
          nextSuggestedAction: 'act on target or continue reading map',
        })
      }

      case 'find': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const limit = Math.max(1, Math.min(100, Number(args.limit || 20)))
        const payload = await captureAgentPageMap(controller, tabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES)
        const found = browserSnapshotService.find(controller, tabId, {
          query: String(args.query || ''),
          role: String(args.role || ''),
          cursor: Number(args.cursor || 0),
          limit,
        })
        return browserStructuredOutput({
          ok: true,
          pageIdentity: payload.pageIdentity,
          matches: found?.matches || [],
          count: found?.matches.length || 0,
          total: found?.total || 0,
          cursor: found?.cursor || 0,
          nextCursor: found?.nextCursor || null,
        })
      }

      case 'snapshot_probe': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const requestedGeneration = Number(args.generation)
        const currentGeneration = currentBrowserPageMapGeneration(controller, tabId)
        if (!Number.isFinite(requestedGeneration) || requestedGeneration <= 0) {
          return browserStructuredErrorOutput(agentBrowserError(
            'stale_page_map',
            'generation is required. Call browser_snapshot first and pass its pageIdentity.generation.',
          ))
        }
        if (currentGeneration === null || currentGeneration !== requestedGeneration) {
          return browserStructuredErrorOutput(agentBrowserError(
            'stale_page_map',
            'Readonly probe requires a fresh page map generation. Call browser_snapshot again.',
            { currentGeneration, requestedGeneration },
          ))
        }
        const request = normalizeBrowserReadonlyProbeRequest({
          generation: requestedGeneration,
          query: args.query,
          scope: args.scope,
          maxNodes: args.max_nodes,
          includeHidden: args.include_hidden,
          riskDecision: 'allowed',
        })
        const result = await controller.executeJS(tabId, buildBrowserReadonlyProbeJs(request))
        return JSON.stringify(result, null, 2)
      }

      case 'screenshot': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const mode = String(args.mode || 'viewport') as 'viewport' | 'clip' | 'full_page'
        const clipRaw = args.clip
        const clip = clipRaw && typeof clipRaw === 'object'
          ? {
            x: Number((clipRaw as Record<string, unknown>).x || 0),
            y: Number((clipRaw as Record<string, unknown>).y || 0),
            width: Number((clipRaw as Record<string, unknown>).width || 0),
            height: Number((clipRaw as Record<string, unknown>).height || 0),
          }
          : undefined
        const base64 = await controller.screenshotAdvanced(tabId, { mode, clip })
        const metrics = await controller.getViewportMetrics(tabId)
        const width = Math.round(metrics.width)
        const height = Math.round(metrics.height)
        const viewportZero = width <= 0 || height <= 0
        const data = {
          ok: !viewportZero,
          width,
          height,
          mode,
          ...(viewportZero ? {
            warning: 'viewport_zero_or_hidden',
            nextSuggestedAction: 'Use browser_tabs to confirm the active tab, then browser_snapshot or browser_cdp for frame structure instead of repeating capture.',
          } : {}),
        }
        return createToolExecutionOutput(JSON.stringify(data, null, 2), {
          shape: 'multimodal',
          data,
          content: viewportZero ? [] : [{ type: 'image', data: base64, mediaType: 'image/png', detail: 'auto' }],
        })
      }

      case 'status': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const prompt = String(args.prompt || '')
        const attachmentName = String(args.attachment_name || '')
        const includeCandidates = args.include_candidates !== false
        const visionAction = String(args.vision_action || '').trim() as '' | 'upload' | 'input' | 'send'
        const toolMeta = resolveToolContextMeta(controller, tabId)
        const { pageStateService } = createBrowserAgentHelpers(controller)
        const [identity, uploadState, promptState, domState] = await Promise.all([
          getPageIdentity(controller, tabId),
          probeWorkflowUploadState(controller, tabId, attachmentName),
          probeWorkflowPromptSubmissionState(controller, tabId, prompt),
          probeWorkflowDomState(controller, tabId),
        ])

        const base64 = await controller.screenshotAdvanced(tabId, { mode: 'viewport' })
        const metrics = await controller.getViewportMetrics(tabId)

        let uploadTargets: ActionTargetCandidate[] = []
        let inputTargets: ActionTargetCandidate[] = []
        let sendTargets: ActionTargetCandidate[] = []
        let activeInputTarget: ActionTargetCandidate | null = null
        let nearbySendTargets: ActionTargetCandidate[] = []

        if (includeCandidates) {
          ;[uploadTargets, inputTargets] = await Promise.all([
            locateActionTargets(controller, tabId, 'upload'),
            locateActionTargets(controller, tabId, 'input'),
          ])
          activeInputTarget = pickActiveInputTarget(inputTargets)
          if (activeInputTarget) {
            sendTargets = rankTargetsNearAnchor(await locateActionTargets(controller, tabId, 'send'), activeInputTarget)
            nearbySendTargets = sendTargets.some((item) => Boolean(item.nearActiveInput))
              ? sendTargets.filter((item) => Boolean(item.nearActiveInput)).slice(0, 4)
              : sendTargets.slice(0, 2)
          } else {
            sendTargets = await locateActionTargets(controller, tabId, 'send')
          }
        }

        let visionCandidates: ActionTargetCandidate[] = []
        if (
          visionAction &&
          ['upload', 'input', 'send'].includes(visionAction) &&
          (
            (visionAction === 'upload' && !uploadState.complete && uploadTargets.length === 0) ||
            (visionAction === 'input' && !promptState.promptFilled && inputTargets.length === 0) ||
            (visionAction === 'send' && !promptState.generating && sendTargets.length === 0)
          )
        ) {
          const domCandidates =
            visionAction === 'upload'
              ? uploadTargets
              : visionAction === 'input'
                ? inputTargets
                : sendTargets
          const analysis = await analyzeViewportWithVision({
            action: visionAction,
            title: identity.title,
            url: identity.url,
            screenshotBase64: base64,
            domCandidates,
          })
          visionCandidates = Array.isArray(analysis.analysis?.targets)
            ? analysis.analysis.targets
                .filter((target) => Number.isFinite(target.x) && Number.isFinite(target.y))
                .map((target) => ({
                  kind: target.kind === 'upload_launcher' ? 'launcher' : target.kind === 'prompt_input' ? 'prompt_input' : 'icon_button',
                  label: target.label,
                  x: target.x,
                  y: target.y,
                  confidence: target.confidence,
                  evidence: [target.reason || 'vision_candidate'],
                }))
            : []
        }

        const pageState = pageStateService.composePageState({
          page: {
            url: identity.url,
            title: identity.title,
            domain: '',
            activeElement: identity.activeElement,
          },
          promptCandidate: prompt,
          attachmentName,
          upload: uploadState,
          prompt: promptState,
          dom: domState,
          candidates: includeCandidates
            ? {
              uploadTargets,
              inputTargets,
              activeInputTarget,
              nearbySendTargets,
              sendTargets,
            }
            : undefined,
        })

        const data = {
          ok: true,
          ...toolMeta,
          latencyMs: Date.now() - startedAt,
          screenshot: {
            width: Math.round(metrics.width),
            height: Math.round(metrics.height),
            mode: 'viewport',
          },
          page: pageState.page,
          uploadState: pageState.upload,
          promptState: pageState.prompt,
          domState: pageState.dom,
          candidates: includeCandidates
            ? {
                uploadTargets: pageState.candidates.uploadTargets.slice(0, 6),
                inputTargets: pageState.candidates.inputTargets.slice(0, 6),
                activeInputTarget: pageState.candidates.activeInputTarget,
                nearbySendTargets: pageState.candidates.nearbySendTargets,
                sendTargets: pageState.candidates.sendTargets.slice(0, 6),
              }
            : undefined,
          visionCandidates,
          evidenceIds: uniqueStrings([
            ...uploadState.evidence,
            ...promptState.submitEvidence,
            ...(domState.bodyStateText ? ['body_state_observed'] : []),
            ...visionCandidates.flatMap((item) => item.evidence || []),
          ]),
        }
        return createToolExecutionOutput(JSON.stringify(data, null, 2), {
          shape: 'multimodal',
          data,
          content: [{ type: 'image', data: base64, mediaType: 'image/png', detail: 'auto' }],
        })
      }

      case 'find_action': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const action = String(args.action || '').trim() as 'upload' | 'send' | 'close' | 'back'
        if (!['upload', 'send', 'close', 'back'].includes(action)) {
          return browserStructuredOutput({ ok: false, reason: 'invalid_action' })
        }
        const targets = await locateActionTargets(controller, tabId, action)
        const toolMeta = resolveToolContextMeta(controller, tabId)
        // R19 观测补缺：结果概要落日志——真机上无法验证 closed-shadow 增补
        // 是否生效（R17 第一名「添加商品」只能靠截图倒推）。
        const shadowCount = targets.filter((item) => (item.evidence || []).includes('closed_shadow_scan')).length
        log(`locate_action_targets action=${action} count=${targets.length} shadow=${shadowCount} top=${JSON.stringify(targets.slice(0, 3).map((item) => `${item.label}${item.disabled ? '[disabled]' : ''}`))}`)
        return JSON.stringify({
          ok: true,
          ...toolMeta,
          action,
          latencyMs: Date.now() - startedAt,
          count: targets.length,
          targets,
          evidenceIds: uniqueStrings(targets.flatMap((item) => item.evidence || [])),
        }, null, 2)
      }

      case 'find_input': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const target = String(args.target || '').trim().toLowerCase()
        const ranked = await locateActionTargets(controller, tabId, 'input')
        const targets = target
          ? [...ranked].sort((a, b) => {
            const aMatch = String(a.label || '').toLowerCase().includes(target) ? 1 : 0
            const bMatch = String(b.label || '').toLowerCase().includes(target) ? 1 : 0
            if (aMatch !== bMatch) return bMatch - aMatch
            return Number(b.confidence || 0) - Number(a.confidence || 0)
          })
          : ranked
        const activeTarget = pickActiveInputTarget(targets) || pickActiveInputTarget(ranked)
        const anchorTarget = activeTarget || targets[0] || null
        const rankedSendTargets = anchorTarget
          ? rankTargetsNearAnchor(await locateActionTargets(controller, tabId, 'send'), anchorTarget)
          : []
        const nearbySendTargets = rankedSendTargets.some((item) => Boolean(item.nearActiveInput))
          ? rankedSendTargets.filter((item) => Boolean(item.nearActiveInput)).slice(0, 4)
          : rankedSendTargets.slice(0, 2)
        const toolMeta = resolveToolContextMeta(controller, tabId)
        return JSON.stringify({
          ok: true,
          ...toolMeta,
          latencyMs: Date.now() - startedAt,
          count: targets.length,
          targets,
          active_target: activeTarget,
          nearby_send_targets: nearbySendTargets,
          evidenceIds: uniqueStrings([
            ...targets.flatMap((item) => item.evidence || []),
            ...nearbySendTargets.flatMap((item) => item.evidence || []),
          ]),
        }, null, 2)
      }

      case 'screenshot_analyze': {
        const startedAt = Date.now()
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const action = String(args.action || 'general').trim() as 'upload' | 'send' | 'close' | 'back' | 'input' | 'general'
        const includeDomCandidates = args.include_dom_candidates !== false
        const domCandidates = includeDomCandidates && action !== 'general'
          ? await locateActionTargets(controller, tabId, action)
          : []
        const mode = String(args.mode || 'viewport') as 'viewport' | 'clip' | 'full_page'
        const clipRaw = args.clip
        const clip = clipRaw && typeof clipRaw === 'object'
          ? {
            x: Number((clipRaw as Record<string, unknown>).x || 0),
            y: Number((clipRaw as Record<string, unknown>).y || 0),
            width: Number((clipRaw as Record<string, unknown>).width || 0),
            height: Number((clipRaw as Record<string, unknown>).height || 0),
          }
          : undefined
        const screenshot = await controller.screenshotAdvanced(tabId, { mode, clip })
        const identity = await getPageIdentity(controller, tabId)
        const analysis = await analyzeViewportWithVision({
          action,
          title: identity.title,
          url: identity.url,
          screenshotBase64: screenshot,
          domCandidates,
        })
        const toolMeta = resolveToolContextMeta(controller, tabId)
        const payload = {
          ok: analysis.ok,
          ...toolMeta,
          ...(!analysis.ok ? { errorCode: 'viewport_analysis_failed' } : {}),
          action,
          mode,
          latencyMs: Date.now() - startedAt,
          reason: analysis.reason,
          ...(analysis.remediation ? { remediation: analysis.remediation } : {}),
          analysis: analysis.analysis || null,
          domCandidates,
          evidenceIds: uniqueStrings([
            ...domCandidates.flatMap((item) => item.evidence || []),
            ...((analysis.analysis?.targets || []).map((item) => String(item.reason || ''))),
          ]),
        }
        return createToolExecutionOutput(JSON.stringify(payload, null, 2), {
          shape: 'multimodal',
          data: payload,
          content: [{ type: 'image', data: screenshot, mediaType: 'image/png', detail: 'auto' }],
        })
      }

      case 'wait_ready': {
        const timeoutMs = Number(args.timeout_ms || 8000)
        const selector = typeof args.selector === 'string' ? args.selector : undefined
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const ready = await waitForReady(controller, tabId, Math.max(500, Math.min(timeoutMs, 30_000)), selector, abortSignal)
        return `Wait result: ready=${ready.ready}, selectorMatched=${ready.matchedSelector}, elapsed=${ready.elapsedMs}ms`
      }

      case 'wait_condition': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const customJs = typeof args.custom_js === 'string' ? args.custom_js : undefined
        const result = await controller.waitForCondition(tabId, {
          condition: String(args.condition || 'page_readable') as never,
          selector: typeof args.selector === 'string' ? args.selector : undefined,
          customJs,
          timeoutMs: Number(args.timeout_ms || 0) || undefined,
          checkIntervalMs: Number(args.check_interval_ms || 0) || undefined,
          stableIterations: Number(args.stable_iterations || 0) || undefined,
        })
        return JSON.stringify(result, null, 2)
      }

      default:
        return `Unknown browser tool: ${toolName}`
  }
}
