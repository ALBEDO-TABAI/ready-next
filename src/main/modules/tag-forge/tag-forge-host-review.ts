import {
  getAskUserQuestionsCardEmitter,
  getAskUserQuestionsCardPersistor,
} from '../agent-control/ask-user/ask-user-questions-bridge'
import { normalizeToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import type { executeAskUserQuestions } from '../tools/builtins/ask-user-questions'
import { ToolDomainError } from '../tools/tool-errors'

export interface TagForgeHostReviewContext {
  abortSignal?: AbortSignal
  agent?: string | null
  onToolEffectEnd?: () => void
  onToolEffectStart?: () => void
  runId?: string
  scope?: { id: string; agent?: string | null } | null
  scopeId?: string
  sessionId?: string
}

const askedReviewRuns = new Map<string, { batchId: string; fingerprint: string; cardId: string; askedAt: number }>()
const REVIEW_RUN_TTL_MS = 30 * 60_000

export async function completeTagForgeHostReview<TFileContext>(
  toolName: string,
  result: string,
  context: TagForgeHostReviewContext,
  fileContext: TFileContext,
  deps: {
    askUserQuestions: typeof executeAskUserQuestions
    executeFileTool: (name: string, args: Record<string, unknown>, fileContext: TFileContext) => Promise<string>
  },
): Promise<string> {
  if (toolName !== 'tag_forge_apply_batch') return result
  let batch: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(result)
    batch = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return result
  }
  const reviewQuestion = batch?.reviewQuestion
  const batchId = typeof batch?.batchId === 'string' ? batch.batchId : ''
  const scopeId = context.scopeId || context.scope?.id || context.sessionId || null
  const now = Date.now()
  for (const [runId, review] of askedReviewRuns) if (now - review.askedAt > REVIEW_RUN_TTL_MS) askedReviewRuns.delete(runId)
  if (
    batch?.reviewRequired !== true
    || !batchId
    || !reviewQuestion
    || typeof reviewQuestion !== 'object'
    || Array.isArray(reviewQuestion)
    || !context.runId
    || !context.sessionId
    || !scopeId
  ) return result
  const fingerprint = JSON.stringify(reviewQuestion)
  const askedReview = askedReviewRuns.get(context.runId)
  if (askedReview) {
    if (askedReview.batchId !== batchId || askedReview.fingerprint !== fingerprint) {
      return result
    }
    context.onToolEffectEnd?.()
    context.onToolEffectStart?.()
    return deps.executeFileTool('tag_forge_review_batch', {
      batchId,
      confirmationCardId: askedReview.cardId,
    }, fileContext)
  }
  context.onToolEffectEnd?.()
  const answer = await deps.askUserQuestions(
    reviewQuestion as Parameters<typeof executeAskUserQuestions>[0],
    {
      sessionId: context.sessionId,
      conversationId: context.scope?.id || context.sessionId,
      scopeId,
      agent: context.agent || context.scope?.agent || null,
      requestId: context.runId,
      signal: context.abortSignal,
      emitAskUserQuestionsCard: getAskUserQuestionsCardEmitter(),
      persistCardPending: getAskUserQuestionsCardPersistor(),
    },
  )
  const answerData = normalizeToolExecutionOutput(answer).data
  const cardId = answerData && typeof answerData === 'object' && typeof answerData.cardId === 'string'
    ? answerData.cardId
    : ''
  if (!cardId) throw new ToolDomainError('tag_forge_review_card_missing', 'Tag Forge review card returned no card id')
  askedReviewRuns.set(context.runId, { batchId, fingerprint, cardId, askedAt: Date.now() })
  context.onToolEffectStart?.()
  return deps.executeFileTool('tag_forge_review_batch', { batchId, confirmationCardId: cardId }, fileContext)
}
