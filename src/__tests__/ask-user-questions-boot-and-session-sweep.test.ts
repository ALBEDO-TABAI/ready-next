/**
 * Stage U (PR 1, B.4b/B.4c) behavior tests for the DB-side sweep helpers.
 *
 * Covers:
 *   B.4b — `sweepPendingAskUserQuestionsCardsOnBoot({ liveCardIds })`:
 *     - Without liveCardIds (boot after hard restart): every pending row
 *       gets cancelled(app_restart).
 *     - With liveCardIds (dev hot-reload of main): live cards in the set
 *       are skipped; non-live pending rows still get cancelled. Returns
 *       `{ mutated, skippedLive }` so the caller can emit the
 *       `ask_user_questions_boot_sweep_skipped_live` metric.
 *
 *   B.4c — `sweepPendingAskUserQuestionsCardsBySession(sessionId)`:
 *     - Only rows whose conversation_id matches are flipped to
 *       cancelled(session_reset). Rows for other sessions are untouched.
 *     - Returns count of mutated rows so the call site can emit
 *       `ask_user_questions_session_reset_swept_db`.
 *
 * SQLite-backed — the sweep functions assemble SQL queries internally so a
 * fake DB would not exercise the actual row-filtering / meta-merge logic.
 * Uses `skipIfSqliteUnavailable` per §6.17 + §6.13 — host Node without
 * better-sqlite3 ABI skips; Electron `verify:native` provides real coverage.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DatabaseManager } from '../main/modules/database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function insertPendingCard(
  db: DatabaseManager,
  cardId: string,
  conversationId: string,
  questions: Array<{ id: string; question: string; kind: 'free_text' }> = [],
): void {
  if (!db.chat.getConversationScope(conversationId)) db.chat.createConversation(conversationId, 'butler', 'Fixture conversation')
  const askedAtMs = Date.now()
  db.chat.addChatMessage(
    cardId,
    conversationId,
    'agent_card',
    `等待用户回答 ${questions.length || 1} 个问题`,
    new Date(askedAtMs).toISOString(),
    {
      askUserQuestions: {
        cardId,
        status: 'pending',
        questions: questions.length > 0 ? questions : [{ id: 'q1', question: 'q', kind: 'free_text' }],
        askedAt: askedAtMs,
      },
    },
  )
}

function readCardMeta(db: DatabaseManager, cardId: string): {
  status?: string
  cancelReason?: string
} | null {
  const row = db.chat.getChatMessageById(cardId)
  if (!row || !row.meta_json) return null
  try {
    const meta = JSON.parse(row.meta_json) as { askUserQuestions?: { status?: string; cancelReason?: string } }
    return meta.askUserQuestions ?? null
  } catch {
    return null
  }
}

test('B.4b boot sweep without liveCardIds: every pending card flipped to cancelled(app_restart)', (t) => {
  if (skipIfSqliteUnavailable(t, 'ask-user-boot-sweep: hard restart')) return
  const db = new DatabaseManager(true)
  t.after(() => db.close())
  insertPendingCard(db, 'auq-aaaaaaaa', 'conv-1')
  insertPendingCard(db, 'auq-bbbbbbbb', 'conv-2')
  insertPendingCard(db, 'auq-cccccccc', 'conv-1')

  const result = db.chat.sweepPendingAskUserQuestionsCardsOnBoot()
  assert.equal(result.mutated, 3)
  assert.equal(result.skippedLive, 0)

  for (const cardId of ['auq-aaaaaaaa', 'auq-bbbbbbbb', 'auq-cccccccc']) {
    const meta = readCardMeta(db, cardId)
    assert.ok(meta, `expected meta for ${cardId}`)
    assert.equal(meta!.status, 'cancelled')
    assert.equal(meta!.cancelReason, 'app_restart')
  }
})

test('B.4b boot sweep with liveCardIds: live cards skipped, others cancelled', (t) => {
  if (skipIfSqliteUnavailable(t, 'ask-user-boot-sweep: dev reload guard')) return
  const db = new DatabaseManager(true)
  t.after(() => db.close())
  insertPendingCard(db, 'auq-live01', 'conv-1')
  insertPendingCard(db, 'auq-live02', 'conv-1')
  insertPendingCard(db, 'auq-stale1', 'conv-2')
  insertPendingCard(db, 'auq-stale2', 'conv-2')

  const liveCardIds = new Set(['auq-live01', 'auq-live02'])
  const result = db.chat.sweepPendingAskUserQuestionsCardsOnBoot({ liveCardIds })
  assert.equal(result.mutated, 2, 'two stale cards cancelled')
  assert.equal(result.skippedLive, 2, 'two live cards skipped')

  // Live cards remain pending.
  for (const id of liveCardIds) {
    const meta = readCardMeta(db, id)
    assert.equal(meta!.status, 'pending', `${id} should still be pending`)
  }
  // Stale cards flipped.
  for (const id of ['auq-stale1', 'auq-stale2']) {
    const meta = readCardMeta(db, id)
    assert.equal(meta!.status, 'cancelled')
    assert.equal(meta!.cancelReason, 'app_restart')
  }
})

test('B.4b boot sweep is idempotent: second call mutates 0 rows', (t) => {
  if (skipIfSqliteUnavailable(t, 'ask-user-boot-sweep: idempotent')) return
  const db = new DatabaseManager(true)
  t.after(() => db.close())
  insertPendingCard(db, 'auq-once0001', 'conv-1')

  const first = db.chat.sweepPendingAskUserQuestionsCardsOnBoot()
  assert.equal(first.mutated, 1)

  const second = db.chat.sweepPendingAskUserQuestionsCardsOnBoot()
  assert.equal(second.mutated, 0, 'no pending rows remain on second sweep')
  assert.equal(second.skippedLive, 0)
})

test('B.4c session sweep: only rows for matching session flipped to cancelled(session_reset)', (t) => {
  if (skipIfSqliteUnavailable(t, 'ask-user-session-sweep: scope')) return
  const db = new DatabaseManager(true)
  t.after(() => db.close())
  insertPendingCard(db, 'auq-sess1a', 'session-A')
  insertPendingCard(db, 'auq-sess1b', 'session-A')
  insertPendingCard(db, 'auq-sess2', 'session-B')

  const mutated = db.chat.sweepPendingAskUserQuestionsCardsBySession('session-A')
  assert.equal(mutated, 2)

  // session-A cards flipped
  for (const id of ['auq-sess1a', 'auq-sess1b']) {
    const meta = readCardMeta(db, id)
    assert.equal(meta!.status, 'cancelled')
    assert.equal(meta!.cancelReason, 'session_reset')
  }
  // session-B untouched
  const sessBMeta = readCardMeta(db, 'auq-sess2')
  assert.equal(sessBMeta!.status, 'pending', 'cross-session row must not be affected')
})

test('B.4c session sweep with no matching pending rows returns 0', (t) => {
  if (skipIfSqliteUnavailable(t, 'ask-user-session-sweep: empty')) return
  const db = new DatabaseManager(true)
  t.after(() => db.close())
  insertPendingCard(db, 'auq-other', 'session-X')
  const mutated = db.chat.sweepPendingAskUserQuestionsCardsBySession('session-not-present')
  assert.equal(mutated, 0)
})

test('B.4c session sweep with explicit cancelReason override', (t) => {
  if (skipIfSqliteUnavailable(t, 'ask-user-session-sweep: custom reason')) return
  const db = new DatabaseManager(true)
  t.after(() => db.close())
  insertPendingCard(db, 'auq-x123', 'sess-K')
  db.chat.sweepPendingAskUserQuestionsCardsBySession('sess-K', 'session_killed_by_user')
  const meta = readCardMeta(db, 'auq-x123')
  assert.equal(meta!.cancelReason, 'session_killed_by_user')
})
