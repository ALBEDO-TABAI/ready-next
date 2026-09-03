import type { DatabaseConnection } from '../../database'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { canonicalJson, digestCanonicalJson } from './codex-model-gateway-contract'

export type ReadyToolActionReceiptRead =
  | Readonly<{ state: 'absent' }>
  | Readonly<{
      state: 'confirmed'
      receiptId: string
      resultDigest: string
      output: ToolExecutionOutput
    }>
  | Readonly<{ state: 'proven_absent'; evidenceDigest: string; reason: string }>
  | Readonly<{ state: 'indeterminate'; evidenceDigest: string; reason: string }>

export interface ReadyToolActionReceiptPort {
  begin(input: {
    readyActionId: string
    actionIdentityDigest: string
    at: string
  }): Promise<{ fresh: boolean }>
  beginBoundProductEffect(input: CodexBoundProductEffectInput): Promise<{ fresh: boolean }>
  read(readyActionId: string): Promise<ReadyToolActionReceiptRead>
  commit(input: {
    readyActionId: string
    actionIdentityDigest: string
    resultDigest: string
    output: ToolExecutionOutput
    at: string
  }): Promise<Extract<ReadyToolActionReceiptRead, { state: 'confirmed' }>>
  markProvenAbsent(input: {
    readyActionId: string
    actionIdentityDigest: string
    reason: string
    evidenceDigest: string
    at: string
  }): void
  markIndeterminate(input: {
    readyActionId: string
    actionIdentityDigest: string
    reason: string
    evidenceDigest: string
    at: string
  }): void
}

export type CodexBoundProductEffectInput = {
  effectActionId: string
  actionIdentityDigest: string
  readyRunId: string
  readyScopeId: string
  messageVisibilityEpoch: number
  codexThreadId: string
  codexTurnId: string
  codexCallId: string
  parentReadyActionId: string
  toolName: string
  productAction: string
  actionOrdinal: number
  argsDigest: string
  at: string
}

export type CodexSettledProductEffect = {
  readyActionId: string
  actionIdentityDigest: string
  state: 'confirmed' | 'indeterminate'
  revision: number
  receiptId: string | null
  evidenceDigest: string
}

export function buildReadyToolActionAbsenceEvidenceDigest(input: {
  readyActionId: string
  actionIdentityDigest: string
  connectionEpoch: string
  reason: string
}): string {
  return digestCanonicalJson({
    readyActionId: input.readyActionId,
    actionIdentityDigest: input.actionIdentityDigest,
    connectionEpoch: input.connectionEpoch,
    reason: input.reason,
  })
}

export class CodexToolActionJournalError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexToolActionJournalError'
  }
}

type ReceiptRow = {
  ready_action_id: string
  action_identity_digest: string
  state: 'pending' | 'confirmed' | 'proven_absent' | 'indeterminate'
  receipt_id: string | null
  result_digest: string | null
  result_json: string | null
  resolution_reason: string | null
  resolution_evidence_digest: string | null
  revision: number
}

function nonEmpty(value: string, code: string): string {
  const normalized = value.trim()
  if (!normalized) throw new CodexToolActionJournalError(code)
  return normalized
}

function changes(result: unknown): number {
  return Number((result as { changes?: number } | undefined)?.changes || 0)
}

export class CodexToolActionJournal implements ReadyToolActionReceiptPort {
  constructor(private readonly db: DatabaseConnection) {}

  async begin(input: {
    readyActionId: string
    actionIdentityDigest: string
    at: string
  }): Promise<{ fresh: boolean }> {
    const readyActionId = nonEmpty(input.readyActionId, 'tool_action_id_invalid')
    const actionIdentityDigest = nonEmpty(
      input.actionIdentityDigest,
      'tool_action_identity_digest_invalid',
    )
    const existing = this.readRow(readyActionId)
    if (existing) {
      if (existing.action_identity_digest !== actionIdentityDigest) {
        throw new CodexToolActionJournalError('tool_action_identity_conflict')
      }
      return { fresh: false }
    }
    const inserted = this.db.prepare(`
      INSERT INTO ready_tool_action_receipts (
        ready_action_id, action_identity_digest, state, revision, created_at, updated_at
      ) VALUES (?, ?, 'pending', 1, ?, ?)
      ON CONFLICT(ready_action_id) DO NOTHING
    `).run(readyActionId, actionIdentityDigest, input.at, input.at)
    if (changes(inserted) === 1) return { fresh: true }
    const raced = this.readRow(readyActionId)
    if (!raced || raced.action_identity_digest !== actionIdentityDigest) {
      throw new CodexToolActionJournalError('tool_action_begin_cas_failed')
    }
    return { fresh: false }
  }

