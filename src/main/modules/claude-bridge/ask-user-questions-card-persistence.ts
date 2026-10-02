import type { InteractionLifecycleIdentity } from '../agent-control/runtime-core/interaction-lifecycle-registry'
import { CodexBindingRepository } from '../agent-control/codex-runtime/codex-binding-repository'
import { readCodexPendingInteractionIdentityForCard } from '../agent-control/codex-runtime/codex-pending-interaction-restart'
import { getDatabase } from '../database'
import { requireRunMessageVisibilityEpoch } from '../repositories/agent-session-message-visibility'
import type { AskUserQuestionsCardPersistenceReceipt } from '../tools/builtins/ask-user-questions'
import type { AskUserQuestionSpec } from '../tools/builtins/ask-user-questions-store'
import { buildFrozenCallPendingSourceDigest } from '../agent-control/safety/frozen-call-store'

export interface PersistAskUserQuestionsCardArgs {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  scopeId?: string | null
  requestId?: string | null
  lifecycleType?: InteractionLifecycleIdentity['type']
  actionConfirmationOwnerRef?: {
    frozenCallId: string
    pendingConfirmationSourceDigest: string
  }
  responsePolicy?: 'local_or_remote' | 'local_renderer_only'
  questions: AskUserQuestionSpec[]
  askedAt: number
}

/** Persists first and returns the exact run identity reused by the later push. */
export function persistAskUserQuestionsCardPending(
  args: PersistAskUserQuestionsCardArgs,
  database: Pick<ReturnType<typeof getDatabase>, 'getRawDb' | 'chat'> = getDatabase(),
): AskUserQuestionsCardPersistenceReceipt {
  const conversationId = args.conversationId || args.sessionId || ''
  if (!conversationId) {
    throw new Error('ask_user_questions persist requires a conversationId or sessionId')
  }
  const askedAt = new Date(args.askedAt).toISOString()
  const summary = `等待用户回答 ${args.questions.length} 个问题`
  const rawDb = database.getRawDb()!
  const bindingRepository = new CodexBindingRepository(rawDb)
  const scopeId = args.scopeId || conversationId
  const messageVisibilityEpoch = args.requestId
    ? requireRunMessageVisibilityEpoch(rawDb, {
        ownerRunId: args.requestId,
        conversationId: scopeId,
      })
    : null
  if (args.requestId) {
    const owner = rawDb.prepare(
      'SELECT status FROM run_meta WHERE run_id = ? LIMIT 1',
    ).get<{ status: string }>(args.requestId)
    if (owner?.status !== 'running') {
      throw new Error('ask_user_questions_run_not_active')
    }
  }
  const codexIdentity = readCodexPendingInteractionIdentityForCard({
    repository: bindingRepository,
    readyRunId: args.requestId,
    scopeId,
  })
  if (args.requestId && bindingRepository.hasProductTurnBinding(args.requestId) && !codexIdentity) {
    throw new Error('codex_pending_interaction_identity_inactive')
  }
  if (codexIdentity && codexIdentity.messageVisibilityEpoch !== messageVisibilityEpoch) {
    throw new Error('codex_pending_interaction_visibility_identity_mismatch')
  }
  const codexRunIdentity = codexIdentity
    ? codexIdentity
    : args.requestId && messageVisibilityEpoch !== null
      ? {
          readyRunId: args.requestId,
          aliasGeneration: null,
          messageVisibilityEpoch,
        }
      : null
  const ownsTransaction = rawDb.inTransaction !== true
  if (ownsTransaction) rawDb.exec('BEGIN IMMEDIATE')
  try {
  const pendingCard = rawDb.prepare(`
    SELECT id FROM chat_messages
     WHERE conversation_id = ? AND role = 'agent_card'
       AND json_extract(meta_json, '$.askUserQuestions.status') = 'pending'
     LIMIT 1
  `).get<{ id: string }>(conversationId)
  const ownerRef = args.actionConfirmationOwnerRef || null
  if (pendingCard) throw new Error('overlapping_card')
  if (ownerRef) {
    if (args.lifecycleType !== 'action_confirmation') {
      throw new Error('action_confirmation_owner_ref_invalid')
    }
    const confirmation = rawDb.prepare(`
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
    }>(ownerRef.frozenCallId)
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
    if (!confirmation
      || sourceDigest !== ownerRef.pendingConfirmationSourceDigest
      || confirmation.run_id !== (args.requestId || null)
      || confirmation.scope_id !== scopeId) {
      throw new Error('action_confirmation_owner_ref_invalid')
    }
    const otherConfirmation = rawDb.prepare(`
      SELECT id FROM pending_confirmations
       WHERE status = 'pending' AND scope_id = ? AND id != ? LIMIT 1
    `).get<{ id: string }>(scopeId, confirmation.id)
    if (otherConfirmation) throw new Error('overlapping_card')
  } else {
    const pendingConfirmation = rawDb.prepare(`
      SELECT id FROM pending_confirmations
       WHERE status = 'pending' AND scope_id = ? LIMIT 1
    `).get<{ id: string }>(scopeId)
    if (pendingConfirmation) throw new Error('overlapping_card')
  }
  database.chat.addChatMessage(
    args.cardId,
    conversationId,
    'agent_card',
    summary,
    askedAt,
    {
      askUserQuestions: {
        cardId: args.cardId,
        status: 'pending',
        questions: args.questions,
        askedAt: args.askedAt,
        scopeId: args.scopeId || null,
        requestId: args.requestId || null,
        lifecycleType: args.lifecycleType || 'ask_user_questions',
        ...(ownerRef ? { actionConfirmationOwnerRef: ownerRef } : {}),
        codexRunIdentity,
        responsePolicy: args.responsePolicy || 'local_or_remote',
      },
    },
    messageVisibilityEpoch ?? undefined,
  )
  if (ownsTransaction) rawDb.exec('COMMIT')
  } catch (error) {
    if (ownsTransaction) rawDb.exec('ROLLBACK')
    throw error
  }
  return { codexRunIdentity }
}
