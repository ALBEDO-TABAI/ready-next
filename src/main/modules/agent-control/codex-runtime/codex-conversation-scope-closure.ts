import type { DatabaseConnection } from '../../database/connection'

export type CodexClosedConversationScopeRead = {
  scopeId: string
  closedAt: string
  closedReason: 'closed'
  closeEvidenceDigest: string
}

export type CodexConversationMessageVisibilityRead = {
  scopeId: string
  previousEpoch: number
  messageVisibilityEpoch: number
}

function nonEmpty(value: string, code: string): void {
  if (!value.trim()) throw new Error(code)
}

function digestValue(value: string, code: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(code)
}

export function readCodexClosedConversationScope(
  db: Pick<DatabaseConnection, 'prepare'>,
  scopeId: string,
): CodexClosedConversationScopeRead | null {
  nonEmpty(scopeId, 'codex_closed_scope_identity_invalid')
  const row = db.prepare(`
    SELECT id, closed_at, closed_reason, close_evidence_digest
      FROM chat_conversations WHERE id = ? LIMIT 1
  `).get<{
    id: string
    closed_at: string | null
    closed_reason: string | null
    close_evidence_digest: string | null
  }>(scopeId)
  if (!row || !row.closed_at || row.closed_reason !== 'closed' || !row.close_evidence_digest) {
    return null
  }
  return {
    scopeId: row.id,
    closedAt: row.closed_at,
    closedReason: 'closed',
    closeEvidenceDigest: row.close_evidence_digest,
  }
}

export function closeCodexConversationScopeInOpenTransaction(
  db: DatabaseConnection,
  input: {
    scopeId: string
    closedAt: string
    closeEvidenceDigest: string
  },
): CodexClosedConversationScopeRead {
  if (db.inTransaction !== true) throw new Error('codex_closed_scope_transaction_missing')
  nonEmpty(input.scopeId, 'codex_closed_scope_identity_invalid')
  nonEmpty(input.closedAt, 'codex_closed_scope_time_invalid')
  digestValue(input.closeEvidenceDigest, 'codex_closed_scope_evidence_invalid')
  const existing = db.prepare(`
    SELECT id, closed_at, closed_reason, close_evidence_digest
      FROM chat_conversations WHERE id = ? LIMIT 1
  `).get<{
    id: string
    closed_at: string | null
    closed_reason: string | null
    close_evidence_digest: string | null
  }>(input.scopeId)
  if (!existing) throw new Error('codex_closed_scope_missing')
  if (existing.closed_at !== null) {
    if (existing.closed_at !== input.closedAt
      || existing.closed_reason !== 'closed'
      || existing.close_evidence_digest !== input.closeEvidenceDigest) {
      throw new Error('codex_closed_scope_conflict')
    }
  } else {
    const result = db.prepare(`
      UPDATE chat_conversations
         SET closed_at = ?, closed_reason = 'closed', close_evidence_digest = ?
       WHERE id = ? AND closed_at IS NULL
    `).run(input.closedAt, input.closeEvidenceDigest, input.scopeId) as { changes?: number }
    if (result.changes !== 1) throw new Error('codex_closed_scope_cas_failed')
  }
  const readback = readCodexClosedConversationScope(db, input.scopeId)
  if (!readback
    || readback.closedAt !== input.closedAt
    || readback.closeEvidenceDigest !== input.closeEvidenceDigest) {
    throw new Error('codex_closed_scope_readback_failed')
  }
  return readback
}

export function advanceCodexConversationMessageVisibilityInOpenTransaction(
  db: DatabaseConnection,
  input: { scopeId: string; resetAt: string },
): CodexConversationMessageVisibilityRead {
  if (db.inTransaction !== true) {
    throw new Error('codex_message_visibility_transaction_missing')
  }
  nonEmpty(input.scopeId, 'codex_message_visibility_scope_invalid')
  nonEmpty(input.resetAt, 'codex_message_visibility_time_invalid')
  const scope = db.prepare(`
    SELECT id, closed_at, message_visibility_epoch, meta_json
      FROM chat_conversations WHERE id = ? LIMIT 1
  `).get<{
    id: string
    closed_at: string | null
    message_visibility_epoch: number
    meta_json: string | null
  }>(input.scopeId)
  if (!scope || scope.closed_at !== null) {
    throw new Error('codex_message_visibility_scope_missing')
  }
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(scope.meta_json || '{}') as Record<string, unknown>
  } catch {
    throw new Error('codex_message_visibility_scope_meta_invalid')
  }
  delete meta.lastReferenceSkill
  delete meta.sessionRecallContext
  const nextEpoch = scope.message_visibility_epoch + 1
  const updated = db.prepare(`
    UPDATE chat_conversations
       SET message_visibility_epoch = ?, meta_json = ?, updated_at = ?
     WHERE id = ? AND closed_at IS NULL AND message_visibility_epoch = ?
  `).run(
    nextEpoch,
    JSON.stringify(meta),
    input.resetAt,
    input.scopeId,
    scope.message_visibility_epoch,
  ) as { changes?: number }
  if (updated.changes !== 1) throw new Error('codex_message_visibility_cas_failed')

  const clearIfPresent = (table: string, sql: string): void => {
    const present = db.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE name = ? LIMIT 1
    `).get<{ present: number }>(table)
    if (present) db.prepare(sql).run(input.scopeId)
  }
  clearIfPresent(
    'chat_messages_fts',
    'DELETE FROM chat_messages_fts WHERE conversation_id = ?',
  )
  clearIfPresent(
    'session_recall_attachment_index',
    'DELETE FROM session_recall_attachment_index WHERE conversation_id = ?',
  )
  clearIfPresent(
    'session_recall_metadata',
    'DELETE FROM session_recall_metadata WHERE conversation_id = ?',
  )
  clearIfPresent(
    'session_recall_vectors',
    'DELETE FROM session_recall_vectors WHERE conversation_id = ?',
  )

  const readback = db.prepare(`
    SELECT message_visibility_epoch
      FROM chat_conversations WHERE id = ? AND closed_at IS NULL LIMIT 1
  `).get<{ message_visibility_epoch: number }>(input.scopeId)
  if (readback?.message_visibility_epoch !== nextEpoch) {
    throw new Error('codex_message_visibility_readback_failed')
  }
  return {
    scopeId: input.scopeId,
    previousEpoch: scope.message_visibility_epoch,
    messageVisibilityEpoch: nextEpoch,
  }
}

export function clearCodexImplicitConversationContextInOpenTransaction(
  db: DatabaseConnection,
  input: { scopeId: string; updatedAt: string },
): void {
  if (db.inTransaction !== true) throw new Error('codex_context_clear_transaction_missing')
  const scope = db.prepare(`
    SELECT meta_json FROM chat_conversations
     WHERE id = ? AND closed_at IS NULL LIMIT 1
  `).get<{ meta_json: string | null }>(input.scopeId)
  if (!scope) throw new Error('codex_context_clear_scope_missing')
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(scope.meta_json || '{}') as Record<string, unknown>
  } catch {
    throw new Error('codex_context_clear_scope_meta_invalid')
  }
  delete meta.lastReferenceSkill
  delete meta.sessionRecallContext
  const updated = db.prepare(`
    UPDATE chat_conversations SET meta_json = ?, updated_at = ?
     WHERE id = ? AND closed_at IS NULL AND COALESCE(meta_json, '{}') = COALESCE(?, '{}')
  `).run(JSON.stringify(meta), input.updatedAt, input.scopeId, scope.meta_json) as { changes?: number }
  if (updated.changes !== 1) throw new Error('codex_context_clear_scope_cas_failed')
}
