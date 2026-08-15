/**
 * SkillToolAuthorization unit tests.
 *
 * Verifies:
 *   - `checkSkillToolAuthorization` decision logic for each (mode, reason,
 *     isPrimitive) combination
 *   - `mode:'selected'` filters typed actions and primitives by the
 *     allowed sets
 *   - `mode:'none'` with an explicit reason denies
 *
 * Admission integration (tool-executor) and preflight integration
 * (tool-runtime) are tested separately via their existing test surfaces;
 * those need a full ToolContext / ToolRuntimeContext fixture which lives
 * in higher-level test files.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  checkSkillToolAuthorization,
  filterToolsByAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'

// ---------------------------------------------------------------------------
// Explicit mode:'none' → denies
// ---------------------------------------------------------------------------

test('mode:none candidate primitives allow only the named skill methods', () => {
  const auth = buildExplicitNoSkillAuthorization('no_skill_signal', {
    candidateSkillPrimitives: {
      skillId: 'lark-cli',
      primitives: ['skill_run_shell', 'skill_read_artifact', 'skill_ask_user'],
    },
  })
  assert.equal(checkSkillToolAuthorization('skill_run_shell', auth, true).allowed, true)
  assert.equal(checkSkillToolAuthorization('skill_read_artifact', auth, true).allowed, true)
  assert.equal(checkSkillToolAuthorization('skill_write_artifact', auth, true).allowed, false)
  assert.equal(checkSkillToolAuthorization('skill_video_expert_pipeline', auth, false).allowed, false)
  const kept = filterToolsByAuthorization(
    [
      { name: 'calendar_list_window' },
      { name: 'ask_user_questions' },
      { name: 'skill_run_shell' },
      { name: 'skill_write_artifact' },
    ],
    auth,
    (tool) => tool.name,
  ).map((tool) => tool.name)
  assert.deepEqual(kept, ['calendar_list_window', 'ask_user_questions', 'skill_run_shell'])
})

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

test('buildSelectedSkillToolAuthorization — allow-sets are immutable (cannot expand authorization via mutation)', () => {
  // Stage 10 final-review tightening: the type already declares
  // `ReadonlySet<string>`, but `Object.freeze` on the authorization does
  // NOT prevent mutation of an underlying Set. A contributor could
  // `as unknown as Set<string>` past the type and silently expand the
  // allow-set at runtime. The factory wraps the Sets in `freezeSet` which
  // returns a closure-backed facade — not a Set instance — so neither
  // direct mutator calls NOR `Set.prototype.<mutator>.call(facade, ...)`
  // can mutate the authorization.
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline'],
    allowedPrimitives: ['skill_run_shell'],
    source: 'explicit',
    reason: 'test_setup',
  })
  if (auth.mode !== 'selected') {
    assert.fail('expected selected')
  }

  // (a) Direct mutator method call — facade has no `.add` property at all,
  // so `(auth.allowedTypedActions as Set).add` is undefined; calling it
  // throws TypeError "is not a function".
  assert.throws(
    () => (auth.allowedTypedActions as unknown as Set<string>).add('skill_evil'),
    'direct .add() call must throw on the facade',
  )
  assert.throws(
    () => (auth.allowedPrimitives as unknown as Set<string>).delete('skill_run_shell'),
    'direct .delete() call must throw on the facade',
  )
  assert.throws(
    () => (auth.allowedPrimitives as unknown as Set<string>).clear(),
    'direct .clear() call must throw on the facade',
  )

  // (b) Prototype-method bypass — Set.prototype.add.call(facade, ...) must
  // also throw because the facade lacks Set internal slots. This is the
  // attack Codex round 2 found uncovered in the original freezeSet impl.
  assert.throws(
    () => Set.prototype.add.call(
      auth.allowedTypedActions as unknown as Set<string>,
      'skill_evil',
    ),
    /Method.*Set.*called on (incompatible|non-object|.* with no \[\[SetData\]\])/i,
    'Set.prototype.add.call(facade, ...) must throw — facade is not a Set instance',
  )
  assert.throws(
    () => Set.prototype.delete.call(
      auth.allowedPrimitives as unknown as Set<string>,
      'skill_run_shell',
    ),
    /Method.*Set.*called on/i,
    'Set.prototype.delete.call(facade, ...) must throw',
  )
  assert.throws(
    () => Set.prototype.clear.call(
      auth.allowedPrimitives as unknown as Set<string>,
    ),
    /Method.*Set.*called on/i,
    'Set.prototype.clear.call(facade, ...) must throw',
  )

  // (c) The allow-set must NOT be a Set instance (so `instanceof Set` is
  // false and Set-specific methods aren't reachable through the prototype
  // chain). This is the structural invariant that backs (a) and (b).
  assert.equal(
    auth.allowedTypedActions instanceof Set,
    false,
    'allow-set must be a closure-backed facade, not a Set instance',
  )

  // (d) Read methods still work — has/values/iteration must function so
  // policy decisions can read membership.
  assert.equal(auth.allowedTypedActions.has('skill_video_expert_pipeline'), true)
  assert.equal(auth.allowedTypedActions.has('skill_unknown'), false)
  assert.equal(auth.allowedTypedActions.size, 1)
  assert.deepEqual(Array.from(auth.allowedTypedActions), ['skill_video_expert_pipeline'])
})
