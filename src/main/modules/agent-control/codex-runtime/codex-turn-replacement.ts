/**
 * Editing the latest message and sending it again replaces that turn: the old message and everything shown after it
 * leave the conversation in the transaction that admits the new one, and the model is told the old turn is withdrawn.
 *
 * The rows stay stored. Run records, memory evidence and artifacts still point at them; only the conversation, its
 * search text and later memory pairing stop seeing them. Native history is not rewritten: a turn that had been
 * accepted is still in the thread, which is why the notice below travels with the replacing turn.
 */
import { createHash } from 'node:crypto'
import { PrePersistenceAdmissionError } from '../send-scoped-confirmation'

type ReplacementDatabase = {
  prepare(sql: string): {
    get<T>(...params: unknown[]): T | undefined
    all<T>(...params: unknown[]): T[]
    run(...params: unknown[]): unknown
  }
}

export type CodexTurnReplacementTarget = {
  originUserMessageId: string
  timestamp: string
}

export const CODEX_REPLACED_TURN_CONTEXT_KEY = 'ready-replaced-turn'
export const CODEX_REPLACED_TURN_CONTEXT_CONTRACT = 'ready_replaced_turn_v1'
export const CODEX_REPLACED_TURN_NOTICE = [
  '用户改写了上一条消息并重新发送。上一条消息以及针对它的回复已经从对话中撤下，用户看不到它们。',
  '把当前这条消息当作对上一条的替换来回答：不要提及、引用或延续被撤下的那一轮，也不要说“如前所述”。',
  '被撤下那一轮里已经发生的实际操作（写入的文件、网页上的动作等）不会自动撤销；只有当前消息要求时才去处理。',
].join('\n')

/**
 * The message can be replaced only while it is the person's latest visible message in this conversation. Returns null
 * when it is not (already replaced, another message came after it, a different conversation or a past epoch).
 */
export function resolveCodexTurnReplacementTarget(db: ReplacementDatabase, input: {
  scopeId: string
  userMessageId: string
}): CodexTurnReplacementTarget | null {
  const target = db.prepare(`
    SELECT message.id, message.timestamp, message.rowid AS row_id
      FROM chat_messages message
      JOIN chat_conversations scope ON scope.id = message.conversation_id
     WHERE message.id = ? AND message.conversation_id = ? AND message.role = 'user'
       AND scope.closed_at IS NULL
       AND message.message_visibility_epoch = scope.message_visibility_epoch
       AND message.replaced_by_run_id IS NULL
     LIMIT 1
  `).get<{ id: string; timestamp: string; row_id: number }>(input.userMessageId, input.scopeId)
  if (!target) return null
  const later = db.prepare(`
    SELECT 1 AS present
      FROM chat_messages message
      JOIN chat_conversations scope ON scope.id = message.conversation_id
     WHERE message.conversation_id = ? AND message.role = 'user' AND message.id <> ?
       AND message.message_visibility_epoch = scope.message_visibility_epoch
       AND message.replaced_by_run_id IS NULL
       AND (message.timestamp > ? OR (message.timestamp = ? AND message.rowid > ?))
     LIMIT 1
  `).get<{ present: number }>(input.scopeId, target.id, target.timestamp, target.timestamp, target.row_id)
  return later ? null : { originUserMessageId: target.id, timestamp: target.timestamp }
}

/**
 * The first check of a send that asks to replace the latest turn, before anything else is prepared (the admission
 * transaction checks again). A send that replaces nothing returns null; a stale target, or one combined with an
 * explicit retry, is refused before persistence so the person's conversation is left as it was.
 */
export function requireRequestedCodexTurnReplacement(db: ReplacementDatabase, scopeId: string, request: {
  replaceLatestTurn?: { userMessageId: string }
  explicitRetry?: unknown
}): CodexTurnReplacementTarget | null {
  if (!request.replaceLatestTurn) return null
  const target = request.explicitRetry ? null : resolveCodexTurnReplacementTarget(db, {
    scopeId, userMessageId: request.replaceLatestTurn.userMessageId,
  })
  if (target) return target
  throw new PrePersistenceAdmissionError(
    'action_projection_confirmation_required',
    true,
    createHash('sha256').update(JSON.stringify({
      scopeId, stage: 'replace_latest_turn_target', userMessageId: request.replaceLatestTurn.userMessageId,
    })).digest('hex'),
    'codex_replace_latest_turn_target_stale',
  )
}

/**
 * Marks the replaced message and everything shown after it. Must run inside the admission transaction, before the
 * replacing message is inserted, so a rejected send hides nothing.
 */
export function markCodexTurnReplacedInOpenTransaction(db: ReplacementDatabase, input: {
  scopeId: string
  target: CodexTurnReplacementTarget
  replacingRunId: string
}): void {
  const rows = db.prepare(`
    SELECT message.id
      FROM chat_messages message
      JOIN chat_conversations scope ON scope.id = message.conversation_id
     WHERE message.conversation_id = ?
       AND message.message_visibility_epoch = scope.message_visibility_epoch
       AND message.replaced_by_run_id IS NULL
       AND (message.id = ? OR message.timestamp >= ?)
  `).all<{ id: string }>(input.scopeId, input.target.originUserMessageId, input.target.timestamp)
  const dropSearchText = db.prepare('DELETE FROM chat_messages_fts WHERE message_id = ?')
  const mark = db.prepare('UPDATE chat_messages SET replaced_by_run_id = ? WHERE id = ?')
  for (const row of rows) {
    dropSearchText.run(row.id)
    mark.run(input.replacingRunId, row.id)
  }
}

/** The context the gateway expects for a prepared run: present only when the run replaced a turn. */
export function codexReplacedTurnContext(prepared: {
  runId: string
  replacedOriginUserMessageId?: string
}): ReturnType<typeof buildCodexReplacedTurnContext> | null {
  return prepared.replacedOriginUserMessageId
    ? buildCodexReplacedTurnContext({
        readyRunId: prepared.runId,
        replacedOriginUserMessageId: prepared.replacedOriginUserMessageId,
      })
    : null
}

export function buildCodexReplacedTurnContext(input: {
  readyRunId: string
  replacedOriginUserMessageId: string
}) {
  return {
    contract: CODEX_REPLACED_TURN_CONTEXT_CONTRACT,
    readyRunId: input.readyRunId,
    replacedOriginUserMessageId: input.replacedOriginUserMessageId,
    notice: CODEX_REPLACED_TURN_NOTICE,
  }
}
