import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTurnFrame } from '../main/modules/agent-control/turn-frame-resolver'
import { buildTurnFrameSteering } from '../main/modules/agent-control/turn-frame-steering'
import type { TaskProjectionRecord } from '../main/modules/agent-control/run-contracts'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skill-task-supervisor'

function snapshot(overrides: Partial<SkillTaskSupervisorSnapshot> = {}): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: 'str-vea',
    detachedTaskId: 'dst-vea',
    skillId: 'video-expert-analyzer',
    scopeId: 'scope-vea',
    sessionId: 'scope-vea',
    action: 'video_expert_pipeline',
    status: 'blocked',
    hasLiveWork: false,
    hasRecentProgress: true,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: '/tmp/vea-output',
    runStatePath: '/tmp/vea-output/run_state.json',
    sceneScoresPath: '/tmp/vea-output/scene_scores.json',
    deliveryReportPath: '/tmp/vea-output/delivery_report.json',
    progress: { currentStage: 'score_batches', completedScenes: 0, totalScenes: 97 },
    blockers: [],
    pauseReason: null,
    resumePayload: null,
    sourceObservations: [],
    progressFingerprint: 'score_batches:0/97',
    observedAt: '2026-04-29T01:00:00.000Z',
    lastProgressAt: '2026-04-29T01:00:00.000Z',
    ...overrides,
  }
}

function projection(overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'detached:dst-vea',
    scopeId: 'scope-vea',
    runId: 'dst-vea',
    taskType: 'multi_step_task',
    module: 'skill',
    taskTitle: '技能执行 · Video Expert Analyzer',
    taskSummary: 'score_batches paused',
    status: 'blocked',
    interactionState: 'suspended',
    waitingFor: 'background',
    steps: [],
    currentStepId: 'video_expert_pipeline',
    budget: null,
    budgetUsagePercent: null,
    budgetWarningLevel: null,
    recoveryHistory: [],
    degradationReason: null,
    blockedReason: 'paused',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'dst-vea',
      detachedTaskId: 'dst-vea',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      outputDir: '/tmp/vea-output',
      runStatePath: '/tmp/vea-output/run_state.json',
    },
    recentArtifacts: [],
    createdAt: '2026-04-29T01:00:00.000Z',
    updatedAt: '2026-04-29T01:00:00.000Z',
    ...overrides,
  }
}

test('resolveTurnFrame turns recoverable supervisor VEA context into typed resume steering', () => {
  const frame = resolveTurnFrame({
    sessionId: 'scope-vea',
    requestId: 'req-vea',
    userIntent: 'continue',
    supervisorSnapshot: snapshot({ status: 'blocked', hasRecentProgress: true }),
  })

  assert.equal(frame.mode, 'skill_resume')
  assert.equal(frame.skill?.skillId, 'video-expert-analyzer')
  assert.equal(frame.steering.preferredToolNames[0], 'skill_video_expert_pipeline')
  assert.ok(frame.steering.preferredToolNames.includes('skill_inspect_run_state'))
  assert.ok(frame.steering.systemReminder?.includes('skill_video_expert_pipeline'))
  assert.ok(frame.steering.systemReminder?.includes('/tmp/vea-output'))
})

test('resolveTurnFrame uses projection-only VEA action for typed resume steering', () => {
  const frame = resolveTurnFrame({
    sessionId: 'scope-vea',
    requestId: 'req-projection',
    userIntent: 'continue',
    projections: [projection()],
  })

  assert.equal(frame.mode, 'skill_resume')
  assert.equal(frame.skill?.source, 'projection')
  assert.equal(frame.steering.preferredToolNames[0], 'skill_video_expert_pipeline')
})

test('Phase 6: retry-only VEA hint frame no longer parent-forces the default pipeline action', () => {
  // Phase 6 retired the `DEFAULT_RESUME_ACTION_BY_SKILL_ID` fallback for
  // VEA — the child runner now owns "what action runs next" for VEA, so
  // a retry-only hint frame (no supervisor snapshot, no explicit action)
  // must NOT synthesize `skill_video_expert_pipeline` as the resume target
  // and must NOT enter `force_tool` mode. Steering falls back to ask_model.
  const frame = resolveTurnFrame({
    sessionId: 'scope-vea',
    requestId: 'req-hint',
    userIntent: 'continue',
    referenceHint: { id: 'video-expert-analyzer', name: 'Video Expert Analyzer' },
  })
  const steering = buildTurnFrameSteering(frame)

  assert.equal(frame.mode, 'skill_resume')
  assert.equal(steering.mode, 'ask_model')
  assert.equal(steering.requiredToolName, null)
})

