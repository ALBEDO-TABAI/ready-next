/**
 * B Phase 1 PR1 — skill primitive gating rules. Pure-module test driving
 * `shouldExposeSkillPrimitive` / `filterSkillPrimitivesBySession` directly so
 * we don't need to boot the runtime-manager.
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
  const got = filterSkillPrimitivesBySession(PRIMITIVE_DEFS, undefined, never, never)
  assert.equal(got.length, 3)
})

test('with sessionId + no active execution + no reference hint → primitives are filtered out', () => {
  const got = filterSkillPrimitivesBySession(PRIMITIVE_DEFS, 'session-1', never, never)
  assert.equal(got.length, 0)
})

test('with sessionId + active execution → primitives are exposed', () => {
  const got = filterSkillPrimitivesBySession(PRIMITIVE_DEFS, 'session-1', always, never)
  assert.deepEqual(got.map((d) => d.name).sort(), [
    'skill_read_artifact',
    'skill_run_shell',
    'skill_write_artifact',
  ])
})

test('with sessionId + reference-skill hint (no active execution) → primitives are exposed', () => {
  const got = filterSkillPrimitivesBySession(PRIMITIVE_DEFS, 'session-1', never, always)
  assert.equal(got.length, 3)
})

test('shouldExposeSkillPrimitive short-circuits: hint alone suffices, execution alone suffices', () => {
  assert.equal(shouldExposeSkillPrimitive('s', never, never), false)
  assert.equal(shouldExposeSkillPrimitive('s', always, never), true)
  assert.equal(shouldExposeSkillPrimitive('s', never, always), true)
  assert.equal(shouldExposeSkillPrimitive('s', always, always), true)
})

test('empty input definition list remains empty regardless of gate outcome', () => {
  assert.deepEqual(filterSkillPrimitivesBySession([], 's', always, always), [])
  assert.deepEqual(filterSkillPrimitivesBySession([], 's', never, never), [])
})
