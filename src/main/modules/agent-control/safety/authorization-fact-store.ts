/**
 * EP2-I-auth — object-level action authorization facts (approved design
 * 05 §3.4). "用户对哪个对象批准了哪个动作" as a PROVABLE structured fact.
 *
 * Closed write surface — exactly two entries:
 *   recordVerbatimGrant()      sole legal caller: the intent-classifier
 *                              consumption chain (user verbatim).
 *   recordConfirmationGrant()  sole legal caller: the frozen-call
 *                              confirmation release path.
 * `scripts/check-authorization-fact-writes.cjs` turns that whitelist into CI.
 * Third-party content can never become a source — the source enum is closed
 * and no tool-result path may call the write entries (gate-enforced).
 *
 * Consumption: ONE read point — the M3 branch of the confirmation gate.
 * Pre-approval ≠ privilege escalation: admission/authorization/tool policy
 * all still run; M1 never consults this store. Lifetime: 30min TTL inside
 * the session lineage; a user negation revokes the whole category at once
 * (拒绝权优先于既往批准).
 */

import { createHash } from 'node:crypto'

import { logAgentMetric } from '../metrics'
import { isSafeMessageVisibilityEpoch, readScopeContextEpoch } from '../session/scope-context-epoch'

export type AuthActionCategory = 'login' | 'upload' | 'send_external' | 'collect_risky_site'

export interface AuthorizationFact {
  key: string
  objectFingerprint: string
  actionCategory: AuthActionCategory
  source: 'user_verbatim' | 'confirmation_card'
  evidence: string
  scopeId: string
  messageVisibilityEpoch?: number
  createdAt: number
  expiresAt: number
  consumedCount: number
}

export const AUTHORIZATION_FACT_TTL_MS = 30 * 60_000

const factsByScope = new Map<string, Map<string, AuthorizationFact>>()

export function __clearAuthorizationFactsForTests(): void {
  factsByScope.clear()
}

export function clearAuthorizationFactsForScope(scopeId: string): number {
  const normalizedScopeId = String(scopeId || '').trim()
  if (!normalizedScopeId) return 0
  const count = factsByScope.get(normalizedScopeId)?.size ?? 0
  factsByScope.delete(normalizedScopeId)
  return count
}

/** Canonical object id per category (05 §3.4.2). Null = not canonicalizable
 *  → the grant is dropped before storage (模糊请求零事实). */
export function canonicalObjectId(category: AuthActionCategory, objectRef: string): string | null {
  const raw = String(objectRef || '').trim()
  if (!raw) return null
  if (category === 'login' || category === 'collect_risky_site') {
    const domain = raw.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i)?.[1]
    if (domain) return domain.toLowerCase()
    // named platforms ("小红书") are canonical enough for the fingerprint
    return /^[一-龥A-Za-z0-9]{2,12}$/.test(raw) ? raw : null
  }
  if (category === 'upload') {
    return /\.[a-z0-9]{1,8}$/i.test(raw) ? raw : null // must look like a file
  }
  // send_external: recipient/chat identity, must be a compact token
  return /^[\w@:.-]{2,64}$/.test(raw) ? raw : null
}

export function objectFingerprintOf(canonicalId: string): string {
  return createHash('sha256').update(canonicalId).digest('hex')
}

function factKey(fingerprint: string, category: AuthActionCategory): string {
  return `${fingerprint}:${category}`
}

function putFact(fact: AuthorizationFact): AuthorizationFact {
  const scoped = factsByScope.get(fact.scopeId) ?? new Map<string, AuthorizationFact>()
  scoped.set(fact.key, fact)
  factsByScope.set(fact.scopeId, scoped)
  logAgentMetric('authorization_fact_created', {
    scopeId: fact.scopeId,
    actionCategory: fact.actionCategory,
    source: fact.source,
    objectFingerprint: fact.objectFingerprint,
  })
  return fact
}

function buildFact(params: {
  scopeId: string
  actionCategory: AuthActionCategory
  objectRef: string
  source: AuthorizationFact['source']
  evidence: string
  now: number
  ttlMs?: number
  messageVisibilityEpoch?: number
}): AuthorizationFact | null {
  if (!params.scopeId) return null
  const durable = readScopeContextEpoch(params.scopeId)
  if (durable.kind === 'closed' || durable.kind === 'unavailable') return null
  if (
    durable.kind === 'open'
    && params.messageVisibilityEpoch !== durable.messageVisibilityEpoch
  ) return null
  const canonical = canonicalObjectId(params.actionCategory, params.objectRef)
  if (!canonical) return null
  const fingerprint = objectFingerprintOf(canonical)
  return {
    key: factKey(fingerprint, params.actionCategory),
    objectFingerprint: fingerprint,
    actionCategory: params.actionCategory,
    source: params.source,
    evidence: params.evidence,
    scopeId: params.scopeId,
    ...(durable.kind === 'open'
      ? { messageVisibilityEpoch: durable.messageVisibilityEpoch }
      : isSafeMessageVisibilityEpoch(params.messageVisibilityEpoch)
        ? { messageVisibilityEpoch: params.messageVisibilityEpoch }
        : {}),
    createdAt: params.now,
    expiresAt: params.now + (params.ttlMs ?? AUTHORIZATION_FACT_TTL_MS),
    consumedCount: 0,
  }
}

