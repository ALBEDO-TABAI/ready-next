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
import {
  BROWSER_PUBLIC_TOOL_NAMES,
  browserToolBaseEffects,
  isBrowserPublicToolName,
  resolveBrowserCapability,
} from '../../../shared/browser-capability-registry'

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
  confirmationSource: BrowserPowerGrant['source'] | null
}

const grantsById = new Map<string, BrowserPowerGrant>()
const auditEvents: BrowserPowerAuditEvent[] = []
let browserPowerGlobalModeReader: (() => boolean) | null = null

export const BROWSER_POWER_TOOL_EFFECT_PROFILES: Record<string, BrowserPowerToolEffectProfile> =
  Object.fromEntries(BROWSER_PUBLIC_TOOL_NAMES.map((name) => [
    name,
    { effects: browserToolBaseEffects(name) },
  ]))

const PRIVATE_POWER_TOOL_NAMES: Readonly<Record<string, string>> = {
  eval: 'browser_eval',
  cdp: 'browser_cdp',
  network_trace: 'browser_network',
  resources_forensics: 'browser_resources',
  download_advanced: 'browser_download',
}

function publicPowerToolName(toolName: string): string {
  return PRIVATE_POWER_TOOL_NAMES[toolName] || toolName
}

export function browserPowerModeEnabled(): boolean {
  if (process.env.READY_BROWSER_POWER_MODE === '1') return true
  try {
    if (browserPowerGlobalModeReader?.() === true) return true
  } catch {
    // Settings are best-effort; per-action capability comes from typed grants.
  }
  return false
}

export function setBrowserPowerGlobalModeReader(reader: (() => boolean) | null): void {
  browserPowerGlobalModeReader = reader
}

export { BROWSER_POWER_MODE_SETTING_KEY }

export function browserToolEffectProfile(toolName: string): BrowserPowerToolEffectProfile | null {
  return BROWSER_POWER_TOOL_EFFECT_PROFILES[publicPowerToolName(toolName)] || null
}

function inferEvalEffects(_code: string): BrowserPowerEffect[] {
  // Arbitrary JavaScript is an escape capability. Its safety cannot be
  // inferred from identifiers, prose, locale, minification, or obfuscation.
  return ['observe', 'page_mutation', 'access_control_circumvention']
}

function inferCdpEffects(method: string, params: Record<string, unknown>): BrowserPowerEffect[] {
  if (/^(?:Network\.getAllCookies|Network\.getCookies|Storage\.getCookies|Storage\.getTrustTokens)$/i.test(method)) {
    return ['observe', 'secret_export']
  }
  if (/^(?:Runtime\.evaluate|Runtime\.callFunctionOn)$/i.test(method)) {
    return ['observe', 'page_mutation', 'access_control_circumvention']
  }
  if (/^(?:Page\.navigate|Page\.reload|Page\.navigateToHistoryEntry)$/i.test(method)) return ['navigate']
  if (/^(?:Input\.|DOM\.set|Emulation\.set|Network\.(?:set|clear)|Page\.set|Storage\.clear|Browser\.setWindowBounds)/i.test(method)) {
    return ['page_mutation']
  }
  if (/^(?:Browser\.setDownloadBehavior|Page\.setDownloadBehavior)$/i.test(method)) return ['download']
  if (/^(?:Network|Page|DOM|Runtime|Accessibility|Performance|CSS|Storage|Browser)\.(?:get|enable|disable|query|describe|capture|snapshot|search|resolve|collect|take|request)/i.test(method)) {
    return ['observe']
  }
  // Unknown CDP commands are not guessed into a non-destructive bucket. They
  // remain usable after a one-shot, exactly bound grant.
  return ['access_control_circumvention']
}

