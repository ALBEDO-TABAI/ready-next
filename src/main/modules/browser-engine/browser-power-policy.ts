import { randomUUID } from 'node:crypto'
import {
  BROWSER_DESTRUCTIVE_EFFECTS,
  BROWSER_POWER_MODE_SETTING_KEY,
  type BrowserPowerAuditEvent,
  type BrowserPowerEffect,
  type BrowserPowerGrant,
  browserEffectsIncludeDestructive,
  isBrowserDestructiveEffect,
  normalizeBrowserPowerEffects,
} from '../../../shared/browser-power'

export type BrowserPowerDecisionAction = 'allow' | 'grant_required' | 'grant_mismatch' | 'blocked_by_policy'

export interface BrowserPowerToolEffectProfile {
  effects: BrowserPowerEffect[]
  destructive?: boolean
  deprecated?: boolean
  replacement?: string
}

export interface BrowserPowerDecision {
  action: BrowserPowerDecisionAction
  grantId: string | null
  effects: BrowserPowerEffect[]
  destructiveEffects: BrowserPowerEffect[]
  reason: string
  powerModeEnabled: boolean
}

const grantsById = new Map<string, BrowserPowerGrant>()
const auditEvents: BrowserPowerAuditEvent[] = []
let browserPowerGlobalModeReader: (() => boolean) | null = null

export const BROWSER_POWER_TOOL_EFFECT_PROFILES: Record<string, BrowserPowerToolEffectProfile> = {
  browser_navigate: { effects: ['navigate'] },
  browser_search: { effects: ['navigate'] },
  browser_get_tabs: { effects: ['observe'] },
  browser_read_page: { effects: ['observe'] },
  browser_read_page_map: { effects: ['observe'] },
  browser_probe_readonly: { effects: ['observe'] },
  browser_click: { effects: ['page_mutation'] },
  browser_click_text: { effects: ['page_mutation'] },
  browser_act_on_target: { effects: ['page_mutation'] },
  browser_type: { effects: ['page_mutation'] },
  browser_type_smart: { effects: ['page_mutation'] },
  browser_compose_message: { effects: ['page_mutation', 'external_submit'] },
  browser_capture_viewport: { effects: ['observe'] },
  browser_probe_workflow_state: { effects: ['observe'] },
  browser_locate_action_targets: { effects: ['observe'] },
  browser_locate_input_targets: { effects: ['observe'] },
  browser_analyze_viewport: { effects: ['observe'] },
  browser_list_upload_targets: { effects: ['observe'] },
  browser_upload_scope_attachment: { effects: ['upload'] },
  browser_click_at: { effects: ['page_mutation'] },
  browser_type_at: { effects: ['page_mutation'] },
  browser_scroll_at: { effects: ['page_mutation'] },
  browser_send_keys: { effects: ['page_mutation'] },
  browser_ask_user_takeover: { effects: ['observe'] },
  browser_query_gemini: { effects: ['page_mutation', 'external_submit'] },
  browser_wait: { effects: ['observe'] },
  browser_wait_for_condition: { effects: ['observe'] },
  browser_go_back: { effects: ['navigate'] },
  browser_collect_images: { effects: ['observe'] },
  browser_download_urls: { effects: ['download'] },
  browser_download_collected_media: { effects: ['download'] },
  browser_inspect_resources: { effects: ['observe', 'navigate'] },
  browser_resolve_video: { effects: ['observe'] },
  browser_extract_structured: { effects: ['observe', 'navigate'] },
  browser_scroll_collect: { effects: ['observe', 'page_mutation', 'navigate'] },
  browser_start_task: { effects: ['observe', 'page_mutation', 'navigate'] },
  browser_get_task: { effects: ['observe'] },
  browser_resume_task: { effects: ['observe', 'page_mutation', 'navigate'] },
  browser_cancel_task: { effects: ['observe'] },
  browser_aggregate_results: { effects: ['observe'] },
  browser_download_gallery: { effects: ['observe', 'download', 'navigate'] },
  browser_research_topic: { effects: ['observe', 'navigate'] },
  browser_run_workflow: { effects: ['page_mutation'], deprecated: true, replacement: 'browser_power_script_run' },
  browser_execute_js: { effects: ['page_mutation'], deprecated: true, replacement: 'browser_power_eval' },
  browser_power_eval: { effects: ['observe', 'page_mutation'] },
  browser_power_cdp: { effects: ['observe', 'page_mutation'] },
  browser_power_network_trace: { effects: ['observe', 'navigate'] },
  browser_power_resource_forensics: { effects: ['observe', 'navigate', 'download'] },
  browser_power_script_run: { effects: ['page_mutation'] },
  browser_media_download_advanced: { effects: ['download'] },
  browser_stage_site_strategy: { effects: ['observe'] },
  browser_visible_collect: { effects: ['observe', 'page_mutation', 'navigate'] },
  browser_collect_notes: { effects: ['observe', 'page_mutation', 'download', 'navigate'] },
  browser_confirm_collection_consent: { effects: ['observe'] },
}

