import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveTurnFrame } from '../main/modules/agent-control/runtime-core/turn-frame-resolver'
import { buildTurnFrameSteering } from '../main/modules/agent-control/runtime-core/turn-frame-steering'
import { createSystemReminderRegistry, type ReminderTopic } from '../main/modules/agent-control/system-reminders/system-reminder-registry'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skills/skill-task-supervisor'

function composeReminder(topic: ReminderTopic, priority: number, text: string): string | null {
  const registry = createSystemReminderRegistry()
  registry.register({ topic, priority, text })
  return registry.compose()
}

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
  const expectedReminder = '系统补充：本轮预算已用尽且后台仍在运行，进入 checkpoint 让用户决定是否继续；不要再发起工具调用。'
  assert.equal(
    steering.systemReminder,
    composeReminder('checkpoint', 100, expectedReminder),
  )
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
  const expectedReminder = '系统补充：技能任务已失败，本轮进入 checkpoint，等待用户后续指令；不要继续工具循环。'
  assert.equal(
    steering.systemReminder,
    composeReminder('checkpoint', 100, expectedReminder),
  )
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

// ------------------------------------------------------------------
// T5 (B child-loop, wave 3) — child-aware steering.
//
// When `frame.skill?.runContract?.childRunId` is set AND no terminal
// close event is attached, the child runner owns the long-skill
// execution. Parent steering MUST NOT surface the typed VEA action,
// MUST NOT enter `force_tool` mode, and MUST emit a child-aware
// reminder text so the model never re-derives a typed call from the
// contract handles.
// ------------------------------------------------------------------

import { resolveTurnFrame as _resolveTurnFrame } from '../main/modules/agent-control/runtime-core/turn-frame-resolver'
import {
  isChildOwnedFrame as _isChildOwnedFrame,
  hasTerminalChildCloseEvent as _hasTerminalChildCloseEvent,
} from '../main/modules/agent-control/runtime-core/turn-frame-steering'

test('T5: child-owned frame (childRunId set, no close) steers ask_model with primitives only and child-aware reminder', () => {
  // Build a recoverable_paused frame the same way the legacy force-tool
  // tests do, then inject a runContract with childRunId. The legacy path
  // would have returned a typed-action steering; the child-owned branch
  // must instead return ask_model with no required tool.
  const frame = _resolveTurnFrame({
    sessionId: 'scope-vea-child',
    requestId: 'req-child-1',
    userIntent: 'continue',
    supervisorSnapshot: snapshot({
      status: 'recoverable_paused' as any,
      hasLiveWork: false,
      hasRecentProgress: false,
    }),
  })
  // Pin a runContract with a live childRunId. Production gets this from
  // `loadSkillRunContract` after the child runner has been launched; the
  // test injects it directly so we don't need a repository fixture.
  if (frame.skill) {
    (frame.skill as any).runContract = {
      childRunId: 'vt5child0',
      childStatus: 'running',
      parentNextHint: 'wait_for_close_event',
      childCloseEvent: null,
    }
  }
  assert.equal(_isChildOwnedFrame(frame), true)
  const steering = buildTurnFrameSteering(frame)
  assert.equal(steering.mode, 'ask_model')
  assert.equal(steering.requiredToolName, null)
  // Typed VEA actions are absent from preferredToolNames — only primitives.
  assert.ok(!steering.preferredToolNames.includes('skill_video_expert_pipeline'))
  assert.ok(!steering.preferredToolNames.includes('skill_video_expert_ai_analyze'))
  assert.ok(steering.preferredToolNames.includes('skill_inspect_run_state'))
  // Reminder text is child-aware so the model knows why the typed
  // action is absent.
  assert.ok(steering.systemReminder, 'child-owned frames must emit a system reminder')
  assert.ok(
    steering.systemReminder.includes('child-loop runner') || steering.systemReminder.includes('child run'),
    'reminder must mention child-loop ownership',
  )
  assert.ok(
    steering.systemReminder.includes('vt5child0'),
    'reminder must include the live childRunId so the model can correlate',
  )
  const expectedReminder = [
    '系统补充：本轮 skill 已由 child-loop runner 接管（childRunId=vt5child0, status=running）。父循环只处理 status / resume / cancel，并等待 child close event。',
    '如需观察状态，只使用 skill_inspect_run_state / skill_read_artifact；需要用户选择时再用 skill_ask_user。不要重新发起该 skill 的动作工具。',
  ].join('\n')
  assert.equal(
    steering.systemReminder,
    composeReminder('child-owned', 85, expectedReminder),
  )
  assert.ok(!/typed skill action/i.test(steering.systemReminder))
  assert.ok(/status/.test(steering.systemReminder))
  assert.ok(/resume/.test(steering.systemReminder))
  assert.ok(/cancel/.test(steering.systemReminder))
})

