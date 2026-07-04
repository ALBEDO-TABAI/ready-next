/**
 * Browser tool definitions + executor for AI tool calling.
 * Provides browser control tools in both Anthropic and OpenAI formats.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import { existsSync } from 'fs'
import { basename, extname, join } from 'path'
import { analyzeViewportWithVision } from './browser-vision'
import { compileBrowserReadonlyScriptTemplate } from './browser-readonly-script-templates'
import { captureBrowserActionReceipt, type BrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import { consumePendingBrowserSitePermissionNotices } from '../browser-engine/browser-permission-policy'
import { AgentRepository } from '../repositories/agent-repository'
import { createRotatingLogger } from '../../utils/rotating-logger'
import {
  findRecentBrowserAction,
  rememberBrowserAction,
} from '../agent-control/session/session-continuity'
import {
  getBrowserAnthropicTools,
  getBrowserOpenAITools,
} from './browser-tool-catalog'
import { beginLeaseGate, type BrowserLeaseGate } from '../browser-engine/agent-browser-lease-gate'
import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'
import { agentBrowserError, isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import { ToolDomainError } from './tool-errors'
import { resolveBrowserWorkflowIntent } from '../../../shared/browser-workflow-intent'
import {
  buildBrowserActionSessionProgress,
  noteBrowserActionSession,
  type BrowserActionSessionProgress,
  type BrowserTransactionConfirmation,
} from '../browser-engine/browser-action-session'
import {
  BROWSER_DESTRUCTIVE_TARGET_REGEX_SOURCES,
  argsCarryPasswordCue,
  matchBrowserDestructiveTarget,
} from '../agent-control/safety/action-confirmation-policy'
import { ACTION_CONFIRMATION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
import { parseTargetId } from '../browser-engine/agent-browser-page-map'
import { gateActOnTarget, type AgentBrowserAction, type AgentBrowserReadBack } from '../browser-engine/agent-browser-act'
import {
  browserPowerModeEnabled,
  recordBrowserPowerAuditEvent,
  type BrowserPowerDecision,
} from '../browser-engine/browser-power-policy'
import type { AgentControlRuntime } from '../agent-control/runtime-core/runtime'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'
import {
  createBrowserStructuredJsonText as browserStructuredJsonText,
  createBrowserStructuredOutput as browserStructuredOutput,
  stringifyBrowserJsonOrFailure,
} from './browser-failure-output'

import {
  buildBrowserTargetProbeJs,
  buildTargetSemanticsLibraryJs,
  buildInputGuardSnippetJs,
  probeCoordinateTargetOrThrow,
  buildFocusedFieldProbeJs,
  throwIfLiveTargetGuardBlocked,
  buildBrowserActOnTargetJs,
  buildBrowserActionDeltaJs,
} from './browser-probe'
export { normalizeDownloadTargets, pinimgOriginalsUrl } from './browser-media-download'
import {
  BROWSER_V2_STOP_LOADING_TIMEOUT_MS,
  buildSmartTypeJs,
  clearFocusedInput,
  dispatchClickAt,
  isBrowserAbortError,
  normalizeErrorCode,
  resolveCssPoint,
  runGuardedCoordinateClick,
  runGuardedCoordinateType,
  runGuardedSelectorClick,
  runGuardedSelectorType,
  sendKeyStroke,
  settleAfterAction,
  sleepWithAbort,
  throwIfAborted,
  waitForLoadingStop,
  waitForReady,
} from './browser-input-actions'
import {
  ensureGeminiSubmitted,
  isLikelyChatPage,
} from './browser-gemini'
import {
  browserPowerDeniedOutput,
  executeBrowserPowerTool,
  resolvePowerDecisionForTool,
  summarizeCodeForAudit,
} from './browser-power-tools'
import { executeBrowserCollectionTool } from './browser-collection-tools'
import {
  captureAgentPageMap,
  currentBrowserPageMapAmbiguity,
  currentBrowserPageMapGeneration,
  DEFAULT_AGENT_PAGE_MAP_MAX_BYTES,
  executeBrowserObserveTool,
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
} from './browser-tool-shared'

const logger = createRotatingLogger('ready-tools.log')
function log(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
}

interface BrowserToolTabSnapshot {
  id: string
  title: string
  url: string
  active: boolean
}

interface BrowserActionFollowedTab {
  tabId: string
  title: string
  url: string
  reason: 'new_tab' | 'active_tab_changed'
  sourceTabId: string | null
  ready?: boolean
  elapsedMs?: number
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
 * WP3 — high-control platform script blacklist (plan §4.4). On strong-detection
 * platforms (小红书/抖音/微博/…), script-hard tools and script params are refused;
 * only visible / template DOM collection is allowed. Returns a structured
 * rejection string when blocked, or null when permitted.
 */
/**
 * Every URL this call could actually operate on: the active tab, the tab the
 * call explicitly targets via `tab_id`, an explicit `args.url`, and any target
 * URL inside `run_workflow` steps. Used by both the high-control script guard
 * and the visible_collect rate-limit decision so neither can be bypassed by
 * leaving a benign page active while pointing the call at a high-control page.
 */
function resolveCandidateTargetUrls(
  args: Record<string, unknown>,
  controller: BrowserController,
): string[] {
  const urls: string[] = []
  try {
    const active = controller.getActiveTab?.()?.url
    if (active) urls.push(active)
  } catch { /* silent-catch: optional controller state may be unavailable in tests. */ }
  if (typeof args.tab_id === 'string') {
    try {
      const tab = controller.getTabList?.().find((t) => t.id === args.tab_id)
      if (tab?.url) urls.push(tab.url)
    } catch { /* silent-catch: optional controller tab lookup may be unavailable in tests. */ }
  }
  if (typeof args.url === 'string') urls.push(args.url)
  if (Array.isArray(args.steps)) {
    for (const step of args.steps) {
      if (step && typeof step === 'object') {
        const s = step as Record<string, unknown>
        for (const key of ['url', 'target', 'href']) {
          if (typeof s[key] === 'string') urls.push(s[key] as string)
        }
      }
    }
  }
  // browser_start_task / thin task adapters carry the target URL(s) inside payload.
  const payload = args.payload && typeof args.payload === 'object' ? (args.payload as Record<string, unknown>) : null
  if (payload) {
    if (typeof payload.url === 'string') urls.push(payload.url)
    if (Array.isArray(payload.urls)) {
      for (const u of payload.urls) if (typeof u === 'string') urls.push(u)
    }
  }
  return urls
}