  async beginBoundProductEffect(input: CodexBoundProductEffectInput): Promise<{ fresh: boolean }> {
    const ownsTransaction = this.db.inTransaction !== true
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.readRow(nonEmpty(input.effectActionId, 'tool_action_id_invalid'))
      if (existing) {
        const binding = this.db.prepare(`
          SELECT action_identity_digest FROM codex_product_effect_bindings
           WHERE effect_action_id = ? LIMIT 1
        `).get<{ action_identity_digest: string }>(input.effectActionId)
        if (!binding || binding.action_identity_digest !== input.actionIdentityDigest
          || existing.action_identity_digest !== input.actionIdentityDigest) {
          throw new CodexToolActionJournalError('product_effect_identity_conflict')
        }
        if (ownsTransaction) this.db.exec('COMMIT')
        return { fresh: false }
      }
      this.db.prepare(`
        INSERT INTO ready_tool_action_receipts (
          ready_action_id, action_identity_digest, state, revision, created_at, updated_at
        ) VALUES (?, ?, 'pending', 1, ?, ?)
      `).run(input.effectActionId, input.actionIdentityDigest, input.at, input.at)
      this.db.prepare(`
        INSERT INTO codex_product_effect_bindings (
          effect_action_id, action_identity_digest, ready_run_id, ready_scope_id,
          message_visibility_epoch, codex_thread_id, codex_turn_id, codex_call_id,
          parent_ready_action_id, tool_name, product_action, action_ordinal,
          args_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.effectActionId,
        input.actionIdentityDigest,
        input.readyRunId,
        input.readyScopeId,
        input.messageVisibilityEpoch,
        input.codexThreadId,
        input.codexTurnId,
        input.codexCallId,
        input.parentReadyActionId,
        input.toolName,
        input.productAction,
        input.actionOrdinal,
        input.argsDigest,
        input.at,
      )
      if (ownsTransaction) this.db.exec('COMMIT')
      return { fresh: true }
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  settleProductEffectsForCloseout(input: {
    readyRunId: string
    closeoutAt: string
  }): CodexSettledProductEffect[] {
    const ownsTransaction = this.db.inTransaction !== true
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE')
    try {
      const turn = this.db.prepare(`
        SELECT effect_authority_closed_at, product_terminal_digest,
               host_failure_product_terminal_digest
          FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
      `).get<{
        effect_authority_closed_at: string | null
        product_terminal_digest: string | null
        host_failure_product_terminal_digest: string | null
      }>(input.readyRunId)
      if (!turn || turn.product_terminal_digest || turn.host_failure_product_terminal_digest) {
        throw new CodexToolActionJournalError('product_effect_owner_terminal')
      }
      if (turn.effect_authority_closed_at) {
        const result = this.readSettledProductEffects(input.readyRunId)
        if (ownsTransaction) this.db.exec('COMMIT')
        return result
      }
      const closed = this.db.prepare(`
        UPDATE codex_turn_bindings
           SET effect_authority_closed_at = ?, revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND effect_authority_closed_at IS NULL
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
      `).run(input.closeoutAt, input.closeoutAt, input.readyRunId)
      if (changes(closed) !== 1) {
        throw new CodexToolActionJournalError('product_effect_authority_close_cas_failed')
      }
      const pending = this.db.prepare(`
        SELECT receipt.ready_action_id, receipt.action_identity_digest
          FROM ready_tool_action_receipts receipt
         WHERE receipt.state = 'pending' AND receipt.ready_action_id IN (
           SELECT call.ready_action_id FROM codex_tool_call_bindings call
            WHERE call.ready_run_id = ?
           UNION
           SELECT effect.effect_action_id FROM codex_product_effect_bindings effect
            WHERE effect.ready_run_id = ?
         )
         ORDER BY receipt.ready_action_id
      `).all<{ ready_action_id: string; action_identity_digest: string }>(
        input.readyRunId,
        input.readyRunId,
      )
      for (const row of pending) {
        const evidenceDigest = digestCanonicalJson({
          contract: 'codex_product_effect_closeout_indeterminate_v1',
          readyRunId: input.readyRunId,
          readyActionId: row.ready_action_id,
          actionIdentityDigest: row.action_identity_digest,
          closeoutAt: input.closeoutAt,
        })
        const settled = this.db.prepare(`
          UPDATE ready_tool_action_receipts
             SET state = 'indeterminate', resolution_reason = 'owner_closeout_before_result',
                 resolution_evidence_digest = ?, revision = revision + 1, updated_at = ?
           WHERE ready_action_id = ? AND action_identity_digest = ? AND state = 'pending'
        `).run(
          evidenceDigest,
          input.closeoutAt,
          row.ready_action_id,
          row.action_identity_digest,
        )
        if (changes(settled) !== 1) {
          throw new CodexToolActionJournalError('product_effect_closeout_settle_cas_failed')
        }
      }
      const result = this.readSettledProductEffects(input.readyRunId)
      if (ownsTransaction) this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  readSettledProductEffects(readyRunId: string): CodexSettledProductEffect[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT receipt.ready_action_id, receipt.action_identity_digest, receipt.state,
             receipt.receipt_id, receipt.result_digest, receipt.resolution_evidence_digest,
             receipt.revision
        FROM ready_tool_action_receipts receipt
       WHERE receipt.ready_action_id IN (
         SELECT call.ready_action_id FROM codex_tool_call_bindings call
          WHERE call.ready_run_id = ?
         UNION
         SELECT effect.effect_action_id FROM codex_product_effect_bindings effect
          WHERE effect.ready_run_id = ?
       )
       ORDER BY receipt.ready_action_id
    `).all<ReceiptRow>(readyRunId, readyRunId)
    if (rows.some((row) => row.state === 'pending')) {
      throw new CodexToolActionJournalError('product_effect_settlement_incomplete')
    }
    return rows.flatMap((row): CodexSettledProductEffect[] => {
      if (row.state === 'proven_absent') return []
      if (row.state === 'confirmed') {
        if (!row.receipt_id || !row.result_digest) {
          throw new CodexToolActionJournalError('tool_action_receipt_incomplete')
        }
        return [{
          readyActionId: row.ready_action_id,
          actionIdentityDigest: row.action_identity_digest,
          state: 'confirmed',
          revision: row.revision,
          receiptId: row.receipt_id,
          evidenceDigest: row.result_digest,
        }]
      }
      if (!row.resolution_evidence_digest) {
        throw new CodexToolActionJournalError('tool_action_resolution_incomplete')
      }
      return [{
        readyActionId: row.ready_action_id,
        actionIdentityDigest: row.action_identity_digest,
        state: 'indeterminate',
        revision: row.revision,
        receiptId: null,
        evidenceDigest: row.resolution_evidence_digest,
      }]
    })
  }

