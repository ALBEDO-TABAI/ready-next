/**
 * Main-agent built-in tool `ask_user_questions`.
 *
 * Lets the agent suspend a turn while the user fills in 1–5 structured
 * questions (single-choice / multi-choice / free-text). The card is rendered
 * inline in the chat stream, stays in history after the user submits, and the
 * answer set is returned to the model as a structured tool result.
 *
 * Boundary: this tool is intentionally NOT a `skill_*` primitive. It lives in
 * the dedicated `agent_interaction` capability group so it is visible to the
 * main agent regardless of any skill authorization state (§6.23).
 *
 * Pipeline:
 *   1. Validate args (Zod) — handled by `tool-input-validator` before this
 *      runs; we re-parse defensively to lock in the inferred type.
 *   2. Refuse if the session already has another pending card (single-
 *      pending invariant — model must not stack reflection cards).
 *   3. Persist card to DB as `status='pending'` via `persistCard` callback
 *      FIRST so renderer hydrate (`listPendingAskUserQuestions`) can see it
 *      even if the IPC push races.
 *   4. Push event via `emitAskUserQuestionsCard` callback (IPC layer wraps
 *      `mainWindow.webContents.send`).
 *   5. `await` Promise. Resolved by the IPC submit handler after it
 *      atomically updates DB to `status='submitted'` and calls
 *      `store.resolve(cardId, answerSet)`.
 *   6. Map answers to a model-friendly tool result: markdown summary +
 *      structured JSON.
 *
 * AbortSignal / timeout / session-reset all flow through the store's
 * reject path → `ToolDomainError` with a specific `errorKind`.
 */

import { z } from 'zod'

import { logAgentMetric } from '../../agent-control/metrics'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../../agent-control/tool-result-types'
import { ToolDomainError } from '../tool-errors'
import {
  AskUserQuestionsStore,
  generateAskUserQuestionsCardId,
  getAskUserQuestionsStore,
  type AskUserAnswer,
  type AskUserQuestionsAnswerSet,
  type AskUserQuestionSpec,
} from './ask-user-questions-store'

const QUESTION_KIND = z.enum(['single_choice', 'multi_choice', 'free_text'])

const QUESTION_SCHEMA = z.object({
  id: z.string().trim().min(1).max(64).describe('问题唯一 id，模型生成（如 q1 / timeline）'),
  question: z.string().trim().min(1).max(500).describe('展示给用户的问题文本'),
  kind: QUESTION_KIND.describe('问题类型：single_choice / multi_choice / free_text'),
  options: z.array(z.string().trim().min(1).max(80)).max(8).optional()
    .describe('单选 / 多选题的备选答案，最多 8 个；自由文本题不允许出现 options'),
  placeholder: z.string().max(200).optional()
    .describe('自由文本题的输入框 placeholder'),
  required: z.boolean().optional().describe('是否必答，默认 true'),
})

/**
 * Plain ZodObject so the registry/validator and `zodObjectToParamList`
 * (which derives the LLM-facing JSONSchema) can both consume it. Cross-
 * question business rules (unique ids, single/multi require ≥2 options,
 * free_text must not carry options) live in `validateAskUserQuestionsArgs`
 * below — the handler runs them after the schema parse and surfaces
 * `ToolDomainError('input_validation', …)` on failure, which routes through
 * dispatch the same way as Zod failures.
 */
export const askUserQuestionsSchema = z.object({
  questions: z.array(QUESTION_SCHEMA).min(1).max(5)
    .describe('要询问的 1-5 个问题；按数组顺序展示给用户'),
})

export type AskUserQuestionsArgs = z.infer<typeof askUserQuestionsSchema>

function validateAskUserQuestionsArgs(args: AskUserQuestionsArgs): string | null {
  const seen = new Set<string>()
  for (let i = 0; i < args.questions.length; i += 1) {
    const q = args.questions[i]
    if (seen.has(q.id)) return `Duplicate question id at index ${i}: ${q.id}`
    seen.add(q.id)
    if (q.kind === 'single_choice' || q.kind === 'multi_choice') {
      if (!q.options || q.options.length < 2) {
        return `Question ${q.id} (${q.kind}) requires at least 2 options`
      }
    } else if (q.kind === 'free_text' && q.options && q.options.length > 0) {
      return `Question ${q.id} (free_text) must not carry options`
    }
  }
  return null
}

