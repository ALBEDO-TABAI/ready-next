import type { DatabaseConnection } from '../../database/connection'
import { buildFrozenCallPendingSourceDigest } from '../safety/frozen-call-store'

function changes(result: unknown): number {
  return Number((result as { changes?: number } | null)?.changes || 0)
}

/** Owns the one SQLite transaction that settles a card and its linked confirmation. */
export class CodexInteractionTransitionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  transitionAskCard(input: {
    messageId: string
    meta: Record<string, unknown>
    content?: string
  }): boolean {
    const ownsTransaction = this.db.inTransaction !== true
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare(`
        SELECT conversation_id, meta_json FROM chat_messages WHERE id = ? LIMIT 1
      `).get<{ conversation_id: string; meta_json: string | null }>(input.messageId)
      if (!existing) {
        if (ownsTransaction) this.db.exec('COMMIT')
        return false
      }
      const priorMeta = existing.meta_json
        ? JSON.parse(existing.meta_json) as Record<string, unknown>
        : {}
      const priorAsk = priorMeta.askUserQuestions && typeof priorMeta.askUserQuestions === 'object'
        ? priorMeta.askUserQuestions as Record<string, unknown>
        : null
      const ownerRef = priorAsk?.actionConfirmationOwnerRef
      if (ownerRef && typeof ownerRef === 'object') {
        this.transitionLinkedConfirmation({
          conversationId: existing.conversation_id,
          priorAsk,
          ownerRef: ownerRef as Record<string, unknown>,
          nextMeta: input.meta,
        })
      }
      const metaJson = JSON.stringify(input.meta || {})
      const nextContent = typeof input.content === 'string' ? input.content : null
      const updated = nextContent !== null
        ? this.db.prepare(`
            UPDATE chat_messages SET meta_json = ?, content = ? WHERE id = ?
             AND EXISTS (
               SELECT 1 FROM chat_conversations active
                WHERE active.id = chat_messages.conversation_id AND active.closed_at IS NULL
                  AND chat_messages.message_visibility_epoch = active.message_visibility_epoch
             )
          `).run(metaJson, nextContent, input.messageId)
        : this.db.prepare(`
            UPDATE chat_messages SET meta_json = ? WHERE id = ?
             AND EXISTS (
               SELECT 1 FROM chat_conversations active
                WHERE active.id = chat_messages.conversation_id AND active.closed_at IS NULL
                  AND chat_messages.message_visibility_epoch = active.message_visibility_epoch
             )
          `).run(metaJson, input.messageId)
      if (changes(updated) !== 1) {
        if (ownsTransaction) this.db.exec('ROLLBACK')
        return false
      }
      if (nextContent !== null) {
        this.db.prepare('DELETE FROM chat_messages_fts WHERE message_id = ?').run(input.messageId)
        this.db.prepare(`
          INSERT INTO chat_messages_fts (message_id, conversation_id, content) VALUES (?, ?, ?)
        `).run(input.messageId, existing.conversation_id, nextContent)
      }
      if (ownsTransaction) this.db.exec('COMMIT')
      return true
    } catch (error) {
      if (ownsTransaction && this.db.inTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  private transitionLinkedConfirmation(input: {
    conversationId: string
    priorAsk: Record<string, unknown>
    ownerRef: Record<string, unknown>
    nextMeta: Record<string, unknown>
  }): void {
    const frozenCallId = input.ownerRef.frozenCallId
    const expectedSourceDigest = input.ownerRef.pendingConfirmationSourceDigest
    if (typeof frozenCallId !== 'string' || typeof expectedSourceDigest !== 'string') {
      throw new Error('action_confirmation_owner_ref_invalid')
    }
    const confirmation = this.db.prepare(`
      SELECT id, run_id, task_id, scope_id, tool_name, params_json, created_at, expires_at
        FROM pending_confirmations WHERE id = ? AND status = 'pending' LIMIT 1
    `).get<{
      id: string
      run_id: string | null
      task_id: string | null
      scope_id: string | null
      tool_name: string
      params_json: string
      created_at: string
      expires_at: string
    }>(frozenCallId)
    const sourceDigest = confirmation ? buildFrozenCallPendingSourceDigest({
      id: confirmation.id,
      runId: confirmation.run_id,
      taskId: confirmation.task_id,
      scopeId: confirmation.scope_id,
      toolName: confirmation.tool_name,
      paramsJson: confirmation.params_json,
      createdAt: confirmation.created_at,
      expiresAt: confirmation.expires_at,
    }) : null
    if (!confirmation || sourceDigest !== expectedSourceDigest
      || confirmation.scope_id !== input.conversationId
      || confirmation.run_id !== input.priorAsk.requestId) {
      throw new Error('action_confirmation_owner_ref_mismatch')
    }
    const nextAsk = input.nextMeta.askUserQuestions
      && typeof input.nextMeta.askUserQuestions === 'object'
      ? input.nextMeta.askUserQuestions as Record<string, unknown>
      : null
    const nextStatus = nextAsk?.status
    let confirmationStatus: 'released' | 'denied' | 'expired'
    let releasedAt: string | null = null
    if (nextStatus === 'submitted') {
      const answers = Array.isArray(nextAsk?.answers) ? nextAsk.answers : []
      const confirmed = answers.some((answer) => {
        if (!answer || typeof answer !== 'object') return false
        const value = (answer as { answer?: unknown }).answer
        return value === '确认执行' || value === '确认（本次会话内同对象免再确认）'
      })
      confirmationStatus = confirmed ? 'released' : 'denied'
      releasedAt = confirmed
        ? new Date(Number(nextAsk?.answeredAt || Date.now())).toISOString()
        : null
    } else if (nextStatus === 'cancelled') {
      const reason = String(nextAsk?.cancelReason || '')
      confirmationStatus = /timeout|abort|restart|expired/.test(reason) ? 'expired' : 'denied'
    } else {
      throw new Error('action_confirmation_transition_invalid')
    }
    const linked = this.db.prepare(`
      UPDATE pending_confirmations SET status = ?, released_at = ?
       WHERE id = ? AND status = 'pending' AND params_json = ?
    `).run(confirmationStatus, releasedAt, confirmation.id, confirmation.params_json)
    if (changes(linked) !== 1) throw new Error('action_confirmation_transition_cas_failed')
  }
}
