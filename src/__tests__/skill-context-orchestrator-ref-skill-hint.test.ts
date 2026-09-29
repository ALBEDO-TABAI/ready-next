/**
 * B plan Phase 0 — P0-T3: verifies that SkillContextOrchestrator writes
 * `lastReferenceSkill` into the session-scoped hint store whenever it inlines
 * a reference-runtime skill. This is the write-side; the read-side is
 * exercised in `skill-execution-missing-reference-hint.test.ts`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

test.before(() => {
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
  })
})
test.after(() => __setScopeContextEpochDatabaseForTests(null))

import { SkillContextOrchestrator } from '../main/modules/agent-control/skills/skill-context-orchestrator'
import {
  _resetLastReferenceSkillHintsForTests,
  clearAllReferenceSkillHints,
  getLastReferenceSkill,
  rememberLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'

function referenceSkill(): any {
  return {
    id: 'novel_writer_system',
    name: 'Novel Writer System',
    description: 'A reference skill for writing fiction.',
    defaultAction: 'read_skill',
    executionMode: 'advisory',
    actions: [
      {
        name: 'read_skill',
        visibility: 'public',
        runtime: 'reference',
        params: [],
      },
    ],
  }
}

function workflowSkill(): any {
  return {
    id: 'video-copy-analyzer',
    name: 'Video Copy Analyzer',
    description: 'Analyze video copy.',
    defaultAction: 'video_copy_analyze',
    executionMode: 'workflow',
    actions: [
      {
        name: 'video_copy_analyze',
        visibility: 'public',
        runtime: 'python',
        // workflow skill — required param means orchestrator will NOT inline
        params: [{ name: 'videoUrl', required: true }],
      },
    ],
  }
}

function buildOrchestrator(skill: any) {
  return new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skill],
    resolveSkillToolByAction: (_skillId, action) => ({
      name: `skill_${skill.id.replace(/-/g, '_')}_${action}`,
      action,
      params: skill.actions.find((a: any) => a.name === action)?.params || [],
    }) as any,
  })
}

test('explicit reference skill can arm a session hint before inline injection', () => {
  _resetLastReferenceSkillHintsForTests()
  const orchestrator = buildOrchestrator(referenceSkill())

  const remembered = orchestrator.rememberExplicitReferenceSkillHint(
    '使用 Novel Writer System 写一段场景',
    'session-preflight',
  )

  assert.equal(remembered, true)
  const hint = getLastReferenceSkill('session-preflight')
  assert.ok(hint)
  assert.equal(hint?.id, 'novel_writer_system')
  assert.equal(hint?.name, 'Novel Writer System')
})

test('explicit workflow skill does not arm the reference primitive hint', () => {
  _resetLastReferenceSkillHintsForTests()
  const orchestrator = buildOrchestrator(workflowSkill())

  const remembered = orchestrator.rememberExplicitReferenceSkillHint(
    '用 Video Copy Analyzer 分析这个视频',
    'session-workflow-preflight',
  )

  assert.equal(remembered, false)
  assert.equal(getLastReferenceSkill('session-workflow-preflight'), null)
})

// Patch A4 — overwriting the same session's hint replaces the previous
// skill in place; old id must not be recoverable.
test('same-session overwrite — loading ref-skill-B replaces ref-skill-A in the hint store', () => {
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('session-overwrite', { id: 'novel_writer_system', name: 'Novel' })
  const first = getLastReferenceSkill('session-overwrite')
  assert.equal(first?.id, 'novel_writer_system')

  rememberLastReferenceSkill('session-overwrite', { id: 'data_analyst', name: 'Data' })
  const second = getLastReferenceSkill('session-overwrite')
  assert.equal(second?.id, 'data_analyst')
  assert.equal(second?.name, 'Data')
  // Timestamp moves forward on overwrite (or stays equal on same-ms writes).
  assert.ok((second?.at || 0) >= (first?.at || 0))
})

// Patch A1 — clearAllReferenceSkillHints must wipe every session, simulating
// `cleanupAgentRuntime` on app shutdown.
test('clearAllReferenceSkillHints wipes every session (runtime dispose)', () => {
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('s1', { id: 'a', name: 'A' })
  rememberLastReferenceSkill('s2', { id: 'b', name: 'B' })
  assert.ok(getLastReferenceSkill('s1'))
  assert.ok(getLastReferenceSkill('s2'))
  clearAllReferenceSkillHints()
  assert.equal(getLastReferenceSkill('s1'), null)
  assert.equal(getLastReferenceSkill('s2'), null)
})
