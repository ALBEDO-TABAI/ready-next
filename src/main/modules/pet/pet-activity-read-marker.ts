import type { PetActivityOpenIdentity, PetActivitySnapshot } from '../../../shared/pet'
import type { DatabaseConnection } from '../database'

export const PET_ACTIVITY_CUTOVER_AT_KEY = 'desktop_pet_activity_cutover_at'

export interface PetActivityReadMarker {
  messageId: string | null
  seenAt: string | null
}

export function readPetActivityMarker(
  db: DatabaseConnection,
  scopeId: string,
): PetActivityReadMarker | null {
  return db.prepare(`
    SELECT pet_last_seen_assistant_message_id AS messageId,
           pet_last_seen_at AS seenAt
      FROM chat_conversations
     WHERE id = ?
       AND closed_at IS NULL
  `).get<PetActivityReadMarker>(scopeId) || null
}

export function readPetActivityCutoverAt(db: DatabaseConnection): string | null {
  return db.prepare(`
    SELECT value
      FROM settings
     WHERE key = ?
  `).get<{ value: string }>(PET_ACTIVITY_CUTOVER_AT_KEY)?.value || null
}

export function isPetTerminalActivityUnread(
  updatedAt: string,
  marker: PetActivityReadMarker | null,
  cutoverAt: string | null,
): boolean {
  if (!marker) return false
  const updated = Date.parse(updatedAt)
  if (!Number.isFinite(updated)) return false
  const seen = Date.parse(marker.seenAt || '')
  const cutover = Date.parse(cutoverAt || '')
  return updated > Math.max(
    Number.isFinite(seen) ? seen : 0,
    Number.isFinite(cutover) ? cutover : 0,
  )
}

export function isPetActivityAfterCutover(updatedAt: string, cutoverAt: string | null): boolean {
  const updated = Date.parse(updatedAt)
  if (!Number.isFinite(updated)) return false
  const cutover = Date.parse(cutoverAt || '')
  return updated > (Number.isFinite(cutover) ? cutover : 0)
}

function latestVisibleAssistantMessageId(db: DatabaseConnection, scopeId: string): string | null {
  return db.prepare(`
    SELECT message.id
      FROM chat_messages message
      JOIN chat_conversations scope ON scope.id = message.conversation_id
     WHERE message.conversation_id = ?
       AND message.role = 'assistant'
       AND scope.closed_at IS NULL
       AND message.message_visibility_epoch = scope.message_visibility_epoch
     ORDER BY message.timestamp DESC LIMIT 1
  `).get<{ id: string }>(scopeId)?.id || null
}

function writePetActivityReadMarker(
  db: DatabaseConnection,
  scopeId: string,
  seenAt: string,
  messageId: string | null,
): boolean {
  const result = db.prepare(`
    UPDATE chat_conversations
       SET pet_last_seen_assistant_message_id = COALESCE(?, pet_last_seen_assistant_message_id),
           pet_last_seen_at = CASE
             WHEN pet_last_seen_at IS NULL OR pet_last_seen_at < ? THEN ?
             ELSE pet_last_seen_at
           END
     WHERE id = ?
       AND closed_at IS NULL
       AND (? IS NULL OR EXISTS (
         SELECT 1
           FROM chat_messages message
          WHERE message.id = ?
            AND message.conversation_id = chat_conversations.id
            AND message.role = 'assistant'
            AND message.message_visibility_epoch = chat_conversations.message_visibility_epoch
       ))
  `).run(messageId, seenAt, seenAt, scopeId, messageId, messageId) as { changes?: number }
  return Number(result.changes || 0) === 1
}

export function markPetActivitySeen(
  db: DatabaseConnection,
  activity: PetActivityOpenIdentity & Pick<PetActivitySnapshot, 'kind'>,
): boolean {
  if (activity.kind !== 'ready' && activity.kind !== 'blocked') return false
  const projection = db.prepare(`
    SELECT status
      FROM task_projections
     WHERE task_id = ?
       AND scope_id = ?
       AND run_id = ?
       AND updated_at = ?
  `).get<{ status: string }>(activity.taskId, activity.scopeId, activity.runId, activity.updatedAt)
  if (!projection) return false
  if (activity.kind === 'ready' && projection.status !== 'completed') return false
  if (activity.kind === 'blocked' && projection.status !== 'failed') return false
  return writePetActivityReadMarker(
    db,
    activity.scopeId,
    activity.updatedAt,
    activity.messageId,
  )
}

export function markPetScopeTerminalActivitiesSeen(
  db: DatabaseConnection,
  scopeId: string,
): boolean {
  const cutoverAt = readPetActivityCutoverAt(db)
  const latest = db.prepare(`
    SELECT MAX(updated_at) AS updatedAt
      FROM task_projections
     WHERE scope_id = ?
       AND status IN ('completed', 'failed')
       AND (? IS NULL OR updated_at > ?)
  `).get<{ updatedAt: string | null }>(scopeId, cutoverAt, cutoverAt)?.updatedAt || null
  if (!latest) return false
  return writePetActivityReadMarker(
    db,
    scopeId,
    latest,
    latestVisibleAssistantMessageId(db, scopeId),
  )
}
