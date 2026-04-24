/**
 * B Phase 1 PR1 — skill primitive gating rules. Pure-module test driving
 * `shouldExposeSkillPrimitive` / `filterSkillPrimitivesBySession` directly so
 * we don't need to boot the runtime-manager.
 *
 * Phase 4 PR5 follow-up: the `hasActiveExecution` branch is retired (state
 * machine gone), so the gate now evaluates `hasReferenceSkillHint` alone.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterSkillPrimitivesBySession,
  shouldExposeSkillPrimitive,
} from '../main/modules/tools/skill-tool-session-gate'

const PRIMITIVE_DEFS = [
  { name: 'skill_run_shell' },
  { name: 'skill_write_artifact' },
  { name: 'skill_read_artifact' },
]

function never(): boolean {
  return false
}
function always(): boolean {
  return true
}

test('without sessionId the primitives list passes through unchanged (legacy boot path)', () => {
  const got = filterSkillPrimitivesBySession(PRIMITIVE_DEFS, undefined, never)
  assert.equal(got.length, 3)
})

test('with sessionId + no reference hint → primitives are filtered out', () => {
  const got = filterSkillPrimitivesBySession(PRIMITIVE_DEFS, 'session-1', never)
  assert.equal(got.length, 0)
})

test('with sessionId + reference-skill hint → primitives are exposed', () => {
  const got = filterSkillPrimitivesBySession(PRIMITIVE_DEFS, 'session-1', always)
  assert.deepEqual(got.map((d) => d.name).sort(), [
    'skill_read_artifact',
    'skill_run_shell',
    'skill_write_artifact',
  ])
})

test('shouldExposeSkillPrimitive: hint decides exposure when sessionId is present', () => {
  assert.equal(shouldExposeSkillPrimitive('s', never), false)
  assert.equal(shouldExposeSkillPrimitive('s', always), true)
})

test('empty input definition list remains empty regardless of gate outcome', () => {
  assert.deepEqual(filterSkillPrimitivesBySession([], 's', always), [])
  assert.deepEqual(filterSkillPrimitivesBySession([], 's', never), [])
})
