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
} from '../../agent-control/tools-runtime/tool-result-types'
import { ToolDomainError } from '../tool-errors'
import type { InteractionLifecycleIdentity } from '../../agent-control/runtime-core/interaction-lifecycle-registry'
import {
  AskUserQuestionsStore,
  generateAskUserQuestionsCardId,
  getAskUserQuestionsStore,
  type AskUserAnswer,
  type AskUserQuestionsAnswerSet,
  type AskUserQuestionsResponsePolicy,
  type AskUserQuestionsSubmissionSurface,
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

/**
 * Stage U (PR 1, B.1) — server-side re-validation of user-submitted answers
 * against the original question spec. Runs in the submit IPC handler **after**
 * `store.get(cardId)` resolves the original `questions[]` and **before** any
 * DB write. Returns null on success; an English message string on failure
 * (mapped to `errorKind: 'input_validation'` by the IPC handler).
 *
 * Why we re-validate in the main process: the renderer card UI enforces
 * `allRequiredAnswered` and option membership in `AskUserQuestionsCard.tsx`,
 * but a hostile / buggy / dev-reloaded renderer could call the IPC with
 * arbitrary payload. The main process is the only trust boundary.
 *
 * Rules enforced (per question kind):
 *   - `single_choice`: answer must be a string ∈ options.
 *   - `multi_choice`: answer must be a non-empty array of strings, each ∈ options.
 *   - `free_text`: answer must be a string (any content; empty allowed if
 *     `required === false`, else non-empty after trim).
 * Plus:
 *   - Every `required: true` question must have an entry.
 *   - Unknown question ids in `answers[]` are rejected (drift = bug).
 *   - Duplicate answer ids are rejected.
 */
export function validateSubmittedAnswers(
  questions: AskUserQuestionSpec[],
  answers: AskUserAnswer[],
): string | null {
  const questionById = new Map<string, AskUserQuestionSpec>(questions.map((q) => [q.id, q]))
  const answerById = new Map<string, AskUserAnswer>()
  for (const a of answers) {
    if (answerById.has(a.id)) {
      return `Duplicate answer for question id: ${a.id}`
    }
    answerById.set(a.id, a)
    const q = questionById.get(a.id)
    if (!q) {
      return `Unknown question id in answers: ${a.id}`
    }
    if (q.kind === 'single_choice') {
      if (typeof a.answer !== 'string') {
        return `Question ${a.id} (single_choice) requires a string answer`
      }
      const options = q.options || []
      if (!options.includes(a.answer)) {
        return `Question ${a.id} (single_choice) answer "${a.answer}" not in options`
      }
    } else if (q.kind === 'multi_choice') {
      if (!Array.isArray(a.answer)) {
        return `Question ${a.id} (multi_choice) requires an array answer`
      }
      if (a.answer.length === 0 && q.required) {
        return `Question ${a.id} (multi_choice) is required but no option was selected`
      }
      const options = q.options || []
      for (const value of a.answer) {
        if (typeof value !== 'string' || !options.includes(value)) {
          return `Question ${a.id} (multi_choice) value "${String(value)}" not in options`
        }
      }
    } else if (q.kind === 'free_text') {
      if (typeof a.answer !== 'string') {
        return `Question ${a.id} (free_text) requires a string answer`
      }
      if (q.required && a.answer.trim().length === 0) {
        return `Question ${a.id} (free_text) is required but answer was empty`
      }
    }
  }
  for (const q of questions) {
    if (q.required && !answerById.has(q.id)) {
      return `Required question not answered: ${q.id}`
    }
  }
  return null
}

export interface AskUserQuestionsCardEvent {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  scopeId?: string | null
  agent?: string | null
  requestId?: string | null
  readyRunId?: string | null
  aliasGeneration?: number | null
  messageVisibilityEpoch?: number | null
  lifecycleType?: InteractionLifecycleIdentity['type']
  responsePolicy?: AskUserQuestionsResponsePolicy
  questions: AskUserQuestionSpec[]
  askedAt: number
}

export type EmitAskUserQuestionsCard = (event: AskUserQuestionsCardEvent) => void

export interface AskUserQuestionsCodexRunIdentity {
  readyRunId: string
  aliasGeneration: number | null
  messageVisibilityEpoch: number
}

export interface AskUserQuestionsCardPersistenceReceipt {
  codexRunIdentity: AskUserQuestionsCodexRunIdentity | null
}

export interface PersistCardPendingArgs {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  scopeId?: string | null
  agent?: string | null
  requestId?: string | null
  lifecycleType?: InteractionLifecycleIdentity['type']
  responsePolicy?: AskUserQuestionsResponsePolicy
  questions: AskUserQuestionSpec[]
  askedAt: number
}

export type PersistAskUserQuestionsCardPending = (
  args: PersistCardPendingArgs,
) =>
  | void
  | AskUserQuestionsCardPersistenceReceipt
  | Promise<void | AskUserQuestionsCardPersistenceReceipt>

export interface AskUserQuestionsHandlerDeps {
  sessionId?: string
  conversationId?: string
  scopeId?: string
  agent?: string | null
  requestId?: string | null
  lifecycleType?: InteractionLifecycleIdentity['type']
  /** Restricts who may answer host-owned, setting-level confirmations. */
  responsePolicy?: AskUserQuestionsResponsePolicy
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

/**
 * Stage U (PR 1) — pure submit/cancel handlers for the `ask_user_questions`
 * IPC. Extracted from `ipc-handler.ts` so we can unit-test the full state
 * machine (validation, DB row-missing handling, resolver-miss rollback,
 * cancel symmetry) without booting electron or sqlite.
 *
 * The IPC handler in `ipc-handler.ts` is now a thin wrapper that:
 *   1. unwraps the IPC payload into typed args
 *   2. injects the live deps (DB singleton + global store + logger)
 *   3. forwards the structured result back to the renderer
 */

import { ASK_USER_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
import { TOOL_ERROR_METRICS } from '../../agent-control/tools-runtime/tool-error-metrics'

export interface SubmitDbAccess {
  getChatMessageById(id: string): { meta_json: string | null } | null
  /** Returns true iff a row existed AND was updated. */
  updateChatMessageMeta(
    id: string,
    meta: Record<string, unknown>,
    opts?: { content?: string },
  ): boolean
}

export interface SubmitAskUserQuestionsDeps {
  store: AskUserQuestionsStore
  db: SubmitDbAccess
  submissionSurface?: AskUserQuestionsSubmissionSurface
  logMetric?: (name: string, payload: Record<string, unknown>) => void
  now?: () => number
}

export type SubmitAskUserQuestionsResult =
  | { success: true }
  | { success: false; errorKind: string; recoverable?: boolean; error: string }

/**
 * PR 1 B.1/B.2/B.3 — submit handler core. Side effects:
 *   - On `input_validation` / `waiting_task_gone` (no record): no DB write,
 *     no store mutation.
 *   - On DB throw (transient): emit metric, return `persistence_failed`,
 *     in-memory pending preserved (user may retry).
 *   - On `updateChatMessageMeta` returning false (row missing): emit metric,
 *     `store.reject(cardId, waiting_task_gone)` so Promise stops awaiting,
 *     return `waiting_task_gone`.
 *   - On `store.resolve` miss (race): emit metric, roll back DB row to
 *     `cancelled (card_resolver_missed)`, return `card_resolver_missed`.
 *
 * Synchronous from the caller's perspective; matches `ipcMain.handle` shape.
 */
export function submitAskUserQuestionsAnswersCore(
  cardId: string,
  answers: AskUserAnswer[],
  deps: SubmitAskUserQuestionsDeps,
): SubmitAskUserQuestionsResult {
  const { store, db } = deps
  const logMetric = deps.logMetric ?? (() => {})
  const nowFn = deps.now ?? Date.now

  const record = store.get(cardId)
  if (!record) {
    return {
      success: false,
      errorKind: ASK_USER_ERROR_KINDS.waitingTaskGone.code,
      error: 'No pending card with this id (already answered, cancelled or timed out)',
    }
  }

  if (
    record.responsePolicy === 'local_renderer_only'
    && deps.submissionSurface === 'remote_channel'
  ) {
    return {
      success: false,
      errorKind: ASK_USER_ERROR_KINDS.confirmationSurfaceDenied.code,
      error: 'This confirmation must be answered in the local app.',
    }
  }

  const validationError = validateSubmittedAnswers(record.questions, answers)
  if (validationError) {
    return {
      success: false,
      errorKind: ASK_USER_ERROR_KINDS.inputValidation.code,
      error: validationError,
    }
  }

  const answeredAt = nowFn()
  let dbUpdated = false
  try {
    const existing = db.getChatMessageById(cardId)
    const meta: Record<string, unknown> = existing?.meta_json
      ? (JSON.parse(existing.meta_json) as Record<string, unknown>)
      : {}
    const aug = (meta.askUserQuestions as Record<string, unknown>) || {}
    const nextMeta: Record<string, unknown> = {
      ...meta,
      askUserQuestions: { ...aug, status: 'submitted', answers, answeredAt },
    }
    const summary = buildAnswerSummary(record.questions, answers)
    dbUpdated = db.updateChatMessageMeta(cardId, nextMeta, { content: summary })
  } catch (persistErr) {
    const message = persistErr instanceof Error ? persistErr.message : String(persistErr)
    logMetric(TOOL_ERROR_METRICS.askUserQuestionsSubmitDbFailed, {
      cardId,
      kind: 'throw',
      errorMessage: message.slice(0, 200),
    })
    return {
      success: false,
      errorKind: ASK_USER_ERROR_KINDS.persistenceFailed.code,
      recoverable: true,
      error: `Failed to persist answers: ${message}`,
    }
  }
  if (!dbUpdated) {
    logMetric(TOOL_ERROR_METRICS.askUserQuestionsSubmitDbFailed, {
      cardId,
      kind: 'row_missing',
    })
    store.reject(
      cardId,
      new ToolDomainError(
        ASK_USER_ERROR_KINDS.waitingTaskGone.code,
        'Card row missing in DB — cannot persist answers; the card was likely cleaned up by a session reset.',
        { cardId },
      ),
    )
    return {
      success: false,
      errorKind: ASK_USER_ERROR_KINDS.waitingTaskGone.code,
      error: 'Card row missing — the card was cleaned up before submission could land.',
    }
  }

  const resolved = store.resolve(cardId, {
    answers,
    answeredAt,
    answeredVia: deps.submissionSurface || 'local_renderer',
  })
  if (!resolved) {
    logMetric(TOOL_ERROR_METRICS.askUserQuestionsSubmitResolverMissed, { cardId })
    try {
      const existing = db.getChatMessageById(cardId)
      const meta: Record<string, unknown> = existing?.meta_json
        ? (JSON.parse(existing.meta_json) as Record<string, unknown>)
        : {}
      const aug = (meta.askUserQuestions as Record<string, unknown>) || {}
      const rollbackMeta: Record<string, unknown> = {
        ...meta,
        askUserQuestions: {
          ...aug,
          status: 'cancelled',
          cancelReason: 'card_resolver_missed',
          cancelledAt: nowFn(),
        },
      }
      db.updateChatMessageMeta(cardId, rollbackMeta, {
        content: `反问卡未能送达模型（系统状态不一致），已自动取消。`,
      })
    } catch {
      // Rollback failure is non-fatal — next boot sweep will clean it up.
    }
    return {
      success: false,
      errorKind: ASK_USER_ERROR_KINDS.cardResolverMissed.code,
      error: 'Card resolver missed (race) — DB row rolled back to cancelled(card_resolver_missed)',
    }
  }
  return { success: true }
}

export interface CancelDbAccess {
  getChatMessageById(id: string): { meta_json: string | null } | null
  updateChatMessageMeta(id: string, meta: Record<string, unknown>): boolean
}

export interface CancelAskUserQuestionsDeps {
  store: AskUserQuestionsStore
  db: CancelDbAccess
  logMetric?: (name: string, payload: Record<string, unknown>) => void
  now?: () => number
}

export type CancelAskUserQuestionsResult =
  | { success: true }
  | { success: false; errorKind: string; error: string }

/**
 * PR 1 B.4a — cancel handler core. Side effects:
 *   - In-memory `store.reject` ALWAYS runs (even if DB throws) so the waiting
 *     Promise never hangs 24h.
 *   - DB write happens first; if it throws, metric is emitted and the result
 *     reports `cancel_persist_failed` (renderer folds card locally with the
 *     diagnostic reason). Boot sweep cleans up the DB residue next time.
 */
export function cancelAskUserQuestionsCardCore(
  cardId: string,
  reason: string,
  deps: CancelAskUserQuestionsDeps,
): CancelAskUserQuestionsResult {
  const { store, db } = deps
  const logMetric = deps.logMetric ?? (() => {})
  const nowFn = deps.now ?? Date.now
  const record = store.get(cardId)
  const cancelledAt = nowFn()
  let dbWriteFailed = false
  let dbErrorMessage = ''
  try {
    const existing = db.getChatMessageById(cardId)
    if (existing) {
      const meta: Record<string, unknown> = existing.meta_json
        ? (JSON.parse(existing.meta_json) as Record<string, unknown>)
        : {}
      const aug = (meta.askUserQuestions as Record<string, unknown>) || {}
      const nextMeta: Record<string, unknown> = {
        ...meta,
        askUserQuestions: {
          ...aug,
          status: 'cancelled',
          cancelReason: reason,
          cancelledAt,
        },
      }
      db.updateChatMessageMeta(cardId, nextMeta)
    }
  } catch (persistErr) {
    dbWriteFailed = true
    dbErrorMessage = persistErr instanceof Error ? persistErr.message : String(persistErr)
    logMetric(TOOL_ERROR_METRICS.askUserQuestionsCancelPersistFailed, {
      cardId,
      reason,
      errorMessage: dbErrorMessage.slice(0, 200),
    })
  }
  if (record) {
    const errorKind = reason === 'user_typed_instead'
      ? ASK_USER_ERROR_KINDS.userSkipped.code
      : ASK_USER_ERROR_KINDS.userCancelled.code
    const friendly = reason === 'user_typed_instead'
      ? '用户用新消息替代了选项回答。'
      : '用户取消了反问卡。'
    store.reject(cardId, new ToolDomainError(errorKind, friendly, { cardId, reason }))
  }
  if (dbWriteFailed) {
    return {
      success: false,
      errorKind: ASK_USER_ERROR_KINDS.cancelPersistFailed.code,
      error: `Cancel succeeded in-memory but DB write failed: ${dbErrorMessage}`,
    }
  }
  return { success: true }
}

function buildAnswerSummary(
  questions: AskUserQuestionSpec[],
  answers: AskUserAnswer[],
): string {
  const byId = new Map(answers.map((a) => [a.id, a] as const))
  const parts = questions.map((q, index) => {
    const answer = byId.get(q.id)
    if (!answer) return `${index + 1}. ${q.question} → (未作答)`
    const rendered = Array.isArray(answer.answer) ? answer.answer.join(' / ') : String(answer.answer)
    return `${index + 1}. ${q.question} → ${rendered}`
  })
  return `用户回答了 ${answers.length}/${questions.length} 个问题：\n${parts.join('\n')}`
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
  const scopeId = deps.scopeId || conversationId || sessionId
  const agent = deps.agent || null
  const requestId = deps.requestId || null
  const responsePolicy = deps.responsePolicy || 'local_or_remote'

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
  let persistenceReceipt: AskUserQuestionsCardPersistenceReceipt | void
  try {
    persistenceReceipt = await persist({
      cardId,
      sessionId,
      conversationId,
      scopeId,
      agent,
      requestId,
      lifecycleType: deps.lifecycleType,
      responsePolicy,
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

  // The persistence receipt is the only authoritative identity for this
  // card. In particular, do not re-read the scope's current identity after
  // this point: reset may advance the visible epoch between the durable
  // INSERT and the renderer push.
  const codexRunIdentity = persistenceReceipt?.codexRunIdentity ?? null

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
        scopeId,
        agent,
        requestId,
        readyRunId: codexRunIdentity?.readyRunId ?? null,
        aliasGeneration: codexRunIdentity?.aliasGeneration ?? null,
        messageVisibilityEpoch: codexRunIdentity?.messageVisibilityEpoch ?? null,
        responsePolicy,
        lifecycleType: deps.lifecycleType,
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
        scopeId,
        agent,
        requestId,
        readyRunId: codexRunIdentity?.readyRunId ?? null,
        aliasGeneration: codexRunIdentity?.aliasGeneration ?? null,
        messageVisibilityEpoch: codexRunIdentity?.messageVisibilityEpoch ?? null,
        responsePolicy,
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
      answeredVia: answerSet.answeredVia || 'local_renderer',
      answers: enrichedAnswers,
    },
  })
}
