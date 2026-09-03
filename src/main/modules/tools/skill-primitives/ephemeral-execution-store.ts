/**
 * In-memory store for `skill_ask_user` pending questions. Kept intentionally
 * separate from the SQLite-backed `skill_executions` table: an ask_user
 * question is a transient, one-shot IPC round-trip, not a workflow step, and
 * writing it to disk would pollute the execution history with rows that are
 * always short-lived and always ephemeral by definition.
 *
 * Design choices (B Phase 1 PR2):
 *   - ExecutionId format `eau-<8hex>` — distinct prefix from `e-<8hex>` so a
 *     quick visual scan of a log tells you "this is an ask_user question"
 *     vs. "this is a real workflow execution". DB lookups by `WHERE id = ?`
 *     on skill_executions simply miss these rows (no special handling
 *     needed).
 *   - 24h timeout: if the user walks away, the handler rejects with
 *     `errorKind: 'timeout'` and the record is purged.
 *   - No cross-process persistence: app quit = everything is dropped. The
 *     renderer-side UI widget is similarly transient.
 *   - The store is a singleton because an EphemeralExecutionStore ties
 *     together the main-process handler (which awaits a Promise) and the
 *     IPC submit handler (which resolves it). Both end up sharing a Map.
 *
 * Tested as a pure module under `tsx --test`.
 */

import { randomUUID } from 'node:crypto'
import { getInteractionLifecycleRegistry } from '../../agent-control/runtime-core/interaction-lifecycle-registry'

export interface EphemeralAskUserRecord {
  executionId: string
  sessionId: string | null
  scopeId?: string | null
  agent?: string | null
  requestId?: string | null
  skillId: string | null
  question: string
  options: string[] | null
  placeholder: string | null
  askedAt: number
  resolve: (value: string) => void
  reject: (error: Error) => void
  /** Timer handle for the 24h timeout — cleared on resolve/reject. */
  timeoutHandle: NodeJS.Timeout
}

export interface PendingAskUserView {
  executionId: string
  sessionId: string | null
  scopeId?: string | null
  agent?: string | null
  requestId?: string | null
  skillId: string | null
  question: string
  options: string[] | null
  placeholder: string | null
  askedAt: number
}

export interface EphemeralAskUserClearedEvent {
  executionId: string
  sessionId: string | null
  scopeId: string | null
  agent: string | null
  requestId: string | null
  reason: 'resolved' | 'rejected' | 'cleared'
}

export const EPHEMERAL_ASK_USER_ID_PREFIX = 'eau-'

