import type { DatabaseConnection } from '../../database'

import { digestCanonicalJson } from './codex-model-gateway-contract'

type RunResult = { changes?: number }

export type CodexThreadArchiveIntentState = 'pending' | 'result_unknown' | 'acknowledged'
export type CodexThreadRetirementReason =
  | 'closed'
  | 'user_reset'
  | 'publication_diverged'
  | 'manual_compaction_quarantine'
  | 'cleanup'
export type CodexThreadArchiveSourceKind =
  | 'idle_close'
  | 'engine_terminal_close'
  | 'idle_reset'
  | 'engine_terminal_reset'
  | 'engine_terminal_stop'
  | 'browser_verifier_nonaccept'
  | 'publication_divergence'
  | 'manual_compaction_quarantine'
  | 'retired_backfill'
export type CodexThreadArchiveAcknowledgementKind =
  | 'rpc_success'
  | 'archived_readback'
  | 'archived_notification'

export type CodexThreadArchiveIntentRead = {
  archiveIntentId: string
  threadBindingId: string
  codexThreadId: string
  codexSessionId: string
  isolatedThreadCwd: string
  aliasId: string
  aliasGeneration: number
  sourceKind: CodexThreadArchiveSourceKind
  retiredReason: CodexThreadRetirementReason
  readyRunId: string | null
  retirementEvidenceDigest: string
  retirementTransactionDigest: string
  intentDigest: string
  state: CodexThreadArchiveIntentState
  attemptCount: number
  lastAttemptAt: string | null
  lastAttemptConnectionEpoch: string | null
  lastAttemptRpcId: number | null
  lastErrorCode: string | null
  lastAbsenceAfterAttemptCount: number | null
  lastAbsenceEvidenceDigest: string | null
  lastAbsenceAt: string | null
  acknowledgedAt: string | null
  acknowledgementKind: CodexThreadArchiveAcknowledgementKind | null
  acknowledgementEvidenceDigest: string | null
  revision: number
  requestedAt: string
  updatedAt: string
}

type ArchiveIntentRow = {
  archive_intent_id: string
  thread_binding_id: string
  codex_thread_id: string
  codex_session_id: string
  isolated_thread_cwd: string
  ready_conversation_alias: string
  alias_generation: number
  source_kind: CodexThreadArchiveSourceKind
  retired_reason: CodexThreadRetirementReason
  ready_run_id: string | null
  retirement_evidence_digest: string
  retirement_transaction_digest: string
  intent_digest: string
  state: CodexThreadArchiveIntentState
  attempt_count: number
  last_attempt_at: string | null
  last_attempt_connection_epoch: string | null
  last_attempt_rpc_id: number | null
  last_error_code: string | null
  last_absence_after_attempt_count: number | null
  last_absence_evidence_digest: string | null
  last_absence_at: string | null
  acknowledged_at: string | null
  acknowledgement_kind: CodexThreadArchiveAcknowledgementKind | null
  acknowledgement_evidence_digest: string | null
  revision: number
  requested_at: string
  updated_at: string
}

function nonEmpty(value: string, code: string): void {
  if (!value.trim()) throw new Error(code)
}

function digestValue(value: string, code: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(code)
}

function changes(result: unknown): number {
  return Number((result as RunResult | null)?.changes || 0)
}

function readIntent(row: ArchiveIntentRow): CodexThreadArchiveIntentRead {
  return {
    archiveIntentId: row.archive_intent_id,
    threadBindingId: row.thread_binding_id,
    codexThreadId: row.codex_thread_id,
    codexSessionId: row.codex_session_id,
    isolatedThreadCwd: row.isolated_thread_cwd,
    aliasId: row.ready_conversation_alias,
    aliasGeneration: row.alias_generation,
    sourceKind: row.source_kind,
    retiredReason: row.retired_reason,
    readyRunId: row.ready_run_id,
    retirementEvidenceDigest: row.retirement_evidence_digest,
    retirementTransactionDigest: row.retirement_transaction_digest,
    intentDigest: row.intent_digest,
    state: row.state,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    lastAttemptConnectionEpoch: row.last_attempt_connection_epoch,
    lastAttemptRpcId: row.last_attempt_rpc_id,
    lastErrorCode: row.last_error_code,
    lastAbsenceAfterAttemptCount: row.last_absence_after_attempt_count,
    lastAbsenceEvidenceDigest: row.last_absence_evidence_digest,
    lastAbsenceAt: row.last_absence_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgementKind: row.acknowledgement_kind,
    acknowledgementEvidenceDigest: row.acknowledgement_evidence_digest,
    revision: row.revision,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
  }
}

