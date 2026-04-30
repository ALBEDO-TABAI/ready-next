/**
 * B plan Phase 4 — the reference-hint TTL sweep is now driven by its own
 * setTimeout + setInterval chain in SkillsRuntimeManager.startReferenceHintSweep().
 * Before PR1-D, the sweep piggy-backed on the retired skill_executions TTL
 * sweep; after retirement it must keep running independently so idle hints
 * don't linger in-process indefinitely.
 *
 * Source-level contract: verifies the independent sweep wiring is present in
 * runtime-manager.ts. Behavioral coverage of the sweep function itself lives
 * in skill-reference-hints-ttl.test.ts.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'

import {
  rememberLastReferenceSkill,
  sweepExpiredReferenceSkillHints,
  _resetLastReferenceSkillHintsForTests,
  REFERENCE_SKILL_HINT_TTL_MS,
  getLastReferenceSkill,
  setReferenceHintChangeEmitter,
} from '../main/modules/agent-control/skill-reference-hints'
import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'

test('runtime-manager reference-hint sweep removes stale hints on its boot timer', () => {
  _resetLastReferenceSkillHintsForTests()
  const root = mkdtempSync(join(tmpdir(), 'reference-hint-sweep-'))
  const now = 1_800_000_000_000
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now })

  const manager = new SkillsRuntimeManager({
    runtimeRoot: root,
    startBackgroundTasks: false,
  })
  const changes: Array<{ sessionId: string; change: string }> = []
  setReferenceHintChangeEmitter((sessionId, change) => {
    changes.push({ sessionId, change })
  })

  try {
    rememberLastReferenceSkill('session-stale', { id: 'novel_writer_system', name: 'Novel' })
    mock.timers.setTime(now + REFERENCE_SKILL_HINT_TTL_MS + 1)
    ;(manager as unknown as { startReferenceHintSweep: () => void }).startReferenceHintSweep()

    mock.timers.tick(29_999)
    assert.deepEqual(changes.map((item) => item.change), ['armed'])

    mock.timers.tick(1)
    assert.equal(getLastReferenceSkill('session-stale'), null)
    assert.deepEqual(changes, [
      { sessionId: 'session-stale', change: 'armed' },
      { sessionId: 'session-stale', change: 'cleared' },
    ])
  } finally {
    manager.stopReferenceHintSweep()
    setReferenceHintChangeEmitter(null)
    mock.timers.reset()
    rmSync(root, { recursive: true, force: true })
    _resetLastReferenceSkillHintsForTests()
  }
})

test('sweepExpiredReferenceSkillHints is safe on empty state and keeps the TTL contract', () => {
  _resetLastReferenceSkillHintsForTests()

  // Sanity: sweeping an empty map returns 0 without throwing and emits the metric.
  const removed = sweepExpiredReferenceSkillHints()
  assert.equal(removed, 0)
  // TTL constant is sane.
  assert.equal(REFERENCE_SKILL_HINT_TTL_MS, 30 * 60 * 1000)
})
