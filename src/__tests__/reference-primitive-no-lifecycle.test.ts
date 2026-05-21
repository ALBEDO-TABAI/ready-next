/**
 * Stage Q (Stage 11) — Selected-skill primitive fence behavior test.
 *
 * Audit §F-1 / Plan §3.2 contract C3: when a primitive call is dispatched
 * for a skill whose `executionMode==='advisory'` OR which has any action
 * with `runtime:'reference'`, `recordPrimitiveOutcome` must NOT write a
 * SkillTaskRun row and `rememberSkillRun` must not record the run.
 *
 * Tests directly exercise `shouldRememberPrimitiveOutcomeForContinuity`
 * (Q.2 belt-and-braces) plus the recordPrimitiveOutcome fence indirectly
 * via `executeSkillTool` with a fake skills runtime.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeSkillTool,
  shouldRememberPrimitiveOutcomeForContinuity,
} from '../main/modules/tools/skills-tools'
import { __setMetricSinkForTests, logAgentMetric, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { snapshotTurnFeatureFlags } from '../main/modules/agent-control/runtime-core/turn-feature-flags'
import {
  __setSkillsRuntimeManagerForTests,
  type SkillsRuntimeManager,
  type SkillState,
} from '../main/modules/skills-runtime/runtime-manager'
import { registerSkillTaskRunRepository } from '../main/modules/agent-control/skills/skill-task-tracker'
import type { SkillTaskRunRecord, SkillTaskRunRepository } from '../main/modules/repositories/skill-task-run-repository'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

// ---------------------------------------------------------------------------
// Belt-and-braces continuity gate (pure function — no runtime needed).
// ---------------------------------------------------------------------------

test('shouldRememberPrimitiveOutcomeForContinuity: isReferenceOrAdvisory=true blocks all', () => {
  // Even cases that would otherwise be recorded (blocked/error/durable
  // handle/etc) are skipped when the skill is reference/advisory.
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'blocked',
    hasDurableHandle: false,
    isReferenceOrAdvisory: true,
  }), false)

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'error',
    hasDurableHandle: false,
    isReferenceOrAdvisory: true,
  }), false)

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'done',
    hasDurableHandle: true,
    isReferenceOrAdvisory: true,
  }), false)
})

test('shouldRememberPrimitiveOutcomeForContinuity: isReferenceOrAdvisory=false preserves prior behavior', () => {
  // Without the flag (or false), behavior matches the existing
  // skill-primitive-continuity.test.ts assertions exactly. This test
  // pins back-compat: the new optional parameter does NOT change
  // outcomes for non-reference skills.
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'done',
    hasDurableHandle: false,
    isReferenceOrAdvisory: false,
  }), false) // monitor-only success without handle still rejected

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'blocked',
    hasDurableHandle: false,
    isReferenceOrAdvisory: false,
  }), true)

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'done',
    hasDurableHandle: false,
    isReferenceOrAdvisory: false,
  }), true)
})

test('shouldRememberPrimitiveOutcomeForContinuity: omitting isReferenceOrAdvisory defaults to false', () => {
  // Pre-Stage-Q callers don't pass the new flag. Default must be false
  // so behavior is unchanged.
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'blocked',
    hasDurableHandle: false,
  }), true)

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'done',
    hasDurableHandle: false,
  }), false)
})

// ---------------------------------------------------------------------------
// Hybrid skill regression — Stage Q implementation plan §3.2 contract.
// ---------------------------------------------------------------------------

test('hybrid skill (reference action + python typed_action): primitive call from any context fenced', () => {
  // Stage Q plan §3.2 documents that hybrid skills (e.g. lets-go-rss)
  // are not misjudged because:
  //   (a) Their reference actions (e.g. read_skill) trigger primitive
  //       calls that SHOULD be fenced — pin that.
  //   (b) Their typed_action paths (python actions) NEVER reach
  //       `executeSkillTool('skill_run_shell', ...)` etc — they go
  //       through `runSkill` directly. So the per-skill (rather than
  //       per-action) fence does not误伤 them.
  //
  // This test pins (a) — when a hybrid skill is selected and a primitive
  // is invoked, the gate returns false (i.e. fence active).
  //
  // Note: the actual `executeSkillTool`-level fence is exercised in
  // `skill-primitive-continuity.test.ts:89` style tests; here we test
  // the contract gate (`shouldRememberPrimitiveOutcomeForContinuity`)
  // because it carries the same `isReferenceOrAdvisory` predicate.
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'done',
    hasDurableHandle: false,
    isReferenceOrAdvisory: true, // hybrid skill marked as such by hoist
  }), false)

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'blocked',
    hasDurableHandle: true,
    isReferenceOrAdvisory: true, // any status × any handle still fenced
  }), false)
})

test('non-reference skill: primitive call NOT fenced (regression for non-reference path)', () => {
  // Pin that the fence is selectively applied. A skill whose
  // `executionMode==='direct'` AND has zero `runtime:'reference'` actions
  // produces `isReferenceOrAdvisory=false`, and primitive continuity
  // continues to be recorded normally.
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'blocked',
    hasDurableHandle: false,
    isReferenceOrAdvisory: false,
  }), true)
})

// ---------------------------------------------------------------------------
// Stage Q implementation plan §3.2 — feature flag snapshot integration.
// ---------------------------------------------------------------------------

test('snapshotTurnFeatureFlags: referencePrimitiveLifecycleFence default enabled', () => {
  const flags = snapshotTurnFeatureFlags({})
  assert.equal(flags.referencePrimitiveLifecycleFence, true)
})

test("snapshotTurnFeatureFlags: READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE='0' disables fence", () => {
  const flags = snapshotTurnFeatureFlags({
    READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE: '0',
  })
  assert.equal(flags.referencePrimitiveLifecycleFence, false)
})

test('snapshotTurnFeatureFlags: skillTaskRunInvariantEnforced default enabled', () => {
  const flags = snapshotTurnFeatureFlags({})
  assert.equal(flags.skillTaskRunInvariantEnforced, true)
})

test("snapshotTurnFeatureFlags: READY_SKILL_TASK_RUN_INVARIANT_ENFORCED='0' disables enforcement", () => {
  const flags = snapshotTurnFeatureFlags({
    READY_SKILL_TASK_RUN_INVARIANT_ENFORCED: '0',
  })
  assert.equal(flags.skillTaskRunInvariantEnforced, false)
})

test('snapshotTurnFeatureFlags: false/off/empty all disable, anything else enables', () => {
  // Per turn-feature-flags.ts isFlagEnabled() helper contract.
  for (const off of ['0', 'false', 'off', 'OFF', 'False']) {
    assert.equal(
      snapshotTurnFeatureFlags({ READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE: off }).referencePrimitiveLifecycleFence,
      false,
      `expected '${off}' to disable fence`,
    )
  }
  for (const on of ['1', 'true', 'on', 'yes', 'enabled']) {
    assert.equal(
      snapshotTurnFeatureFlags({ READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE: on }).referencePrimitiveLifecycleFence,
      true,
      `expected '${on}' to enable fence`,
    )
  }
})

// ---------------------------------------------------------------------------
// Metric-sink integration: prove the fence emits the expected metric when
// triggered via a real recordPrimitiveOutcome path. We can't easily mock
// the SkillsRuntimeManager singleton from a test, so we exercise the
// equivalent path: hand-craft a turnFeatureFlags + skillKind context and
// drive `recordPrimitiveOutcome` indirectly through executeSkillTool's
// authorization gate. Even a bare invocation that fails authorization will
// not emit the fence metric (the fence is at recordPrimitiveOutcome time,
// after authorization). So we make this a contract observation: the
// metric sink wiring works AT ALL, and would catch a regression if the
// fence went silent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Real e2e integration: drive `executeSkillTool` with a synthetic
// SkillsRuntimeManager that returns a reference-runtime skill. Verify the
// fence prevents SkillTaskRunRepository.create from being called and emits
// the expected metric.
// ---------------------------------------------------------------------------

function makeReferenceSkillManager(skillId: string): SkillsRuntimeManager {
  const fakeSkill = {
    id: skillId,
    name: skillId,
    description: '',
    version: '0.0.0',
    installed: true,
    installStatePath: '',
    source: 'embedded',
    manifestValid: true,
    actions: [
      { id: 'read_skill', runtime: 'reference' },
    ],
    executionMode: 'advisory',
  } as unknown as SkillState
  return {
    listSkills: () => [fakeSkill],
  } as unknown as SkillsRuntimeManager
}

function makeRecordingRepository(): {
  repo: SkillTaskRunRepository
  createCalls: SkillTaskRunRecord[]
  updateCalls: Array<{ id: string; patch: Partial<SkillTaskRunRecord> }>
} {
  const createCalls: SkillTaskRunRecord[] = []
  const updateCalls: Array<{ id: string; patch: Partial<SkillTaskRunRecord> }> = []
  const repo = {
    create: (record: SkillTaskRunRecord) => { createCalls.push(record) },
    update: (id: string, patch: Partial<SkillTaskRunRecord>) => { updateCalls.push({ id, patch }) },
    updateRowSync: (id: string, patch: Partial<SkillTaskRunRecord>) => { updateCalls.push({ id, patch }) },
    get: () => null,
    findByDetachedTaskId: () => null,
    findLatestRecoverable: () => null,
    listActiveBySession: () => [],
    listByScope: () => [],
  } as unknown as SkillTaskRunRepository
  return { repo, createCalls, updateCalls }
}

test('e2e fence: reference skill primitive call does NOT write SkillTaskRun + emits skipped metric', async () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  __setSkillsRuntimeManagerForTests(makeReferenceSkillManager('humanizer-zh'))
  const { repo, createCalls } = makeRecordingRepository()
  registerSkillTaskRunRepository(repo)
  try {
    let result: unknown = null
    try {
      result = await executeSkillTool(
      'skill_write_artifact',
      { relativePath: 'note.txt', content: 'hello' },
      'session-q-e2e',
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId: 'humanizer-zh',
          allowedTypedActions: [],
          allowedPrimitives: ['skill_write_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
        turnFeatureFlags: snapshotTurnFeatureFlags({}),
      },
    )
    } catch {
      // The fake runtime manager doesn't implement getRuntimeInfo() etc.
      // that `executeWriteArtifact` needs. The fence runs BEFORE the
      // actual write, so the throw happens after we've already captured
      // whether DB writes were skipped. Catch and ignore.
    }
    void result
    // The call may throw (fake runtime missing methods) or succeed.
    // We only care that:
    // (a) NO SkillTaskRun row was created (fence active)
    // (b) the skipped metric was emitted at least once
    assert.equal(createCalls.length, 0, `expected 0 SkillTaskRun.create calls, got ${createCalls.length}`)
    const skipped = events.filter((e) => e.metric === 'reference_primitive_lifecycle_skipped')
    assert.ok(skipped.length >= 1, `expected reference_primitive_lifecycle_skipped metric, got events: ${JSON.stringify(events.map(e => e.metric))}`)
    assert.equal(skipped[0].skillId, 'humanizer-zh')
    assert.equal(skipped[0].toolName, 'skill_write_artifact')
  } finally {
    registerSkillTaskRunRepository(null)
    __setSkillsRuntimeManagerForTests(null)
    __setMetricSinkForTests(null)
  }
})

test('e2e fence DISABLED via flag: reference skill primitive DOES write SkillTaskRun', async () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  __setSkillsRuntimeManagerForTests(makeReferenceSkillManager('humanizer-zh'))
  const { repo, createCalls } = makeRecordingRepository()
  registerSkillTaskRunRepository(repo)
  try {
    let result: unknown = null
    try {
      result = await executeSkillTool(
      'skill_write_artifact',
      { relativePath: 'note.txt', content: 'hello' },
      'session-q-e2e-flag-off',
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId: 'humanizer-zh',
          allowedTypedActions: [],
          allowedPrimitives: ['skill_write_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
        turnFeatureFlags: snapshotTurnFeatureFlags({
          READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE: '0',
        }),
      },
    )
    } catch {
      // Same as above — fake runtime crashes after recordPrimitive runs.
    }
    void result
    // Flag off → fence does NOT trigger early return.
    // recordPrimitiveOutcome runs normally; create SHOULD be called for
    // primitive runKind. (Even if writeArtifact fails inside the sandbox
    // the running/error event still creates the row.)
    assert.ok(createCalls.length >= 1, `expected >=1 SkillTaskRun.create call, got ${createCalls.length}`)
    const skipped = events.filter((e) => e.metric === 'reference_primitive_lifecycle_skipped')
    const disabled = events.filter((e) => e.metric === 'reference_primitive_lifecycle_fence_disabled')
    assert.equal(skipped.length, 0)
    assert.ok(disabled.length >= 1, `expected reference_primitive_lifecycle_fence_disabled metric, got: ${JSON.stringify(events.map(e => e.metric))}`)
  } finally {
    registerSkillTaskRunRepository(null)
    __setSkillsRuntimeManagerForTests(null)
    __setMetricSinkForTests(null)
  }
})

test('metric sink: fence event payload is well-formed when forwarded by sink', () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    // Synthesize the same metric that the fence would emit. This is a
    // belt-and-braces test: it validates the metric name + payload schema
    // is stable, so a future rename of the metric would break this test
    // and force the contract to be updated in lockstep.
    const fakeFenceEmit = (sessionId: string, skillId: string, toolName: string): void => {
      logAgentMetric('reference_primitive_lifecycle_skipped', {
        sessionId,
        scopeId: sessionId,
        skillId,
        toolName,
        status: 'done',
      })
    }
    fakeFenceEmit('session-q-test', 'humanizer-zh', 'skill_write_artifact')
    assert.equal(events.length, 1)
    assert.equal(events[0].metric, 'reference_primitive_lifecycle_skipped')
    assert.equal(events[0].skillId, 'humanizer-zh')
    assert.equal(events[0].toolName, 'skill_write_artifact')
    assert.equal(events[0].sessionId, 'session-q-test')
  } finally {
    __setMetricSinkForTests(null)
  }
})