  async read(readyActionId: string): Promise<ReadyToolActionReceiptRead> {
    const row = this.readRow(nonEmpty(readyActionId, 'tool_action_id_invalid'))
    if (!row) return { state: 'absent' }
    if (row.state === 'pending') {
      return {
        state: 'indeterminate',
        reason: 'action_pending_without_terminal_receipt',
        evidenceDigest: digestCanonicalJson({
          readyActionId: row.ready_action_id,
          actionIdentityDigest: row.action_identity_digest,
          state: row.state,
        }),
      }
    }
    if (row.state === 'proven_absent' || row.state === 'indeterminate') {
      if (!row.resolution_reason || !row.resolution_evidence_digest) {
        throw new CodexToolActionJournalError('tool_action_resolution_incomplete')
      }
      return {
        state: row.state,
        reason: row.resolution_reason,
        evidenceDigest: row.resolution_evidence_digest,
      }
    }
    if (!row.receipt_id || !row.result_digest || !row.result_json) {
      throw new CodexToolActionJournalError('tool_action_receipt_incomplete')
    }
    let output: ToolExecutionOutput
    try {
      output = JSON.parse(row.result_json) as ToolExecutionOutput
    } catch {
      throw new CodexToolActionJournalError('tool_action_result_invalid')
    }
    if (digestCanonicalJson(output) !== row.result_digest) {
      throw new CodexToolActionJournalError('tool_action_result_digest_mismatch')
    }
    return {
      state: 'confirmed',
      receiptId: row.receipt_id,
      resultDigest: row.result_digest,
      output,
    }
  }

