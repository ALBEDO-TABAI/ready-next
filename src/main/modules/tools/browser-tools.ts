/**
 * Browser tool definitions + executor for AI tool calling.
 * Provides browser control tools in both Anthropic and OpenAI formats.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import { basename, extname, join } from 'path'
import { compileBrowserReadonlyScriptTemplate } from './browser-readonly-script-templates'
import type { BrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import { consumePendingBrowserSitePermissionNotices } from '../browser-engine/browser-permission-policy'
import { createRotatingLogger } from '../../utils/rotating-logger'
import {
  getBrowserAnthropicTools,
  getBrowserOpenAITools,
} from './browser-tool-catalog'
import { beginLeaseGate, type BrowserLeaseGate } from '../browser-engine/agent-browser-lease-gate'
import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'
import { agentBrowserError } from '../browser-engine/agent-browser-errors'
import { ToolDomainError } from './tool-errors'
import { resolveBrowserWorkflowIntent } from '../../../shared/browser-workflow-intent'
import {
  buildBrowserActionSessionProgress,
  noteBrowserActionSession,
  type BrowserActionSessionProgress,
  type BrowserTransactionConfirmation,
} from '../browser-engine/browser-action-session'
import { BROWSER_DESTRUCTIVE_TARGET_REGEX_SOURCES } from '../agent-control/safety/action-confirmation-policy'
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
import { createBrowserStructuredJsonText as browserStructuredJsonText } from './browser-failure-output'

import {
  buildInputGuardSnippetJs,
  probeCoordinateTargetOrThrow,
  buildFocusedFieldProbeJs,
} from './browser-probe'
export { normalizeDownloadTargets, pinimgOriginalsUrl } from './browser-media-download'
import {
  BROWSER_V2_STOP_LOADING_TIMEOUT_MS,
  clearFocusedInput,
  isBrowserAbortError,
  normalizeErrorCode,
  throwIfAborted,
  waitForLoadingStop,
} from './browser-input-actions'
import {
  browserPowerDeniedOutput,
  executeBrowserPowerTool,
  resolvePowerDecisionForTool,
  summarizeCodeForAudit,
} from './browser-power-tools'
import { executeBrowserCollectionTool } from './browser-collection-tools'
import { executeBrowserObserveTool } from './browser-observe-tools'
import { executeBrowserActTool, runWorkflowStep } from './browser-act-tools'
import {
  activeBrowserToolUrl,
  browserStructuredErrorOutput,
  type BrowserActionFollowedTab,
} from './browser-tool-shared'

const logger = createRotatingLogger('ready-tools.log')
function log(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
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

export async function executeBrowserTool(
  toolName: string,
  args: Record<string, unknown>,
  controller: BrowserController,
  abortSignal?: AbortSignal,
  sessionId?: string,
  leaseGate?: BrowserLeaseGate,
  currentUserText?: string,
  runtime?: AgentControlRuntime | null,
  taskExecutionContext?: {
    ownerAgentId?: string | null
    ownerRunId?: string | null
    parentTaskId?: string | null
    executionBinding?: import('../../../shared/agent-execution-profile').TaskExecutionBinding | null
  },
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
          taskExecutionContext,
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
          taskExecutionContext,
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
      case 'browser_navigate':
      case 'browser_search':
      case 'browser_act_on_target':
      case 'browser_click':
      case 'browser_click_text':
      case 'browser_type':
      case 'browser_type_smart':
      case 'browser_compose_message':
      case 'browser_list_upload_targets':
      case 'browser_upload_scope_attachment':
      case 'browser_click_at':
      case 'browser_type_at':
      case 'browser_scroll_at':
      case 'browser_send_keys':
      case 'browser_ask_user_takeover':
      case 'browser_go_back':
        // B7 —— 行动/导航组实现体整体搬至 browser-act-tools.ts；runWorkflowStep
        // 随组迁移并由本文件 import 回引注入 power/collection ctx；页面地图
        // generation/ambiguity 经 act→observe 单向 import 回读；
        // attachBrowserActionSessionOutput（排空合同红线）留在本文件经 ctx
        // 注入。此处必须 `return await`，让拒绝仍走本函数的 catch（Abort
        // 重抛/ToolDomainError/错误拍扁）。
        return await executeBrowserActTool(toolName, args, {
          controller,
          abortSignal,
          sessionId,
          currentUserText,
          attachBrowserActionSessionOutput,
        })

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

      case 'browser_execute_js':
      case 'browser_power_eval':
      case 'browser_power_cdp':
      case 'browser_power_network_trace':
      case 'browser_power_resource_forensics':
      case 'browser_media_download_advanced':
      case 'browser_power_script_run':
        // B4 —— Power 工具组实现体整体搬至 browser-power-tools.ts；
        // attachBrowserActionSessionOutput 留在本文件经 ctx 注入（排空合同
        // 不外移），runWorkflowStep 自 B7 起随行动组迁至 browser-act-tools
        // 并经 import 回引注入。此处必须 `return await`，让拒绝仍走本函数
        // 的 catch（Abort 重抛/错误拍扁）。
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
        // runWorkflowStep 自 B7 起随行动组迁至 browser-act-tools 并经 import
        // 回引注入（与 browser_search / browser_click_text 同组共享守卫执行
        // 层），candidateTargetUrls / leaseGate / runtime 随调用态传入。此处
        // 必须 `return await`，让拒绝仍走本函数的 catch（Abort 重抛/
        // ToolDomainError/错误拍扁）。
        return await executeBrowserCollectionTool(toolName, args, {
          controller,
          abortSignal,
          sessionId,
          currentUserText,
          leaseGate,
          runtime,
          candidateTargetUrls,
          runWorkflowStep,
          taskExecutionContext,
        })

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