export function browserPowerModeEnabled(currentUserText?: string | null): boolean {
  if (process.env.READY_BROWSER_POWER_MODE === '1') return true
  try {
    if (browserPowerGlobalModeReader?.() === true) return true
  } catch {
    // Settings are best-effort here; explicit per-run wording and grants still work.
  }
  const text = String(currentUserText || '')
  return /power\s*browser|web-access|自由\s*(?:js|脚本|eval)|\bcdp\b|网络追踪|监听网络|资源嗅探|嗅探|下载.{0,12}(?:视频|音频|资源)|(?:视频|音频|媒体).{0,12}下载/i.test(text)
}

export function setBrowserPowerGlobalModeReader(reader: (() => boolean) | null): void {
  browserPowerGlobalModeReader = reader
}

export { BROWSER_POWER_MODE_SETTING_KEY }

export function browserToolEffectProfile(toolName: string): BrowserPowerToolEffectProfile | null {
  return BROWSER_POWER_TOOL_EFFECT_PROFILES[toolName] || null
}

export function inferBrowserPowerEffects(params: {
  toolName: string
  args?: Record<string, unknown>
  fallback?: BrowserPowerEffect[]
}): BrowserPowerEffect[] {
  const args = params.args || {}
  const profile = browserToolEffectProfile(params.toolName)
  const fallback = params.fallback || profile?.effects || ['observe']
  const direct = normalizeBrowserPowerEffects(args.expected_effects, fallback)
  if (params.toolName !== 'browser_power_cdp') return direct

  const method = typeof args.method === 'string' ? args.method : ''
  if (/^(Runtime\.evaluate|Runtime\.callFunctionOn)$/i.test(method)) return direct
  if (/^(Network|Page|DOM|Runtime)\.(get|enable|disable|query|describe|capture|screenshot|snapshot|evaluateOnNewDocument)/i.test(method)) {
    return normalizeBrowserPowerEffects(args.expected_effects, ['observe'])
  }
  return normalizeBrowserPowerEffects(args.expected_effects, ['page_mutation'])
}

export function registerBrowserPowerGrant(input: Omit<BrowserPowerGrant, 'id' | 'createdAt'> & { id?: string }): BrowserPowerGrant {
  const now = Date.now()
  const grant: BrowserPowerGrant = {
    ...input,
    id: input.id || `browser-power-grant-${randomUUID()}`,
    createdAt: now,
    expiresAt: Number.isFinite(input.expiresAt) ? input.expiresAt : now + 30 * 60 * 1000,
    effects: normalizeBrowserPowerEffects(input.effects, ['observe']),
  }
  grantsById.set(grant.id, grant)
  return grant
}

export function __clearBrowserPowerPolicyForTests(): void {
  grantsById.clear()
  auditEvents.length = 0
  browserPowerGlobalModeReader = null
}

export function __browserPowerAuditEventsForTests(): BrowserPowerAuditEvent[] {
  return auditEvents.slice()
}

export function recordBrowserPowerAuditEvent(event: Omit<BrowserPowerAuditEvent, 'id' | 'createdAt'>): BrowserPowerAuditEvent {
  const audit: BrowserPowerAuditEvent = {
    ...event,
    id: `browser-power-audit-${randomUUID()}`,
    createdAt: Date.now(),
  }
  auditEvents.push(audit)
  while (auditEvents.length > 500) auditEvents.shift()
  return audit
}

function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function grantMatchesUrl(grant: BrowserPowerGrant, url: string | null | undefined): boolean {
  if (!grant.hostname && !grant.urlPattern) return true
  const raw = String(url || '')
  if (grant.hostname) {
    const host = hostnameOf(raw)
    if (!host || (host !== grant.hostname.toLowerCase() && !host.endsWith(`.${grant.hostname.toLowerCase()}`))) return false
  }
  if (grant.urlPattern) {
    if (!raw.includes(grant.urlPattern)) return false
  }
  return true
}