/** True when a start_task payload carries a page-executing script param. */
function startTaskPayloadHasScript(args: Record<string, unknown>): boolean {
  const payload = args.payload && typeof args.payload === 'object' ? (args.payload as Record<string, unknown>) : null
  if (!payload) return false
  if (typeof payload.customScript === 'string' && payload.customScript.trim().length > 0) return true
  const wait = payload.wait && typeof payload.wait === 'object' ? (payload.wait as Record<string, unknown>) : null
  if (wait) {
    if (wait.condition === 'custom_js') return true
    if (typeof wait.customJs === 'string' && (wait.customJs as string).trim().length > 0) return true
  }
  return false
}

function highControlScriptGuard(
  toolName: string,
  args: Record<string, unknown>,
  candidateUrls: string[],
): ToolExecutionOutput | null {
  if (!candidateUrls.some((url) => isHighControlPlatformText(url))) return null
  const hasCustomScript = typeof args.custom_script === 'string' && args.custom_script.trim().length > 0
  const hasCustomJs =
    args.condition === 'custom_js' || (typeof args.custom_js === 'string' && (args.custom_js as string).trim().length > 0)
  const blocked =
    toolName === 'browser_execute_js' ||
    toolName === 'browser_run_workflow' ||
    ((toolName === 'browser_extract_structured' || toolName === 'browser_scroll_collect') && hasCustomScript) ||
    (toolName === 'browser_wait_for_condition' && hasCustomJs) ||
    // browser_start_task wraps scroll_collect/research and can carry a page
    // script in payload.customScript / payload.wait.customJs (Codex R3) — block
    // it on high-control platforms so the start_task wrapper can't bypass.
    (toolName === 'browser_start_task' && startTaskPayloadHasScript(args))
  if (!blocked) return null
  return browserStructuredErrorOutput(
    agentBrowserError(
      'script_blocked',
      '该平台为强检测平台，已禁用脚本硬操作（execute_js / run_workflow / custom_script / custom_js）。请改用可见采集：browser_read_page、browser_collect_images、browser_visible_collect（模板路径）、browser_capture_viewport、滚动。',
      { highControlPlatform: true, tool: toolName },
    ),
  )
}

type ScriptReadOnlyVerdict =
  | { output: ToolExecutionOutput; args?: never }
  | { output?: never; args: Record<string, unknown> }

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function scriptDeniedOutput(toolName: string, reason: string, detail?: Record<string, unknown>): ToolExecutionOutput {
  return browserStructuredErrorOutput(agentBrowserError(
    'freeform_script_denied',
    '浏览器脚本工具只接受命名只读模板；自由 JavaScript 已被拒绝。请改用 read_text/read_attr/read_all_text/count_selector/exists_selector/read_rect/read_meta 模板。',
    { tool: toolName, reason, ...(detail || {}) },
  ))
}

function compileReadonlyScriptFromArgs(
  toolName: string,
  args: Record<string, unknown>,
  options?: { allowTemplateAlias?: boolean; location?: string },
): { code: string | null; output?: ToolExecutionOutput } {
  const template =
    stringValue(args.script_template)
    || (options?.allowTemplateAlias ? stringValue(args.template) : '')
  if (!template) return { code: null }

  const compiled = compileBrowserReadonlyScriptTemplate({
    template,
    selector: args.selector,
    attr: args.attr,
    name: args.name,
  })
  if (!compiled.ok) {
    return {
      code: null,
      output: scriptDeniedOutput(toolName, compiled.reason, {
        template: compiled.template || template,
        location: options?.location || toolName,
      }),
    }
  }
  return { code: compiled.code }
}

