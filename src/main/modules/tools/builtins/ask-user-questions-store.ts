/**
 * In-memory store for `ask_user_questions` pending question cards.
 *
 * Distinct from `EphemeralExecutionStore` (which serves `skill_ask_user`):
 *   - Per-card multi-question shape (`questions[]`) vs. single-question record.
 *   - Lives outside skill domain — naming + IDs (`auq-<8hex>`) make it
 *     visually obvious in logs that the record came from the main-agent
 *     reflection tool, not from a skill.
 *   - Persistence (cross-session retention of the answered card in
 *     `chat_messages`) is owned by the handler / IPC layer, NOT the store.
 *     The store only tracks the Promise resolver + abort/timeout for the
 *     in-flight wait.
 *
 * Lifecycle:
 *   - `register` inserts a card after the handler has already persisted it
 *     to DB as `status='pending'`.
 *   - `resolve` clears the timeout + removes the record + resolves the
 *     awaiting Promise with the user's `AskUserAnswerSet`.
 *   - `reject` mirrors `resolve` for abort / timeout / session reset /
 *     user-typed-new-message (the "user_skipped" path).
 *   - `rejectBySession` walks the map, rejecting every record whose
 *     `sessionId` matches; used on `agent:newSession` / `agent:kill`.
 *   - `clear` drops everything on shutdown.
 *   - `hasPendingForSession` lets the handler enforce the "same session
 *     single pending card" invariant before registering a new one — the
 *     handler returns `overlapping_card` error so the model self-corrects.
 *
 * Tested as a pure module under `tsx --test` (no electron dependency).
 */

import { randomUUID } from 'node:crypto'
import { getInteractionLifecycleRegistry } from '../../agent-control/runtime-core/interaction-lifecycle-registry'
import type { InteractionLifecycleIdentity } from '../../agent-control/runtime-core/interaction-lifecycle-registry'

export type AskUserQuestionKind = 'single_choice' | 'multi_choice' | 'free_text'

export interface AskUserQuestionSpec {
  id: string
  question: string
  kind: AskUserQuestionKind
  options?: string[] | null
  placeholder?: string | null
  required: boolean
}

export interface AskUserAnswer {
  id: string
  /** single_choice → string ; multi_choice → string[] ; free_text → string */
  answer: string | string[]
}

export interface AskUserQuestionsAnswerSet {
  answers: AskUserAnswer[]
  answeredAt: number
  answeredVia?: AskUserQuestionsSubmissionSurface
}

export type AskUserQuestionsResponsePolicy = 'local_or_remote' | 'local_renderer_only'
export type AskUserQuestionsSubmissionSurface = 'local_renderer' | 'remote_channel'

export interface AskUserQuestionsCardRecord {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  scopeId?: string | null
  agent?: string | null
  requestId?: string | null
  readyRunId?: string | null
  aliasGeneration?: number | null
  messageVisibilityEpoch?: number | null
  responsePolicy?: AskUserQuestionsResponsePolicy
  lifecycleType?: InteractionLifecycleIdentity['type']
  actionConfirmationOwnerRef?: {
    frozenCallId: string
    pendingConfirmationSourceDigest: string
  }
  questions: AskUserQuestionSpec[]
  askedAt: number
  resolve: (answerSet: AskUserQuestionsAnswerSet) => void
  reject: (error: Error) => void
  timeoutHandle: NodeJS.Timeout
}

export interface PendingAskUserQuestionsCardView {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  scopeId?: string | null
  agent?: string | null
  requestId?: string | null
  readyRunId?: string | null
  aliasGeneration?: number | null
  messageVisibilityEpoch?: number | null
  responsePolicy?: AskUserQuestionsResponsePolicy
  lifecycleType?: InteractionLifecycleIdentity['type']
  actionConfirmationOwnerRef?: {
    frozenCallId: string
    pendingConfirmationSourceDigest: string
  }
  questions: AskUserQuestionSpec[]
  askedAt: number
}

export const ASK_USER_QUESTIONS_ID_PREFIX = 'auq-'

