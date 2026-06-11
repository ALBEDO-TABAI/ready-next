/**
 * EP2-C6 — deterministic belief decay matrix: usage promotes, the decay
 * conjunction demotes one step, the floor is two-phase (mark then delete),
 * and suspected duplicates are never deleted.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideBeliefDecay,
  runBeliefDecayRound,
  type BeliefDecaySignals,
} from '../main/modules/agent-control/memory/belief-decay'

const NOW = new Date('2026-06-12T12:00:00.000Z')

function signals(over: Partial<BeliefDecaySignals> = {}): BeliefDecaySignals {
  return {
    relPath: 'knowledge/card.md',
    confidence: 'M',
    created: '2026-01-01', // 162 days — stale
    accessCount: 0,
    wasUsefulCount: 0,
    backlinksCount: 0,
    markedDecayed: false,
    possibleDuplicate: false,
    ...over,
  }
}

test('decision matrix: usage promotes; conjunction demotes; any missing signal keeps', () => {
  assert.deepEqual(decideBeliefDecay(signals({ wasUsefulCount: 1, confidence: 'L' }), NOW),
    { action: 'promote', toConfidence: 'M', reason: 'usage_signal' })
  assert.deepEqual(decideBeliefDecay(signals({ accessCount: 5 }), NOW),
    { action: 'promote', toConfidence: 'H', reason: 'usage_signal' })
  assert.equal(decideBeliefDecay(signals({ wasUsefulCount: 2, confidence: 'H' }), NOW).action, 'keep')

  assert.deepEqual(decideBeliefDecay(signals({ confidence: 'H' }), NOW),
    { action: 'demote', toConfidence: 'M', reason: 'decay_conjunction' })
  assert.deepEqual(decideBeliefDecay(signals(), NOW),
    { action: 'demote', toConfidence: 'L', reason: 'decay_conjunction' })

  // conjunction broken by any one signal → keep
  assert.equal(decideBeliefDecay(signals({ backlinksCount: 1 }), NOW).action, 'keep')
  assert.equal(decideBeliefDecay(signals({ accessCount: 1 }), NOW).action, 'keep')
  assert.equal(decideBeliefDecay(signals({ created: '2026-06-01' }), NOW).action, 'keep')
})

test('floor is two-phase: mark first, delete only when a marked card still qualifies', () => {
  assert.equal(decideBeliefDecay(signals({ confidence: 'L' }), NOW).action, 'mark_decayed')
  assert.equal(decideBeliefDecay(signals({ confidence: 'L', markedDecayed: true }), NOW).action, 'delete')
  // a marked card that regained usage is promoted, not deleted
  assert.equal(decideBeliefDecay(signals({ confidence: 'L', markedDecayed: true, wasUsefulCount: 1 }), NOW).action, 'promote')
})

test('suspected duplicates are never deleted by decay', () => {
  const decision = decideBeliefDecay(signals({ confidence: 'L', markedDecayed: true, possibleDuplicate: true }), NOW)
  assert.equal(decision.action, 'keep')
  assert.equal(decision.reason, 'duplicate_never_deleted')
})

test('round applier dispatches effectors and reports counts', () => {
  const ops: string[] = []
  const report = runBeliefDecayRound([
    signals({ relPath: 'knowledge/a.md', confidence: 'H' }),                                  // demote
    signals({ relPath: 'knowledge/b.md', confidence: 'L' }),                                  // mark
    signals({ relPath: 'knowledge/c.md', confidence: 'L', markedDecayed: true }),             // delete
    signals({ relPath: 'knowledge/d.md', wasUsefulCount: 1 }),                                // promote
    signals({ relPath: 'knowledge/e.md', backlinksCount: 2 }),                                // keep
  ], {
    setConfidence: (relPath, confidence) => ops.push(`set:${relPath}:${confidence}`),
    markDecayed: (relPath) => ops.push(`mark:${relPath}`),
    deleteCard: (relPath) => ops.push(`delete:${relPath}`),
  }, NOW)
  assert.deepEqual(report, { promoted: 1, demoted: 1, marked: 1, deleted: 1, kept: 1 })
  assert.deepEqual(ops.sort(), [
    'delete:knowledge/c.md',
    'mark:knowledge/b.md',
    'set:knowledge/a.md:M',
    'set:knowledge/d.md:H',
  ])
})
