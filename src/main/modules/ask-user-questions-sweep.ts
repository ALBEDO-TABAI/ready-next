/**
 * Stage U (PR 1, B.4b/B.4c, review patch) — pure sweep helpers extracted
 * from `database.ts` so behavior tests can run on host Node without
 * native better-sqlite3.
 *
 * The `DatabaseManager` instance methods (`sweepPendingAskUserQuestionsCardsOnBoot`,
 * `sweepPendingAskUserQuestionsCardsBySession`) are now thin wrappers that
 * inject the live `listPendingAskUserQuestionsCards()` / `updateChatMessageMeta()`
 * methods. The pure helpers exercise the actual mutation logic (live-card
 * skipping, session matching, meta merge) — those tests prove the contract
 * without the SQLite ABI gate.
 *
 * The previous SQLite-backed test (`ask-user-questions-boot-and-session-sweep.test.ts`)
 * still exists as an end-to-end probe under `verify:native`, but the real
 * behavior verification now lives in pure tests that always run.
 */

export interface PendingCardSnapshot {
  /** chat_messages.id (= cardId) */
  readonly messageId: string
  /** chat_messages.conversation_id; equals the sessionId that owns the card */
  readonly conversationId: string
  /** Parsed meta_json (object, never null). */
  readonly meta: Record<string, unknown>
}

export type UpdateMetaFn = (messageId: string, nextMeta: Record<string, unknown>) => boolean

export interface BootSweepInput {
  pending: ReadonlyArray<PendingCardSnapshot>
  liveCardIds?: ReadonlySet<string>
  now: string
  updateMeta: UpdateMetaFn
}

export interface BootSweepOutcome {
  /** Rows actually flipped to cancelled (DB update returned true). */
  mutated: number
  /** Rows skipped because their cardId was in `liveCardIds`. */
  skippedLive: number
}

/**
 * Compute and apply the boot-time sweep. For each pending card:
 *   - if its id is in `liveCardIds`, skip (record `skippedLive`)
 *   - otherwise build a merged meta with status='cancelled',
 *     cancelReason='app_restart', cancelledAt=now and call `updateMeta`
 *
 * Idempotent at the input level: once a card has been flipped out of
 * 'pending', a subsequent boot will not see it in `pending` and the count
 * naturally drops to 0.
 */
export function performBootSweep(input: BootSweepInput): BootSweepOutcome {
  const { pending, liveCardIds, now, updateMeta } = input
  const live = liveCardIds ?? null
  let mutated = 0
  let skippedLive = 0
  for (const entry of pending) {
    if (live && live.has(entry.messageId)) {
      skippedLive += 1
      continue
    }
    const aug = (entry.meta.askUserQuestions as Record<string, unknown>) || {}
    const nextMeta: Record<string, unknown> = {
      ...entry.meta,
      askUserQuestions: {
        ...aug,
        status: 'cancelled',
        cancelReason: 'app_restart',
        cancelledAt: now,
      },
    }
    if (updateMeta(entry.messageId, nextMeta)) {
      mutated += 1
    }
  }
  return { mutated, skippedLive }
}

export interface SessionSweepInput {
  pending: ReadonlyArray<PendingCardSnapshot>
  /** Match `entry.conversationId === sessionId`. The DB column powering this
   *  field is `chat_messages.conversation_id`; current main-process code
   *  treats the runtime "sessionId" as identical to the conversationId
   *  written when the card was persisted. The pure helper makes the
   *  comparison explicit so it can be tested with mismatched fixtures. */
  sessionId: string
  cancelReason: string
  now: string
  updateMeta: UpdateMetaFn
}

/**
 * Apply the session-scoped sweep. Returns the number of rows mutated.
 * Rows whose `conversationId` does not equal `sessionId` are untouched —
 * see the mismatch test for the cross-session safety contract.
 */
export function performSessionSweep(input: SessionSweepInput): number {
  const { pending, sessionId, cancelReason, now, updateMeta } = input
  if (!sessionId) return 0
  let mutated = 0
  for (const entry of pending) {
    if (entry.conversationId !== sessionId) continue
    const aug = (entry.meta.askUserQuestions as Record<string, unknown>) || {}
    const nextMeta: Record<string, unknown> = {
      ...entry.meta,
      askUserQuestions: {
        ...aug,
        status: 'cancelled',
        cancelReason,
        cancelledAt: now,
      },
    }
    if (updateMeta(entry.messageId, nextMeta)) {
      mutated += 1
    }
  }
  return mutated
}