export function generateEphemeralAskUserId(): string {
  return `${EPHEMERAL_ASK_USER_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

export function isEphemeralAskUserId(executionId: string): boolean {
  return typeof executionId === 'string' && executionId.startsWith(EPHEMERAL_ASK_USER_ID_PREFIX)
}

export class EphemeralExecutionStore {
  private readonly records = new Map<string, EphemeralAskUserRecord>()
  private readonly clearListeners = new Set<(event: EphemeralAskUserClearedEvent) => void>()
  private readonly terminalFences = new Set<string>()

  private runKey(scopeId: string, requestId: string): string {
    return `${scopeId}\u0000${requestId}`
  }

  prepareRunTerminalFence(scopeId: string, requestId: string): void {
    if (!scopeId || !requestId) throw new Error('ephemeral_run_terminal_identity_invalid')
    const key = this.runKey(scopeId, requestId)
    if (this.terminalFences.has(key)) throw new Error('ephemeral_run_terminal_fence_conflict')
    this.terminalFences.add(key)
  }

  rollbackRunTerminalFence(scopeId: string, requestId: string): void {
    this.terminalFences.delete(this.runKey(scopeId, requestId))
  }

  commitRunTerminalFence(scopeId: string, requestId: string, error: Error): number {
    const key = this.runKey(scopeId, requestId)
    if (!this.terminalFences.delete(key)) throw new Error('ephemeral_run_terminal_fence_missing')
    return this.rejectByRun(scopeId, requestId, error)
  }

  has(executionId: string): boolean {
    return this.records.has(executionId)
  }

  get(executionId: string): EphemeralAskUserRecord | null {
    return this.records.get(executionId) || null
  }

  register(record: EphemeralAskUserRecord): void {
    this.records.set(record.executionId, record)
    getInteractionLifecycleRegistry().register({
      interactionId: record.executionId,
      runId: record.requestId || '',
      agentId: record.agent || '',
      scopeId: record.scopeId || record.sessionId || '',
      type: 'ask_user',
    })
  }

  onCleared(listener: (event: EphemeralAskUserClearedEvent) => void): () => void {
    this.clearListeners.add(listener)
    return () => this.clearListeners.delete(listener)
  }

  private notifyCleared(record: EphemeralAskUserRecord, reason: EphemeralAskUserClearedEvent['reason']): void {
    const event: EphemeralAskUserClearedEvent = {
      executionId: record.executionId,
      sessionId: record.sessionId,
      scopeId: record.scopeId ?? record.sessionId,
      agent: record.agent ?? null,
      requestId: record.requestId ?? null,
      reason,
    }
    for (const listener of this.clearListeners) {
      try {
        listener(event)
      } catch {
        /* silent-catch: listener failure must not break ask_user lifecycle */
      }
    }
  }

  /**
   * Resolve a pending ask_user question with the user's answer. Returns true
   * when a record was actually resolved; false when no record existed (e.g.
   * a late submit after timeout).
   */
  resolve(executionId: string, value: string): boolean {
    const record = this.records.get(executionId)
    if (!record) return false
    const scopeId = record.scopeId || record.sessionId || ''
    if (record.requestId && this.terminalFences.has(this.runKey(scopeId, record.requestId))) {
      return false
    }
    clearTimeout(record.timeoutHandle)
    this.records.delete(executionId)
    getInteractionLifecycleRegistry().settle({
      interactionId: record.executionId,
      runId: record.requestId || '',
      agentId: record.agent || '',
      scopeId: record.scopeId || record.sessionId || '',
      disposition: 'resume_with_result',
    })
    this.notifyCleared(record, 'resolved')
    record.resolve(value)
    return true
  }

  /**
   * Reject a pending ask_user question (abort, timeout, session-drop).
   * Returns true when a record existed and was rejected.
   */
  reject(executionId: string, error: Error): boolean {
    const record = this.records.get(executionId)
    if (!record) return false
    clearTimeout(record.timeoutHandle)
    this.records.delete(executionId)
    getInteractionLifecycleRegistry().settle({
      interactionId: record.executionId,
      runId: record.requestId || '',
      agentId: record.agent || '',
      scopeId: record.scopeId || record.sessionId || '',
      disposition: 'terminate',
    })
    this.notifyCleared(record, 'rejected')
    record.reject(error)
    return true
  }

  /** Drop every pending record; used on app shutdown. */
  clear(): void {
    for (const [, record] of this.records) {
      clearTimeout(record.timeoutHandle)
      getInteractionLifecycleRegistry().settle({
        interactionId: record.executionId,
        runId: record.requestId || '',
        agentId: record.agent || '',
        scopeId: record.scopeId || record.sessionId || '',
        disposition: 'terminate',
      })
      this.notifyCleared(record, 'cleared')
      try {
        record.reject(new Error('Ephemeral ask_user store cleared'))
      } catch {
        /* listeners already cleaned up */
      }
    }
    this.records.clear()
    this.terminalFences.clear()
  }

  /**
   * Reject every pending record whose session matches; used on session
   * teardown. Returns the number of records rejected.
   */
  rejectBySession(sessionId: string, error: Error): number {
    let rejected = 0
    for (const [executionId, record] of this.records) {
      if (record.sessionId === sessionId) {
        clearTimeout(record.timeoutHandle)
        this.records.delete(executionId)
        getInteractionLifecycleRegistry().settle({
          interactionId: record.executionId,
          runId: record.requestId || '',
          agentId: record.agent || '',
          scopeId: record.scopeId || record.sessionId || '',
          disposition: 'terminate',
        })
        this.notifyCleared(record, 'rejected')
        try {
          record.reject(error)
        } catch {
          /* listener already cleaned up */
        }
        rejected += 1
      }
    }
    return rejected
  }

  rejectByRun(scopeId: string, requestId: string, error: Error): number {
    let rejected = 0
    for (const [executionId, record] of this.records) {
      if ((record.scopeId || record.sessionId) !== scopeId || record.requestId !== requestId) continue
      if (this.reject(executionId, error)) rejected += 1
    }
    return rejected
  }

  size(): number {
    return this.records.size
  }

  /**
   * Snapshot of currently-pending questions (never exposes resolvers).
   * Useful for diagnostic IPC / health checks.
   */
  list(): PendingAskUserView[] {
    const out: PendingAskUserView[] = []
    for (const record of this.records.values()) {
      out.push({
        executionId: record.executionId,
        sessionId: record.sessionId,
        scopeId: record.scopeId ?? record.sessionId,
        agent: record.agent ?? null,
        requestId: record.requestId ?? null,
        skillId: record.skillId,
        question: record.question,
        options: record.options,
        placeholder: record.placeholder,
        askedAt: record.askedAt,
      })
    }
    return out
  }

  hasPendingForRun(agent: string, sessionId: string | null | undefined, requestId: string): boolean {
    if (!agent || !sessionId || !requestId) return false
    for (const record of this.records.values()) {
      const recordSessionId = record.scopeId || record.sessionId
      if (recordSessionId !== sessionId) continue
      if (record.agent !== agent) continue
      if (record.requestId !== requestId) continue
      return true
    }
    return false
  }
}

let sharedStore: EphemeralExecutionStore | null = null

export function getEphemeralExecutionStore(): EphemeralExecutionStore {
  if (!sharedStore) sharedStore = new EphemeralExecutionStore()
  return sharedStore
}

/** Test helper — replaces the singleton with a fresh store. */
export function _resetEphemeralExecutionStoreForTests(): void {
  if (sharedStore) sharedStore.clear()
  sharedStore = new EphemeralExecutionStore()
}
