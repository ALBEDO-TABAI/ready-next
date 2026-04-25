/**
 * B plan Phase 4 — gating coverage shifted from the 6 execution-control
 * tools (retired along with the skill_executions state machine) to the 4
 * skill primitives. Primitives are only exposed to the LLM when the session
 * has a reference-skill hint armed by the orchestrator.
 *
 * Uses the pure `skill-tool-session-gate.ts` module so this suite runs under
 * `tsx --test` without dragging in the electron / runtime-manager chain.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterSkillPrimitivesBySession,
  shouldExposeSkillPrimitive,
} from '../main/modules/tools/skill-tool-session-gate'

const ALL_PRIMITIVE_TOOLS = [
  { name: 'skill_ask_user' },
  { name: 'skill_run_shell' },
  { name: 'skill_write_artifact' },
  { name: 'skill_read_artifact' },
]

const neverActive = () => false
const alwaysActive = () => true
const neverHint = () => false
const alwaysHint = () => true

test('without sessionId the full primitive list stays (legacy boot/static fallback path)', () => {
  const filtered = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    undefined,
    neverActive,
    neverHint,
  )
  assert.equal(filtered.length, 4)
  assert.deepEqual(
    filtered.map((def) => def.name).sort(),
    ALL_PRIMITIVE_TOOLS.map((def) => def.name).sort(),
  )
})

test('with sessionId but no execution and no reference hint, primitives are filtered out', () => {
  const filtered = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    'session-idle',
    neverActive,
    neverHint,
  )
  assert.deepEqual(filtered, [])
})

test('reference-skill hint alone is enough to expose the 4 primitives', () => {
  const filtered = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    'session-with-hint',
    neverActive,
    alwaysHint,
  )
  assert.equal(filtered.length, 4)
})

test('active execution alone is enough to expose the 4 primitives', () => {
  const filtered = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    'session-with-exec',
    alwaysActive,
    neverHint,
  )
  assert.equal(filtered.length, 4)
})

test('shouldExposeSkillPrimitive short-circuits on sessionId=undefined', () => {
  assert.equal(
    shouldExposeSkillPrimitive(undefined, neverActive, neverHint),
    true,
    'boot-path caller must see the full list',
  )
})

test('shouldExposeSkillPrimitive is pure — same inputs produce same output', () => {
  const a = shouldExposeSkillPrimitive('s', neverActive, neverHint)
  const b = shouldExposeSkillPrimitive('s', neverActive, neverHint)
  assert.equal(a, b)
})

test('concurrent sessions get independent gate outcomes (one with hint, one without)', () => {
  const hintsBySession = new Map<string, boolean>([
    ['session-A-hint', true],
    ['session-B-idle', false],
  ])
  const hintResolver = (sid: string) => hintsBySession.get(sid) === true

  const listA = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    'session-A-hint',
    neverActive,
    hintResolver,
  )
  const listB = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    'session-B-idle',
    neverActive,
    hintResolver,
  )

  assert.equal(listA.length, 4, 'session-A sees the full primitive list because a hint is armed')
  assert.deepEqual(listB, [], 'session-B without a hint sees nothing')
})

test('gate returns a fresh array each call; no cached reference', () => {
  const first = filterSkillPrimitivesBySession(ALL_PRIMITIVE_TOOLS, undefined, neverActive, neverHint)
  const second = filterSkillPrimitivesBySession(ALL_PRIMITIVE_TOOLS, undefined, neverActive, neverHint)
  assert.deepEqual(first.map((d) => d.name), second.map((d) => d.name))
  assert.notEqual(first, second)
  // Input array is untouched.
  assert.equal(ALL_PRIMITIVE_TOOLS.length, 4)
})
