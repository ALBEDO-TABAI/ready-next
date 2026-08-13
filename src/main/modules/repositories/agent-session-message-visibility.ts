import type { WorkflowRawDatabase } from './browser-workflow-unit-of-work'

export function requireRunMessageVisibilityEpoch(
  db: WorkflowRawDatabase,
  input: { ownerRunId: string; conversationId: string },
): number {
  const owner = db.prepare(`
    SELECT scope_id, message_visibility_epoch
      FROM run_meta
     WHERE run_id = ?
     LIMIT 1
  `).get<{ scope_id: string | null; message_visibility_epoch: number }>(input.ownerRunId)
  if (!owner) {
    throw new Error('conversation_message_visibility_run_missing')
  }
  if (owner.scope_id !== input.conversationId
    || !Number.isSafeInteger(owner.message_visibility_epoch)
    || owner.message_visibility_epoch < 0) {
    throw new Error('conversation_message_visibility_run_scope_mismatch')
  }
  const scope = db.prepare(`
    SELECT message_visibility_epoch
      FROM chat_conversations
     WHERE id = ? AND closed_at IS NULL
     LIMIT 1
  `).get<{ message_visibility_epoch: number }>(input.conversationId)
  if (!scope || !Number.isSafeInteger(scope.message_visibility_epoch)) {
    throw new Error('conversation_message_visibility_scope_missing')
  }
  if (owner.message_visibility_epoch !== scope.message_visibility_epoch) {
    throw new Error('conversation_message_visibility_epoch_stale')
  }
  const turn = db.prepare(`
    SELECT message_visibility_epoch
      FROM codex_turn_bindings
     WHERE ready_run_id = ?
     LIMIT 1
  `).get<{ message_visibility_epoch: number }>(input.ownerRunId)
  if (turn && turn.message_visibility_epoch !== owner.message_visibility_epoch) {
    throw new Error('conversation_message_visibility_epoch_stale')
  }
  return owner.message_visibility_epoch
}
