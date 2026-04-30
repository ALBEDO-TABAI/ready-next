import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTurnFrame } from '../main/modules/agent-control/turn-frame-resolver'
import type { TaskProjectionRecord } from '../main/modules/agent-control/run-contracts'
import type { SkillTaskRunRecord } from '../main/modules/repositories/skill-task-run-repository'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skill-task-supervisor'

function projection(skillId: string, overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: `skill:scope-test:${skillId}`,
    scopeId: 'scope-test',
    runId: 'run-projection',
    taskType: 'short_task',
    module: 'skill',
    taskTitle: '技能任务',
    taskSummary: '技能任务暂停',
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
      taskId: 'task-projection',
      skillId,
      action: 'video_expert_pipeline',
      outputDir: `/tmp/${skillId}`,
      runStatePath: `/tmp/${skillId}/run_state.json`,
    },
    recentArtifacts: [],
    createdAt: '2026-04-29T01:00:00.000Z',
    updatedAt: '2026-04-29T01:00:00.000Z',
    ...overrides,
  }
}

function snapshot(skillId: string, overrides: Partial<SkillTaskSupervisorSnapshot> = {}): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: 'str-supervisor',
    detachedTaskId: 'dst-supervisor',
    skillId,
    scopeId: 'scope-test',
    sessionId: 'scope-test',
    action: 'video_expert_pipeline',
    status: 'blocked',
    liveness: null,
    hasLiveWork: false,
    hasRecentProgress: true,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: `/tmp/${skillId}`,
    runStatePath: `/tmp/${skillId}/run_state.json`,
    sceneScoresPath: `/tmp/${skillId}/scene_scores.json`,
    deliveryReportPath: `/tmp/${skillId}/delivery_report.json`,
    progress: { currentStage: 'score_batches', completedScenes: 0, totalScenes: 97 },
    blockers: [],
    pauseReason: null,
    resumePayload: null,
    sourceObservations: [],
    progressFingerprint: null,
    observedAt: '2026-04-29T01:00:00.000Z',
    lastProgressAt: '2026-04-29T01:00:00.000Z',
    ...overrides,
  }
}

function taskRun(skillId: string): SkillTaskRunRecord {
  return {
    id: 'str-task-run',
    scopeId: 'scope-test',
    sessionId: 'scope-test',
    agent: 'butler',
    runId: 'run-task',
    skillId,
    skillName: skillId,
    action: 'video_expert_pipeline',
    toolName: 'skill_video_expert_pipeline',
    runKind: 'typed_action',
    status: 'blocked',
    interactionState: 'suspended',
    goalText: null,
    resourceRefs: [],
    params: null,
    steps: [],
    currentStepId: 'video_expert_pipeline',
    artifacts: [],
    outputDir: `/tmp/${skillId}`,
    runStatePath: `/tmp/${skillId}/run_state.json`,
    sceneScoresPath: null,
    deliveryReportPath: null,
    failureKind: null,
    failureDetail: null,
    jobId: null,
    provider: null,
    model: null,
    startedAt: '2026-04-29T01:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-04-29T01:00:00.000Z',
    updatedAt: '2026-04-29T01:00:00.000Z',
    resumePayload: null,
    progressFingerprint: null,
  } as SkillTaskRunRecord
}

test('resolveTurnFrame prefers supervisor over projection and stale reference hint', () => {
  const frame = resolveTurnFrame({
    sessionId: 'scope-test',
    requestId: 'req-1',
    userIntent: 'continue',
    supervisorSnapshot: snapshot('video-expert-analyzer'),
    projections: [projection('lets-go-rss')],
    referenceHint: { id: 'novel-writer-system', name: 'novel_writer_system' },
  })

  assert.equal(frame.skill?.skillId, 'video-expert-analyzer')
  assert.equal(frame.skill?.source, 'supervisor')
  assert.equal(frame.skill?.runStatePath, '/tmp/video-expert-analyzer/run_state.json')
})

test('resolveTurnFrame prefers projection over task run and stale reference hint', () => {
  const frame = resolveTurnFrame({
    sessionId: 'scope-test',
    requestId: 'req-2',
    userIntent: 'continue',
    projections: [projection('video-expert-analyzer')],
    taskRuns: [taskRun('lets-go-rss')],
    referenceHint: { id: 'novel-writer-system', name: 'novel_writer_system' },
  })

  assert.equal(frame.skill?.skillId, 'video-expert-analyzer')
  assert.equal(frame.skill?.source, 'projection')
  assert.equal(frame.skill?.outputDir, '/tmp/video-expert-analyzer')
})

test('resolveTurnFrame uses reference hint only when no recoverable task identity exists', () => {
  const frame = resolveTurnFrame({
    sessionId: 'scope-test',
    requestId: 'req-3',
    userIntent: 'continue',
    referenceHint: { id: 'novel-writer-system', name: 'novel_writer_system' },
  })

  assert.equal(frame.skill?.skillId, 'novel-writer-system')
  assert.equal(frame.skill?.source, 'reference_hint')
  assert.equal(frame.skill?.runStatePath, null)
})

test('resolveTurnFrame preserves explicit task artifact identity over supervisor context', () => {
  const frame = resolveTurnFrame({
    sessionId: 'scope-test',
    requestId: 'req-4',
    userIntent: 'continue',
    explicitSkillId: 'video-expert-analyzer',
    explicitSkillName: 'Video Expert Analyzer',
    explicitOutputDir: '/tmp/explicit-vea',
    explicitRunStatePath: '/tmp/explicit-vea/run_state.json',
    explicitTaskRunId: 'str-explicit',
    explicitDetachedTaskId: 'dst-explicit',
    supervisorSnapshot: snapshot('lets-go-rss'),
    projections: [projection('novel-writer-system')],
    referenceHint: { id: 'novel-writer-system', name: 'novel_writer_system' },
  } as any)

  assert.equal(frame.skill?.skillId, 'video-expert-analyzer')
  assert.equal(frame.skill?.source, 'explicit')
  assert.equal(frame.skill?.outputDir, '/tmp/explicit-vea')
  assert.equal(frame.skill?.runStatePath, '/tmp/explicit-vea/run_state.json')
  assert.equal(frame.skill?.taskRunId, 'str-explicit')
  assert.equal(frame.skill?.detachedTaskId, 'dst-explicit')
})

test('resolveTurnFrame maps recoverable paused supervisor status into recoverable liveness', () => {
  const frame = resolveTurnFrame({
    sessionId: 'scope-test',
    requestId: 'req-recoverable',
    userIntent: 'continue',
    supervisorSnapshot: snapshot('video-expert-analyzer', {
      status: 'recoverable_paused' as any,
      hasLiveWork: false,
      hasRecentProgress: false,
    }),
  })

  assert.equal(frame.skill?.skillId, 'video-expert-analyzer')
  assert.equal(frame.liveness, 'recoverable_paused')
  assert.equal(frame.mode, 'skill_resume')
})
