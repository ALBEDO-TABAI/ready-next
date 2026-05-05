/**
 * Stage 4 W3 — SkillToolAuthorization unit tests for the W3a installation
 * step (type + admission seam + preflight skill_* skip).
 *
 * Verifies:
 *   - `checkSkillToolAuthorization` decision logic for each (mode, reason,
 *     isPrimitive) combination
 *   - The `'not_set'` default short-circuits to allow (back-compat with
 *     pre-cutover callers)
 *   - `mode:'selected'` filters typed actions and primitives by the
 *     allowed sets
 *   - `mode:'none'` with an explicit reason denies (post-cutover signal)
 *
 * Admission integration (tool-executor) and preflight integration
 * (tool-runtime) are tested separately via their existing test surfaces;
 * those need a full ToolContext / ToolRuntimeContext fixture which lives
 * in higher-level test files.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SKILL_TOOL_AUTHORIZATION_NOT_SET,
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  checkSkillToolAuthorization,
} from '../main/modules/agent-control/skill-tool-authorization'

// ---------------------------------------------------------------------------
// Default value
// ---------------------------------------------------------------------------

test('SKILL_TOOL_AUTHORIZATION_NOT_SET has mode:none reason:not_set', () => {
  assert.equal(SKILL_TOOL_AUTHORIZATION_NOT_SET.mode, 'none')
  if (SKILL_TOOL_AUTHORIZATION_NOT_SET.mode === 'none') {
    assert.equal(SKILL_TOOL_AUTHORIZATION_NOT_SET.reason, 'not_set')
  }
})

test('SKILL_TOOL_AUTHORIZATION_NOT_SET is frozen (immutable shared value)', () => {
  assert.equal(Object.isFrozen(SKILL_TOOL_AUTHORIZATION_NOT_SET), true)
})

// ---------------------------------------------------------------------------
// W3a back-compat short-circuit — `'not_set'` always allows
// ---------------------------------------------------------------------------

test('checkSkillToolAuthorization with not_set default → allows any skill_* tool (W3a back-compat)', () => {
  const decision = checkSkillToolAuthorization(
    'skill_video_expert_pipeline',
    SKILL_TOOL_AUTHORIZATION_NOT_SET,
    /* isPrimitive */ false,
  )
  assert.equal(decision.allowed, true)
})

test('checkSkillToolAuthorization with not_set default → allows primitive too', () => {
  const decision = checkSkillToolAuthorization(
    'skill_run_shell',
    SKILL_TOOL_AUTHORIZATION_NOT_SET,
    /* isPrimitive */ true,
  )
  assert.equal(decision.allowed, true)
})

// ---------------------------------------------------------------------------
// Explicit mode:'none' with non-not_set reason → denies (post-cutover)
// ---------------------------------------------------------------------------

test('checkSkillToolAuthorization with mode:none reason:no_skill_signal → denies', () => {
  const auth = buildExplicitNoSkillAuthorization('no_skill_signal')
  const decision = checkSkillToolAuthorization('skill_video_expert_pipeline', auth, false)
  assert.equal(decision.allowed, false)
  if (!decision.allowed) {
    assert.equal(decision.reason, 'no_skill_signal')
  }
})

test('checkSkillToolAuthorization with mode:none reason:turn_not_skill_resume → denies', () => {
  const auth = buildExplicitNoSkillAuthorization('turn_not_skill_resume')
  const decision = checkSkillToolAuthorization('skill_run_shell', auth, true)
  assert.equal(decision.allowed, false)
})

test('checkSkillToolAuthorization with mode:none reason:config_repair_no_recoverable_task → denies', () => {
  const auth = buildExplicitNoSkillAuthorization('config_repair_no_recoverable_task')
  const decision = checkSkillToolAuthorization('skill_video_expert_pipeline', auth, false)
  assert.equal(decision.allowed, false)
})

// ---------------------------------------------------------------------------
// mode:'selected' — filter by allowed sets
// ---------------------------------------------------------------------------

test('mode:selected — typed action in allowedTypedActions → allows', () => {
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze'],
    allowedPrimitives: [],
    source: 'explicit',
    reason: 'user_named_skill',
  })
  const decision = checkSkillToolAuthorization('skill_video_expert_pipeline', auth, false)
  assert.equal(decision.allowed, true)
})

test('mode:selected — typed action NOT in allowedTypedActions → denies with tool_not_in_allowed_typed_actions', () => {
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_ai_analyze'],
    allowedPrimitives: [],
    source: 'explicit',
    reason: 'user_named_skill',
  })
  const decision = checkSkillToolAuthorization('skill_video_expert_pipeline', auth, false)
  assert.equal(decision.allowed, false)
  if (!decision.allowed) {
    assert.equal(decision.reason, 'tool_not_in_allowed_typed_actions')
  }
})

test('mode:selected — primitive in allowedPrimitives → allows', () => {
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_run_shell', 'skill_read_artifact'],
    source: 'trusted_resume',
    reason: 'run_state_resource',
  })
  const decision = checkSkillToolAuthorization('skill_run_shell', auth, true)
  assert.equal(decision.allowed, true)
})

test('mode:selected — primitive NOT in allowedPrimitives → denies with tool_not_in_allowed_primitives', () => {
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact'],
    source: 'active_task',
    reason: 'background_task_running',
  })
  const decision = checkSkillToolAuthorization('skill_run_shell', auth, true)
  assert.equal(decision.allowed, false)
  if (!decision.allowed) {
    assert.equal(decision.reason, 'tool_not_in_allowed_primitives')
  }
})

test('mode:selected — typed action and primitive sets are independent', () => {
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline'],
    allowedPrimitives: [],
    source: 'explicit',
    reason: 'user_named_skill',
  })
  // Typed action allowed
  assert.equal(checkSkillToolAuthorization('skill_video_expert_pipeline', auth, false).allowed, true)
  // The same name treated as primitive would NOT be allowed (different set)
  assert.equal(checkSkillToolAuthorization('skill_video_expert_pipeline', auth, true).allowed, false)
})

// ---------------------------------------------------------------------------
// Factory invariants
// ---------------------------------------------------------------------------

test('buildSelectedSkillToolAuthorization — produces frozen object', () => {
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'foo',
    allowedTypedActions: ['skill_foo_run'],
    allowedPrimitives: ['skill_run_shell'],
    source: 'explicit',
    reason: 'test',
  })
  assert.equal(Object.isFrozen(auth), true)
})

test('buildExplicitNoSkillAuthorization — produces frozen object with given reason', () => {
  const auth = buildExplicitNoSkillAuthorization('no_skill_signal')
  assert.equal(Object.isFrozen(auth), true)
  assert.equal(auth.mode, 'none')
  if (auth.mode === 'none') {
    assert.equal(auth.reason, 'no_skill_signal')
  }
})

test('buildSelectedSkillToolAuthorization — sets are populated from iterable inputs', () => {
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'foo',
    allowedTypedActions: ['a', 'b', 'c'],
    allowedPrimitives: new Set(['x', 'y']),
    source: 'explicit',
    reason: 'test',
  })
  if (auth.mode === 'selected') {
    assert.equal(auth.allowedTypedActions.size, 3)
    assert.equal(auth.allowedTypedActions.has('a'), true)
    assert.equal(auth.allowedPrimitives.size, 2)
    assert.equal(auth.allowedPrimitives.has('x'), true)
  }
})