test('resolveTurnFrame keeps typed resume steering for recoverable paused VEA output', () => {
  const frame = resolveTurnFrame({
    sessionId: 'scope-vea',
    requestId: 'req-paused',
    userIntent: 'continue',
    supervisorSnapshot: snapshot({
      status: 'recoverable_paused' as any,
      hasLiveWork: false,
      hasRecentProgress: false,
    }),
  })

  assert.equal(frame.liveness, 'recoverable_paused')
  assert.equal(frame.steering.preferredToolNames[0], 'skill_video_expert_pipeline')
})

test('Phase 6: recoverable paused VEA frame no longer parent-forces; the child runner owns the resume', () => {
  // Phase 6 — VEA force retirement. Previously this test asserted
  // `mode === 'force_tool'` on a recoverable_paused VEA supervisor frame.
  // The plan explicitly retires that path: the child-loop runner now owns
  // VEA execution, the engine's force-tool dispatch path is fenced by
  // `shouldParentForceLongSkillTool(contract)` (returns false when
  // `contract.childRunId` is set), and `loadSkillRunContract` populates
  // `childRunId` once the child runner has launched a run.
  //
  // The steering layer still surfaces `skill_video_expert_pipeline` in
  // `preferredToolNames` so the model can voluntarily pick the typed
  // action — but the engine no longer synthesizes the `tool_use` itself.
  // We accept any non-`force_tool` mode here; today's resolver picks
  // `checkpoint` (the live-work signal is gone, so there's nothing to
  // "force" in any case).
  const frame = resolveTurnFrame({
    sessionId: 'scope-vea',
    requestId: 'req-force',
    userIntent: 'continue',
    supervisorSnapshot: snapshot({
      status: 'recoverable_paused' as any,
      hasLiveWork: false,
      hasRecentProgress: false,
    }),
  })

  assert.notEqual(
    frame.steering.mode,
    'force_tool',
    'Phase 6: VEA must not be parent-forced — child-loop runner owns the resume',
  )
  assert.ok(
    frame.steering.preferredToolNames.includes('skill_video_expert_pipeline'),
    'Phase 6: typed action stays in preferredToolNames as a model nudge, never a synthesized force',
  )
})

test('buildTurnFrameSteering: budget-exhausted running_process produces checkpoint mode', () => {
  // Stage 7 — budget exhausted with a still-live background worker means the
  // user-facing turn must close cleanly. Force/preferred fields are cleared.
  const frame = resolveTurnFrame({
    sessionId: 'scope-vea',
    requestId: 'req-bg',
    userIntent: 'continue',
    supervisorSnapshot: snapshot({
      status: 'background_running' as any,
      hasLiveWork: true,
      hasRecentProgress: true,
    }),
  })
  // Mark the budget as exhausted (the resolver does not own budget; the
  // turn engine sets this at lease evaluation time, so we patch it here
  // for the steering re-derivation contract under test).
  const exhaustedFrame = {
    ...frame,
    budget: { ...frame.budget, exhausted: true },
  }
  const steering = buildTurnFrameSteering(exhaustedFrame)
  assert.equal(steering.mode, 'checkpoint')
  assert.equal(steering.requiredToolName, null)
  assert.deepEqual(steering.preferredToolNames, [])
})

test('buildTurnFrameSteering: failed-liveness skill frame produces checkpoint mode', () => {
  // Stage 7 — a terminal failure cannot be force-resumed; the user has to
  // see the failure first.
  const frame = resolveTurnFrame({
    sessionId: 'scope-vea',
    requestId: 'req-failed',
    userIntent: 'continue',
    supervisorSnapshot: snapshot({
      status: 'failed' as any,
      hasLiveWork: false,
      hasRecentProgress: false,
    }),
  })
  const steering = buildTurnFrameSteering(frame)
  assert.equal(steering.mode, 'checkpoint')
})

test('buildTurnFrameSteering: recentForceToolDispatched falls back to ask_model', () => {
  // Stage 7 — once a force_tool has just dispatched, the very next iteration
  // must NOT force again, otherwise we infinite-loop on the same typed
  // action. The `extras.recentForceToolDispatched=true` signal downgrades
  // the steering mode to ask_model while keeping preferred-tool nudging.
  const frame = resolveTurnFrame({
    sessionId: 'scope-vea',
    requestId: 'req-recent',
    userIntent: 'continue',
    supervisorSnapshot: snapshot({
      status: 'recoverable_paused' as any,
      hasLiveWork: false,
      hasRecentProgress: false,
    }),
  })
  const steering = buildTurnFrameSteering(frame, { recentForceToolDispatched: true })
  assert.equal(steering.mode, 'ask_model')
  assert.ok(steering.preferredToolNames.includes('skill_video_expert_pipeline'))
})
