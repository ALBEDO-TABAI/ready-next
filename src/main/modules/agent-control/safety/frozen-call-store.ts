/**
 * EP1-I3-2 — Frozen-call store (确认闸门的冻结/放行账本).
 *
 * Design source: docs/agent-evolution/05-意图理解与行动确认设计明细.md §3.2.
 * Contract:      docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md (EP1-I3-2).
 *
 * Execution model is "原 run 内同步等待": the gate freezes the ORIGINAL
 * tool_use params here, suspends inside the live tool-execution context,
 * and — after user confirmation — releases the frozen params back into the
 * SAME dispatch path. Consequences this store enforces:
 *
 *   - The frozen record stores tool_name + params only, never runtime state.
 *     Runtime state (abortSignal / browserController / allowedToolNames /
 *     scope) stays alive in the waiting call frame; that is exactly why the
 *     release token is memory-only: after a process restart no context
 *     exists to resume into, so DB-pending orphans can only expire.
 *   - `release(id, token)` is the ONLY way to obtain the frozen params for
 *     execution. It flips pending → released atomically (in-process,
 *     single-threaded) so a frozen call releases exactly once. The token
 *     skips nothing but the re-confirmation — admission checks rerun in the
 *     dispatcher.
 *   - Expiry (default TTL 10 min), denial and release are terminal; a
 *     non-pending record can never be released (绝不在上下文失效后补执行).
 *   - Single pending per session/scope: `freeze` rejects when another
 *     pending record exists for the same session, so the model reroutes.
 *
 * DB rows (migration 053 `pending_confirmations`) are the durable audit
 * ledger; the in-memory map is the runtime authority. DB write failures are
 * surfaced as `store_unavailable` (freeze refuses — never execute an
 * unconfirmable call silently).
 */

import { createHash, randomUUID } from 'node:crypto'

import { digestCanonicalJson } from '../codex-runtime/codex-model-gateway-contract'

export type FrozenCallStatus = 'pending' | 'released' | 'denied' | 'expired'

// ---------------------------------------------------------------------------
// Audit redaction (Codex review P1#4). The FULL params live only in this
// process's memory (the byte-identical release source). Everything durable or
// user-visible — the pending_confirmations row, the confirmation-card text,
// metrics — gets a REDACTED copy plus a sha256 of the frozen bytes, so
// credentials typed into login/captcha fields or carried in outbound messages
// never land in SQLite, chat_messages, or logs.
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN =
  /pass(word)?|passwd|secret|token|credential|api[_-]?key|cookie|authorization|私钥|口令|密码|身份证|银行卡|cvv|pin/i
const SENSITIVE_VALUE_PATTERN =
  /密码|口令|私钥|身份证|银行卡|credit\s*card|cvv|bearer\s+[a-z0-9]/i
/** Structural enum-ish fields that stay readable even under redact-all. */
const STRUCTURAL_AUDIT_KEYS = new Set([
  'action', 'kind', 'msg_type', 'read_back', 'confirmedVia', 'file_type', 'tab_id',
])
const REDACTED_PLACEHOLDER = '«redacted»'
export const AUDIT_SUMMARY_MAX_CHARS = 140

/**
 * Single-line redacted summary for the CONFIRMATION CARD only. The card must
 * show the user WHAT object they are approving (05 §3.2 动作+对象+风险), so
 * non-sensitive values stay readable here; sensitive keys/values — and, for
 * sensitive rules, every free-text value — are masked before the text leaves
 * memory. Durable audit surfaces (DB row, metrics) never get values at all —
 * see buildAuditShape().
 */
export function buildAuditSummary(
  params: Record<string, unknown>,
  opts?: { redactAllStrings?: boolean },
): string {
  let json: string
  try {
    json = JSON.stringify(redactParamsForAudit(params, opts)) ?? '{}'
  } catch {
    // silent-catch: unserializable params degrade to the '{}' audit summary
    json = '{}'
  }
  return json.length > AUDIT_SUMMARY_MAX_CHARS ? `${json.slice(0, AUDIT_SUMMARY_MAX_CHARS)}…` : json
}