function resolveScriptReadOnlyVerdict(
  toolName: string,
  args: Record<string, unknown>,
): ScriptReadOnlyVerdict {
  if (toolName === 'browser_execute_js') {
    if (stringValue(args.code)) {
      return { output: scriptDeniedOutput(toolName, 'freeform_code', { field: 'code' }) }
    }
    const compiled = compileReadonlyScriptFromArgs(toolName, args, { allowTemplateAlias: true })
    if (compiled.output) return { output: compiled.output }
    if (compiled.code) return { args: { ...args, code: compiled.code } }
    return { args }
  }

  if (toolName === 'browser_wait_for_condition') {
    if (stringValue(args.custom_js)) {
      return { output: scriptDeniedOutput(toolName, 'freeform_custom_js', { field: 'custom_js' }) }
    }
    const compiled = compileReadonlyScriptFromArgs(toolName, args, { allowTemplateAlias: true })
    if (compiled.output) return { output: compiled.output }
    if (compiled.code) return { args: { ...args, condition: 'custom_js', custom_js: compiled.code } }
    if (args.condition === 'custom_js') {
      return { output: scriptDeniedOutput(toolName, 'missing_readonly_template', { field: 'custom_js' }) }
    }
    return { args }
  }

  if (toolName === 'browser_extract_structured' || toolName === 'browser_scroll_collect') {
    if (stringValue(args.custom_script)) {
      return { output: scriptDeniedOutput(toolName, 'freeform_custom_script', { field: 'custom_script' }) }
    }
    const compiled = compileReadonlyScriptFromArgs(toolName, args, { allowTemplateAlias: false })
    if (compiled.output) return { output: compiled.output }
    if (compiled.code) return { args: { ...args, custom_script: compiled.code } }
    return { args }
  }

  if (toolName === 'browser_run_workflow') {
    if (!Array.isArray(args.steps)) return { args }
    const nextSteps: unknown[] = []
    for (const step of args.steps) {
      if (!step || typeof step !== 'object') {
        nextSteps.push(step)
        continue
      }
      const current = step as Record<string, unknown>
      if (String(current.action || '').trim().toLowerCase() !== 'execute_js') {
        nextSteps.push(current)
        continue
      }
      if (stringValue(current.code)) {
        return { output: scriptDeniedOutput(toolName, 'workflow_freeform_code', { field: 'steps[].code' }) }
      }
      const compiled = compileReadonlyScriptFromArgs(toolName, current, {
        allowTemplateAlias: true,
        location: 'workflow.execute_js',
      })
      if (compiled.output) return { output: compiled.output }
      nextSteps.push(compiled.code ? { ...current, code: compiled.code } : current)
    }
    return { args: { ...args, steps: nextSteps } }
  }

  if (toolName === 'browser_start_task') {
    const payload = args.payload && typeof args.payload === 'object' ? args.payload as Record<string, unknown> : null
    if (!payload) return { args }
    if (stringValue(payload.customScript)) {
      return { output: scriptDeniedOutput(toolName, 'payload_freeform_custom_script', { field: 'payload.customScript' }) }
    }
    const nextPayload: Record<string, unknown> = { ...payload }
    const payloadCompiled = compileReadonlyScriptFromArgs(toolName, payload, {
      allowTemplateAlias: false,
      location: 'payload.customScript',
    })
    if (payloadCompiled.output) return { output: payloadCompiled.output }
    if (payloadCompiled.code) nextPayload.customScript = payloadCompiled.code

    const wait = payload.wait && typeof payload.wait === 'object' ? payload.wait as Record<string, unknown> : null
    if (wait) {
      if (stringValue(wait.customJs)) {
        return { output: scriptDeniedOutput(toolName, 'payload_wait_freeform_custom_js', { field: 'payload.wait.customJs' }) }
      }
      const waitCompiled = compileReadonlyScriptFromArgs(toolName, wait, {
        allowTemplateAlias: true,
        location: 'payload.wait.customJs',
      })
      if (waitCompiled.output) return { output: waitCompiled.output }
      if (waitCompiled.code) {
        nextPayload.wait = { ...wait, condition: 'custom_js', customJs: waitCompiled.code }
      } else if (wait.condition === 'custom_js') {
        return { output: scriptDeniedOutput(toolName, 'payload_wait_missing_readonly_template', { field: 'payload.wait.customJs' }) }
      }
    }
    return { args: { ...args, payload: nextPayload } }
  }

  return { args }
}

type SearchEngine = 'auto' | 'google' | 'duckduckgo' | 'bing' | 'baidu'
export function getAnthropicTools(): Array<Record<string, unknown>> {
  return getBrowserAnthropicTools()
}

export function getOpenAITools(): Array<Record<string, unknown>> {
  return getBrowserOpenAITools()
}

// ── Browser Tool Executor ───────────────────────────────────────────

function isBrowserTransactionTurn(currentUserText?: string | null): boolean {
  return resolveBrowserWorkflowIntent(currentUserText || '').kind === 'transaction'
}

function browserActionSessionPatch(params: {
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
}): { projectionPatch: Record<string, unknown>; session: BrowserActionSessionProgress } | null {
  if (!params.sessionId || !isBrowserTransactionTurn(params.currentUserText)) return null
  const targetTabId = params.followedTab?.tabId
    || params.tabId
    || (typeof params.args.tab_id === 'string' ? params.args.tab_id : null)
    || params.controller.getActiveTab?.()?.id
    || null
  const currentUrl = params.followedTab?.url || activeBrowserToolUrl(params.controller, targetTabId)
  const frameId = params.frameId || (typeof params.args.frame_id === 'string' ? params.args.frame_id : null)
  const frameUrl = typeof params.args.frame_url === 'string' ? params.args.frame_url : null
  const session = noteBrowserActionSession(params.sessionId, {
    targetTabId,
    targetFrameId: frameId,
    frameUrl,
    currentUrl,
    lastAction: params.toolName,
    lastFollowedTab: params.followedTab
      ? {
        tabId: params.followedTab.tabId,
        url: params.followedTab.url || null,
        title: params.followedTab.title || null,
        reason: params.followedTab.reason || null,
      }
      : null,
    confirmation: params.confirmation || null,
    nextSuggestedAction: params.nextSuggestedAction || null,
  })
  if (!session) return null
  return {
    session,
    projectionPatch: {
      taskType: 'browser_transaction',
      module: 'browser',
      progress: buildBrowserActionSessionProgress(session),
    },
  }
}

function attachBrowserActionSessionOutput(
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
    /** P1-E5 — post-action change receipt (url/focus/toast delta). */
    changeReceipt?: BrowserActionReceipt | null
  },
): string | ToolExecutionOutput {
  const patch = browserActionSessionPatch(params)
  // Drain 必须先于 early-return：注记一旦取出就必须随本次输出交付。
  const sitePermissionNotices = consumePendingBrowserSitePermissionNotices()
  if (!patch && !params.changeReceipt && sitePermissionNotices.length === 0) return result
  const data: Record<string, unknown> = typeof result === 'string'
    ? (() => {
      try {
        const parsed = JSON.parse(result) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { result }
      } catch {
        // silent-catch: 非 JSON 结果按原文包装返回。
        return { result }
      }
    })()
    : { ...(result.data || {}) }
  if (params.confirmation) {
    data.transactionConfirmed = params.confirmation
  }
  // P1-E5 — attach the change receipt so the model sees what changed without
  // a follow-up read_page. Session patch may be absent (early live target).
  if (params.changeReceipt) {
    data.changeReceipt = params.changeReceipt
  }
  // Agent 驾驶期间被自动拒绝的站点权限请求随下一次浏览器动作输出带给模型
  //（drain 语义，权限判决本身已在 session-policy-service 落日志）。
  if (sitePermissionNotices.length > 0) {
    data.sitePermissionNotices = sitePermissionNotices
  }
  if (!patch) {
    return createToolExecutionOutput(JSON.stringify(data, null, 2), {
      shape: 'json',
      data,
      projectionPatch: typeof result === 'string' ? undefined : result.projectionPatch,
      interactionHint: typeof result === 'string' ? null : result.interactionHint,
      framePatch: typeof result === 'string' ? null : result.framePatch,
      contextModifier: typeof result === 'string' ? null : result.contextModifier,
      envelope: typeof result === 'string' ? null : result.envelope,
    })
  }
  data.browserActionSession = patch.session
  const mergedProjectionPatch = typeof result === 'string'
    ? patch.projectionPatch
    : { ...(result.projectionPatch || {}), ...patch.projectionPatch }
  return createToolExecutionOutput(
    JSON.stringify(data, null, 2),
    {
      shape: 'json',
      data,
      projectionPatch: mergedProjectionPatch,
      interactionHint: typeof result === 'string' ? null : result.interactionHint,
      framePatch: typeof result === 'string' ? null : result.framePatch,
      contextModifier: typeof result === 'string' ? null : result.contextModifier,
      envelope: typeof result === 'string' ? null : result.envelope,
    },
  )
}