export function recordCodexThreadArchiveIntentInOpenTransaction(
  db: DatabaseConnection,
  input: {
    threadBindingId: string
    codexThreadId: string
    codexSessionId: string
    isolatedThreadCwd: string
    aliasId: string
    aliasGeneration: number
    sourceKind: CodexThreadArchiveSourceKind
    retiredReason: CodexThreadRetirementReason
    readyRunId: string | null
    retirementEvidenceDigest: string
    retirementTransactionDigest: string
    requestedAt: string
  },
): CodexThreadArchiveIntentRead {
  if (db.inTransaction !== true) throw new Error('codex_thread_archive_transaction_missing')
  for (const value of [
    input.threadBindingId,
    input.codexThreadId,
    input.codexSessionId,
    input.isolatedThreadCwd,
    input.aliasId,
    input.requestedAt,
  ]) nonEmpty(value, 'codex_thread_archive_identity_invalid')
  if (!Number.isSafeInteger(input.aliasGeneration) || input.aliasGeneration < 1) {
    throw new Error('codex_thread_archive_generation_invalid')
  }
  digestValue(input.retirementEvidenceDigest, 'codex_thread_archive_retirement_evidence_invalid')
  digestValue(input.retirementTransactionDigest, 'codex_thread_archive_retirement_transaction_invalid')
  const expectedReason: Record<CodexThreadArchiveSourceKind, CodexThreadRetirementReason | null> = {
    idle_close: 'closed',
    engine_terminal_close: 'closed',
    idle_reset: 'user_reset',
    engine_terminal_reset: 'user_reset',
    engine_terminal_stop: 'publication_diverged',
    browser_verifier_nonaccept: 'publication_diverged',
    publication_divergence: 'publication_diverged',
    manual_compaction_quarantine: 'manual_compaction_quarantine',
    retired_backfill: null,
  }
  if ((input.readyRunId === null) !== [
    'idle_close',
    'idle_reset',
    'manual_compaction_quarantine',
    'retired_backfill',
  ].includes(input.sourceKind)) {
    throw new Error('codex_thread_archive_source_identity_invalid')
  }
  if (expectedReason[input.sourceKind] && expectedReason[input.sourceKind] !== input.retiredReason) {
    throw new Error('codex_thread_archive_retirement_reason_mismatch')
  }
  const binding = db.prepare(`
    SELECT thread_binding_id, codex_thread_id, codex_session_id, isolated_thread_cwd,
           ready_conversation_alias, alias_generation, retired_at, retired_reason,
           retirement_evidence_digest
      FROM codex_thread_bindings WHERE thread_binding_id = ? LIMIT 1
  `).get<{
    thread_binding_id: string
    codex_thread_id: string | null
    codex_session_id: string | null
    isolated_thread_cwd: string | null
    ready_conversation_alias: string
    alias_generation: number
    retired_at: string | null
    retired_reason: string | null
    retirement_evidence_digest: string | null
  }>(input.threadBindingId)
  if (!binding
    || binding.codex_thread_id !== input.codexThreadId
    || binding.codex_session_id !== input.codexSessionId
    || binding.isolated_thread_cwd !== input.isolatedThreadCwd
    || binding.ready_conversation_alias !== input.aliasId
    || binding.alias_generation !== input.aliasGeneration
    || binding.retired_at !== input.requestedAt
    || binding.retired_reason !== input.retiredReason
    || binding.retirement_evidence_digest !== input.retirementEvidenceDigest) {
    throw new Error('codex_thread_archive_retirement_identity_mismatch')
  }
  if (input.readyRunId) {
    const turn = db.prepare(`
      SELECT ready_run_id FROM codex_turn_bindings
       WHERE ready_run_id = ? AND thread_binding_id = ?
         AND product_terminal_digest IS NOT NULL AND product_closeout_at = ?
       LIMIT 1
    `).get<{ ready_run_id: string }>(input.readyRunId, input.threadBindingId, input.requestedAt)
    if (!turn) throw new Error('codex_thread_archive_product_closeout_mismatch')
  }
  const identity = {
    contract: 'codex_thread_archive_intent_v1',
    threadBindingId: input.threadBindingId,
    codexThreadId: input.codexThreadId,
    codexSessionId: input.codexSessionId,
    isolatedThreadCwd: input.isolatedThreadCwd,
    aliasId: input.aliasId,
    aliasGeneration: input.aliasGeneration,
    sourceKind: input.sourceKind,
    retiredReason: input.retiredReason,
    readyRunId: input.readyRunId,
    retirementEvidenceDigest: input.retirementEvidenceDigest,
    retirementTransactionDigest: input.retirementTransactionDigest,
    requestedAt: input.requestedAt,
  }
  const intentDigest = digestCanonicalJson(identity)
  const archiveIntentId = `codex-archive-${intentDigest.slice(0, 32)}`
  const existing = db.prepare(`
    SELECT * FROM codex_thread_archive_intents WHERE thread_binding_id = ? LIMIT 1
  `).get<ArchiveIntentRow>(input.threadBindingId)
  if (existing) {
    if (existing.intent_digest !== intentDigest || existing.archive_intent_id !== archiveIntentId) {
      throw new Error('codex_thread_archive_intent_conflict')
    }
    return readIntent(existing)
  }
  db.prepare(`
    INSERT INTO codex_thread_archive_intents (
      archive_intent_id, thread_binding_id, codex_thread_id, codex_session_id,
      isolated_thread_cwd, ready_conversation_alias, alias_generation, source_kind,
      retired_reason, ready_run_id, retirement_evidence_digest, retirement_transaction_digest,
      intent_digest, state, revision, requested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
  `).run(
    archiveIntentId,
    input.threadBindingId,
    input.codexThreadId,
    input.codexSessionId,
    input.isolatedThreadCwd,
    input.aliasId,
    input.aliasGeneration,
    input.sourceKind,
    input.retiredReason,
    input.readyRunId,
    input.retirementEvidenceDigest,
    input.retirementTransactionDigest,
    intentDigest,
    input.requestedAt,
    input.requestedAt,
  )
  const inserted = db.prepare(`
    SELECT * FROM codex_thread_archive_intents WHERE archive_intent_id = ? LIMIT 1
  `).get<ArchiveIntentRow>(archiveIntentId)
  if (!inserted || inserted.intent_digest !== intentDigest) {
    throw new Error('codex_thread_archive_intent_readback_failed')
  }
  return readIntent(inserted)
}

