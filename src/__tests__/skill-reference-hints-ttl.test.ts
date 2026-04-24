/**
 * Patch A1 — TTL sweep for the reference-skill hint store. Exercises that:
 *   - A hint older than REFERENCE_SKILL_HINT_TTL_MS gets evicted by
 *     `sweepExpiredReferenceSkillHints`.
 *   - `getLastReferenceSkill` also expires on-read (defense in depth).
 *   - Fresh hints survive.
 */

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  REFERENCE_SKILL_HINT_TTL_MS,
  _resetLastReferenceSkillHintsForTests,
  getLastReferenceSkill,
  rememberLastReferenceSkill,
  sweepExpiredReferenceSkillHints,
} from '../main/modules/agent-control/skill-reference-hints'

test('sweep removes hints older than TTL and keeps fresh ones', () => {
  _resetLastReferenceSkillHintsForTests()
  const now = 1_800_000_000_000
  mock.timers.enable({ apis: ['Date'], now })

  try {
    rememberLastReferenceSkill('session-stale', { id: 'stale', name: 'Stale' })
    // Jump past the TTL.
    mock.timers.setTime(now + REFERENCE_SKILL_HINT_TTL_MS + 1)
    rememberLastReferenceSkill('session-fresh', { id: 'fresh', name: 'Fresh' })

    const removed = sweepExpiredReferenceSkillHints()
    assert.equal(removed, 1, 'only the stale session hint should be removed')
    assert.equal(getLastReferenceSkill('session-stale'), null)
    assert.equal(getLastReferenceSkill('session-fresh')?.id, 'fresh')
  } finally {
    mock.timers.reset()
  }
})

test('getLastReferenceSkill evicts on read when a hint expired since it was written', () => {
  _resetLastReferenceSkillHintsForTests()
  const now = 1_800_000_000_000
  mock.timers.enable({ apis: ['Date'], now })

  try {
    rememberLastReferenceSkill('session-x', { id: 'x', name: 'X' })
    mock.timers.setTime(now + REFERENCE_SKILL_HINT_TTL_MS + 100)
    assert.equal(getLastReferenceSkill('session-x'), null, 'expired hint returns null on read')
    // Second read confirms the entry is truly gone (not re-added).
    assert.equal(sweepExpiredReferenceSkillHints(), 0)
  } finally {
    mock.timers.reset()
  }
})

test('sweep is idempotent on an empty store and returns 0', () => {
  _resetLastReferenceSkillHintsForTests()
  assert.equal(sweepExpiredReferenceSkillHints(), 0)
  assert.equal(sweepExpiredReferenceSkillHints(), 0)
})
