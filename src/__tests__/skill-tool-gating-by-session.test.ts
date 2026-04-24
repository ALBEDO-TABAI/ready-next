/**
 * B plan Phase 0 — P0-T1: verifies that execution-control tools (submit /
 * restart / cancel) only appear on the LLM-facing tool list when the session
 * has an active execution. `skill_get_state` stays visible at all times.
 *
 * Uses the pure `skill-tool-session-gate.ts` module so this suite runs under
 * `tsx --test` without dragging in the electron / runtime-manager chain.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SESSION_GATED_EXECUTION_CONTROL_TOOL_NAMES,
  filterExecutionControlToolsBySession,
  shouldExposeExecutionControlTool,
} from '../main/modules/tools/skill-tool-session-gate'

const ALL_CONTROL_TOOLS = [
  { name: 'skill_get_state' },
  { name: 'skill_submit_input' },
  { name: 'skill_submit_confirmation' },
  { name: 'skill_submit_agent_result' },
  { name: 'skill_restart_from_step' },
  { name: 'skill_cancel_execution' },
]

function neverActive(): boolean {
  return false
}

function alwaysActive(): boolean {
  return true
}

test('gated set covers exactly the 5 submit/restart/cancel names (not skill_get_state)', () => {
  const sorted = Array.from(SESSION_GATED_EXECUTION_CONTROL_TOOL_NAMES).sort()
  assert.deepEqual(sorted, [
    'skill_cancel_execution',
    'skill_restart_from_step',
    'skill_submit_agent_result',
    'skill_submit_confirmation',
    'skill_submit_input',
  ])
  assert.equal(SESSION_GATED_EXECUTION_CONTROL_TOOL_NAMES.has('skill_get_state'), false)
})

test('without sessionId the full control list stays (legacy boot/static fallback path)', () => {
  const filtered = filterExecutionControlToolsBySession(ALL_CONTROL_TOOLS, undefined, neverActive)
  assert.equal(filtered.length, 6)
  assert.deepEqual(
    filtered.map((def) => def.name).sort(),
    ALL_CONTROL_TOOLS.map((def) => def.name).sort(),
  )
})

test('with sessionId and NO active execution the 5 submit/restart/cancel are filtered, skill_get_state stays', () => {
  const filtered = filterExecutionControlToolsBySession(ALL_CONTROL_TOOLS, 'session-A', neverActive)
  assert.deepEqual(filtered.map((def) => def.name), ['skill_get_state'])
})

test('with sessionId and an active execution the full control list is visible again', () => {
  const filtered = filterExecutionControlToolsBySession(ALL_CONTROL_TOOLS, 'session-B', alwaysActive)
  assert.equal(filtered.length, 6)
  assert.deepEqual(
    filtered.map((def) => def.name).sort(),
    ALL_CONTROL_TOOLS.map((def) => def.name).sort(),
  )
})

test('non-skill tools in a mixed array are never touched by the gate', () => {
  const mixed = [
    { name: 'document_open_tab' },
    { name: 'skill_submit_input' },
    { name: 'browser_click' },
    { name: 'skill_get_state' },
  ]
  const filtered = filterExecutionControlToolsBySession(mixed, 'session-C', neverActive)
  const names = filtered.map((def) => def.name)
  assert.ok(names.includes('document_open_tab'))
  assert.ok(names.includes('browser_click'))
  assert.ok(names.includes('skill_get_state'))
  assert.ok(!names.includes('skill_submit_input'))
})

test('shouldExposeExecutionControlTool returns the resolver value per-call for gated names', () => {
  const calls: string[] = []
  const resolver = (sid: string) => {
    calls.push(sid)
    return sid === 'session-with-exec'
  }
  assert.equal(
    shouldExposeExecutionControlTool('skill_submit_input', 'session-with-exec', resolver),
    true,
  )
  assert.equal(
    shouldExposeExecutionControlTool('skill_submit_input', 'session-idle', resolver),
    false,
  )
  // skill_get_state short-circuits the resolver
  calls.length = 0
  assert.equal(
    shouldExposeExecutionControlTool('skill_get_state', 'session-idle', resolver),
    true,
  )
  assert.equal(calls.length, 0, 'resolver must not be called for non-gated names')
})

// Patch A4 — two sessions, one with an execution and one without, must
// produce different tool lists when both are consulted back-to-back. Each
// session-scoped call is independent so a filter change for session-A cannot
// leak into session-B.
test('concurrent sessions get independent gate outcomes (A active, B idle)', () => {
  const executionsBySession = new Map<string, boolean>([
    ['session-A-active', true],
    ['session-B-idle', false],
  ])
  const resolver = (sid: string) => executionsBySession.get(sid) === true

  const listA = filterExecutionControlToolsBySession(
    ALL_CONTROL_TOOLS,
    'session-A-active',
    resolver,
  )
  const listB = filterExecutionControlToolsBySession(
    ALL_CONTROL_TOOLS,
    'session-B-idle',
    resolver,
  )

  assert.deepEqual(
    listA.map((d) => d.name).sort(),
    ALL_CONTROL_TOOLS.map((d) => d.name).sort(),
    'session-A sees the full list because it has an execution',
  )
  assert.deepEqual(
    listB.map((d) => d.name),
    ['skill_get_state'],
    'session-B only sees the read-only tool',
  )
})

test('gate is pure — calling it twice for the same inputs returns equivalent arrays (no mutation)', () => {
  const resolver = (sid: string) => sid === 'session-active'
  const first = filterExecutionControlToolsBySession(ALL_CONTROL_TOOLS, 'session-idle', resolver)
  const second = filterExecutionControlToolsBySession(ALL_CONTROL_TOOLS, 'session-idle', resolver)
  assert.deepEqual(first.map((d) => d.name), second.map((d) => d.name))
  assert.notEqual(first, second, 'must return a fresh array each call; no cached reference')
  // Input array is untouched.
  assert.equal(ALL_CONTROL_TOOLS.length, 6)
})