export class CodexThreadArchiveIntentStore {
  constructor(private readonly db: DatabaseConnection) {}

  readOutstanding(): CodexThreadArchiveIntentRead[] {
    return this.db.prepare(`
      SELECT * FROM codex_thread_archive_intents
       WHERE state != 'acknowledged'
       ORDER BY requested_at, archive_intent_id
    `).all<ArchiveIntentRow>().map(readIntent)
  }

  readByThreadId(codexThreadId: string): CodexThreadArchiveIntentRead | null {
    nonEmpty(codexThreadId, 'codex_thread_archive_thread_id_invalid')
    const row = this.db.prepare(`
      SELECT * FROM codex_thread_archive_intents WHERE codex_thread_id = ? LIMIT 1
    `).get<ArchiveIntentRow>(codexThreadId)
    return row ? readIntent(row) : null
  }

  assertDispatchEligible(codexThreadId: string): void {
    const intent = this.readByThreadId(codexThreadId)
    if (!intent || intent.state !== 'result_unknown') {
      throw new Error('codex_thread_archive_dispatch_not_authorized')
    }
    this.assertRetiredBinding(intent)
  }

  assertReadbackListEligible(input: {
    cwd: string
    sourceKinds: ['vscode']
    archived: boolean
    cursor: string | null
    useStateDbOnly: true
  }): void {
    nonEmpty(input.cwd, 'codex_thread_archive_readback_cwd_invalid')
    if (input.sourceKinds.length !== 1 || input.sourceKinds[0] !== 'vscode'
      || typeof input.archived !== 'boolean'
      || (input.cursor !== null && typeof input.cursor !== 'string')
      || input.useStateDbOnly !== true) {
      throw new Error('codex_thread_archive_readback_params_invalid')
    }
    const eligible = this.db.prepare(`
      SELECT 1 AS found FROM codex_thread_archive_intents
       WHERE isolated_thread_cwd = ? AND state = 'result_unknown' LIMIT 1
    `).get<{ found: number }>(input.cwd)
    if (!eligible) throw new Error('codex_thread_archive_readback_not_authorized')
  }

