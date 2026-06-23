import { BeliefCardStore, type BeliefCardFrontmatter } from './belief-card-store'
import {
  FAILURE_LEARNING_PREFIX,
  POSSIBLE_RISK_UPDATE_OF_PREFIX,
  POSSIBLE_UPDATE_OF_PREFIX,
} from './reserved-card-source'

export const SITE_CARD_FAILURE_KINDS = [
  'login_wall',
  'captcha_or_risk_challenge',
  'risk_control_or_waf',
  'selector_missing',
  'script_detection',
  'rate_limited',
] as const

export type SiteCardFailureKind = (typeof SITE_CARD_FAILURE_KINDS)[number]

export interface SiteCardLearningSignal {
  domain: string
  failureKind: string
  detail: string
  now?: Date
  hardBlocked?: boolean
}

export interface CheckInSiteCardLearningInput {
  domain?: string | null
  url?: string | null
  blockers: readonly string[]
  now?: Date
}

export interface ToolFailureSiteCardLearningInput {
  toolName: string
  errorKind?: string | null
  args?: unknown
  data?: unknown
  text?: string | null
  now?: Date
}

export type SiteCardLearningResult =
  | { status: 'written'; relPath: string; mode: 'new-card' | 'sidecar-update' | 'risk-suggestion' }
  | { status: 'skipped'; reason: string; relPath?: string }
  | { status: 'rejected'; reason: string }

function hasFailureEvidence(card: { body: string } | null, date: string, failureKind: SiteCardFailureKind): boolean {
  if (!card) return false
  return card.body.includes(`${date} ${failureKind}:`)
}

function normalizeDomain(domain: string): string | null {
  const normalized = String(domain || '').trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : null
}

function normalizeFailureKind(kind: string): SiteCardFailureKind | null {
  const normalized = String(kind || '').trim().toLowerCase().replace(/[-\s]+/g, '_')
  return (SITE_CARD_FAILURE_KINDS as readonly string[]).includes(normalized)
    ? normalized as SiteCardFailureKind
    : null
}

const FAILURE_KIND_ALIASES: Record<string, SiteCardFailureKind> = {
  auth_required: 'login_wall',
  clip_login_required: 'login_wall',
  login_required: 'login_wall',
  login_wall: 'login_wall',
  captcha_required: 'captcha_or_risk_challenge',
  captcha_or_risk_challenge: 'captcha_or_risk_challenge',
  risk_challenge: 'captcha_or_risk_challenge',
  risk_control: 'risk_control_or_waf',
  risk_control_or_waf: 'risk_control_or_waf',
  waf_blocked: 'risk_control_or_waf',
  card_not_found: 'selector_missing',
  detail_mismatch: 'selector_missing',
  detail_not_opened: 'selector_missing',
  no_images: 'selector_missing',
  selector_mismatch: 'selector_missing',
  selector_missing: 'selector_missing',
  script_failed_to_execute: 'selector_missing',
  automation_detected: 'script_detection',
  bot_detected: 'script_detection',
  script_detection: 'script_detection',
  queued_global_concurrency: 'rate_limited',
  rate_limited: 'rate_limited',
  too_many_requests: 'rate_limited',
}

const POLICY_REFUSAL_CODES = new Set([
  'blocked_external',
  'forbidden_action',
  'high_control_url_batch_denied',
  'partial_collection_consent_required',
  'permission_denied',
  'provenance_required',
  'tool_authorization_denied',
  'url_provenance_required',
])

function normalizeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_')
  return normalized || null
}

function failureKindFromCode(value: unknown): SiteCardFailureKind | null {
  const code = normalizeCode(value)
  if (!code || POLICY_REFUSAL_CODES.has(code)) return null
  return normalizeFailureKind(code) || FAILURE_KIND_ALIASES[code] || null
}

function domainFromUrl(value: string | null | undefined): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  try {
    return normalizeDomain(new URL(raw).hostname)
  } catch {
    return null
  }
}

function firstKnownUrl(value: unknown, depth = 0): string | null {
  if (depth > 3 || value == null) return null
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value.trim()) ? value.trim() : null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstKnownUrl(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of ['url', 'targetUrl', 'sourceUrl', 'openUrl', 'currentUrl', 'href', 'containerPath']) {
    const found = firstKnownUrl(record[key], depth + 1)
    if (found) return found
  }
  for (const item of Object.values(record)) {
    const found = firstKnownUrl(item, depth + 1)
    if (found) return found
  }
  return null
}

function compactStrings(value: unknown, depth = 0): string[] {
  if (depth > 2 || value == null) return []
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)]
  }
  if (Array.isArray(value)) return value.flatMap((item) => compactStrings(item, depth + 1)).slice(0, 12)
  if (typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => [key, ...compactStrings(item, depth + 1)])
    .slice(0, 12)
}

function browserLearningToolName(toolName: string): boolean {
  const normalized = String(toolName || '').trim()
  return normalized.startsWith('browser_')
    || normalized.startsWith('web_clip')
    || normalized.includes('visible_collect')
    || normalized.includes('note_collect')
}