function canUsePowerScriptPath(params: {
  toolName: string
  args: Record<string, unknown>
  controller: BrowserController
  currentUserText?: string
  sessionId?: string
}): { ok: true; decision: BrowserPowerDecision } | { ok: false; output?: ToolExecutionOutput } {
  if (!browserPowerModeEnabled(params.currentUserText) && typeof params.args.grant_id !== 'string') {
    return { ok: false }
  }
  const decision = resolvePowerDecisionForTool({
    toolName: params.toolName,
    args: params.args,
    controller: params.controller,
    currentUserText: params.currentUserText,
    sessionId: params.sessionId,
    fallbackEffects: ['page_mutation'],
  })
  if (decision.action !== 'allow') {
    return { ok: false, output: browserPowerDeniedOutput(decision, { tool: params.toolName }) }
  }
  return { ok: true, decision }
}

function legacyToolHasFreeformScript(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'browser_execute_js') return stringValue(args.code).length > 0
  if (toolName === 'browser_wait_for_condition') return stringValue(args.custom_js).length > 0 || args.condition === 'custom_js'
  if (toolName === 'browser_extract_structured' || toolName === 'browser_scroll_collect') return stringValue(args.custom_script).length > 0
  if (toolName === 'browser_run_workflow') {
    return Array.isArray(args.steps) && args.steps.some((step) =>
      step && typeof step === 'object'
      && String((step as Record<string, unknown>).action || '').trim().toLowerCase() === 'execute_js'
      && stringValue((step as Record<string, unknown>).code).length > 0)
  }
  if (toolName === 'browser_start_task') return startTaskPayloadHasScript(args)
  return false
}

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

