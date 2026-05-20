import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  rememberLastReferenceSkill,
  getLastReferenceSkill,
  REFERENCE_SKILL_HINT_TTL_MS,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skills/skill-reference-hints'

// skill-resume G8 — getLastReferenceSkill must bump `at` on every successful
// read so an actively-used hint doesn't expire mid-flow during a long
// pipeline (10-30+ min). Production logs showed referenceSkillHintArmed=true
// for 67+ min then suddenly the typed actions disappeared because the hint
// expired against its first-arm timestamp.

describe('skill-resume G8 — TTL bumps on read keep active sessions alive', () => {
  beforeEach(() => {
    _resetLastReferenceSkillHintsForTests()
  })

  it('bumps `at` to now() on every getLastReferenceSkill call', async () => {
    rememberLastReferenceSkill('sess-1', { id: 'video-expert-analyzer', name: 'VEA' })
    const first = getLastReferenceSkill('sess-1')!
    const firstAt = first.at

    // Tiny sleep so Date.now() advances at least 1 ms
    await new Promise((r) => setTimeout(r, 5))

    const second = getLastReferenceSkill('sess-1')!
    assert.ok(second.at >= firstAt, '`at` should monotonically increase')
    assert.notEqual(second.at, firstAt, '`at` actually moved on subsequent read')
  })

  it('returns null and does not bump when the existing entry is past TTL', () => {
    // Manually plant an expired entry (cannot use rememberLastReferenceSkill
    // because that always stamps now()). Re-import the in-memory map's
    // shape via the public API by remembering then back-dating:
    rememberLastReferenceSkill('sess-stale', { id: 'lets-go-rss', name: 'rss' })
    const live = getLastReferenceSkill('sess-stale')!
    // Mutate `at` to be in the deep past
    live.at = Date.now() - REFERENCE_SKILL_HINT_TTL_MS - 1000

    const recovered = getLastReferenceSkill('sess-stale')
    assert.equal(recovered, null, 'expired entry returns null')

    // And subsequent reads still null (entry was deleted)
    assert.equal(getLastReferenceSkill('sess-stale'), null)
  })

  it('keeps a hint alive across reads spanning longer than the TTL window', async () => {
    rememberLastReferenceSkill('sess-active', { id: 'video-expert-analyzer', name: 'VEA' })

    // Simulate ongoing usage: every 50ms read once. Over a few iterations the
    // bumped `at` should keep the hint live indefinitely (in production this
    // is what an active turn-engine loop does — every iteration calls
    // getSkillAnthropicTools(sessionId) → getLastReferenceSkill).
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
      const live = getLastReferenceSkill('sess-active')
      assert.ok(live, `read #${i} should still see the hint`)
    }
    // After 100ms of active reads, hint is still alive (TTL is 30 min so this
    // case would also pass without the bump; the assertion above is the
    // monotonic-bump check that proves the mechanism works).
    assert.ok(getLastReferenceSkill('sess-active'))
  })
})