export function generateAskUserQuestionsCardId(): string {
  return `${ASK_USER_QUESTIONS_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

export function isAskUserQuestionsCardId(cardId: string): boolean {
  return typeof cardId === 'string' && cardId.startsWith(ASK_USER_QUESTIONS_ID_PREFIX)
}

export class AskUserQuestionsStore {
  private readonly records = new Map<string, AskUserQuestionsCardRecord>()

  has(cardId: string): boolean {
    return this.records.has(cardId)
  }

  get(cardId: string): AskUserQuestionsCardRecord | null {
    return this.records.get(cardId) || null
  }

  register(record: AskUserQuestionsCardRecord): void {
    this.records.set(record.cardId, record)
    getInteractionLifecycleRegistry().register({
      interactionId: record.cardId,
      runId: record.requestId || '',
      agentId: record.agent || '',
      scopeId: record.scopeId || record.sessionId || '',
      type: record.lifecycleType || 'ask_user_questions',
    })
  }

  hasPendingForSession(sessionId: string | null): boolean {
    if (!sessionId) return false
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId) return true
    }
    return false
  }

  findPendingForSession(sessionId: string | null): AskUserQuestionsCardRecord | null {
    if (!sessionId) return null
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId) return record
    }
    return null
  }

  findPendingForFrozenCall(frozenCallId: string): AskUserQuestionsCardRecord | null {
    for (const record of this.records.values()) {
      if (record.actionConfirmationOwnerRef?.frozenCallId === frozenCallId) return record
    }
    return null
  }

  /**
   * Phase I P0 — 远程入站答案拦截按 scope 找 pending 卡。渠道 run 的卡
   * scopeId 与 sessionId 同值别名（现行模型），两个字段都匹配以免登记侧
   * 只填了其一。
   */
  findPendingForScope(scopeKey: string | null): AskUserQuestionsCardRecord | null {
    if (!scopeKey) return null
    for (const record of this.records.values()) {
      if (record.scopeId === scopeKey || record.sessionId === scopeKey) return record
    }
    return null
  }

  hasPendingForRun(agent: string, sessionId: string | null | undefined, requestId: string): boolean {
    if (!agent || !sessionId || !requestId) return false
    for (const record of this.records.values()) {
      const recordSessionId = record.scopeId || record.sessionId
      if (recordSessionId !== sessionId) continue
      if (record.agent !== agent) continue
      if (record.requestId !== requestId) continue
      return true
    }
    return false
  }

  /**
   * Resolve a pending card with the user's full answer set. Returns true
   * when the card existed and was resolved; false when no card existed
   * (e.g. a late submit after timeout / abort).
   */
  resolve(cardId: string, answerSet: AskUserQuestionsAnswerSet): boolean {
    const record = this.records.get(cardId)
    if (!record) return false
    clearTimeout(record.timeoutHandle)
    this.records.delete(cardId)
    getInteractionLifecycleRegistry().settle({
      interactionId: record.cardId,
      runId: record.requestId || '',
      agentId: record.agent || '',
      scopeId: record.scopeId || record.sessionId || '',
      disposition: 'resume_with_result',
    })
    record.resolve(answerSet)
    return true
  }

  /**
   * Reject a pending card (abort / timeout / session-drop / user_skipped).
   * Returns true when the card existed and was rejected.
   */
  reject(cardId: string, error: Error): boolean {
    const record = this.records.get(cardId)
    if (!record) return false
    clearTimeout(record.timeoutHandle)
    this.records.delete(cardId)
    getInteractionLifecycleRegistry().settle({
      interactionId: record.cardId,
      runId: record.requestId || '',
      agentId: record.agent || '',
      scopeId: record.scopeId || record.sessionId || '',
      disposition: 'terminate',
    })
    record.reject(error)
    return true
  }

  /** Drop every pending card; used on app shutdown. */
  clear(): void {
    for (const [, record] of this.records) {
      clearTimeout(record.timeoutHandle)
      getInteractionLifecycleRegistry().settle({
        interactionId: record.cardId,
        runId: record.requestId || '',
        agentId: record.agent || '',
        scopeId: record.scopeId || record.sessionId || '',
        disposition: 'terminate',
      })
      try {
        record.reject(new Error('ask_user_questions store cleared'))
      } catch {
        // silent-catch: shutdown path — listener may already be gone (race with
        // the same Promise being settled by abort/timeout). Swallowing here
        // avoids tearing down app exit on a noop.
      }
    }
    this.records.clear()
  }

  /**
   * Reject every pending card whose session matches; used on session
   * teardown. Returns the number of cards rejected.
   */
  rejectBySession(sessionId: string, error: Error): number {
    let rejected = 0
    for (const [cardId, record] of this.records) {
      if (record.sessionId === sessionId) {
        clearTimeout(record.timeoutHandle)
        this.records.delete(cardId)
        getInteractionLifecycleRegistry().settle({
          interactionId: record.cardId,
          runId: record.requestId || '',
          agentId: record.agent || '',
          scopeId: record.scopeId || record.sessionId || '',
          disposition: 'terminate',
        })
        try {
          record.reject(error)
        } catch {
          // silent-catch: same race as `clear()` — the awaiting Promise may
          // already have been settled by abort/timeout. Caller wants a count
          // of "records removed", not "rejections delivered".
        }
        rejected += 1
      }
    }
    return rejected
  }

  size(): number {
    return this.records.size
  }

  /** Snapshot of currently-pending cards (never exposes resolvers). */
  list(): PendingAskUserQuestionsCardView[] {
    const out: PendingAskUserQuestionsCardView[] = []
    for (const record of this.records.values()) {
      out.push({
        cardId: record.cardId,
        sessionId: record.sessionId,
        conversationId: record.conversationId,
        scopeId: record.scopeId ?? record.sessionId,
        agent: record.agent ?? null,
        requestId: record.requestId ?? null,
        readyRunId: record.readyRunId ?? null,
        aliasGeneration: record.aliasGeneration ?? null,
        messageVisibilityEpoch: record.messageVisibilityEpoch ?? null,
        responsePolicy: record.responsePolicy,
        lifecycleType: record.lifecycleType,
        actionConfirmationOwnerRef: record.actionConfirmationOwnerRef,
        questions: record.questions,
        askedAt: record.askedAt,
      })
    }
    return out
  }
}

let sharedStore: AskUserQuestionsStore | null = null

export function getAskUserQuestionsStore(): AskUserQuestionsStore {
  if (!sharedStore) sharedStore = new AskUserQuestionsStore()
  return sharedStore
}

/** Test helper — replaces the singleton with a fresh store. */
export function _resetAskUserQuestionsStoreForTests(): void {
  if (sharedStore) sharedStore.clear()
  sharedStore = new AskUserQuestionsStore()
}