function consumeGrantIfMatched(params: {
  grantId: string
  effects: BrowserPowerEffect[]
  scopeId?: string | null
  tabId?: string | null
  url?: string | null
  destination?: string | null
}): { ok: true; grant: BrowserPowerGrant } | { ok: false; reason: string } {
  const grant = grantsById.get(params.grantId)
  if (!grant) return { ok: false, reason: 'grant_not_found' }
  const now = Date.now()
  if (grant.expiresAt <= now) return { ok: false, reason: 'grant_expired' }
  if (grant.remainingCalls !== null && grant.remainingCalls !== undefined && grant.remainingCalls <= 0) {
    return { ok: false, reason: 'grant_exhausted' }
  }
  if (grant.scopeId && params.scopeId && grant.scopeId !== params.scopeId) return { ok: false, reason: 'scope_mismatch' }
  if (grant.tabId && params.tabId && grant.tabId !== params.tabId) return { ok: false, reason: 'tab_mismatch' }
  if (!grantMatchesUrl(grant, params.url)) return { ok: false, reason: 'url_mismatch' }
  if (grant.destination && params.destination && grant.destination !== params.destination) {
    return { ok: false, reason: 'destination_mismatch' }
  }
  const effectSet = new Set(grant.effects)
  for (const effect of params.effects) {
    if (!effectSet.has(effect)) return { ok: false, reason: `effect_mismatch:${effect}` }
  }
  if (typeof grant.remainingCalls === 'number') {
    grant.remainingCalls -= 1
    grantsById.set(grant.id, grant)
  }
  return { ok: true, grant }
}

export function resolveBrowserPowerAuthorization(params: {
  toolName: string
  args?: Record<string, unknown>
  effects: BrowserPowerEffect[]
  grantId?: string | null
  scopeId?: string | null
  tabId?: string | null
  url?: string | null
  destination?: string | null
  currentUserText?: string | null
}): BrowserPowerDecision {
  const effects = normalizeBrowserPowerEffects(params.effects, ['observe'])
  const destructiveEffects = effects.filter(isBrowserDestructiveEffect)
  const powerModeEnabled = browserPowerModeEnabled(params.currentUserText)
  const grantId = typeof params.grantId === 'string' && params.grantId.trim() ? params.grantId.trim() : ''

  if (grantId) {
    const matched = consumeGrantIfMatched({
      grantId,
      effects,
      scopeId: params.scopeId,
      tabId: params.tabId,
      url: params.url,
      destination: params.destination,
    })
    if (matched.ok) {
      return { action: 'allow', grantId: matched.grant.id, effects, destructiveEffects, reason: 'matching_grant', powerModeEnabled }
    }
    return { action: 'grant_mismatch', grantId, effects, destructiveEffects, reason: matched.reason, powerModeEnabled }
  }

  if (browserEffectsIncludeDestructive(effects)) {
    return {
      action: 'grant_required',
      grantId: null,
      effects,
      destructiveEffects,
      reason: `destructive_effect_requires_grant:${destructiveEffects.join(',') || BROWSER_DESTRUCTIVE_EFFECTS.join(',')}`,
      powerModeEnabled,
    }
  }

  if (!powerModeEnabled) {
    return {
      action: 'grant_required',
      grantId: null,
      effects,
      destructiveEffects,
      reason: 'power_mode_not_enabled',
      powerModeEnabled,
    }
  }

  return {
    action: 'allow',
    grantId: 'current-user-nondestructive-power',
    effects,
    destructiveEffects,
    reason: 'current_user_text_or_setting_enables_nondestructive_power',
    powerModeEnabled,
  }
}

export function browserPowerGrantRequiredPayload(decision: BrowserPowerDecision, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: false,
    errorKind: decision.action,
    errorCode: decision.action,
    message: decision.action === 'grant_mismatch'
      ? `Power Browser 授权不匹配：${decision.reason}`
      : `Power Browser 需要用户授权：${decision.reason}`,
    requiredEffects: decision.effects,
    destructiveEffects: decision.destructiveEffects,
    powerModeEnabled: decision.powerModeEnabled,
    ...(extra || {}),
  }
}
