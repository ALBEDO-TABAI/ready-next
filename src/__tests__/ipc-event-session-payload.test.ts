import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Stage V — V3.2 IPC event payload sessionId propagation.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md §4 V3.2
 *
 * V3.2 contract: every `agent:*` push channel that is per-session MUST
 * carry `sessionId` at the top level of the wire payload (so the
 * renderer can route per-session without aliasing through `scopeId`).
 * Global/non-session emits MUST send `sessionId: null` explicitly.
 *
 * This test mirrors the bridge logic in
 * `src/main/modules/claude-bridge/ipc-handler.ts` for three sample push
 * channels and asserts the wire payload shape. Same pattern as
 * `agent-task-projections-changed-ipc.test.ts`: we don't import the
 * ipc-handler module directly (it pulls in too much electron/runtime
 * machinery), we mirror the small emit-site logic and spy on
 * `webContents.send`.
 *
 * Channels covered:
 *   - `agent:scopeRunEvent`         (per-session scope run lifecycle)
 *   - `agent:taskProjectionsChanged` (per-session task projection mutation)
 *   - `agent:askUserQuestions:push`  (per-session reflection card; null when global)
 */

type Send = (channel: string, payload: unknown) => void

/**
 * Spy webContents shaped like the real Electron `WebContents.send`.
 * The spy records every `(channel, payload)` pair so the test can assert
 * the V3.2 contract on the wire shape.
 */
function makeFakeWebContents(sends: Array<[string, unknown]>) {
  return {
    isDestroyed: () => false,
    webContents: {
      send: ((channel: string, payload: unknown) => {
        sends.push([channel, payload])
      }) as Send,
    },
  }
}

// ───────── Bridge mirrors ─────────
// Each function below mirrors the emit-site logic in
// `src/main/modules/claude-bridge/ipc-handler.ts` for the matching channel.
// Whenever the real emit site changes, the mirror must be updated; the
// shape asserted below is the V3.2 wire contract.

function emitScopeRunEventFromRuntime(
  fakeWin: ReturnType<typeof makeFakeWebContents>,
  data: { scopeId: string; type: string; phase: string; agent: string },
): void {
  // Mirrors ipc-handler.ts `runtime.on('scopeRunEvent', ...)` forwarder.
  if (fakeWin.isDestroyed()) return
  const sessionId = data && typeof data === 'object' && typeof data.scopeId === 'string'
    ? data.scopeId
    : null
  fakeWin.webContents.send('agent:scopeRunEvent', {
    ...data,
    sessionId,
  })
}

function emitTaskProjectionsChanged(
  fakeWin: ReturnType<typeof makeFakeWebContents>,
  event: { scopeId: string; changedTaskIds: string[]; reason: 'create' | 'update' | 'delete' | 'supersede' },
): void {
  // Mirrors ipc-handler.ts `onProjectionChange` bridge.
  if (fakeWin.isDestroyed()) return
  fakeWin.webContents.send('agent:taskProjectionsChanged', {
    ...event,
    sessionId: event.scopeId,
  })
}

function emitAskUserQuestionsCardPush(
  fakeWin: ReturnType<typeof makeFakeWebContents>,
  event: {
    cardId: string
    sessionId: string | null
    conversationId: string | null
    questions: Array<{ id: string; question: string; kind: 'free_text' }>
    askedAt: number
  },
): void {
  // Mirrors ipc-handler.ts `registerAskUserQuestionsCardEmitter` bridge.
  // The card event is built upstream and already carries `sessionId`
  // (nullable) by V3.2 contract; the bridge passes the event through.
  if (fakeWin.isDestroyed()) return
  fakeWin.webContents.send('agent:askUserQuestions:push', event)
}

// ───────── Tests ─────────

test('agent:scopeRunEvent push carries sessionId mirroring scopeId', () => {
  const sends: Array<[string, unknown]> = []
  const win = makeFakeWebContents(sends)

  emitScopeRunEventFromRuntime(win, {
    scopeId: 'scope-aaa',
    type: 'updated',
    phase: 'planning',
    agent: 'claude',
  })

  assert.equal(sends.length, 1, 'one wire send expected')
  assert.equal(sends[0][0], 'agent:scopeRunEvent')
  const payload = sends[0][1] as Record<string, unknown>
  assert.equal(payload.scopeId, 'scope-aaa', 'scopeId preserved')
  assert.equal(payload.sessionId, 'scope-aaa', 'V3.2: sessionId mirrors scopeId on wire')
  assert.equal(typeof payload.sessionId, 'string', 'V3.2: sessionId is string when per-session')
})

