/**
 * Stage U (PR 1, B.4b/B.4c, review patch) — pure sweep helper tests.
 *
 * The instance-method tests in `ask-user-questions-boot-and-session-sweep.test.ts`
 * use SQLite and skip on host Node (ABI mismatch). These pure tests exercise
 * the SAME logic without the native gate, so the contract is proven on every
 * `npm run test` regardless of which Node version is in use.
 *
 * Covers:
 *   - performBootSweep:
 *     * empty input → 0/0
 *     * no liveCardIds → every pending row flipped
 *     * with liveCardIds → live cards skipped, others flipped (count split)
 *     * updateMeta returning false → counted as not mutated
 *     * meta merge preserves unrelated top-level fields
 *   - performSessionSweep:
 *     * empty sessionId → 0 (guard against accidental wipe)
 *     * matching sessionId → only matching rows flipped
 *     * MISMATCH: card persisted with conversationId !== runtime sessionId →
 *       NOT swept (cross-session safety contract)
 *     * cancelReason override propagates to written meta
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  performBootSweep,
  performSessionSweep,
  type PendingCardSnapshot,
} from '../main/modules/ask-user-questions-sweep'

function makeCard(
  messageId: string,
  conversationId: string,
  extraMeta: Record<string, unknown> = {},
): PendingCardSnapshot {
  return {
    messageId,
    conversationId,
    meta: {
      ...extraMeta,
      askUserQuestions: {
        cardId: messageId,
        status: 'pending',
        questions: [{ id: 'q1', question: 'q?', kind: 'free_text' }],
        askedAt: 1,
      },
    },
  }
}

// ============================================================================
// performBootSweep
// ============================================================================

test('boot sweep: empty pending list → 0 mutated, 0 skipped', () => {
  const writes: Array<[string, Record<string, unknown>]> = []
  const out = performBootSweep({
    pending: [],
    now: 'T1',
    updateMeta: (id, meta) => { writes.push([id, meta]); return true },
  })
  assert.equal(out.mutated, 0)
  assert.equal(out.skippedLive, 0)
  assert.equal(writes.length, 0)
})

test('boot sweep: no liveCardIds → every pending row flipped with cancelReason=app_restart', () => {
  const writes: Array<[string, Record<string, unknown>]> = []
  const out = performBootSweep({
    pending: [
      makeCard('auq-aaaa1111', 'conv-1'),
      makeCard('auq-bbbb2222', 'conv-2'),
      makeCard('auq-cccc3333', 'conv-1'),
    ],
    now: 'T-NOW',
    updateMeta: (id, meta) => { writes.push([id, meta]); return true },
  })
  assert.equal(out.mutated, 3)
  assert.equal(out.skippedLive, 0)
  assert.equal(writes.length, 3)
  for (const [, meta] of writes) {
    const aug = meta.askUserQuestions as { status: string; cancelReason: string; cancelledAt: string }
    assert.equal(aug.status, 'cancelled')
    assert.equal(aug.cancelReason, 'app_restart')
    assert.equal(aug.cancelledAt, 'T-NOW')
  }
})

test('boot sweep: liveCardIds → matching cards skipped; others flipped', () => {
  const writes: Array<[string, Record<string, unknown>]> = []
  const out = performBootSweep({
    pending: [
      makeCard('auq-live0001', 'conv-1'),
      makeCard('auq-stale001', 'conv-1'),
      makeCard('auq-live0002', 'conv-2'),
      makeCard('auq-stale002', 'conv-2'),
    ],
    liveCardIds: new Set(['auq-live0001', 'auq-live0002']),
    now: 'T1',
    updateMeta: (id, meta) => { writes.push([id, meta]); return true },
  })
  assert.equal(out.mutated, 2)
  assert.equal(out.skippedLive, 2)
  // Only the two stale cards were written.
  assert.deepEqual(writes.map(([id]) => id).sort(), ['auq-stale001', 'auq-stale002'])
})

test('boot sweep: updateMeta returning false counts as not mutated', () => {
  let attempted = 0
  const out = performBootSweep({
    pending: [
      makeCard('auq-a', 'conv-1'),
      makeCard('auq-b', 'conv-2'),
      makeCard('auq-c', 'conv-3'),
    ],
    now: 'T1',
    updateMeta: () => { attempted += 1; return false }, // always fails (row vanished)
  })
  assert.equal(attempted, 3)
  assert.equal(out.mutated, 0, 'no rows actually flipped')
  assert.equal(out.skippedLive, 0)
})

test('boot sweep: meta merge preserves unrelated top-level fields', () => {
  let captured: Record<string, unknown> | null = null
  performBootSweep({
    pending: [
      makeCard('auq-extra', 'conv-1', {
        attachments: [{ name: 'foo.txt', path: '/tmp/foo.txt' }],
        otherTopLevel: 42,
      }),
    ],
    now: 'T1',
    updateMeta: (_id, meta) => { captured = meta; return true },
  })
  assert.ok(captured, 'updateMeta was called')
  assert.deepEqual((captured as any).attachments, [{ name: 'foo.txt', path: '/tmp/foo.txt' }])
  assert.equal((captured as any).otherTopLevel, 42)
  // The askUserQuestions block also preserves the original cardId / askedAt:
  const aug = (captured as any).askUserQuestions as Record<string, unknown>
  assert.equal(aug.cardId, 'auq-extra')
  assert.equal(aug.askedAt, 1)
})

// ============================================================================
// performSessionSweep
// ============================================================================

test('session sweep: empty sessionId is a hard no-op (guard against accidental wipe)', () => {
  const writes: Array<[string, Record<string, unknown>]> = []
  const out = performSessionSweep({
    pending: [
      makeCard('auq-a', 'conv-1'),
      makeCard('auq-b', 'conv-2'),
    ],
    sessionId: '',
    cancelReason: 'session_reset',
    now: 'T1',
    updateMeta: (id, meta) => { writes.push([id, meta]); return true },
  })
  assert.equal(out, 0)
  assert.equal(writes.length, 0)
})

test('session sweep: only rows whose conversationId matches sessionId are flipped', () => {
  const writes: string[] = []
  const out = performSessionSweep({
    pending: [
      makeCard('auq-x', 'session-A'),
      makeCard('auq-y', 'session-B'),
      makeCard('auq-z', 'session-A'),
    ],
    sessionId: 'session-A',
    cancelReason: 'session_reset',
    now: 'T1',
    updateMeta: (id) => { writes.push(id); return true },
  })
  assert.equal(out, 2)
  assert.deepEqual(writes.sort(), ['auq-x', 'auq-z'])
})

test('session sweep MISMATCH: card persisted with different conversationId than runtime sessionId is NOT swept', () => {
  // Cross-session safety contract: even if a hypothetical entry point passes
  // a sessionId that doesn't match what was persisted as conversationId, the
  // sweep must NOT touch unrelated cards. If this ever changes (e.g. someone
  // wires lineageRootId instead of conversationId), this test fails loudly
  // before it can leak into prod.
  const writes: string[] = []
  const out = performSessionSweep({
    pending: [
      // Pretend the runtime "sessionId" is `lineage-root-X` but the
      // chat_messages row was persisted with conversationId='conv-original'.
      // This is the mismatch case: nothing should be touched.
      makeCard('auq-mismatch', 'conv-original'),
    ],
    sessionId: 'lineage-root-X',
    cancelReason: 'session_reset',
    now: 'T1',
    updateMeta: (id) => { writes.push(id); return true },
  })
  assert.equal(out, 0, 'mismatched card must NOT be swept')
  assert.equal(writes.length, 0)
})

test('session sweep: cancelReason override propagates into the merged meta', () => {
  let captured: Record<string, unknown> | null = null
  performSessionSweep({
    pending: [makeCard('auq-x', 'sess-K')],
    sessionId: 'sess-K',
    cancelReason: 'session_killed_by_user',
    now: 'T1',
    updateMeta: (_id, meta) => { captured = meta; return true },
  })
  assert.ok(captured)
  const aug = (captured as any).askUserQuestions as Record<string, unknown>
  assert.equal(aug.cancelReason, 'session_killed_by_user')
  assert.equal(aug.cancelledAt, 'T1')
})

test('session sweep: updateMeta returning false counts as not mutated (DB row vanished mid-sweep)', () => {
  const out = performSessionSweep({
    pending: [
      makeCard('auq-a', 'sess-1'),
      makeCard('auq-b', 'sess-1'),
    ],
    sessionId: 'sess-1',
    cancelReason: 'session_reset',
    now: 'T1',
    updateMeta: () => false,
  })
  assert.equal(out, 0)
})
