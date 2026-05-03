import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearActiveSkillContext,
  rememberActiveSkillContext,
  resolveActiveSkillContextFromInputs,
  type ActiveSkillContext,
} from '../main/modules/agent-control/active-skill-context'
import type { TaskProjectionRecord } from '../main/modules/agent-control/run-contracts'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skill-task-supervisor'

function projection(overrides: Partial<TaskProjectionRecord>): TaskProjectionRecord {
  return {
    taskId: 'task-system',
    scopeId: 'conv-vea',
    runId: 'run-system',
    taskType: 'short_task',
    module: 'system',
    taskTitle: '正在处理视频分析任务',
    taskSummary: 'Video Expert Analyzer blocked by stale provider config',
    status: 'blocked',
    interactionState: 'running',
    waitingFor: 'background',
    steps: [],
    currentStepId: 'video_expert_pipeline',
    budget: null,
    budgetUsagePercent: null,
    budgetWarningLevel: null,
    recoveryHistory: [],
    degradationReason: null,
    blockedReason: '自动并行评分失败：ValueError: 未找到 provider: zai',
    resumableActions: ['continue', 'cancel'],
    continuationRef: null,
    recentArtifacts: [
      {
        id: 'dst-vea:outputDir',
        module: 'skill',
        kind: 'directory',
        label: '技能输出目录',
        path: '/tmp/video-output',
        createdAt: '2026-04-29T01:00:00.000Z',
        meta: {
          detachedTaskId: 'dst-vea',
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          outputKey: 'outputDir',
        },
      },
      {
        id: 'dst-vea:runStatePath',
        module: 'skill',
        kind: 'artifact',
        label: 'run_state.json',
        path: '/tmp/video-output/run_state.json',
        createdAt: '2026-04-29T01:00:00.000Z',
        meta: {
          detachedTaskId: 'dst-vea',
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          outputKey: 'runStatePath',
        },
      },
    ],
    createdAt: '2026-04-29T01:00:00.000Z',
    updatedAt: '2026-04-29T01:00:00.000Z',
    ...overrides,
  }
}

function snapshot(overrides: Partial<SkillTaskSupervisorSnapshot>): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: 'str-vea',
    detachedTaskId: 'dst-vea',
    skillId: 'video-expert-analyzer',
    scopeId: 'conv-vea',
    sessionId: 'conv-vea',
    action: 'video_expert_pipeline',
    status: 'blocked',
    liveness: null,
    hasLiveWork: false,
    hasRecentProgress: true,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: '/tmp/video-output',
    runStatePath: '/tmp/video-output/run_state.json',
    sceneScoresPath: '/tmp/video-output/scene_scores.json',
    deliveryReportPath: '/tmp/video-output/delivery_report.json',
    progress: { currentStage: 'score_batches', completedScenes: 0, totalScenes: 97 },
    blockers: ['ValueError: 未找到 provider: zai'],
    pauseReason: null,
    resumePayload: null,
    sourceObservations: [],
    progressFingerprint: null,
    observedAt: '2026-04-29T01:00:00.000Z',
    lastProgressAt: '2026-04-29T01:00:00.000Z',
    ...overrides,
  }
}

test('active skill context prefers blocked VEA projection over stale reference hint', () => {
  const context = resolveActiveSkillContextFromInputs({
    sessionId: 'conv-vea',
    projections: [projection({})],
    referenceHint: { id: 'novel-writer-system', name: 'novel_writer_system' },
  })

  assert.equal(context?.source, 'projection')
  assert.equal(context?.skillId, 'video-expert-analyzer')
  assert.equal(context?.detachedTaskId, 'dst-vea')
  assert.equal(context?.action, 'video_expert_pipeline')
  assert.equal(context?.outputDir, '/tmp/video-output')
  assert.equal(context?.runStatePath, '/tmp/video-output/run_state.json')
  assert.match(context?.staleBlockerReason || '', /zai/)
})

test('active skill context prefers recoverable supervisor snapshot over stale reference hint', () => {
  const context = resolveActiveSkillContextFromInputs({
    sessionId: 'conv-vea',
    supervisorSnapshot: snapshot({}),
    referenceHint: { id: 'novel-writer-system', name: 'novel_writer_system' },
  }) as ActiveSkillContext

  assert.equal(context.source, 'supervisor')
  assert.equal(context.skillId, 'video-expert-analyzer')
  assert.equal(context.taskRunId, 'str-vea')
  assert.equal(context.detachedTaskId, 'dst-vea')
  assert.equal(context.runStatePath, '/tmp/video-output/run_state.json')
})

test('active skill context treats remembered context as fallback behind recoverable projection', () => {
  clearActiveSkillContext('conv-vea')
  rememberActiveSkillContext('conv-vea', {
    skillId: 'novel-writer-system',
    skillName: 'novel-writer-system',
    taskRunId: null,
    detachedTaskId: null,
    runStatePath: null,
    outputDir: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    action: null,
    source: 'reference_hint',
    confidence: 20,
    status: null,
    staleBlockerReason: null,
    observedAt: new Date().toISOString(),
  })

  try {
    const context = resolveActiveSkillContextFromInputs({
      sessionId: 'conv-vea',
      projections: [projection({})],
      referenceHint: { id: 'novel-writer-system', name: 'novel_writer_system' },
    })

    assert.equal(context?.source, 'projection')
    assert.equal(context?.skillId, 'video-expert-analyzer')
  } finally {
    clearActiveSkillContext('conv-vea')
  }
})

test('active skill context resolves VEA progress stage to executable action when scene scores exist', () => {
  const context = resolveActiveSkillContextFromInputs({
    sessionId: 'conv-vea',
    projections: [
      projection({
        currentStepId: 'score_batches',
        continuationRef: null,
        recentArtifacts: [
          {
            id: 'dst-vea:outputDir',
            module: 'skill',
            kind: 'directory',
            label: '技能输出目录',
            path: '/tmp/video-output',
            createdAt: '2026-04-29T01:00:00.000Z',
            meta: {
              detachedTaskId: 'dst-vea',
              skillId: 'video-expert-analyzer',
              outputKey: 'outputDir',
            },
          },
          {
            id: 'dst-vea:sceneScoresPath',
            module: 'skill',
            kind: 'artifact',
            label: 'scene_scores.json',
            path: '/tmp/video-output/scene_scores.json',
            createdAt: '2026-04-29T01:00:00.000Z',
            meta: {
              detachedTaskId: 'dst-vea',
              skillId: 'video-expert-analyzer',
              outputKey: 'sceneScoresPath',
            },
          },
        ],
      }),
    ],
  })

  assert.equal(context?.skillId, 'video-expert-analyzer')
  assert.equal(context?.action, 'video_expert_ai_analyze')
})
