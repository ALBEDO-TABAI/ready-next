/**
 * B plan Phase 4 — gating coverage shifted from the 6 execution-control
 * tools (retired along with the skill_executions state machine) to current
 * skill primitives. Primitives are only exposed to the LLM when the session
 * has a reference-skill hint armed by the orchestrator.
 *
 * Uses the pure `skill-tool-session-gate.ts` module so this suite runs under
 * `tsx --test` without dragging in the electron / runtime-manager chain.
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  filterSkillPrimitivesBySession,
  shouldExposeSkillPrimitive,
} from '../main/modules/tools/skill-tool-session-gate'
import { shouldExposeSkillAction } from '../main/modules/tools/skills-tools'
import { ToolRegistry } from '../main/modules/agent-control/tool-registry'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skill-tool-authorization'
import {
  clearActiveSkillContext,
  rememberActiveSkillContext,
} from '../main/modules/agent-control/active-skill-context'

const STANDARD_PRIMITIVES = [
  'skill_ask_user',
  'skill_run_shell',
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_patch_config',
  'skill_start_detached',
  'skill_inspect_detached',
  'skill_cancel_detached',
  'skill_inspect_run_state',
]

const ALL_PRIMITIVE_TOOLS = [
  { name: 'skill_ask_user' },
  { name: 'skill_run_shell' },
  { name: 'skill_write_artifact' },
  { name: 'skill_read_artifact' },
  { name: 'skill_patch_config' },
  { name: 'skill_start_detached' },
  { name: 'skill_inspect_detached' },
  { name: 'skill_cancel_detached' },
]

const neverActive = () => false
const alwaysActive = () => true
const neverHint = () => false
const alwaysHint = () => true

afterEach(() => {
  clearActiveSkillContext()
})

test('without sessionId the full primitive list stays (legacy boot/static fallback path)', () => {
  const filtered = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    undefined,
    neverActive,
    neverHint,
  )
  assert.equal(filtered.length, ALL_PRIMITIVE_TOOLS.length)
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

test('ordinary chat session does not expose primitives after a completed skill projection', () => {
  const filtered = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    'session-after-skill-done',
    neverActive,
    neverHint,
    () => false,
  )
  assert.deepEqual(filtered, [])
})

test('reference-skill hint alone is enough to expose primitives', () => {
  const filtered = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    'session-with-hint',
    neverActive,
    alwaysHint,
  )
  assert.equal(filtered.length, ALL_PRIMITIVE_TOOLS.length)
})

test('active execution alone is enough to expose primitives', () => {
  const filtered = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    'session-with-exec',
    alwaysActive,
    neverHint,
  )
  assert.equal(filtered.length, ALL_PRIMITIVE_TOOLS.length)
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

  assert.equal(listA.length, ALL_PRIMITIVE_TOOLS.length, 'session-A sees the full primitive list because a hint is armed')
  assert.deepEqual(listB, [], 'session-B without a hint sees nothing')
})

test('active skill task projection alone is enough to expose primitives', () => {
  const filtered = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    'session-with-active-skill-task',
    neverActive,
    neverHint,
    () => true,
  )

  assert.equal(filtered.length, ALL_PRIMITIVE_TOOLS.length)
})

test('active childRunId keeps primitives visible when session has a running child', () => {
  const filtered = filterSkillPrimitivesBySession(
    ALL_PRIMITIVE_TOOLS,
    'session-with-running-child',
    neverActive,
    neverHint,
    () => false,
    () => true,
  )

  assert.equal(filtered.length, ALL_PRIMITIVE_TOOLS.length)
})

test('active skill context can expose internal typed actions without a reference hint', () => {
  assert.equal(shouldExposeSkillAction({
    actionVisibility: 'internal',
    actionName: 'video_expert_pipeline',
    skillId: 'video-expert-analyzer',
    referenceHintSkillId: null,
    activeSkillId: 'video-expert-analyzer',
    exposeWhenHintArmed: ['video_expert_pipeline'],
  }), true)
})

test('registry exposes primitives and VEA typed actions from active context alone', () => {
  rememberActiveSkillContext('session-with-vea-context', {
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    taskRunId: 'tr-vea',
    detachedTaskId: 'dst-vea',
    runStatePath: '/tmp/vea/run_state.json',
    outputDir: '/tmp/vea',
    sceneScoresPath: null,
    deliveryReportPath: null,
    action: 'video_expert_pipeline',
    source: 'projection',
    confidence: 84,
    status: 'blocked',
    staleBlockerReason: '旧 blocker',
    observedAt: new Date().toISOString(),
  })

  const names = new ToolRegistry()
    .getToolDefinitionsForGroup('skills', 'session-with-vea-context', buildSelectedSkillToolAuthorization({
      skillId: 'video-expert-analyzer',
      allowedTypedActions: ['skill_video_expert_pipeline'],
      allowedPrimitives: STANDARD_PRIMITIVES,
      source: 'explicit',
      reason: 'test_setup',
    }))
    .map((tool) => tool.name)

  assert.ok(names.includes('skill_run_shell'))
  assert.ok(names.includes('skill_patch_config'))
  assert.ok(names.includes('skill_video_expert_pipeline'))
})

test('gate returns a fresh array each call; no cached reference', () => {
  const first = filterSkillPrimitivesBySession(ALL_PRIMITIVE_TOOLS, undefined, neverActive, neverHint)
  const second = filterSkillPrimitivesBySession(ALL_PRIMITIVE_TOOLS, undefined, neverActive, neverHint)
  assert.deepEqual(first.map((d) => d.name), second.map((d) => d.name))
  assert.notEqual(first, second)
  // Input array is untouched.
  assert.equal(ALL_PRIMITIVE_TOOLS.length, 8)
})
