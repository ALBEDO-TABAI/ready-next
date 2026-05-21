/**
 * Stage V V3.1 — AgentSessionManager descriptor layer.
 *
 * Covers the descriptor parse + enriched listing contract added to
 * `session-manager.ts` so that `ReadyAgentOrchestrator.listAllSessions()`
 * (and any future consumer) addresses sessions by `(agent, sessionId)`
 * tuples rather than reading the raw composite `${agent}::${sessionId}`
 * key as if it were a bare agent id — the bug codex round-1 flagged.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md
 *   §4 V3.1
 *
 * Behavior matrix:
 *   1. parseSessionKey roundtrip — composite key `agent::sessionId` parses
 *      back to descriptor `{ agent, sessionId }`.
 *   2. parseSessionKey legacy form — bare key (no `::` delimiter) parses
 *      to `{ agent: key, sessionId: null }`.
 *   3. parseSessionKey first-delimiter split — if the sessionId itself
 *      contains `::` we split on the *first* delimiter so the tail is
 *      preserved verbatim. (Defensive: upstream registration disallows
 *      `::` in agent ids, but this guards future regressions.)
 *   4. listStatesEnriched returns descriptors mirroring the snapshot key
 *      verbatim, sorted most-recent-first like `listStates()`.
 *   5. getActiveCount excludes `'closed'` automatically (the negation
 *      form of the active-state list means terminal additions like
 *      `'closed'` need no explicit handling — V3.1 plan note).
 *   6. has() reports composite-key presence — used by closeSession to
 *      decide `{ closed: true | false }`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentSessionManager,
  parseSessionKey,
  type SessionDescriptor,
} from '../main/modules/agent-control/session/session-manager'

function descriptorsEqual(a: SessionDescriptor, b: SessionDescriptor): boolean {
  return a.agent === b.agent && a.sessionId === b.sessionId
}

test('V3.1 parseSessionKey roundtrips composite agent::sessionId form', () => {
  const composite = 'ready-default::sess-abc-123'
  const parsed = parseSessionKey(composite)
  assert.ok(
    descriptorsEqual(parsed, { agent: 'ready-default', sessionId: 'sess-abc-123' }),
    `expected { agent: 'ready-default', sessionId: 'sess-abc-123' }, got ${JSON.stringify(parsed)}`,
  )
  // Roundtrip via the production composer (orchestrator.toTaskKey uses
  // the same `${agent}::${sessionId}` template).
  const reconstructed = `${parsed.agent}::${parsed.sessionId}`
  assert.equal(reconstructed, composite, 'roundtrip must produce the original composite key')
})

test('V3.1 parseSessionKey returns null sessionId for legacy bare keys', () => {
  const parsed = parseSessionKey('ready-default')
  assert.ok(
    descriptorsEqual(parsed, { agent: 'ready-default', sessionId: null }),
    'legacy bare key (no `::`) must produce sessionId === null, never an empty string',
  )
})

test('V3.1 parseSessionKey splits on the FIRST `::` delimiter', () => {
  // sessionId carries an additional `::` (would happen if some future
  // sessionId encoding embedded one). The split must keep the tail
  // verbatim — otherwise we'd alias unrelated sessions to the same key.
  const parsed = parseSessionKey('agent-x::sub::tail')
  assert.equal(parsed.agent, 'agent-x', 'agent must be the prefix before the first `::`')
  assert.equal(parsed.sessionId, 'sub::tail', 'sessionId must preserve embedded `::` in the tail')
})

test('V3.1 listStatesEnriched returns descriptors that mirror the composite key', async () => {
  const sessions = new AgentSessionManager()
  // Seed multiple sessions with distinct (agent, sessionId) pairs plus
  // one legacy bare-key entry. Sleep briefly between writes so the
  // `updatedAt` ISO strings sort deterministically.
  sessions.setState('ready-default::sess-A', 'queued')
  await new Promise((r) => setTimeout(r, 5))
  sessions.setState('ready-default::sess-B', 'tool_running')
  await new Promise((r) => setTimeout(r, 5))
  sessions.setState('legacy-bare-key', 'done')

  const enriched = sessions.listStatesEnriched()
  assert.equal(enriched.length, 3, 'all three seeded sessions must be present')

  // Sorted most-recent-first by updatedAt.
  assert.equal(enriched[0].agent, 'legacy-bare-key', 'most-recent entry must be first')
  assert.equal(enriched[2].agent, 'ready-default::sess-A', 'oldest entry must be last')

  // Each snapshot carries a descriptor that matches a fresh parse of
  // its composite key. The descriptor is the only sanctioned consumer
  // exit — `snap.agent` remains the raw composite for backwards-compat.
  for (const snap of enriched) {
    const reparsed = parseSessionKey(snap.agent)
    assert.deepEqual(
      snap.descriptor,
      reparsed,
      `descriptor for ${snap.agent} must equal a fresh parseSessionKey()`,
    )
  }

  // Spot-check: the descriptor for the bare-key legacy entry must have
  // sessionId === null (never the empty string, never the bare key
  // again — that's the V3.1 bug fix).
  const legacySnap = enriched.find((s) => s.agent === 'legacy-bare-key')!
  assert.equal(legacySnap.descriptor.sessionId, null)
  assert.equal(legacySnap.descriptor.agent, 'legacy-bare-key')
})

test('V3.1 getActiveCount excludes terminal closed/done/cancelled/failed', () => {
  const sessions = new AgentSessionManager()
  sessions.setState('agent-1::s1', 'queued')        // active
  sessions.setState('agent-1::s2', 'planning')      // active
  sessions.setState('agent-1::s3', 'tool_running')  // active
  sessions.setState('agent-1::s4', 'responding')    // active
  sessions.setState('agent-1::s5', 'done')          // terminal
  sessions.setState('agent-1::s6', 'failed')        // terminal
  sessions.setState('agent-1::s7', 'cancelled')     // terminal
  sessions.setState('agent-1::s8', 'closed')        // terminal — V3.1 addition

  assert.equal(
    sessions.getActiveCount(),
    4,
    'V3.1 `closed` must not bump active count (terminal state)',
  )
})

test('V3.1 has() reports composite-key membership for idempotent closeSession', () => {
  const sessions = new AgentSessionManager()
  assert.equal(sessions.has('agent-1::s1'), false, 'empty manager must report absent')
  sessions.setState('agent-1::s1', 'queued')
  assert.equal(sessions.has('agent-1::s1'), true, 'seeded key must report present')
  // Different composite key — same agent, different sessionId — must
  // not bleed.
  assert.equal(sessions.has('agent-1::s2'), false, 'unrelated composite key must report absent')
})