  markDispatchResultUnknown(input: {
    archiveIntentId: string
    connectionEpoch: string
    rpcId: number
    requestDigest: string
    attemptedAt: string
  }): CodexThreadArchiveIntentRead {
    for (const value of [
      input.archiveIntentId,
      input.connectionEpoch,
      input.requestDigest,
      input.attemptedAt,
    ]) {
      nonEmpty(value, 'codex_thread_archive_attempt_identity_invalid')
    }
    if (!Number.isSafeInteger(input.rpcId) || input.rpcId <= 0) {
      throw new Error('codex_thread_archive_attempt_rpc_id_invalid')
    }
    digestValue(input.requestDigest, 'codex_thread_archive_attempt_request_digest_invalid')
    return this.immediate(() => {
      const current = this.requireIntent(input.archiveIntentId)
      if (current.state !== 'pending') throw new Error('codex_thread_archive_attempt_state_conflict')
      if (current.attemptCount > 0
        && (current.lastAbsenceAfterAttemptCount !== current.attemptCount
          || !current.lastAbsenceEvidenceDigest)) {
        throw new Error('codex_thread_archive_retry_without_absence_proof')
      }
      this.assertRetiredBinding(current)
      const attemptCount = current.attemptCount + 1
      const update = this.db.prepare(`
        UPDATE codex_thread_archive_intents
           SET state = 'result_unknown', attempt_count = attempt_count + 1,
               last_attempt_at = ?, last_attempt_connection_epoch = ?, last_attempt_rpc_id = ?,
               last_error_code = NULL, revision = revision + 1, updated_at = ?
         WHERE archive_intent_id = ? AND revision = ? AND state = 'pending'
      `).run(
        input.attemptedAt,
        input.connectionEpoch,
        input.rpcId,
        input.attemptedAt,
        input.archiveIntentId,
        current.revision,
      )
      if (changes(update) !== 1) throw new Error('codex_thread_archive_attempt_cas_failed')
      this.db.prepare(`
        INSERT INTO codex_thread_archive_attempts (
          archive_intent_id, attempt_count, connection_epoch, rpc_id,
          request_digest, activated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        input.archiveIntentId,
        attemptCount,
        input.connectionEpoch,
        input.rpcId,
        input.requestDigest,
        input.attemptedAt,
      )
      return this.requireIntent(input.archiveIntentId)
    })
  }

  markAttemptWriteStarted(input: {
    archiveIntentId: string
    connectionEpoch: string
    rpcId: number
    attemptedAt: string
  }): void {
    this.updateAttempt(input, 'write_started')
  }

  markAttemptWriteConfirmed(input: {
    archiveIntentId: string
    connectionEpoch: string
    rpcId: number
    childWriteDigest: string
    confirmedAt: string
  }): void {
    digestValue(input.childWriteDigest, 'codex_thread_archive_child_write_digest_invalid')
    this.updateAttempt(input, 'write_confirmed')
  }

  markAttemptUnresolved(input: {
    archiveIntentId: string
    connectionEpoch: string
    rpcId: number
    reason: 'response_timeout' | 'child_write_error' | 'connection_closed'
    unresolvedAt: string
  }): void {
    this.updateAttempt(input, 'unresolved')
  }

  reconcileAttemptResponse(input: {
    archiveIntentId: string
    connectionEpoch: string
    rpcId: number
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
    responseAt: string
  }): CodexThreadArchiveIntentRead {
    digestValue(input.responseDigest, 'codex_thread_archive_response_digest_invalid')
    return this.immediate(() => {
      const identity = this.requireAttemptIdentity(input, { allowAcknowledged: true })
      const attempt = this.db.prepare(`
        SELECT response_kind, response_digest, response_at, revision
          FROM codex_thread_archive_attempts
         WHERE archive_intent_id = ? AND attempt_count = ? LIMIT 1
      `).get<{
        response_kind: 'accepted' | 'rejected' | null
        response_digest: string | null
        response_at: string | null
        revision: number
      }>(input.archiveIntentId, identity.attemptCount)
      if (!attempt) throw new Error('codex_thread_archive_attempt_missing')
      if (attempt.response_kind) {
        if (attempt.response_kind !== input.responseKind
          || attempt.response_digest !== input.responseDigest
          || attempt.response_at !== input.responseAt) {
          throw new Error('codex_thread_archive_response_conflict')
        }
      } else {
        const update = this.db.prepare(`
          UPDATE codex_thread_archive_attempts
             SET response_kind = ?, response_digest = ?, response_at = ?,
                 revision = revision + 1
           WHERE archive_intent_id = ? AND attempt_count = ? AND revision = ?
             AND response_kind IS NULL
        `).run(
          input.responseKind,
          input.responseDigest,
          input.responseAt,
          input.archiveIntentId,
          identity.attemptCount,
          attempt.revision,
        )
        if (changes(update) !== 1) throw new Error('codex_thread_archive_response_cas_failed')
      }
      const current = this.requireIntent(input.archiveIntentId)
      if (input.responseKind === 'rejected' || current.state === 'acknowledged') return current
      return this.acknowledgeInOpenTransaction({
        archiveIntentId: input.archiveIntentId,
        attemptCount: identity.attemptCount,
        kind: 'rpc_success',
        evidenceDigest: input.responseDigest,
        acknowledgedAt: input.responseAt,
      })
    })
  }

  reconcileArchivedNotification(input: {
    codexThreadId: string
    connectionEpoch: string
    notificationDigest: string
    notifiedAt: string
  }): CodexThreadArchiveIntentRead | null {
    digestValue(input.notificationDigest, 'codex_thread_archive_notification_digest_invalid')
    return this.immediate(() => {
      const intent = this.readByThreadId(input.codexThreadId)
      if (!intent) return null
      if (intent.state === 'acknowledged') {
        return intent.lastAttemptConnectionEpoch === input.connectionEpoch ? intent : null
      }
      if (intent.state !== 'result_unknown'
        || intent.lastAttemptConnectionEpoch !== input.connectionEpoch
        || !intent.lastAttemptRpcId) return null
      const attempt = this.requireAttemptIdentity({
        archiveIntentId: intent.archiveIntentId,
        connectionEpoch: input.connectionEpoch,
        rpcId: intent.lastAttemptRpcId,
      })
      this.db.prepare(`
        UPDATE codex_thread_archive_attempts
           SET notification_digest = ?, notification_at = ?, revision = revision + 1
         WHERE archive_intent_id = ? AND attempt_count = ?
           AND notification_digest IS NULL
      `).run(
        input.notificationDigest,
        input.notifiedAt,
        intent.archiveIntentId,
        attempt.attemptCount,
      )
      return this.acknowledgeInOpenTransaction({
        archiveIntentId: intent.archiveIntentId,
        attemptCount: attempt.attemptCount,
        kind: 'archived_notification',
        evidenceDigest: input.notificationDigest,
        acknowledgedAt: input.notifiedAt,
      })
    })
  }

  recordAttemptFailure(input: {
    archiveIntentId: string
    attemptCount: number
    errorCode: string
    failedAt: string
  }): void {
    for (const value of [input.archiveIntentId, input.errorCode, input.failedAt]) {
      nonEmpty(value, 'codex_thread_archive_failure_invalid')
    }
    this.immediate(() => {
      const current = this.requireIntent(input.archiveIntentId)
      if (current.state === 'acknowledged') return
      if (current.state !== 'result_unknown' || current.attemptCount !== input.attemptCount) {
        throw new Error('codex_thread_archive_failure_identity_mismatch')
      }
      const update = this.db.prepare(`
        UPDATE codex_thread_archive_intents
           SET last_error_code = ?, revision = revision + 1, updated_at = ?
         WHERE archive_intent_id = ? AND revision = ? AND state = 'result_unknown'
           AND attempt_count = ?
      `).run(
        input.errorCode,
        input.failedAt,
        input.archiveIntentId,
        current.revision,
        input.attemptCount,
      )
      if (changes(update) !== 1) throw new Error('codex_thread_archive_failure_cas_failed')
    })
  }

  recordUnarchivedReadback(input: {
    archiveIntentId: string
    attemptCount: number
    reconciliationConnectionEpoch: string
    evidenceDigest: string
    reconciledAt: string
  }): CodexThreadArchiveIntentRead {
    digestValue(input.evidenceDigest, 'codex_thread_archive_absence_evidence_invalid')
    return this.immediate(() => {
      const current = this.requireIntent(input.archiveIntentId)
      if (current.state !== 'result_unknown' || current.attemptCount !== input.attemptCount) {
        throw new Error('codex_thread_archive_absence_identity_mismatch')
      }
      if (current.lastAttemptConnectionEpoch === input.reconciliationConnectionEpoch) {
        throw new Error('codex_thread_archive_same_connection_retry_forbidden')
      }
      const update = this.db.prepare(`
        UPDATE codex_thread_archive_intents
           SET state = 'pending', last_absence_after_attempt_count = ?,
               last_absence_evidence_digest = ?, last_absence_at = ?,
               revision = revision + 1, updated_at = ?
         WHERE archive_intent_id = ? AND revision = ? AND state = 'result_unknown'
           AND attempt_count = ?
      `).run(
        input.attemptCount,
        input.evidenceDigest,
        input.reconciledAt,
        input.reconciledAt,
        input.archiveIntentId,
        current.revision,
        input.attemptCount,
      )
      if (changes(update) !== 1) throw new Error('codex_thread_archive_absence_cas_failed')
      return this.requireIntent(input.archiveIntentId)
    })
  }

  acknowledge(input: {
    archiveIntentId: string
    attemptCount: number
    kind: CodexThreadArchiveAcknowledgementKind
    evidenceDigest: string
    acknowledgedAt: string
  }): CodexThreadArchiveIntentRead {
    digestValue(input.evidenceDigest, 'codex_thread_archive_ack_evidence_invalid')
    return this.immediate(() => this.acknowledgeInOpenTransaction(input))
  }

  private acknowledgeInOpenTransaction(input: {
    archiveIntentId: string
    attemptCount: number
    kind: CodexThreadArchiveAcknowledgementKind
    evidenceDigest: string
    acknowledgedAt: string
  }): CodexThreadArchiveIntentRead {
    const current = this.requireIntent(input.archiveIntentId)
    if (current.state === 'acknowledged') {
      if (current.attemptCount !== input.attemptCount
        || current.acknowledgementKind !== input.kind
        || current.acknowledgementEvidenceDigest !== input.evidenceDigest) {
        throw new Error('codex_thread_archive_ack_conflict')
      }
      return current
    }
    if (current.state !== 'result_unknown' || current.attemptCount !== input.attemptCount) {
      throw new Error('codex_thread_archive_ack_identity_mismatch')
    }
    const update = this.db.prepare(`
      UPDATE codex_thread_archive_intents
         SET state = 'acknowledged', acknowledged_at = ?, acknowledgement_kind = ?,
             acknowledgement_evidence_digest = ?, revision = revision + 1, updated_at = ?
       WHERE archive_intent_id = ? AND revision = ? AND state = 'result_unknown'
         AND attempt_count = ?
    `).run(
      input.acknowledgedAt,
      input.kind,
      input.evidenceDigest,
      input.acknowledgedAt,
      input.archiveIntentId,
      current.revision,
      input.attemptCount,
    )
    if (changes(update) !== 1) throw new Error('codex_thread_archive_ack_cas_failed')
    return this.requireIntent(input.archiveIntentId)
  }

  private updateAttempt(
    input:
      | { archiveIntentId: string; connectionEpoch: string; rpcId: number; attemptedAt: string }
      | { archiveIntentId: string; connectionEpoch: string; rpcId: number; childWriteDigest: string; confirmedAt: string }
      | { archiveIntentId: string; connectionEpoch: string; rpcId: number; reason: 'response_timeout' | 'child_write_error' | 'connection_closed'; unresolvedAt: string },
    kind: 'write_started' | 'write_confirmed' | 'unresolved',
  ): void {
    this.immediate(() => {
      const identity = this.requireAttemptIdentity(input, { allowAcknowledged: true })
      const row = this.db.prepare(`
        SELECT child_write_attempted_at, child_write_confirmed_at, child_write_digest,
               unresolved_at, unresolved_reason, revision
          FROM codex_thread_archive_attempts
         WHERE archive_intent_id = ? AND attempt_count = ? LIMIT 1
      `).get<{
        child_write_attempted_at: string | null
        child_write_confirmed_at: string | null
        child_write_digest: string | null
        unresolved_at: string | null
        unresolved_reason: string | null
        revision: number
      }>(input.archiveIntentId, identity.attemptCount)
      if (!row) throw new Error('codex_thread_archive_attempt_missing')
      if (kind === 'write_started') {
        const exact = input as Extract<typeof input, { attemptedAt: string }>
        if (row.child_write_attempted_at) return
        const update = this.db.prepare(`
          UPDATE codex_thread_archive_attempts
             SET child_write_attempted_at = ?, revision = revision + 1
           WHERE archive_intent_id = ? AND attempt_count = ? AND revision = ?
             AND child_write_attempted_at IS NULL
        `).run(exact.attemptedAt, input.archiveIntentId, identity.attemptCount, row.revision)
        if (changes(update) !== 1) throw new Error('codex_thread_archive_write_start_cas_failed')
        return
      }
      if (kind === 'write_confirmed') {
        const exact = input as Extract<typeof input, { confirmedAt: string }>
        if (!row.child_write_attempted_at) throw new Error('codex_thread_archive_write_not_started')
        if (row.child_write_confirmed_at) {
          if (row.child_write_digest !== exact.childWriteDigest) {
            throw new Error('codex_thread_archive_write_confirmation_conflict')
          }
          return
        }
        const update = this.db.prepare(`
          UPDATE codex_thread_archive_attempts
             SET child_write_confirmed_at = ?, child_write_digest = ?, revision = revision + 1
           WHERE archive_intent_id = ? AND attempt_count = ? AND revision = ?
             AND child_write_confirmed_at IS NULL
        `).run(
          exact.confirmedAt,
          exact.childWriteDigest,
          input.archiveIntentId,
          identity.attemptCount,
          row.revision,
        )
        if (changes(update) !== 1) throw new Error('codex_thread_archive_write_confirm_cas_failed')
        return
      }
      const exact = input as Extract<typeof input, { unresolvedAt: string }>
      if (row.unresolved_at) return
      const update = this.db.prepare(`
        UPDATE codex_thread_archive_attempts
           SET unresolved_at = ?, unresolved_reason = ?, revision = revision + 1
         WHERE archive_intent_id = ? AND attempt_count = ? AND revision = ?
           AND unresolved_at IS NULL
      `).run(
        exact.unresolvedAt,
        exact.reason,
        input.archiveIntentId,
        identity.attemptCount,
        row.revision,
      )
      if (changes(update) !== 1) throw new Error('codex_thread_archive_unresolved_cas_failed')
    })
  }

  private requireAttemptIdentity(input: {
    archiveIntentId: string
    connectionEpoch: string
    rpcId: number
  }, options: { allowAcknowledged?: boolean } = {}): { attemptCount: number } {
    const intent = this.requireIntent(input.archiveIntentId)
    if ((intent.state !== 'result_unknown'
        && !(options.allowAcknowledged && intent.state === 'acknowledged'))
      || intent.lastAttemptConnectionEpoch !== input.connectionEpoch
      || intent.lastAttemptRpcId !== input.rpcId) {
      throw new Error('codex_thread_archive_attempt_identity_mismatch')
    }
    const attempt = this.db.prepare(`
      SELECT attempt_count FROM codex_thread_archive_attempts
       WHERE archive_intent_id = ? AND attempt_count = ?
         AND connection_epoch = ? AND rpc_id = ? LIMIT 1
    `).get<{ attempt_count: number }>(
      input.archiveIntentId,
      intent.attemptCount,
      input.connectionEpoch,
      input.rpcId,
    )
    if (!attempt) throw new Error('codex_thread_archive_attempt_missing')
    return { attemptCount: attempt.attempt_count }
  }

  private requireIntent(archiveIntentId: string): CodexThreadArchiveIntentRead {
    const row = this.db.prepare(`
      SELECT * FROM codex_thread_archive_intents WHERE archive_intent_id = ? LIMIT 1
    `).get<ArchiveIntentRow>(archiveIntentId)
    if (!row) throw new Error('codex_thread_archive_intent_missing')
    return readIntent(row)
  }

  private assertRetiredBinding(intent: CodexThreadArchiveIntentRead): void {
    const binding = this.db.prepare(`
      SELECT codex_thread_id, codex_session_id, isolated_thread_cwd,
             ready_conversation_alias, alias_generation, retired_at, retired_reason,
             retirement_evidence_digest
        FROM codex_thread_bindings WHERE thread_binding_id = ? LIMIT 1
    `).get<{
      codex_thread_id: string | null
      codex_session_id: string | null
      isolated_thread_cwd: string | null
      ready_conversation_alias: string
      alias_generation: number
      retired_at: string | null
      retired_reason: string | null
      retirement_evidence_digest: string | null
    }>(intent.threadBindingId)
    if (!binding
      || binding.codex_thread_id !== intent.codexThreadId
      || binding.codex_session_id !== intent.codexSessionId
      || binding.isolated_thread_cwd !== intent.isolatedThreadCwd
      || binding.ready_conversation_alias !== intent.aliasId
      || binding.alias_generation !== intent.aliasGeneration
      || binding.retired_at !== intent.requestedAt
      || binding.retired_reason !== intent.retiredReason
      || binding.retirement_evidence_digest !== intent.retirementEvidenceDigest) {
      throw new Error('codex_thread_archive_retired_binding_mismatch')
    }
  }

  private immediate<T>(work: () => T): T {
    if (this.db.inTransaction) return work()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
}

export class CodexDurableThreadArchiveDispatchPort {
  constructor(private readonly input: {
    store: CodexThreadArchiveIntentStore
    now: () => string
  }) {}

  assertReadbackListEligible(input: {
    cwd: string
    sourceKinds: ['vscode']
    archived: boolean
    cursor: string | null
    useStateDbOnly: true
  }): void {
    this.input.store.assertReadbackListEligible(input)
  }

  async activate(input: {
    connectionEpoch: string
    rpcId: number
    codexThreadId: string
    requestDigest: string
  }): Promise<{ archiveIntentId: string }> {
    const intent = this.input.store.readByThreadId(input.codexThreadId)
    if (!intent) throw new Error('codex_thread_archive_intent_missing')
    const attempt = this.input.store.markDispatchResultUnknown({
      archiveIntentId: intent.archiveIntentId,
      connectionEpoch: input.connectionEpoch,
      rpcId: input.rpcId,
      requestDigest: input.requestDigest,
      attemptedAt: this.input.now(),
    })
    return { archiveIntentId: attempt.archiveIntentId }
  }

  async markWriteAttempted(input: {
    connectionEpoch: string
    rpcId: number
    archiveIntentId: string
  }): Promise<void> {
    this.input.store.markAttemptWriteStarted({
      ...input,
      attemptedAt: this.input.now(),
    })
  }

  async markChildWriteConfirmed(input: {
    connectionEpoch: string
    rpcId: number
    archiveIntentId: string
    childWriteDigest: string
  }): Promise<void> {
    this.input.store.markAttemptWriteConfirmed({
      ...input,
      confirmedAt: this.input.now(),
    })
  }

  async markUnresolved(input: {
    connectionEpoch: string
    rpcId: number
    archiveIntentId: string
    reason: 'response_timeout' | 'child_write_error' | 'connection_closed'
  }): Promise<void> {
    this.input.store.markAttemptUnresolved({
      ...input,
      unresolvedAt: this.input.now(),
    })
  }

  async reconcileResponse(input: {
    connectionEpoch: string
    rpcId: number
    archiveIntentId: string
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
  }): Promise<void> {
    this.input.store.reconcileAttemptResponse({
      ...input,
      responseAt: this.input.now(),
    })
  }

  async consumeLateResponse(input: {
    connectionEpoch: string
    rpcId: number
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
  }): Promise<boolean> {
    const intent = this.input.store.readOutstanding().find((entry) => (
      entry.state === 'result_unknown'
      && entry.lastAttemptConnectionEpoch === input.connectionEpoch
      && entry.lastAttemptRpcId === input.rpcId
    ))
    if (!intent) return false
    await this.reconcileResponse({ ...input, archiveIntentId: intent.archiveIntentId })
    return true
  }

  async reconcileArchivedNotification(input: {
    connectionEpoch: string
    codexThreadId: string
    notificationDigest: string
  }): Promise<boolean> {
    return Boolean(this.input.store.reconcileArchivedNotification({
      ...input,
      notifiedAt: this.input.now(),
    }))
  }

  async markConnectionClosed(connectionEpoch: string): Promise<void> {
    for (const intent of this.input.store.readOutstanding()) {
      if (intent.state !== 'result_unknown'
        || intent.lastAttemptConnectionEpoch !== connectionEpoch
        || !intent.lastAttemptRpcId) continue
      this.input.store.markAttemptUnresolved({
        archiveIntentId: intent.archiveIntentId,
        connectionEpoch,
        rpcId: intent.lastAttemptRpcId,
        reason: 'connection_closed',
        unresolvedAt: this.input.now(),
      })
    }
  }
}