/** WRITE ENTRY 1 — user verbatim (classifier consumption chain only). */
export function recordVerbatimGrant(params: {
  scopeId: string
  actionCategory: AuthActionCategory
  objectRef: string
  verbatim: string
  now?: number
  ttlMs?: number
  messageVisibilityEpoch?: number
}): AuthorizationFact | null {
  const fact = buildFact({
    ...params,
    source: 'user_verbatim',
    evidence: params.verbatim.slice(0, 200),
    now: params.now ?? Date.now(),
  })
  return fact ? putFact(fact) : null
}

/** WRITE ENTRY 2 — confirmation-card release (frozen-call collapse only). */
export function recordConfirmationGrant(params: {
  scopeId: string
  actionCategory: AuthActionCategory
  objectRef: string
  frozenCallId: string
  paramsSha256: string
  now?: number
  ttlMs?: number
  messageVisibilityEpoch?: number
}): AuthorizationFact | null {
  const fact = buildFact({
    ...params,
    source: 'confirmation_card',
    evidence: `frozen:${params.frozenCallId}:${params.paramsSha256}`,
    now: params.now ?? Date.now(),
  })
  return fact ? putFact(fact) : null
}

/** THE single M3 consumption point (action-confirmation-policy adjudication). */
export function consumeAuthorizationFact(params: {
  scopeId: string | null | undefined
  actionCategory: AuthActionCategory
  objectRef: string | null | undefined
  messageVisibilityEpoch?: number
  now?: number
}): boolean {
  if (!params.scopeId || !params.objectRef) return false
  const durable = readScopeContextEpoch(params.scopeId)
  if (durable.kind === 'closed' || durable.kind === 'unavailable') return false
  if (
    durable.kind === 'open'
    && params.messageVisibilityEpoch !== durable.messageVisibilityEpoch
  ) return false
  const canonical = canonicalObjectId(params.actionCategory, params.objectRef)
  if (!canonical) return false
  const scoped = factsByScope.get(params.scopeId)
  if (!scoped) return false
  const key = factKey(objectFingerprintOf(canonical), params.actionCategory)
  const fact = scoped.get(key)
  if (!fact) return false
  if (
    durable.kind === 'open'
    && fact.messageVisibilityEpoch !== durable.messageVisibilityEpoch
  ) {
    scoped.delete(key)
    return false
  }
  const now = params.now ?? Date.now()
  if (now >= fact.expiresAt) {
    scoped.delete(key)
    logAgentMetric('authorization_fact_expired', { scopeId: fact.scopeId, actionCategory: fact.actionCategory })
    return false
  }
  fact.consumedCount += 1
  logAgentMetric('authorization_fact_consumed', {
    scopeId: fact.scopeId,
    actionCategory: fact.actionCategory,
    objectFingerprint: fact.objectFingerprint,
    consumedCount: fact.consumedCount,
  })
  return true
}

/** Negation revocation: 拒绝权优先于既往批准 (05 §3.4.5). */
export function revokeAuthorizationsForCategories(
  scopeId: string,
  categories: ReadonlyArray<AuthActionCategory>,
  messageVisibilityEpoch?: number,
): number {
  const durable = readScopeContextEpoch(scopeId)
  if (durable.kind === 'closed' || durable.kind === 'unavailable') return 0
  if (durable.kind === 'open' && messageVisibilityEpoch !== durable.messageVisibilityEpoch) return 0
  const scoped = factsByScope.get(scopeId)
  if (!scoped) return 0
  let revoked = 0
  for (const [key, fact] of scoped) {
    if (!categories.includes(fact.actionCategory)) continue
    scoped.delete(key)
    revoked += 1
    logAgentMetric('authorization_fact_revoked', { scopeId, actionCategory: fact.actionCategory })
  }
  return revoked
}

/** Negation family → M3 categories affected. */
export function authCategoriesForNegationFamilies(families: ReadonlyArray<string>): AuthActionCategory[] {
  const out: AuthActionCategory[] = []
  if (families.includes('collection')) out.push('collect_risky_site')
  if (families.includes('external_send')) out.push('send_external')
  return out
}

/**
 * Conservative verbatim-grant extraction (v1, deterministic): only forms
 * that EXPLICITLY name object + action produce grants — vague requests
 * yield nothing (确认卫生第二条). Callers must pass USER text only.
 */
export function detectVerbatimGrants(text: string): Array<{ actionCategory: AuthActionCategory; objectRef: string }> {
  const t = String(text || '')
  const out: Array<{ actionCategory: AuthActionCategory; objectRef: string }> = []
  const login = t.match(/登录(?:我的)?\s*([一-龥A-Za-z0-9.-]{2,24}?)(?:的?(?:账号|站点)|[，。,；;\s]|$)/)
  if (login && login[1]) out.push({ actionCategory: 'login', objectRef: login[1] })
  const upload = t.match(/上传\s*([^\s，。;；]+\.[a-z0-9]{1,8})/i)
  if (upload && upload[1]) out.push({ actionCategory: 'upload', objectRef: upload[1] })
  return out
}
