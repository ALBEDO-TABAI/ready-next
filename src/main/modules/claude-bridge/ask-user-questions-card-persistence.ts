import type { InteractionLifecycleIdentity } from '../agent-control/runtime-core/interaction-lifecycle-registry'
import { CodexBindingRepository } from '../agent-control/codex-runtime/codex-binding-repository'
import { readCodexPendingInteractionIdentityForCard } from '../agent-control/codex-runtime/codex-pending-interaction-restart'
import { getDatabase } from '../database'
import { requireRunMessageVisibilityEpoch } from '../repositories/agent-session-message-visibility'
import type { AskUserQuestionsCardPersistenceReceipt } from '../tools/builtins/ask-user-questions'
import type { AskUserQuestionSpec } from '../tools/builtins/ask-user-questions-store'

export interface PersistAskUserQuestionsCardArgs {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  scopeId?: string | null
  requestId?: string | null
  lifecycleType?: InteractionLifecycleIdentity['type']
  responsePolicy?: 'local_or_remote' | 'local_renderer_only'
  questions: AskUserQuestionSpec[]
  askedAt: number
}

/** Persists first and returns the exact run identity reused by the later push. */
export function persistAskUserQuestionsCardPending(
  args: PersistAskUserQuestionsCardArgs,
  database: Pick<ReturnType<typeof getDatabase>, 'getRawDb' | 'addChatMessage'> = getDatabase(),
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
  database.addChatMessage(
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
        codexRunIdentity,
        responsePolicy: args.responsePolicy || 'local_or_remote',
      },
    },
    messageVisibilityEpoch ?? undefined,
  )
  return { codexRunIdentity }
}