test('T5: child-owned frame with pending handoff exposes write_artifact but not typed actions', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-turn-frame-handoff-'))
  try {
    mkdirSync(join(root, 'audiovisual_handoff', 'body'), { recursive: true })
    writeFileSync(join(root, 'audiovisual_handoff', 'receipt.json'), JSON.stringify({
      tasks: {
        body: {
          status: 'pending',
          task: 'audiovisual_handoff/body/task.md',
          output: 'body/output.md',
        },
      },
    }), 'utf8')
    const frame = _resolveTurnFrame({
      sessionId: 'scope-vea-child',
      requestId: 'req-child-handoff',
      userIntent: 'continue',
      supervisorSnapshot: snapshot({
        status: 'blocked',
        hasLiveWork: false,
        hasRecentProgress: false,
        outputDir: root,
        runStatePath: join(root, 'run_state.json'),
      }),
    })
    if (frame.skill) {
      (frame.skill as any).runContract = {
        childRunId: 'vt5handoff',
        childStatus: 'blocked',
        parentNextHint: 'wait_for_close_event',
        childCloseEvent: null,
      }
    }
    frame.activeArtifactRoots = [root]

    const steering = buildTurnFrameSteering(frame)

    assert.equal(steering.mode, 'ask_model')
    assert.ok(!steering.preferredToolNames.includes('skill_video_expert_pipeline'))
    assert.ok(!steering.preferredToolNames.includes('skill_video_expert_ai_analyze'))
    assert.ok(steering.preferredToolNames.includes('skill_read_artifact'))
    assert.ok(steering.preferredToolNames.includes('skill_write_artifact'))
    assert.ok(steering.systemReminder?.includes('skill_write_artifact'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T5: child-owned frame with terminal close (status=completed) releases parent steering', () => {
  const frame = _resolveTurnFrame({
    sessionId: 'scope-vea-child',
    requestId: 'req-child-2',
    userIntent: 'continue',
    supervisorSnapshot: snapshot({
      status: 'recoverable_paused' as any,
      hasLiveWork: false,
      hasRecentProgress: false,
    }),
  })
  if (frame.skill) {
    (frame.skill as any).runContract = {
      childRunId: 'vt5done00',
      childStatus: 'completed',
      parentNextHint: 'continue_other_work',
      childCloseEvent: {
        childRunId: 'vt5done00',
        skillId: 'video-expert-analyzer',
        status: 'completed',
        terminalReason: 'completed',
        outputDir: '/tmp/vea-output',
        runStatePath: '/tmp/vea-output/run_state.json',
        progress: null,
        sceneScoresPath: null,
        deliveryReportPath: null,
        finishedAt: '2026-04-30T00:00:00.000Z',
        error: null,
      },
    }
  }
  // hasTerminalChildCloseEvent: completed/failed/killed are terminal.
  assert.equal(
    _hasTerminalChildCloseEvent((frame.skill as any).runContract),
    true,
  )
  // Once the close is terminal the frame is no longer "child-owned" for
  // steering purposes — parent may resume typed-action steering for any
  // follow-on user turn.
  assert.equal(_isChildOwnedFrame(frame), false)
})

test('T5: non-terminal close (status=recoverable_paused) keeps the frame child-owned', () => {
  const frame = _resolveTurnFrame({
    sessionId: 'scope-vea-child',
    requestId: 'req-child-3',
    userIntent: 'continue',
    supervisorSnapshot: snapshot({
      status: 'recoverable_paused' as any,
      hasLiveWork: false,
      hasRecentProgress: false,
    }),
  })
  if (frame.skill) {
    (frame.skill as any).runContract = {
      childRunId: 'vt5pause0',
      childStatus: 'recoverable_paused',
      parentNextHint: 'wait_for_close_event',
      childCloseEvent: {
        childRunId: 'vt5pause0',
        skillId: 'video-expert-analyzer',
        status: 'recoverable_paused',
        terminalReason: 'checkpoint_background',
        outputDir: '/tmp/vea-output',
        runStatePath: '/tmp/vea-output/run_state.json',
        progress: null,
        sceneScoresPath: null,
        deliveryReportPath: null,
        finishedAt: '2026-04-30T00:00:00.000Z',
        error: null,
      },
    }
  }
  assert.equal(
    _hasTerminalChildCloseEvent((frame.skill as any).runContract),
    false,
    'recoverable_paused is non-terminal — the child may still resume',
  )
  assert.equal(_isChildOwnedFrame(frame), true)
})