function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'failure'
}

function isRiskSuggestion(kind: SiteCardFailureKind): boolean {
  return kind === 'captcha_or_risk_challenge' || kind === 'risk_control_or_waf' || kind === 'script_detection'
}

function explicitCheckInFailureKind(blocker: string): SiteCardFailureKind | null {
  const match = blocker.match(/(?:^|\s)site_failure:([a-z0-9_-]+)(?::|\s|$)/i)
  return match ? failureKindFromCode(match[1]) : null
}

function toolFailureKind(input: ToolFailureSiteCardLearningInput): SiteCardFailureKind | null {
  const record = input.data && typeof input.data === 'object'
    ? input.data as Record<string, unknown>
    : {}
  return failureKindFromCode(input.errorKind)
    || failureKindFromCode(record.errorKind)
    || failureKindFromCode(record.errorCode)
    || failureKindFromCode(record.reason)
    || failureKindFromCode(record.code)
}

export function siteCardLearningSignalsFromCheckIn(input: CheckInSiteCardLearningInput): SiteCardLearningSignal[] {
  const domain = normalizeDomain(input.domain || '')
    || domainFromUrl(input.url)
    || domainFromUrl(firstKnownUrl(input.blockers))
  if (!domain) return []
  const out: SiteCardLearningSignal[] = []
  const seen = new Set<string>()
  for (const blocker of input.blockers) {
    const failureKind = explicitCheckInFailureKind(blocker)
    if (!failureKind || seen.has(failureKind)) continue
    seen.add(failureKind)
    out.push({
      domain,
      failureKind,
      detail: `checkin blocker: ${String(blocker).slice(0, 180)}`,
      now: input.now,
    })
  }
  return out
}

export function siteCardLearningSignalFromToolFailure(input: ToolFailureSiteCardLearningInput): SiteCardLearningSignal | null {
  if (!browserLearningToolName(input.toolName)) return null
  const url = firstKnownUrl(input.args) || firstKnownUrl(input.data)
  const domain = domainFromUrl(url)
  if (!domain) return null
  const failureKind = toolFailureKind(input)
  if (!failureKind) return null
  const detailText = [
    input.errorKind || '',
    input.text || '',
    ...compactStrings(input.data),
  ].join(' ')
  return {
    domain,
    failureKind,
    detail: `${input.toolName} ${input.errorKind || 'structured_failure'}: ${detailText.trim().slice(0, 180)}`,
    now: input.now,
  }
}

export function learnSiteCardFromFailure(store: BeliefCardStore, signal: SiteCardLearningSignal): SiteCardLearningResult {
  if (signal.hardBlocked) return { status: 'rejected', reason: 'hard_blocked_site_is_read_only' }
  const domain = normalizeDomain(signal.domain)
  if (!domain) return { status: 'rejected', reason: 'invalid_domain' }
  const failureKind = normalizeFailureKind(signal.failureKind)
  if (!failureKind) return { status: 'rejected', reason: 'unknown_failure_kind' }

  const now = signal.now ?? new Date()
  const date = now.toISOString().slice(0, 10)
  const existingRelPath = `knowledge/sites/${domain}.md`
  const existing = store.readCard(existingRelPath, { includeStaged: true })
  if (hasFailureEvidence(existing, date, failureKind)) {
    return { status: 'skipped', reason: 'same_day_duplicate', relPath: existingRelPath }
  }
  const mode: 'new-card' | 'sidecar-update' | 'risk-suggestion' = existing
    ? isRiskSuggestion(failureKind) ? 'risk-suggestion' : 'sidecar-update'
    : 'new-card'
  const relPath = existing
    ? `knowledge/sites/${domain}-${slugPart(failureKind)}-${date}.md`
    : existingRelPath

  if (store.readCard(relPath, { includeStaged: true })) {
    return { status: 'skipped', reason: 'same_day_duplicate', relPath }
  }

  const source = existing
    ? mode === 'risk-suggestion'
      ? `${POSSIBLE_RISK_UPDATE_OF_PREFIX}${existingRelPath}`
      : `${POSSIBLE_UPDATE_OF_PREFIX}${existingRelPath}`
    : `${FAILURE_LEARNING_PREFIX}${failureKind}`

  const frontmatter: BeliefCardFrontmatter = {
    title: existing ? `${domain} 失败经验建议` : `${domain} 站点经验`,
    description: `${date} ${failureKind}: ${signal.detail.slice(0, 96)}`,
    confidence: 'M',
    tag: 'knowledge',
    created: date,
    status: 'staged',
    site: domain,
    source,
  }
  const body = [
    `- ${date} ${failureKind}: ${signal.detail}`,
    '',
    existing
      ? `这是一张旁卡；确认后再合并到 ${existingRelPath}。`
      : '这是一张新站点经验卡；确认后才会进入站点经验提示。',
  ].join('\n')
  const written = store.writeCard({ relPath, frontmatter, body })
  if (!written.ok) return { status: 'rejected', reason: written.reason }
  return { status: 'written', relPath, mode }
}
