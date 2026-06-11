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

import { randomUUID } from 'node:crypto'

export type FrozenCallStatus = 'pending' | 'released' | 'denied' | 'expired'

export interface FrozenCallDbStatement {
  run(...params: unknown[]): unknown
}

export interface FrozenCallDb {
  prepare(sql: string): FrozenCallDbStatement
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
}

interface FrozenCallRecord extends FrozenCallRecordView {
  token: string
  releasedAt: number | null
}

export interface FreezeArgs {
  toolName: string
  params: Record<string, unknown>
  runId?: string | null
  taskId?: string | null
  scopeId?: string | null
  sessionId?: string | null
  ttlMs?: number
}

export type FreezeResult =
  | { ok: true; id: string; token: string; expiresAt: number }
  | { ok: false; reason: 'pending_exists' | 'store_unavailable' }

export type ReleaseResult =
  | { ok: true; toolName: string; params: Record<string, unknown>; paramsJson: string }
  | { ok: false; reason: 'not_found' | 'invalid_token' | 'not_pending' | 'expired' }

export const DEFAULT_FROZEN_CALL_TTL_MS = 10 * 60 * 1000

export class FrozenCallStore {
  private readonly records = new Map<string, FrozenCallRecord>()
  private readonly db: FrozenCallDb | null
  private readonly now: () => number

  constructor(db: FrozenCallDb | null, opts?: { now?: () => number }) {
    this.db = db
    this.now = opts?.now ?? Date.now
    // Restart orphans: DB rows still 'pending' from a previous process have
    // no waiting context (token was memory-only) — expire anything stale.
    if (this.db) {
      try {
        this.db
          .prepare("UPDATE pending_confirmations SET status = 'expired' WHERE status = 'pending' AND expires_at < ?")
          .run(new Date(this.now()).toISOString())
      } catch {
        // Sweep failure is non-fatal — rows stay pending in DB only; the
        // in-memory authority starts empty either way.
      }
    }
  }

  freeze(args: FreezeArgs): FreezeResult {
    this.sweepExpired()
    const sessionKey = args.sessionId || args.scopeId || null
    if (sessionKey && this.findPendingForSession(sessionKey)) {
      return { ok: false, reason: 'pending_exists' }
    }
    const createdAt = this.now()
    const ttlMs = typeof args.ttlMs === 'number' && args.ttlMs > 0 ? args.ttlMs : DEFAULT_FROZEN_CALL_TTL_MS
    const record: FrozenCallRecord = {
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
      status: 'pending',
      token: randomUUID(),
      releasedAt: null,
    }
    if (this.db) {
      try {
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
            record.paramsJson,
            new Date(record.createdAt).toISOString(),
            new Date(record.expiresAt).toISOString(),
            'pending',
          )
      } catch {
        return { ok: false, reason: 'store_unavailable' }
      }
    }
    this.records.set(record.id, record)
    return { ok: true, id: record.id, token: record.token, expiresAt: record.expiresAt }
  }

  get(id: string): FrozenCallRecordView | null {
    const record = this.records.get(id)
    if (!record) return null
    const { token: _token, releasedAt: _releasedAt, ...view } = record
    return view
  }

  findPendingForSession(sessionKey: string | null): FrozenCallRecordView | null {
    if (!sessionKey) return null
    this.sweepExpired()
    for (const record of this.records.values()) {
      if (record.status !== 'pending') continue
      if (record.sessionId === sessionKey || record.scopeId === sessionKey) {
        const { token: _token, releasedAt: _releasedAt, ...view } = record
        return view
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
    if (!record) return { ok: false, reason: 'not_found' }
    if (record.status === 'pending' && this.now() > record.expiresAt) {
      this.transition(record, 'expired')
      return { ok: false, reason: 'expired' }
    }
    if (record.status !== 'pending') return { ok: false, reason: 'not_pending' }
    if (record.token !== token) return { ok: false, reason: 'invalid_token' }
    this.transition(record, 'released')
    return {
      ok: true,
      toolName: record.toolName,
      params: JSON.parse(record.paramsJson) as Record<string, unknown>,
      paramsJson: record.paramsJson,
    }
  }

  /** User rejected the action — terminal. Returns false if not pending. */
  deny(id: string): boolean {
    const record = this.records.get(id)
    if (!record || record.status !== 'pending') return false
    this.transition(record, 'denied')
    return true
  }

  /** Timeout / abort / run preempted — terminal. Returns false if not pending. */
  expire(id: string): boolean {
    const record = this.records.get(id)
    if (!record || record.status !== 'pending') return false
    this.transition(record, 'expired')
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

  private transition(record: FrozenCallRecord, status: Exclude<FrozenCallStatus, 'pending'>): void {
    record.status = status
    record.releasedAt = status === 'released' ? this.now() : null
    if (this.db) {
      try {
        this.db
          .prepare('UPDATE pending_confirmations SET status = ?, released_at = ? WHERE id = ?')
          .run(status, record.releasedAt ? new Date(record.releasedAt).toISOString() : null, record.id)
      } catch {
        // Audit-row drift is observable via the boot sweep; the in-memory
        // authority has already transitioned, so execution semantics hold.
      }
    }
  }
}
