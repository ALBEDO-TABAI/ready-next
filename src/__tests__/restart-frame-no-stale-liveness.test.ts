/**
 * Stage Q (Stage 11) — frame liveness must NOT inherit stale supervisor
 * state when userIntent='start'.
 *
 * Audit §C-9 / §E / plan §3.6 contract C9. The bug case:
 *   - user types "重新开始"
 *   - identity correctly resolves to mode='skill' / relation='new'
 *   - turn engine still loaded the OLD supervisor snapshot
 *     (status='blocked' / status='budget_paused' / etc)
 *   - frame got `mode='skill_start' + liveness='blocked'`
 *   - steering immediately checkpointed the new turn into the old
 *     run's blocked state
 *
 * The fix: `inferLiveness` early-returns 'unknown' on userIntent='start'.
 *
 * This test directly drives the resolver rather than the full turn-
 * engine: spinning up the engine requires extensive fixturing (host,
 * orchestrator, repositories). The resolver path is the gating point
 * the audit identified.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTurnFrame } from '../main/modules/agent-control/turn-frame-resolver'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skills/skill-task-supervisor'

function makeStaleSupervisorSnapshot(): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: 'str-stale-shell',
    detachedTaskId: null,
    skillId: 'humanizer-zh',
    scopeId: 'scope-q',
    sessionId: 'scope-q',
    action: 'skill_write_artifact',
    status: 'blocked',
    liveness: null,
    hasLiveWork: false,
    hasRecentProgress: false,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: null,
    runStatePath: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {},
    blockers: [],
    pauseReason: null,
    resumePayload: { taskRunId: 'str-stale-shell', skillId: 'humanizer-zh', action: 'skill_write_artifact' },
    sourceObservations: [],
    progressFingerprint: null,
    observedAt: '2026-05-08T00:00:00.000Z',
    lastProgressAt: null,
  }
}

test('Stage Q: userIntent=start with stale blocked supervisor → frame.liveness !== blocked', () => {
  // Pre-PR-6: this same fixture would yield frame.liveness='blocked'
  // because inferLiveness honored the supervisor snapshot regardless
  // of the user's intent. After PR-6 the resolver early-returns
  // 'unknown' on userIntent='start'.
  const snapshot = makeStaleSupervisorSnapshot()
  const frame = resolveTurnFrame({
    sessionId: 'scope-q',
    requestId: 'req-1',
    userIntent: 'start', // user typed "重新开始"
    explicitSkillId: null,
    explicitSkillName: null,
    activeContext: null,
    supervisorSnapshot: snapshot,
    referenceHint: null,
  })
  // The frame may still construct a skill block from the supervisor
  // (chooseContext will still return a context), BUT the liveness
  // must NOT be 'blocked' / 'recoverable_paused' / 'running_process'.
  // Stage Q contract: userIntent='start' suppresses stale liveness.
  assert.notEqual(frame.liveness, 'blocked', `expected liveness !== blocked, got ${frame.liveness}`)
  assert.notEqual(frame.liveness, 'recoverable_paused', `expected liveness !== recoverable_paused, got ${frame.liveness}`)
  assert.notEqual(frame.liveness, 'running_process', `expected liveness !== running_process, got ${frame.liveness}`)
})

test('Stage Q: userIntent=continue with stale blocked supervisor → frame.liveness=blocked (legacy path preserved)', () => {
  // Regression: pre-PR-6 behavior is preserved for the resume path.
  // userIntent='continue' (or any non-'start') still pulls the
  // supervisor's blocked status into the frame.
  const snapshot = makeStaleSupervisorSnapshot()
  const frame = resolveTurnFrame({
    sessionId: 'scope-q',
    requestId: 'req-2',
    userIntent: 'continue',
    explicitSkillId: null,
    explicitSkillName: null,
    activeContext: null,
    supervisorSnapshot: snapshot,
    referenceHint: null,
  })
  assert.equal(frame.liveness, 'blocked')
})

test('Stage Q: userIntent=start with no supervisor → frame.liveness is unknown', () => {
  const frame = resolveTurnFrame({
    sessionId: 'scope-q',
    requestId: 'req-3',
    userIntent: 'start',
    explicitSkillId: null,
    explicitSkillName: null,
    activeContext: null,
    supervisorSnapshot: null,
    referenceHint: null,
  })
  // Without any context, frame.skill is null and liveness is 'unknown'
  // (this assertion pins both pre-Q and post-Q behavior).
  assert.equal(frame.liveness, 'unknown')
  assert.equal(frame.skill, null)
})
