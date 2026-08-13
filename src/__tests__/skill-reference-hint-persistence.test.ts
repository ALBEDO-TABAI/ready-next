import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  rememberLastReferenceSkill,
  getLastReferenceSkill,
  snapshotLastReferenceSkill,
  restoreLastReferenceSkill,
  clearAllReferenceSkillHints,
  REFERENCE_SKILL_HINT_TTL_MS,
  _resetLastReferenceSkillHintsForTests,
  _peekLastReferenceSkillForTests,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

before(() => {
  __setScopeContextEpochDatabaseForTests({ getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never })
})
after(() => __setScopeContextEpochDatabaseForTests(null))

// skill-resume plan A1 — verify the persistence shim that lets the in-memory
// reference-skill hint survive Ready restart by being snapshotted to
// chat_conversations.meta_json and restored on session resume.

describe('skill-resume A1 persistence helpers', () => {
  beforeEach(() => {
    _resetLastReferenceSkillHintsForTests()
  })

  describe('snapshotLastReferenceSkill', () => {
    it('returns null when no hint is armed', () => {
      assert.equal(snapshotLastReferenceSkill('sess-1'), null)
    })

    it('returns null when sessionId is undefined', () => {
      assert.equal(snapshotLastReferenceSkill(undefined), null)
    })

    it('returns {id, name, at} after rememberLastReferenceSkill', () => {
      rememberLastReferenceSkill('sess-1', { id: 'video-expert-analyzer', name: 'Video Expert' })
      const snap = snapshotLastReferenceSkill('sess-1')
      assert.ok(snap, 'snapshot present')
      assert.equal(snap!.id, 'video-expert-analyzer')
      assert.equal(snap!.name, 'Video Expert')
      assert.equal(typeof snap!.at, 'number')
      assert.ok(snap!.at > 0)
    })
  })

  describe('restoreLastReferenceSkill', () => {
    it('replays a fresh hint into the Map (verified via getLastReferenceSkill)', () => {
      const ok = restoreLastReferenceSkill('sess-2', {
        id: 'video-expert-analyzer',
        name: 'Video Expert',
        at: Date.now() - 5000, // 5 sec ago — well within TTL
      })
      assert.equal(ok, true)
      const hint = getLastReferenceSkill('sess-2')
      assert.ok(hint)
      assert.equal(hint!.id, 'video-expert-analyzer')
      assert.equal(hint!.name, 'Video Expert')
    })

    it('rejects a stale hint (>TTL) and does not arm', () => {
      const ok = restoreLastReferenceSkill('sess-3', {
        id: 'video-expert-analyzer',
        name: 'Video Expert',
        at: Date.now() - REFERENCE_SKILL_HINT_TTL_MS - 60_000, // 1 min past TTL
      })
      assert.equal(ok, false)
      assert.equal(getLastReferenceSkill('sess-3'), null)
    })

    it('rejects null/undefined hint silently', () => {
      assert.equal(restoreLastReferenceSkill('sess-4', null), false)
      assert.equal(restoreLastReferenceSkill('sess-4', undefined), false)
      assert.equal(getLastReferenceSkill('sess-4'), null)
    })

    it('rejects malformed hint (missing fields)', () => {
      assert.equal(restoreLastReferenceSkill('sess-5', { id: '', name: 'x', at: Date.now() }), false)
      assert.equal(restoreLastReferenceSkill('sess-5', { id: 'x', name: 'y', at: 0 }), false)
      // @ts-expect-error testing missing field
      assert.equal(restoreLastReferenceSkill('sess-5', { id: 'x', name: 'y' }), false)
      assert.equal(getLastReferenceSkill('sess-5'), null)
    })

    it('preserves original `at` (TTL math survives restart)', () => {
      const originalAt = Date.now() - 600_000 // 10 min ago
      restoreLastReferenceSkill('sess-6', {
        id: 'video-expert-analyzer',
        name: 'Video Expert',
        at: originalAt,
      })
      // skill-resume G8: getLastReferenceSkill bumps `at` on read (so active
      // sessions don't lose hint mid-flow). To verify restore PRESERVED the
      // snapshotted at, peek without bumping. Production code is unaffected —
      // the first active read will refresh the TTL anyway.
      const peeked = _peekLastReferenceSkillForTests('sess-6')
      assert.ok(peeked)
      assert.equal(peeked!.at, originalAt, 'restore preserves at, does not stamp fresh')
    })

    it('rejects when sessionId is empty/undefined', () => {
      assert.equal(restoreLastReferenceSkill('', { id: 'x', name: 'y', at: Date.now() }), false)
      assert.equal(restoreLastReferenceSkill(undefined, { id: 'x', name: 'y', at: Date.now() }), false)
    })
  })

  describe('end-to-end persistence round-trip', () => {
    it('arm → snapshot → simulate restart (clear) → restore → hint reappears', () => {
      rememberLastReferenceSkill('sess-7', { id: 'video-expert-analyzer', name: 'Video Expert' })
      const snap = snapshotLastReferenceSkill('sess-7')
      assert.ok(snap)

      // Simulate a Ready restart wiping the in-memory Map.
      clearAllReferenceSkillHints()
      assert.equal(getLastReferenceSkill('sess-7'), null, 'cleared')

      // Replay from persisted snapshot.
      const ok = restoreLastReferenceSkill('sess-7', snap)
      assert.equal(ok, true)
      const restoredBeforeRead = _peekLastReferenceSkillForTests('sess-7')
      assert.ok(restoredBeforeRead)
      assert.equal(restoredBeforeRead!.id, snap!.id)
      assert.equal(restoredBeforeRead!.at, snap!.at)
      const restoredAfterRead = getLastReferenceSkill('sess-7')
      assert.ok(restoredAfterRead)
      assert.equal(restoredAfterRead!.id, snap!.id)
      assert.ok(restoredAfterRead!.at >= snap!.at)
    })

    it('different sessionIds are isolated (no cross-contamination)', () => {
      rememberLastReferenceSkill('sess-A', { id: 'video-expert-analyzer', name: 'A' })
      rememberLastReferenceSkill('sess-B', { id: 'lets-go-rss', name: 'B' })
      const snapA = snapshotLastReferenceSkill('sess-A')!
      const snapB = snapshotLastReferenceSkill('sess-B')!
      clearAllReferenceSkillHints()
      restoreLastReferenceSkill('sess-A', snapA)
      assert.equal(getLastReferenceSkill('sess-A')!.id, 'video-expert-analyzer')
      assert.equal(getLastReferenceSkill('sess-B'), null, 'sess-B not restored')
      restoreLastReferenceSkill('sess-B', snapB)
      assert.equal(getLastReferenceSkill('sess-B')!.id, 'lets-go-rss')
    })
  })
})