  async commit(input: {
    readyActionId: string
    actionIdentityDigest: string
    resultDigest: string
    output: ToolExecutionOutput
    at: string
  }): Promise<Extract<ReadyToolActionReceiptRead, { state: 'confirmed' }>> {
    const outputJson = canonicalJson(input.output)
    if (digestCanonicalJson(input.output) !== input.resultDigest) {
      throw new CodexToolActionJournalError('tool_action_result_digest_invalid')
    }
    const receiptId = `ready-tool-receipt-${digestCanonicalJson({
      readyActionId: input.readyActionId,
      resultDigest: input.resultDigest,
    })}`
    const updated = this.db.prepare(`
      UPDATE ready_tool_action_receipts
         SET state = 'confirmed', receipt_id = ?, result_digest = ?, result_json = ?,
             revision = revision + 1, updated_at = ?
       WHERE ready_action_id = ? AND action_identity_digest = ? AND state = 'pending'
    `).run(
      receiptId,
      input.resultDigest,
      outputJson,
      input.at,
      input.readyActionId,
      input.actionIdentityDigest,
    )
    if (changes(updated) !== 1) {
      const existing = await this.read(input.readyActionId)
      if (
        existing.state !== 'confirmed'
        || existing.receiptId !== receiptId
        || existing.resultDigest !== input.resultDigest
        || canonicalJson(existing.output) !== outputJson
      ) throw new CodexToolActionJournalError('tool_action_commit_cas_failed')
      return existing
    }
    return { state: 'confirmed', receiptId, resultDigest: input.resultDigest, output: input.output }
  }

  markProvenAbsent(input: {
    readyActionId: string
    actionIdentityDigest: string
    reason: string
    evidenceDigest: string
    at: string
  }): void {
    this.resolvePending({ ...input, state: 'proven_absent' })
  }

  markIndeterminate(input: {
    readyActionId: string
    actionIdentityDigest: string
    reason: string
    evidenceDigest: string
    at: string
  }): void {
    this.resolvePending({ ...input, state: 'indeterminate' })
  }

  private resolvePending(input: {
    readyActionId: string
    actionIdentityDigest: string
    state: 'proven_absent' | 'indeterminate'
    reason: string
    evidenceDigest: string
    at: string
  }): void {
    const updated = this.db.prepare(`
      UPDATE ready_tool_action_receipts
         SET state = ?, resolution_reason = ?, resolution_evidence_digest = ?,
             revision = revision + 1, updated_at = ?
       WHERE ready_action_id = ? AND action_identity_digest = ? AND state = 'pending'
    `).run(
      input.state,
      nonEmpty(input.reason, 'tool_action_resolution_reason_invalid'),
      nonEmpty(input.evidenceDigest, 'tool_action_resolution_evidence_invalid'),
      input.at,
      input.readyActionId,
      input.actionIdentityDigest,
    )
    if (changes(updated) !== 1) throw new CodexToolActionJournalError('tool_action_resolution_cas_failed')
  }

  private readRow(readyActionId: string): ReceiptRow | null {
    return this.db.prepare(`
      SELECT ready_action_id, action_identity_digest, state, receipt_id,
             result_digest, result_json, resolution_reason, resolution_evidence_digest, revision
        FROM ready_tool_action_receipts WHERE ready_action_id = ? LIMIT 1
    `).get<ReceiptRow>(readyActionId) || null
  }
}