test('agent:taskProjectionsChanged push carries sessionId mirroring scopeId', () => {
  const sends: Array<[string, unknown]> = []
  const win = makeFakeWebContents(sends)

  emitTaskProjectionsChanged(win, {
    scopeId: 'scope-bbb',
    changedTaskIds: ['t1', 't2'],
    reason: 'create',
  })

  assert.equal(sends.length, 1, 'one wire send expected')
  assert.equal(sends[0][0], 'agent:taskProjectionsChanged')
  const payload = sends[0][1] as Record<string, unknown>
  assert.equal(payload.scopeId, 'scope-bbb', 'scopeId preserved')
  assert.deepEqual(payload.changedTaskIds, ['t1', 't2'], 'changedTaskIds preserved')
  assert.equal(payload.reason, 'create', 'reason preserved')
  assert.equal(payload.sessionId, 'scope-bbb', 'V3.2: sessionId mirrors scopeId on wire')
})

test('agent:askUserQuestions:push carries sessionId field (string when per-session)', () => {
  const sends: Array<[string, unknown]> = []
  const win = makeFakeWebContents(sends)

  emitAskUserQuestionsCardPush(win, {
    cardId: 'card-1',
    sessionId: 'scope-ccc',
    conversationId: 'conv-1',
    questions: [{ id: 'q1', question: 'Continue?', kind: 'free_text' }],
    askedAt: Date.now(),
  })

  assert.equal(sends.length, 1, 'one wire send expected')
  assert.equal(sends[0][0], 'agent:askUserQuestions:push')
  const payload = sends[0][1] as Record<string, unknown>
  assert.equal(payload.cardId, 'card-1', 'cardId preserved')
  assert.equal(payload.sessionId, 'scope-ccc', 'V3.2: sessionId is the per-session id')
  // Critical V3.2 invariant: the sessionId field MUST exist on the wire
  // (not undefined). Renderer listeners route by this field; an absent
  // sessionId would silently force a fallback path (V3.3d listener guard).
  assert.ok('sessionId' in payload, 'V3.2: sessionId field is present (not omitted)')
})

test('agent:askUserQuestions:push carries sessionId=null when card is global (no session)', () => {
  // Per ask-user-questions.ts:525-526, sessionId is `deps.sessionId || null`
  // — the persist + push path explicitly tolerates null. V3.2 listener
  // guard (V3.3d in the next PR) relies on null being on the wire so the
  // listener can route via conversationId fallback rather than dropping.
  const sends: Array<[string, unknown]> = []
  const win = makeFakeWebContents(sends)

  emitAskUserQuestionsCardPush(win, {
    cardId: 'card-2',
    sessionId: null,
    conversationId: 'conv-2',
    questions: [{ id: 'q1', question: 'Continue?', kind: 'free_text' }],
    askedAt: Date.now(),
  })

  assert.equal(sends.length, 1, 'one wire send expected')
  const payload = sends[0][1] as Record<string, unknown>
  assert.equal(payload.sessionId, null, 'V3.2: explicit null marks global (not session-scoped) emit')
  assert.ok('sessionId' in payload, 'V3.2: null sessionId is present, not omitted')
})

test('V3.2 invariant: every per-session sample emit produces a wire payload whose sessionId is string-or-null', () => {
  // Aggregate cross-channel invariant. If a future bridge change drops
  // sessionId from the wire (`undefined` instead of `string | null`),
  // this test fails first — making the regression obvious.
  const sends: Array<[string, unknown]> = []
  const win = makeFakeWebContents(sends)

  emitScopeRunEventFromRuntime(win, {
    scopeId: 'scope-1',
    type: 'updated',
    phase: 'planning',
    agent: 'claude',
  })
  emitTaskProjectionsChanged(win, {
    scopeId: 'scope-1',
    changedTaskIds: ['t1'],
    reason: 'update',
  })
  emitAskUserQuestionsCardPush(win, {
    cardId: 'card-3',
    sessionId: 'scope-1',
    conversationId: 'conv-3',
    questions: [{ id: 'q1', question: '?', kind: 'free_text' }],
    askedAt: Date.now(),
  })

  assert.equal(sends.length, 3)
  for (const [channel, raw] of sends) {
    const payload = raw as Record<string, unknown>
    assert.ok('sessionId' in payload, `${channel}: V3.2 contract requires sessionId field on wire`)
    const v = payload.sessionId
    const okType = v === null || typeof v === 'string'
    assert.ok(okType, `${channel}: V3.2 sessionId must be string|null, got ${typeof v}`)
  }
})