function buildClickByTextJs(text: string, exact: boolean): string {
  return `
    (() => {
      ${buildTargetSemanticsLibraryJs()}
      const target = ${JSON.stringify(text)}
      const exact = ${exact ? 'true' : 'false'}
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

      const candidates = all.filter((el) => el instanceof HTMLElement && visible(el) && isClickable(el))
      let matched = null
      for (const el of candidates) {
        const txt = normalize(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '')
        if (!txt) continue
        if ((exact && txt === target) || (!exact && txt.includes(target))) {
          matched = el
          break
        }
      }
      let viaPointerOwner = false
      if (!matched) {
        // D10-c（真机实锚：XHS creator "写长文" 是零语义标记的 span，React
        // 根委托监听）：文本命中的可见叶子向上爬 cursor:pointer owner。
        for (const el of all) {
          if (!(el instanceof HTMLElement) || el.children.length > 0 || !visible(el)) continue
          const txt = normalize(el.textContent || '')
          if (!txt) continue
          if (!((exact && txt === target) || (!exact && txt.includes(target)))) continue
          let owner = el
          for (let i = 0; i < 8 && owner; i++) {
            let cursor = ''
            try { cursor = window.getComputedStyle(owner).cursor } catch { cursor = '' }
            if (cursor === 'pointer') { matched = owner; viaPointerOwner = true; break }
            // D14：爬到 shadow root 顶端时跨界跳到 host 继续——Web Component
            // 的 pointer 信号可能只标在 host（light 侧）上。
            owner = owner.parentElement || ((owner.getRootNode && owner.getRootNode().host) || null)
          }
          if (matched) break
        }
      }
      if (!matched) return 'Element by text not found: ' + target
      // EP1-I3 live-target net — the located element's clickable owner may be
      // a payment/captcha/改密 control even when the search text was generic.
      const __readyOwnerLabel = readyClickSemanticsLabel(matched)
      if (__readyOwnerLabel && READY_DESTRUCTIVE_TARGET_PATTERNS.some((p) => p.test(__readyOwnerLabel))) {
        return { __readyDestructiveTargetBlocked: true, label: __readyOwnerLabel.slice(0, 80) }
      }
      matched.scrollIntoView({ block: 'center', behavior: 'instant' })
      matched.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      // D10-c：委托型控件监听 pointerdown/mousedown，先派发指针序列再
      // el.click() 保留原生激活语义；对原生控件多出的前奏无害。
      const __readyRect = matched.getBoundingClientRect()
      const __readyOpts = { bubbles: true, cancelable: true, view: window, clientX: __readyRect.left + __readyRect.width / 2, clientY: __readyRect.top + __readyRect.height / 2 }
      matched.dispatchEvent(new PointerEvent('pointerdown', __readyOpts))
      matched.dispatchEvent(new MouseEvent('mousedown', __readyOpts))
      matched.dispatchEvent(new PointerEvent('pointerup', __readyOpts))
      matched.dispatchEvent(new MouseEvent('mouseup', __readyOpts))
      matched.click()
      return 'Clicked by text' + (viaPointerOwner ? ' (pointer-owner)' : '') + ': ' + normalize(matched.textContent || matched.getAttribute('aria-label') || matched.getAttribute('title') || matched.tagName)
    })()
  `
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
 * 主帧 miss 后逐子帧重试 buildClickByTextJs。命中即停（click JS 只在命中
 * 时产生副作用，未命中帧无副作用，顺序尝试安全）；破坏性目标 owner 复查
 * 由 click JS 自身携带，命中封锁对象由调用方统一 throwIfLiveTargetGuardBlocked。
 */
async function clickByTextAcrossFrames(
  controller: BrowserController,
  tabId: string | null,
  text: string,
  exact: boolean,
): Promise<{ result: unknown; frameKey: string | null; framesSearched: number }> {
  const js = buildClickByTextJs(text, exact)
  const mainResult = await controller.executeJS(tabId, js)
  if (!isClickByTextMiss(mainResult)) return { result: mainResult, frameKey: null, framesSearched: 0 }
  const frames = listSubframesSafe(controller, tabId)
  if (typeof controller.executeJSInFrame === 'function') {
    for (const frame of frames) {
      try {
        const result = await controller.executeJSInFrame(tabId, frame.frameKey, js)
        if (!isClickByTextMiss(result)) return { result, frameKey: frame.frameKey, framesSearched: frames.length }
      } catch {
        // silent-catch: 单帧执行失败（帧销毁/导航中）不阻断其余帧尝试。
        continue
      }
    }
  }
  const missText = typeof mainResult === 'string'
    ? `${mainResult}（已搜索主帧与 ${frames.length} 个子帧）`
    : mainResult
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
            // D14：跨 shadow 边界跳 host，同 buildClickByTextJs。
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

async function runWorkflowStep(
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
    // EP1-I3 live-target net — browser_run_workflow is not in the dispatch
    // confirmation policy, so the inner click is invisible to the gate; it
    // must re-check at the execution layer via the shared guarded entry.
    return await runGuardedSelectorClick(controller, tabId, selector)
  }

  if (action === 'click_text') {
    const text = String(step.text || '').trim()
    if (!text) return 'Error: workflow click_text missing text'
    const exact = step.exact === true
    // The text arg itself is the semantic the model chose to click — guard
    // it directly, and the located-element owner label is re-checked inside
    // buildClickByTextJs before the click fires.
    const textHit = matchBrowserDestructiveTarget(text)
    if (textHit) {
      throw new ToolDomainError(
        'grant_required',
        `workflow click_text 目标文本「${text.slice(0, 80)}」命中浏览器破坏性动作清单（${textHit.reason}），需要用户授予该目标的 Power grant 后才能执行。`,
        { text, ruleId: textHit.ruleId },
      )
    }
    const located = await clickByTextAcrossFrames(controller, tabId, text, exact)
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
    })
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
    const point = await runGuardedCoordinateType(controller, tabId, x, y, text, {
      clearBefore,
      pressEnter,
      useShiftEnter,
      allowPasswordFill: false,
    }, signal)
    return `Typed at normalized(${point.nx},${point.ny}) css(${point.cssX},${point.cssY})`
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

  if (action === 'execute_js') {
    const code = typeof step.code === 'string' ? step.code : ''
    if (!code) return 'Error: workflow execute_js missing code'
    return String(await controller.executeJS(tabId, code))
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
    const rawWorkflowCompose = await controller.executeJS(tabId, buildSmartTypeJs({ target, text, clearFirst, submit }))
    throwIfLiveTargetGuardBlocked(rawWorkflowCompose, { target, via: 'workflow_compose' })
    return String(rawWorkflowCompose)
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
  const canUseSelector = typeof target.selectorHint === 'string' &&
    target.selectorHint.length > 0 &&
    (target.selectorHint.startsWith('#') || target.selectorHint.includes('['))
  if (canUseSelector) {
    const result = await controller.executeJS(
      tabId,
      `
        (() => {
          const selector = ${JSON.stringify(target.selectorHint)}
          try {
            const node = document.querySelector(selector)
            if (!(node instanceof HTMLElement)) return { ok: false, method: 'selector_not_found' }
            node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
            node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
            if (typeof node.click === 'function') node.click()
            else {
              node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
              node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
              node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            }
            return { ok: true, method: 'selector_click' }
          } catch (error) {
            return { ok: false, method: String(error || 'selector_click_failed') }
          }
        })()
      `,
    ) as { ok?: boolean; method?: string } | null
    if (result?.ok) {
      await settleAfterAction(controller, tabId, abortSignal)
      return { ok: true, method: String(result.method || 'selector_click') }
    }
  }
  if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
    await dispatchClickAt(controller, tabId, Number(target.x), Number(target.y))
    await settleAfterAction(controller, tabId, abortSignal)
    return { ok: true, method: 'coordinate_click' }
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
    return { recovered: true, method: 'browser_go_back' }
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

export async function executeBrowserTool(
  toolName: string,
  args: Record<string, unknown>,
  controller: BrowserController,
  abortSignal?: AbortSignal,
  sessionId?: string,
  leaseGate?: BrowserLeaseGate,
  currentUserText?: string,
  runtime?: AgentControlRuntime | null,
): Promise<string | ToolExecutionOutput> {
  log(`executeBrowserTool: ${toolName} args=${JSON.stringify(args).slice(0, 200)}`)

  const legacyPowerScript = legacyToolHasFreeformScript(toolName, args)
  let legacyPowerDecision: BrowserPowerDecision | null = null
  if (legacyPowerScript) {
    const power = canUsePowerScriptPath({ toolName, args, controller, currentUserText, sessionId })
    if (!power.ok) {
      if (power.output) return power.output
    } else {
      legacyPowerDecision = power.decision
      if (toolName === 'browser_execute_js') {
        return executeBrowserTool(
          'browser_power_eval',
          {
            code: String(args.code || ''),
            purpose: String(args.purpose || 'legacy browser_execute_js compatibility'),
            expected_effects: power.decision.effects,
            tab_id: args.tab_id,
            grant_id: args.grant_id,
          },
          controller,
          abortSignal,
          sessionId,
          leaseGate,
          currentUserText,
          runtime,
        )
      }
      if (toolName === 'browser_run_workflow') {
        return executeBrowserTool(
          'browser_power_script_run',
          {
            steps: args.steps,
            purpose: String(args.purpose || 'legacy browser_run_workflow execute_js compatibility'),
            expected_effects: power.decision.effects,
            tab_id: args.tab_id,
            continue_on_error: args.continue_on_error,
            grant_id: args.grant_id,
          },
          controller,
          abortSignal,
          sessionId,
          leaseGate,
          currentUserText,
          runtime,
        )
      }
    }
  }

  // WP3 — high-control platform script blacklist: on 小红书/抖音/微博/… do not
  // run script-hard tools / script params; only visible/DOM collection is
  // allowed (plan §4.4). Checked against the active tab's URL, before the lease
  // gate so a rejected tool never opens an action window.
  const candidateTargetUrls = resolveCandidateTargetUrls(args, controller)
  if (!legacyPowerDecision) {
    const highControlDenied = highControlScriptGuard(toolName, args, candidateTargetUrls)
    if (highControlDenied) {
      log(`Browser tool high-control-denied: ${toolName}`)
      return highControlDenied
    }

    const scriptReadOnlyVerdict = resolveScriptReadOnlyVerdict(toolName, args)
    if (scriptReadOnlyVerdict.output) {
      log(`Browser tool freeform-script-denied: ${toolName}`)
      return scriptReadOnlyVerdict.output
    }
    args = scriptReadOnlyVerdict.args
  } else {
    recordBrowserPowerAuditEvent({
      toolName,
      grantId: legacyPowerDecision.grantId,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : null,
      url: activeBrowserToolUrl(controller, typeof args.tab_id === 'string' ? args.tab_id : null),
      effects: legacyPowerDecision.effects,
      purpose: String(args.purpose || 'legacy freeform script path'),
      codeSummary: summarizeCodeForAudit(String(args.code || args.custom_js || args.custom_script || '')),
      paramsSummary: { legacyPowerPath: true },
      resultSummary: null,
    })
  }

  const gate = beginLeaseGate(leaseGate, toolName, args)
  if (gate.deniedMessage !== null) {
    log(`Browser tool lease-denied: ${toolName} ${gate.deniedMessage}`)
    return browserStructuredJsonText(gate.deniedMessage)
  }

  try {
    throwIfAborted(abortSignal)
    switch (toolName) {
      case 'browser_navigate': {
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

      case 'browser_search': {
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

      case 'browser_get_tabs':
      case 'browser_read_page':
      case 'browser_read_page_map':
      case 'browser_probe_readonly':
      case 'browser_capture_viewport':
      case 'browser_probe_workflow_state':
      case 'browser_locate_action_targets':
      case 'browser_locate_input_targets':
      case 'browser_analyze_viewport':
      case 'browser_wait':
      case 'browser_wait_for_condition':
      case 'browser_query_gemini':
        // B6 —— 观察/感知组实现体整体搬至 browser-observe-tools.ts；页面地图
        // generation/ambiguity 单例随组迁移，留守 browser_act_on_target 经
        // import 回读；attachBrowserActionSessionOutput（排空合同红线）留在
        // 本文件经 ctx 注入。此处必须 `return await`，让拒绝仍走本函数的
        // catch（Abort 重抛/ToolDomainError/错误拍扁）。
        return await executeBrowserObserveTool(toolName, args, {
          controller,
          abortSignal,
          sessionId,
          currentUserText,
          attachBrowserActionSessionOutput,
        })

      case 'browser_act_on_target': {
        const targetId = String(args.target_id || args.targetId || '').trim()
        const action = String(args.action || 'click') as AgentBrowserAction
        const value = args.value === undefined ? undefined : String(args.value)
        const disambiguation = String(args.disambiguation || '').trim()
        const readBack = String(args.read_back || args.readBack || 'delta') as AgentBrowserReadBack
        if (!targetId) return browserStructuredErrorOutput(agentBrowserError('target_not_found', 'target_id is required'))
        if (!['click', 'expand', 'choose', 'fill', 'hover'].includes(action)) {
          return browserStructuredErrorOutput(agentBrowserError('target_not_found', `Unsupported action: ${String(args.action || '')}`))
        }
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const parsed = parseTargetId(targetId)
        if (!parsed) {
          return browserStructuredErrorOutput(agentBrowserError('target_not_found', `Malformed target id: ${targetId}`))
        }
        const currentGeneration = currentBrowserPageMapGeneration(controller, tabId)
        if (currentGeneration === null) {
          return browserStructuredErrorOutput(agentBrowserError(
            'stale_page_map',
            'No page map has been read for this tab. Call browser_read_page_map first.',
            { targetGeneration: parsed.generation },
          ))
        }
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
        let liveProbe: { matchCount?: number; disabled?: boolean; target?: unknown } | null
        try {
          liveProbe = await runInTargetFrame(buildBrowserTargetProbeJs(parsed.node)) as {
            matchCount?: number
            disabled?: boolean
            target?: unknown
          } | null
        } catch (error) {
          if (isFrameGoneError(error)) {
            return browserStructuredErrorOutput(agentBrowserError(
              'stale_page_map',
              `Target ${targetId} belongs to frame ${targetFrameKey}, which is no longer present. Call browser_read_page_map again.`,
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
            ambiguityGroup: currentBrowserPageMapAmbiguity(controller, tabId, targetId),
          },
        )
        if (isAgentBrowserError(gated)) return browserStructuredErrorOutput(gated)
        if (!liveProbe) {
          return browserStructuredErrorOutput(agentBrowserError(
            'target_not_found',
            `Target ${targetId} was not found on the current page.`,
            { targetId },
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
          ? liveProbe.target as { role?: string; name?: string; value?: string; states?: Record<string, unknown> }
          : null
        if (targetRecord?.states?.fileInput === true) {
          return browserStructuredErrorOutput(agentBrowserError(
            'script_blocked',
            `Target ${targetId} is a file input. Use browser_upload_scope_attachment for file upload.`,
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
        try {
          actionResult = await runInTargetFrame(buildBrowserActOnTargetJs(parsed.node, action, value))
        } catch (error) {
          if (isFrameGoneError(error)) {
            return browserStructuredErrorOutput(agentBrowserError(
              'stale_page_map',
              `Target ${targetId} belongs to frame ${targetFrameKey}, which disappeared before the action ran. Call browser_read_page_map again.`,
              { targetId, frameKey: targetFrameKey },
            ))
          }
          throw error
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
        // D18 升级通道：合成点击（含 open-shadow 穿透）对 closed shadow root
        // 内部监听器不可达（事件不向 shadow 内传播，host.click() 也点不到内部
        // 按钮）。click 判无效果（delta 未变且未开新 tab）时，在同一次调用内
        // 用可信指针输入（与 browser_click_at 同一 dispatchMouse 通道，含破坏
        // 性目标闸门）在原点击坐标补真实命中测试点击。只处理主帧：iframe 的
        // rect 坐标系与视口不同构。
        let escalation: Record<string, unknown> | null = null
        const rawClickPoint = !actionFailed && action === 'click' && actionResult && typeof actionResult === 'object'
          ? (actionResult as { clickPoint?: { x?: unknown; y?: unknown; vw?: unknown; vh?: unknown } | null }).clickPoint
          : null
        const cpx = Number(rawClickPoint?.x)
        const cpy = Number(rawClickPoint?.y)
        const cpw = Number(rawClickPoint?.vw)
        const cph = Number(rawClickPoint?.vh)
        const clickPointValid = Number.isFinite(cpx) && Number.isFinite(cpy)
          && cpw > 0 && cph > 0 && cpx >= 0 && cpx <= cpw && cpy >= 0 && cpy <= cph
        if (
          action === 'click' && !actionFailed && readBack !== 'none'
          && !changed && !followedTab && targetFrameKey === '0' && clickPointValid
        ) {
          const nx = Math.max(0, Math.min(999, Math.round((cpx / cpw) * 1000)))
          const ny = Math.max(0, Math.min(999, Math.round((cpy / cph) * 1000)))
          try {
            await runGuardedCoordinateClick(controller, tabId, nx, ny, abortSignal)
            const escalatedFollowedTab = await waitForActionFollowedTab(controller, tabId, beforeTabs, abortSignal)
            afterDelta = await readBrowserActionDeltaBestEffort(controller, tabId, 'after')
            const escalatedChanged = didBrowserActionChange(before, afterDelta) || Boolean(escalatedFollowedTab)
            escalation = {
              attempted: true,
              mode: 'trusted_pointer',
              reason: 'no_change_after_synthetic_click',
              changed: escalatedChanged,
            }
            changed = changed || escalatedChanged
            if (escalatedFollowedTab) followedTab = escalatedFollowedTab
          } catch (error) {
            // 闸门（grant_required / 待确认拒绝）保持响亮——升级点击与
            // browser_click_at 的安全语义必须同构，不能因为是兜底就静默。
            if (error instanceof ToolDomainError) throw error
            escalation = {
              attempted: true,
              mode: 'trusted_pointer',
              reason: 'no_change_after_synthetic_click',
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }
        const after = readBack === 'map'
          ? await captureAgentPageMap(controller, tabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES)
          : afterDelta
        const payload = {
          ok: !actionFailed,
          targetId,
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

      case 'browser_click': {
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
        const result = await runGuardedSelectorClick(controller, tabId, selector)
        await settleAfterAction(controller, tabId, abortSignal)
        const followedTab = await waitForActionFollowedTab(controller, tabId, beforeTabs, abortSignal)
        const confirmation = await detectBrowserPageTransactionConfirmation(controller, followedTab?.tabId || tabId)
        // P1-E5 — deterministic post-action change receipt so the model can skip
        // a follow-up browser_read_page; never fails the click if the probe errors.
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

      case 'browser_click_text': {
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
          const frameClick = await clickByTextAcrossFrames(controller, tabId, text, exact)
          if (isClickByTextMiss(frameClick.result)) {
            const missBase = result.error || `Element by text not found: ${text}`
            return `${missBase}（已搜索主帧与 ${frameClick.framesSearched} 个子帧）`
          }
          throwIfLiveTargetGuardBlocked(frameClick.result, { text, via: 'browser_click_text_frame' })
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

      case 'browser_type': {
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
        })
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

      case 'browser_type_smart': {
        const target = String(args.target || '').trim()
        const text = String(args.text || '')
        if (!target || text === undefined) return 'Error: target and text are required'
        const clearFirst = args.clear_first !== false
        const submit = args.submit === true
        const tabId = (args.tab_id as string) || null
        const shouldGuardSubmit = submit && await isLikelyChatPage(controller, tabId)
        const rawSmartType = await controller.executeJS(tabId, buildSmartTypeJs({
          target,
          text,
          clearFirst,
          submit: submit && !shouldGuardSubmit,
          allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
        }))
        throwIfLiveTargetGuardBlocked(rawSmartType, { target })
        const result = String(rawSmartType)
        if (shouldGuardSubmit) {
          const attempted: string[] = ['type_smart_submit_guard']
          const submitState = await ensureGeminiSubmitted(controller, tabId, text, attempted, abortSignal)
          const confirmation = submitState.submitted ? await detectBrowserPageTransactionConfirmation(controller, tabId) : null
          return attachBrowserActionSessionOutput(
            `${result}\n[chat-submit-guard] submitted=${submitState.submitted} method=${submitState.method}`,
            {
              toolName,
              args,
              controller,
              sessionId,
              currentUserText,
              tabId,
              confirmation,
              nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
            },
          )
        }
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

      case 'browser_compose_message': {
        const text = String(args.text || '')
        if (!text) return 'Error: text is required'
        const target = String(args.target || '')
        const clearFirst = args.clear_first !== false
        const submit = args.submit !== false
        const tabId = (args.tab_id as string) || null
        const shouldGuardSubmit = submit && await isLikelyChatPage(controller, tabId)
        const rawCompose = await controller.executeJS(tabId, buildSmartTypeJs({
          target,
          text,
          clearFirst,
          submit: submit && !shouldGuardSubmit,
          allowPasswordFill: argsCarryPasswordCue(JSON.stringify(args)),
        }))
        throwIfLiveTargetGuardBlocked(rawCompose, { target })
        const result = String(rawCompose)
        if (shouldGuardSubmit) {
          const attempted: string[] = ['compose_submit_guard']
          const submitState = await ensureGeminiSubmitted(controller, tabId, text, attempted, abortSignal)
          const confirmation = submitState.submitted ? await detectBrowserPageTransactionConfirmation(controller, tabId) : null
          return attachBrowserActionSessionOutput(
            `${result}\n[chat-submit-guard] submitted=${submitState.submitted} method=${submitState.method}`,
            {
              toolName,
              args,
              controller,
              sessionId,
              currentUserText,
              tabId,
              confirmation,
              nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
            },
          )
        }
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

      case 'browser_list_upload_targets': {
        const tabId = (args.tab_id as string) || null
        const targets = await controller.findUploadTargets(tabId)
        return JSON.stringify({
          count: targets.length,
          targets,
        }, null, 2)
      }

      case 'browser_upload_scope_attachment': {
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

      case 'browser_click_at': {
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
        return attachBrowserActionSessionOutput(JSON.stringify({
          ok: true,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          viewport: { width: point.width, height: point.height },
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

      case 'browser_type_at': {
        const x = Number(args.x)
        const y = Number(args.y)
        const text = String(args.text || '')
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y are required numbers'
        if (!text) return 'Error: text is required'
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const pressEnter = args.press_enter !== false
        const clearBeforeTyping = args.clear_before_typing !== false
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
        const confirmation = pressEnter ? await detectBrowserPageTransactionConfirmation(controller, tabId) : null
        return attachBrowserActionSessionOutput(JSON.stringify({
          ok: true,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          submitted: pressEnter,
          text_length: text.length,
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

      case 'browser_scroll_at': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const x = Number(args.x ?? 500)
        const y = Number(args.y ?? 500)
        const direction = String(args.direction || '').toLowerCase()
        if (!['up', 'down', 'left', 'right'].includes(direction)) {
          return 'Error: direction must be up/down/left/right'
        }
        const magnitude = Math.max(40, Math.min(4000, Number(args.magnitude || 800)))
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

      case 'browser_send_keys': {
        const tabId = (args.tab_id as string) || null
        const key = String(args.key || '').trim()
        if (!key) return 'Error: key is required'
        await sendKeyStroke(controller, tabId, key, args.modifiers)
        const confirmation = /^(Enter|Return)$/i.test(key)
          ? await detectBrowserPageTransactionConfirmation(controller, tabId)
          : null
        return attachBrowserActionSessionOutput(`Sent key: ${key}`, {
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

      case 'browser_ask_user_takeover': {
        const callToAction = String(args.call_to_action || '').trim()
        if (!callToAction) return 'Error: call_to_action is required'
        const details = String(args.details || '')
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

      case 'browser_execute_js':
      case 'browser_power_eval':
      case 'browser_power_cdp':
      case 'browser_power_network_trace':
      case 'browser_power_resource_forensics':
      case 'browser_media_download_advanced':
      case 'browser_power_script_run':
        // B4 —— Power 工具组实现体整体搬至 browser-power-tools.ts；
        // attachBrowserActionSessionOutput / runWorkflowStep 留在本文件经
        // ctx 注入（排空合同与 workflow 守卫执行层不外移）。此处必须
        // `return await`，让拒绝仍走本函数的 catch（Abort 重抛/错误拍扁）。
        return await executeBrowserPowerTool(toolName, args, {
          controller,
          abortSignal,
          sessionId,
          currentUserText,
          attachBrowserActionSessionOutput,
          runWorkflowStep,
        })

      case 'browser_collect_images':
      case 'browser_inspect_resources':
      case 'browser_resolve_video':
      case 'browser_download_urls':
      case 'browser_download_collected_media':
      case 'browser_extract_structured':
      case 'browser_scroll_collect':
      case 'browser_start_task':
      case 'browser_get_task':
      case 'browser_resume_task':
      case 'browser_cancel_task':
      case 'browser_aggregate_results':
      case 'browser_download_gallery':
      case 'browser_research_topic':
      case 'browser_run_workflow':
      case 'browser_stage_site_strategy':
      case 'browser_visible_collect':
      case 'browser_collect_notes':
      case 'browser_confirm_collection_consent':
        // B5 —— 采集/内容任务组实现体整体搬至 browser-collection-tools.ts；
        // runWorkflowStep 留在本文件经 ctx 注入（与 browser_search /
        // browser_click_text 共享守卫执行层），candidateTargetUrls / leaseGate /
        // runtime 随调用态传入。此处必须 `return await`，让拒绝仍走本函数的
        // catch（Abort 重抛/ToolDomainError/错误拍扁）。
        return await executeBrowserCollectionTool(toolName, args, {
          controller,
          abortSignal,
          sessionId,
          currentUserText,
          leaseGate,
          runtime,
          candidateTargetUrls,
          runWorkflowStep,
        })

      case 'browser_go_back': {
        const tabId = (args.tab_id as string) || null
        const result = controller.goBack(tabId)
        if (!result.success) return `Error: ${result.error}`
        return 'Navigated back.'
      }

      default:
        return `Unknown browser tool: ${toolName}`
    }
  } catch (error) {
    if (isBrowserAbortError(error)) throw error
    // EP1-T4-2 (browser pilot) — let structured domain errors flow to the
    // dispatcher's error contract (errorKind + envelope) instead of being
    // flattened to a string. No browser handler throws ToolDomainError at
    // HEAD, so this is purely the forward migration path; plain throws keep
    // the legacy string shape below.
    if (error instanceof ToolDomainError) throw error
    const msg = error instanceof Error ? error.message : String(error)
    log(`Browser tool error: ${msg}`)
    return `Error executing ${toolName}: ${msg}`
  } finally {
    gate.end()
  }
}