export interface AskUserQuestionsCardEvent {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  questions: AskUserQuestionSpec[]
  askedAt: number
}

export type EmitAskUserQuestionsCard = (event: AskUserQuestionsCardEvent) => void

export interface PersistCardPendingArgs {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  questions: AskUserQuestionSpec[]
  askedAt: number
}

export type PersistAskUserQuestionsCardPending = (args: PersistCardPendingArgs) => void | Promise<void>

export interface AskUserQuestionsHandlerDeps {
  sessionId?: string
  conversationId?: string
  signal?: AbortSignal
  /** Notifies the renderer a card is pending. No-op in unit tests. */
  emitAskUserQuestionsCard?: EmitAskUserQuestionsCard
  /**
   * Persists the card row (status='pending') BEFORE the IPC push. The IPC
   * submit handler is responsible for updating the same row to
   * status='submitted' before calling `store.resolve` so renderer hydrate
   * never races a stale pending row.
   *
   * No-op default so unit tests can run without a SQLite gate.
   */
  persistCardPending?: PersistAskUserQuestionsCardPending
  /** Defaults to the shared singleton. Injectable for isolated unit tests. */
  store?: AskUserQuestionsStore
  /** Defaults to 24h; injected for tests. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24h — mirrors skill_ask_user
const NOOP_EMIT: EmitAskUserQuestionsCard = () => {}
const NOOP_PERSIST: PersistAskUserQuestionsCardPending = () => {}

const METRIC_ASK_USER_QUESTIONS_USED = 'ask_user_questions_used'
const METRIC_ASK_USER_QUESTIONS_REJECTED = 'ask_user_questions_rejected'

function normalizeQuestions(raw: AskUserQuestionsArgs['questions']): AskUserQuestionSpec[] {
  return raw.map((q) => ({
    id: q.id,
    question: q.question,
    kind: q.kind,
    options: q.options && q.options.length > 0 ? [...q.options] : null,
    placeholder: typeof q.placeholder === 'string' && q.placeholder.length > 0
      ? q.placeholder
      : null,
    required: typeof q.required === 'boolean' ? q.required : true,
  }))
}

function summarizeAnswers(
  questions: AskUserQuestionSpec[],
  answers: AskUserAnswer[],
): string {
  const answerById = new Map<string, AskUserAnswer>(answers.map((a) => [a.id, a]))
  const lines: string[] = [`用户回答了 ${answers.length}/${questions.length} 个问题：`]
  questions.forEach((q, index) => {
    const found = answerById.get(q.id)
    if (!found) {
      lines.push(`${index + 1}. ${q.question}\n   → (未作答)`)
      return
    }
    const rendered = Array.isArray(found.answer)
      ? found.answer.join(' / ')
      : String(found.answer)
    lines.push(`${index + 1}. ${q.question}\n   → ${rendered}`)
  })
  return lines.join('\n')
}

export async function executeAskUserQuestions(
  args: AskUserQuestionsArgs,
  deps: AskUserQuestionsHandlerDeps,
): Promise<ToolExecutionOutput> {
  const parsed = askUserQuestionsSchema.safeParse(args)
  if (!parsed.success) {
    throw new ToolDomainError('input_validation', parsed.error.message)
  }
  const businessError = validateAskUserQuestionsArgs(parsed.data)
  if (businessError) {
    throw new ToolDomainError('input_validation', businessError)
  }

  const store = deps.store || getAskUserQuestionsStore()
  const emit = deps.emitAskUserQuestionsCard || NOOP_EMIT
  const persist = deps.persistCardPending || NOOP_PERSIST
  const timeoutMs = typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0
    ? deps.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const sessionId = deps.sessionId || null
  const conversationId = deps.conversationId || null

  // Single-pending invariant. The model must not stack reflection cards.
  if (sessionId) {
    const existing = store.findPendingForSession(sessionId)
    if (existing) {
      logAgentMetric(METRIC_ASK_USER_QUESTIONS_REJECTED, {
        reason: 'overlapping_card',
        sessionId,
        existingCardId: existing.cardId,
      })
      throw new ToolDomainError(
        'overlapping_card',
        '已有一个未回答的反问卡片，请等待用户答完后再发起新一组问题。',
        { existingCardId: existing.cardId },
      )
    }
  }

  const cardId = generateAskUserQuestionsCardId()
  const askedAt = Date.now()
  const questions = normalizeQuestions(parsed.data.questions)

  // Persist BEFORE pushing the IPC event so the renderer hydrate path can
  // never observe a card in IPC that DB hasn't seen yet. A persistence
  // failure should fail the tool call — we do not want to push an event
  // for a card that will never be retrievable on restart.
  try {
    await persist({
      cardId,
      sessionId,
      conversationId,
      questions,
      askedAt,
    })
  } catch (persistErr) {
    const message = persistErr instanceof Error ? persistErr.message : String(persistErr)
    logAgentMetric(METRIC_ASK_USER_QUESTIONS_REJECTED, {
      reason: 'persist_failed',
      sessionId,
      message: message.slice(0, 200),
    })
    throw new ToolDomainError('persistence_failed', `Failed to persist card: ${message}`)
  }

  const answerSet = await new Promise<AskUserQuestionsAnswerSet>((resolvePromise, rejectPromise) => {
    const timeoutHandle = setTimeout(() => {
      if (!store.has(cardId)) return
      logAgentMetric(METRIC_ASK_USER_QUESTIONS_REJECTED, {
        reason: 'timeout',
        timeoutMs,
        sessionId,
        cardId,
      })
      store.reject(
        cardId,
        new ToolDomainError(
          'timeout',
          `ask_user_questions timed out after ${timeoutMs}ms with no user response`,
          { cardId, timeoutMs },
        ),
      )
    }, timeoutMs)

    store.register({
      cardId,
      sessionId,
      conversationId,
      questions,
      askedAt,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeoutHandle,
    })

    const onAbort = () => {
      if (!store.has(cardId)) return
      logAgentMetric(METRIC_ASK_USER_QUESTIONS_REJECTED, {
        reason: 'aborted',
        sessionId,
        cardId,
      })
      store.reject(cardId, new ToolDomainError('aborted', 'ask_user_questions was aborted.'))
    }
    if (deps.signal) {
      if (deps.signal.aborted) onAbort()
      else deps.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      emit({
        cardId,
        sessionId,
        conversationId,
        questions,
        askedAt,
      })
    } catch (emitErr) {
      // Emitter failure is non-fatal — DB row exists (pending) and renderer
      // hydrate (`listPendingAskUserQuestions`) can still pick it up on
      // reconnect. Log but do not reject; a transient IPC glitch should
      // not collapse the whole tool call.
      const message = emitErr instanceof Error ? emitErr.message : String(emitErr)
      console.error('[ask_user_questions] emit failed:', message)
    }
  })

  // Compact the user's answer set into a deterministic, model-friendly shape.
  // We rebuild the per-question answer map from the resolved answerSet so the
  // model always sees the original question alongside the answer (avoids
  // confusion if a later turn truncates conversation history).
  const compactAnswers: AskUserAnswer[] = answerSet.answers.map((a) => ({
    id: a.id,
    answer: Array.isArray(a.answer) ? [...a.answer] : String(a.answer),
  }))
  const summary = summarizeAnswers(questions, compactAnswers)
  const enrichedAnswers = compactAnswers.map((a) => {
    const q = questions.find((qq) => qq.id === a.id)
    return {
      id: a.id,
      question: q?.question || '',
      kind: q?.kind || 'free_text',
      answer: a.answer,
    }
  })

  logAgentMetric(METRIC_ASK_USER_QUESTIONS_USED, {
    sessionId,
    cardId,
    questionCount: questions.length,
    answeredCount: compactAnswers.length,
    durationMs: Date.now() - askedAt,
  })

  return createToolExecutionOutput(summary, {
    shape: 'json',
    data: {
      cardId,
      askedAt,
      answeredAt: answerSet.answeredAt,
      answers: enrichedAnswers,
    },
  })
}