/**
 * Value-free structural shape for durable audit surfaces (the
 * pending_confirmations row). No parameter VALUE — sensitive or not — is
 * persisted; the sha256 fingerprint identifies the frozen bytes, and the
 * chat-message card (already redacted) is the human-readable record of what
 * the user approved.
 */
export function buildAuditShape(value: unknown): unknown {
  if (Array.isArray(value)) return `<array(${value.length})>`
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = v && typeof v === 'object' ? buildAuditShape(v) : `<${v === null ? 'null' : typeof v}>`
    }
    return out
  }
  return `<${value === null ? 'null' : typeof value}>`
}

export function redactParamsForAudit(
  value: unknown,
  opts?: { redactAllStrings?: boolean },
  key?: string,
): unknown {
  if (typeof value === 'string') {
    if (key && STRUCTURAL_AUDIT_KEYS.has(key)) return value
    if (opts?.redactAllStrings) return REDACTED_PLACEHOLDER
    if (key && SENSITIVE_KEY_PATTERN.test(key)) return REDACTED_PLACEHOLDER
    if (SENSITIVE_VALUE_PATTERN.test(value)) return REDACTED_PLACEHOLDER
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactParamsForAudit(item, opts, key))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactParamsForAudit(v, opts, k)
    }
    return out
  }
  return value
}

export interface FrozenCallDbStatement {
  run(...params: unknown[]): unknown
  get?<T = unknown>(...params: unknown[]): T | undefined
}

export interface FrozenCallDb {
  prepare(sql: string): FrozenCallDbStatement
  exec?(sql: string): void
  readonly inTransaction?: boolean
}

export interface FrozenCallRecordView {
  id: string
  runId: string | null
  taskId: string | null
  scopeId: string | null
  sessionId: string | null
  toolName: string
  paramsJson: string
  createdAt: number
  expiresAt: number
  status: FrozenCallStatus
  pendingConfirmationSourceDigest: string
}

interface FrozenCallRecord extends FrozenCallRecordView {
  token: string
  releasedAt: number | null
}

export function buildFrozenCallPendingSourceDigest(input: {
  id: string
  runId: string | null
  taskId: string | null
  scopeId: string | null
  toolName: string
  paramsJson: string
  createdAt: string
  expiresAt: string
}): string {
  return digestCanonicalJson(input)
}

function toRecordView(record: FrozenCallRecord): FrozenCallRecordView {
  return {
    id: record.id,
    runId: record.runId,
    taskId: record.taskId,
    scopeId: record.scopeId,
    sessionId: record.sessionId,
    toolName: record.toolName,
    paramsJson: record.paramsJson,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status: record.status,
    pendingConfirmationSourceDigest: record.pendingConfirmationSourceDigest,
  }
}

export interface FreezeArgs {
  toolName: string
  params: Record<string, unknown>
  runId?: string | null
  taskId?: string | null
  scopeId?: string | null
  sessionId?: string | null
  ttlMs?: number
  /**
   * The matched policy rule deals in credentials / sensitive payloads
   * (login fill, sensitive outbound send) — the audit copy masks ALL
   * free-text values, not just sensitively-named keys.
   */
  sensitiveParams?: boolean
}

export type FreezeResult =
  | {
      ok: true
      id: string
      token: string
      expiresAt: number
      /** sha256 of the frozen paramsJson — the audit fingerprint shared by the DB row, card and metrics. */
      paramsSha256: string
      /** Clipped redacted summary — the only param representation allowed outside memory. */
      auditSummary: string
      pendingConfirmationSourceDigest: string
    }
  | { ok: false; reason: 'pending_exists' | 'store_unavailable' }

export type ReleaseResult =
  | { ok: true; toolName: string; params: Record<string, unknown>; paramsJson: string }
  | { ok: false; reason: 'not_found' | 'invalid_token' | 'not_pending' | 'expired' | 'store_unavailable' }

export type DenyResult =
  | { ok: true }
  | { ok: false; reason: 'not_pending' | 'expired' | 'store_unavailable' }

export type ExpireResult =
  | { ok: true }
  | { ok: false; reason: 'not_pending' | 'store_unavailable' }