export function inferBrowserPowerEffects(params: {
  toolName: string
  args?: Record<string, unknown>
  fallback?: BrowserPowerEffect[]
}): BrowserPowerEffect[] {
  const args = params.args || {}
  const publicName = publicPowerToolName(params.toolName)
  if (publicName === 'browser_cdp') {
    return inferCdpEffects(
      typeof args.method === 'string' ? args.method : '',
      args.params && typeof args.params === 'object' && !Array.isArray(args.params)
        ? args.params as Record<string, unknown>
        : args,
    )
  }
  if (publicName === 'browser_eval') {
    return inferEvalEffects(typeof args.code === 'string' ? args.code : '')
  }
  if (params.fallback) return [...params.fallback]
  if (!isBrowserPublicToolName(publicName)) {
    throw new Error(`browser_operation_not_registered:${publicName}`)
  }
  const capability = resolveBrowserCapability(publicName, args)
  if (!capability) throw new Error(`browser_operation_not_registered:${publicName}`)
  return [...capability.effects]
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
  runId?: string | null
  taskId?: string | null
  tabId?: string | null
  documentKeyHash?: string | null
  objectRef?: string | null
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
  if (grant.scopeId && (!params.scopeId || grant.scopeId !== params.scopeId)) return { ok: false, reason: 'scope_mismatch' }
  if (grant.runId && (!params.runId || grant.runId !== params.runId)) return { ok: false, reason: 'run_mismatch' }
  if (grant.taskId && (!params.taskId || grant.taskId !== params.taskId)) return { ok: false, reason: 'task_mismatch' }
  if (grant.tabId && (!params.tabId || grant.tabId !== params.tabId)) return { ok: false, reason: 'tab_mismatch' }
  if (grant.documentKeyHash && (!params.documentKeyHash || grant.documentKeyHash !== params.documentKeyHash)) {
    return { ok: false, reason: 'document_mismatch' }
  }
  if (grant.objectRef && (!params.objectRef || grant.objectRef !== params.objectRef)) return { ok: false, reason: 'object_mismatch' }
  if (!grantMatchesUrl(grant, params.url)) return { ok: false, reason: 'url_mismatch' }
  if (grant.destination && (!params.destination || grant.destination !== params.destination)) {
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
  runId?: string | null
  taskId?: string | null
  tabId?: string | null
  documentKeyHash?: string | null
  objectRef?: string | null
  url?: string | null
  destination?: string | null
}): BrowserPowerDecision {
  const effects = normalizeBrowserPowerEffects(params.effects, ['observe'])
  const destructiveEffects = effects.filter(isBrowserDestructiveEffect)
  const powerModeEnabled = browserPowerModeEnabled()
  const grantId = typeof params.grantId === 'string' && params.grantId.trim() ? params.grantId.trim() : ''

  if (grantId) {
    const matched = consumeGrantIfMatched({
      grantId,
      effects,
      scopeId: params.scopeId,
      runId: params.runId,
      taskId: params.taskId,
      tabId: params.tabId,
      documentKeyHash: params.documentKeyHash,
      objectRef: params.objectRef,
      url: params.url,
      destination: params.destination,
    })
    if (matched.ok) {
      return {
        action: 'allow',
        grantId: matched.grant.id,
        effects,
        destructiveEffects,
        reason: 'matching_grant',
        powerModeEnabled,
        confirmationSource: matched.grant.source,
      }
    }
    return { action: 'grant_mismatch', grantId, effects, destructiveEffects, reason: matched.reason, powerModeEnabled, confirmationSource: null }
  }

  if (browserEffectsIncludeDestructive(effects)) {
    return {
      action: 'grant_required',
      grantId: null,
      effects,
      destructiveEffects,
      reason: `destructive_effect_requires_grant:${destructiveEffects.join(',') || BROWSER_DESTRUCTIVE_EFFECTS.join(',')}`,
      powerModeEnabled,
      confirmationSource: null,
    }
  }

  return {
    action: 'allow',
    grantId: 'current-user-nondestructive-power',
    effects,
    destructiveEffects,
    reason: 'nondestructive_effects_are_allowed_on_the_exposed_surface',
    powerModeEnabled,
    confirmationSource: null,
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
