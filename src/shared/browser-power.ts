export const BROWSER_POWER_EFFECTS = [
  'observe',
  'navigate',
  'page_mutation',
  'download',
  'upload',
  'external_submit',
  'credential_use',
  'challenge_interaction',
  'payment',
  'remote_delete',
  'account_delete',
  'credential_change',
  'secret_export',
  'access_control_circumvention',
] as const

export const BROWSER_POWER_MODE_SETTING_KEY = 'browser_power_mode_enabled'

export type BrowserPowerEffect = (typeof BROWSER_POWER_EFFECTS)[number]

export const BROWSER_DESTRUCTIVE_EFFECTS = [
  'payment',
  'remote_delete',
  'account_delete',
  'credential_change',
  'secret_export',
  'access_control_circumvention',
] as const satisfies readonly BrowserPowerEffect[]

export type BrowserDestructiveEffect = (typeof BROWSER_DESTRUCTIVE_EFFECTS)[number]

const DESTRUCTIVE_EFFECT_SET: ReadonlySet<BrowserPowerEffect> = new Set(BROWSER_DESTRUCTIVE_EFFECTS)

export interface BrowserPowerGrant {
  id: string
  scopeId?: string | null
  tabId?: string | null
  urlPattern?: string | null
  hostname?: string | null
  destination?: string | null
  effects: BrowserPowerEffect[]
  expiresAt: number
  remainingCalls?: number | null
  source: 'current_user_verbatim' | 'confirmation_card' | 'settings' | 'test'
  createdAt: number
  reason?: string | null
}

export interface BrowserPowerAuditEvent {
  id: string
  toolName: string
  grantId: string | null
  tabId: string | null
  url: string | null
  effects: BrowserPowerEffect[]
  purpose: string | null
  codeSummary?: string | null
  paramsSummary?: Record<string, unknown> | null
  resultSummary?: Record<string, unknown> | null
  createdAt: number
}

export interface BrowserResourceCandidateV2 {
  url: string
  kind: 'video' | 'audio' | 'image' | 'document' | 'json' | 'stream' | 'unknown'
  source: 'dom' | 'performance' | 'network' | 'response_body' | 'cdp_trace' | 'power_eval'
  mimeType?: string
  status?: number
  score?: number
  evidence: string[]
  referer?: string
  downloadHeaders?: Record<string, string>
  segments?: string[]
}

export interface BrowserMediaVerification {
  ok: boolean
  filePath?: string
  fileSize?: number
  durationSec?: number
  hasVideo?: boolean
  hasAudio?: boolean
  width?: number
  height?: number
  codecSummary?: string
  error?: string
}

export function isBrowserDestructiveEffect(effect: BrowserPowerEffect): effect is BrowserDestructiveEffect {
  return DESTRUCTIVE_EFFECT_SET.has(effect)
}

export function browserEffectsIncludeDestructive(effects: readonly BrowserPowerEffect[]): boolean {
  return effects.some(isBrowserDestructiveEffect)
}

export function normalizeBrowserPowerEffects(values: unknown, fallback: BrowserPowerEffect[]): BrowserPowerEffect[] {
  const input = Array.isArray(values) ? values : []
  const allowed = new Set<BrowserPowerEffect>(BROWSER_POWER_EFFECTS)
  const out: BrowserPowerEffect[] = []
  for (const value of input) {
    if (typeof value !== 'string') continue
    if (!allowed.has(value as BrowserPowerEffect)) continue
    if (!out.includes(value as BrowserPowerEffect)) out.push(value as BrowserPowerEffect)
  }
  return out.length > 0 ? out : fallback
}