export type CanonicalDecisionReadResult =
  | { ok: true; status: Exclude<FrozenCallStatus, 'pending'> }
  | { ok: false; reason: 'pending' | 'not_found' | 'source_mismatch' | 'store_unavailable' }

type TerminalAuditResult = 'committed' | 'not_pending' | 'store_unavailable'

export const DEFAULT_FROZEN_CALL_TTL_MS = 10 * 60 * 1000
const TERMINAL_FROZEN_CALL_TOMBSTONE_LIMIT = 2_048

export class FrozenCallStore {
  private readonly records = new Map<string, FrozenCallRecord>()
  private readonly terminalCallIds = new Set<string>()
  private readonly db: FrozenCallDb | null
  private readonly now: () => number

  constructor(db: FrozenCallDb | null, opts?: { now?: () => number }) {
    this.db = db
    this.now = opts?.now ?? Date.now
  }

  freeze(args: FreezeArgs): FreezeResult {
    this.sweepExpired()
    const sessionKey = args.sessionId || args.scopeId || null
    if (sessionKey && this.findPendingForSession(sessionKey)) {
      return { ok: false, reason: 'pending_exists' }
    }
    const createdAt = this.now()
    const ttlMs = typeof args.ttlMs === 'number' && args.ttlMs > 0 ? args.ttlMs : DEFAULT_FROZEN_CALL_TTL_MS
    const createdAtIso = new Date(createdAt).toISOString()
    const expiresAtIso = new Date(createdAt + ttlMs).toISOString()
    const recordBase = {
      id: `fc-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      runId: args.runId ?? null,
      taskId: args.taskId ?? null,
      scopeId: args.scopeId ?? null,
      sessionId: args.sessionId ?? null,
      toolName: args.toolName,
      // The frozen bytes — release re-executes EXACTLY this serialization.
      paramsJson: JSON.stringify(args.params),
      createdAt,
      expiresAt: createdAt + ttlMs,
      status: 'pending' as const,
      token: randomUUID(),
      releasedAt: null,
    }
    const paramsJson = JSON.stringify(args.params)
    const auditJson = JSON.stringify({
      __audit: 'redacted',
      canonicalSha256: digestCanonicalJson(args.params),
      sha256: createHash('sha256').update(paramsJson).digest('hex'),
      shape: buildAuditShape(args.params),
    })
    const pendingConfirmationSourceDigest = buildFrozenCallPendingSourceDigest({
      id: recordBase.id,
      runId: recordBase.runId,
      taskId: recordBase.taskId,
      scopeId: recordBase.scopeId,
      toolName: recordBase.toolName,
      paramsJson: auditJson,
      createdAt: createdAtIso,
      expiresAt: expiresAtIso,
    })
    const record: FrozenCallRecord = {
      ...recordBase,
      paramsJson,
      pendingConfirmationSourceDigest,
    }
    const paramsSha256 = createHash('sha256').update(record.paramsJson).digest('hex')
    const auditSummary = buildAuditSummary(args.params, { redactAllStrings: args.sensitiveParams })
    if (this.db) {
      try {
        // Durable row carries ONLY a value-free structural shape + sha256 of
        // the frozen bytes — never any parameter value. Release reads the
        // in-memory record, so audit redaction cannot affect the
        // byte-identical contract.
        const ownsTransaction = Boolean(this.db.exec) && this.db.inTransaction !== true
        if (ownsTransaction) this.db.exec?.('BEGIN IMMEDIATE')
        const sessionKey = record.scopeId || record.sessionId
        const pendingCard = sessionKey ? this.db.prepare(`
          SELECT 1 AS present FROM chat_messages
           WHERE conversation_id = ? AND role = 'agent_card'
             AND json_extract(meta_json, '$.askUserQuestions.status') = 'pending'
           LIMIT 1
        `).get?.(sessionKey) : undefined
        const pendingConfirmation = sessionKey
          ? this.db.prepare(`
              SELECT 1 AS present FROM pending_confirmations
               WHERE status = 'pending' AND (scope_id = ? OR run_id = ?) LIMIT 1
            `).get?.(sessionKey, record.runId)
          : undefined
        if (pendingCard || pendingConfirmation) {
          if (ownsTransaction) this.db.exec?.('ROLLBACK')
          return { ok: false, reason: 'pending_exists' }
        }
        this.db
          .prepare(
            'INSERT INTO pending_confirmations (id, run_id, task_id, scope_id, tool_name, params_json, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            record.id,
            record.runId,
            record.taskId,
            record.scopeId,
            record.toolName,
            auditJson,
            createdAtIso,
            expiresAtIso,
            'pending',
          )
        if (ownsTransaction) this.db.exec?.('COMMIT')
      } catch {
        if (this.db.exec && this.db.inTransaction === true) {
          try { this.db.exec('ROLLBACK') } catch { /* silent-catch: the outer failure still denies execution with store_unavailable. */ }
        }
        // silent-catch: insert failure returns the structured store_unavailable result
        return { ok: false, reason: 'store_unavailable' }
      }
    }
    this.records.set(record.id, record)
    return {
      ok: true,
      id: record.id,
      token: record.token,
      expiresAt: record.expiresAt,
      paramsSha256,
      auditSummary,
      pendingConfirmationSourceDigest,
    }
  }

  get(id: string): FrozenCallRecordView | null {
    const record = this.records.get(id)
    if (!record) return null
    return toRecordView(record)
  }

  isPastDue(id: string): boolean {
    const record = this.records.get(id)
    return Boolean(record && this.now() > record.expiresAt)
  }

  findPendingForSession(sessionKey: string | null): FrozenCallRecordView | null {
    if (!sessionKey) return null
    this.sweepExpired()
    for (const record of this.records.values()) {
      if (record.status !== 'pending') continue
      if (record.sessionId === sessionKey || record.scopeId === sessionKey) {
        return toRecordView(record)
      }
    }
    return null
  }

  /**
   * The ONLY release entry. Validates token + pending status + TTL, flips
   * pending → released atomically, and hands back the frozen params for the
   * dispatcher to re-enter the SAME dispatch path. Never regenerates params.
   */
  release(id: string, token: string): ReleaseResult {
    const record = this.records.get(id)
    if (!record) {
      return this.terminalCallIds.has(id)
        ? { ok: false, reason: 'not_pending' }
        : { ok: false, reason: 'not_found' }
    }
    if (record.status === 'pending' && this.now() > record.expiresAt) {
      const expired = this.transition(record, 'expired')
      return {
        ok: false,
        reason: expired === 'committed' ? 'expired' : expired,
      }
    }
    if (record.status !== 'pending') return { ok: false, reason: 'not_pending' }
    if (record.token !== token) return { ok: false, reason: 'invalid_token' }
    const auditResult = this.transition(record, 'released')
    if (auditResult !== 'committed') return { ok: false, reason: auditResult }
    return {
      ok: true,
      toolName: record.toolName,
      params: JSON.parse(record.paramsJson) as Record<string, unknown>,
      paramsJson: record.paramsJson,
    }
  }

  releaseAfterCanonicalDecision(id: string, token: string): ReleaseResult {
    const record = this.records.get(id)
    if (!record) return { ok: false, reason: 'not_found' }
    if (record.status !== 'pending') return { ok: false, reason: 'not_pending' }
    if (record.token !== token) return { ok: false, reason: 'invalid_token' }
    record.status = 'released'
    record.releasedAt = this.now()
    const result = {
      ok: true as const,
      toolName: record.toolName,
      params: JSON.parse(record.paramsJson) as Record<string, unknown>,
      paramsJson: record.paramsJson,
    }
    this.retireInMemory(record)
    return result
  }

  /**
   * Read back the durable half of the card + confirmation transaction before
   * the in-memory execution token can be released. The expected digest binds
   * the read to the exact pending row that the card was created from, so an
   * old terminal row with the same logical owner cannot authorize this call.
   */
  readCanonicalDecision(
    id: string,
    expectedSourceDigest: string,
  ): CanonicalDecisionReadResult {
    if (!this.db?.prepare) return { ok: false, reason: 'store_unavailable' }
    try {
      const row = this.db.prepare(`
        SELECT id, run_id, task_id, scope_id, tool_name, params_json,
               created_at, expires_at, status
          FROM pending_confirmations WHERE id = ? LIMIT 1
      `).get?.<{
        id: string
        run_id: string | null
        task_id: string | null
        scope_id: string | null
        tool_name: string
        params_json: string
        created_at: string
        expires_at: string
        status: FrozenCallStatus
      }>(id)
      if (!row) return { ok: false, reason: 'not_found' }
      const sourceDigest = buildFrozenCallPendingSourceDigest({
        id: row.id,
        runId: row.run_id,
        taskId: row.task_id,
        scopeId: row.scope_id,
        toolName: row.tool_name,
        paramsJson: row.params_json,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })
      if (sourceDigest !== expectedSourceDigest) {
        return { ok: false, reason: 'source_mismatch' }
      }
      return row.status === 'pending'
        ? { ok: false, reason: 'pending' }
        : { ok: true, status: row.status }
    } catch {
      // silent-catch: the confirmation consumer revokes permission when this formal read is unavailable.
      return { ok: false, reason: 'store_unavailable' }
    }
  }

  retireAfterCanonicalDecision(id: string, status: 'denied' | 'expired'): boolean {
    const record = this.records.get(id)
    if (!record || record.status !== 'pending') return false
    record.status = status
    record.releasedAt = null
    this.retireInMemory(record)
    return true
  }

  /** User rejected the action — terminal, unless TTL or durable state won the race. */
  deny(id: string): DenyResult {
    const record = this.records.get(id)
    if (!record || record.status !== 'pending') return { ok: false, reason: 'not_pending' }
    if (this.now() > record.expiresAt) {
      const expired = this.transition(record, 'expired')
      return {
        ok: false,
        reason: expired === 'committed' ? 'expired' : expired,
      }
    }
    const denied = this.transition(record, 'denied')
    return denied === 'committed'
      ? { ok: true }
      : { ok: false, reason: denied }
  }

  /** Timeout / abort / run preempted — terminal, with durable truth readback. */
  expire(id: string): ExpireResult {
    const record = this.records.get(id)
    if (!record || record.status !== 'pending') return { ok: false, reason: 'not_pending' }
    const expired = this.transition(record, 'expired')
    return expired === 'committed'
      ? { ok: true }
      : { ok: false, reason: expired }
  }

  /** Durable closeout already won; discard only this process's execution token. */
  retireAfterDurableSettlement(id: string): boolean {
    const record = this.records.get(id)
    if (!record || record.status !== 'pending') return false
    record.status = 'expired'
    record.releasedAt = null
    this.retireInMemory(record)
    return true
  }

  private sweepExpired(): void {
    const nowMs = this.now()
    for (const record of this.records.values()) {
      if (record.status === 'pending' && nowMs > record.expiresAt) {
        this.transition(record, 'expired')
      }
    }
  }

  private transition(
    record: FrozenCallRecord,
    status: Exclude<FrozenCallStatus, 'pending'>,
  ): TerminalAuditResult {
    record.status = status
    record.releasedAt = status === 'released' ? this.now() : null
    let auditResult: TerminalAuditResult = 'committed'
    if (this.db) {
      try {
        const updated = this.db
          .prepare("UPDATE pending_confirmations SET status = ?, released_at = ? WHERE id = ? AND status = 'pending'")
          .run(status, record.releasedAt ? new Date(record.releasedAt).toISOString() : null, record.id) as {
            changes?: number
          } | null
        if (Number(updated?.changes || 0) !== 1) auditResult = 'not_pending'
      } catch {
        // silent-catch: a release without a matching durable pending row must
        // never hand action parameters back to the dispatcher.
        auditResult = 'store_unavailable'
      }
    }
    this.retireInMemory(record)
    return auditResult
  }

  private retireInMemory(record: FrozenCallRecord): void {
    this.records.delete(record.id)
    if (this.terminalCallIds.size >= TERMINAL_FROZEN_CALL_TOMBSTONE_LIMIT) {
      const oldest = this.terminalCallIds.values().next().value
      if (typeof oldest === 'string') this.terminalCallIds.delete(oldest)
    }
    this.terminalCallIds.add(record.id)
  }
}
