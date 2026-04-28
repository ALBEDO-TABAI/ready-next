import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clearSkillTaskProjection,
  getLatestRecoverableSkillTaskRun,
  recordSkillParentTaskLifecycleEvent,
  recordSkillTaskEvent,
  registerSkillTaskRunRepository,
  readSkillTaskProjection,
  upsertDetachedSkillTaskRun,
} from '../main/modules/agent-control/skill-task-tracker'
import type { SkillTaskRunRecord, SkillTaskRunRepository } from '../main/modules/repositories/skill-task-run-repository'

function createTaskRunRepositoryHarness() {
  const rows = new Map<string, SkillTaskRunRecord>()
  const repository = {
    create(record: SkillTaskRunRecord) {
      rows.set(record.id, { ...record, steps: record.steps.map((step) => ({ ...step })) })
    },
    update(id: string, patch: Partial<SkillTaskRunRecord>) {
      const current = rows.get(id)
      if (!current) return
      rows.set(id, {
        ...current,
        ...patch,
        steps: patch.steps ? patch.steps.map((step) => ({ ...step })) : current.steps,
        artifacts: patch.artifacts ? patch.artifacts.map((artifact) => ({ ...artifact })) : current.artifacts,
      })
    },
    listActiveBySession(sessionId: string) {
      return Array.from(rows.values()).filter((row) =>
        row.sessionId === sessionId && (row.status === 'running' || row.status === 'blocked'),
      )
    },
    findLatestRecoverable(params: { sessionId?: string | null; skillId?: string | null; includeDone?: boolean }) {
      const statuses = params.includeDone
        ? new Set(['running', 'blocked', 'failed', 'done'])
        : new Set(['running', 'blocked', 'failed'])
      return Array.from(rows.values())
        .filter((row) => !params.sessionId || row.sessionId === params.sessionId)
        .filter((row) => !params.skillId || row.skillId === params.skillId)
        .filter((row) => statuses.has(row.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null
    },
    get(id: string) {
      return rows.get(id) || null
    },
    findByDetachedTaskId(detachedTaskId: string) {
      return Array.from(rows.values())
        .filter((row) => row.detachedTaskId === detachedTaskId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null
    },
  }
  return { repository: repository as unknown as SkillTaskRunRepository, rows }
}

function makeStoredRun(overrides: Partial<SkillTaskRunRecord>): SkillTaskRunRecord {
  return {
    id: overrides.id || 'str-test',
    scopeId: overrides.scopeId ?? 'scope-skill-priority',
    sessionId: overrides.sessionId ?? 'scope-skill-priority',
    agent: overrides.agent ?? 'butler',
    runId: overrides.runId ?? null,
    skillId: overrides.skillId || 'video-expert-analyzer',
    skillName: overrides.skillName ?? 'Video Expert Analyzer',
    action: overrides.action || 'video_expert_pipeline',
    toolName: overrides.toolName ?? 'skill_video_expert_pipeline',
    runKind: overrides.runKind || 'typed_action',
    status: overrides.status || 'running',
    interactionState: overrides.interactionState || 'running',
    goalText: overrides.goalText ?? null,
    resourceRefs: overrides.resourceRefs || [],
    params: overrides.params || null,
    steps: overrides.steps || [{
      id: 'skill_video_expert_pipeline#1',
      title: '执行视频分析',
      status: 'running',
      updatedAt: overrides.updatedAt || '2026-04-28T00:00:00.000Z',
    }],
    currentStepId: overrides.currentStepId ?? 'skill_video_expert_pipeline#1',
    artifacts: overrides.artifacts || [],
    outputDir: overrides.outputDir ?? null,
    runStatePath: overrides.runStatePath ?? null,
    sceneScoresPath: overrides.sceneScoresPath ?? null,
    deliveryReportPath: overrides.deliveryReportPath ?? null,
    failureKind: overrides.failureKind ?? null,
    failureDetail: overrides.failureDetail ?? null,
    jobId: overrides.jobId ?? null,
    detachedTaskId: overrides.detachedTaskId ?? null,
    resumePayload: overrides.resumePayload || null,
    createdAt: overrides.createdAt || '2026-04-28T00:00:00.000Z',
    startedAt: overrides.startedAt ?? '2026-04-28T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-04-28T00:00:00.000Z',
    finishedAt: overrides.finishedAt ?? null,
  }
}

test('SkillTaskTracker records primitive steps and recent artifacts for task cards', () => {
  clearSkillTaskProjection('scope-skill-1')

  recordSkillTaskEvent({
    sessionId: 'scope-skill-1',
    skillId: 'novel_writer_system',
    skillName: 'Novel Writer System',
    toolName: 'skill_run_shell',
    status: 'done',
  })
  recordSkillTaskEvent({
    sessionId: 'scope-skill-1',
    skillId: 'novel_writer_system',
    skillName: 'Novel Writer System',
    toolName: 'skill_write_artifact',
    status: 'done',
    artifactPath: '/tmp/ready-skill-output/report.md',
    artifactLabel: 'report.md',
  })

  const projection = readSkillTaskProjection({
    sessionId: 'scope-skill-1',
    skillId: 'novel_writer_system',
  })

  assert.equal(projection?.module, 'skill')
  assert.equal(projection?.taskTitle, '技能执行 · Novel Writer System')
  assert.equal(projection?.steps?.length, 2)
  assert.equal(projection?.steps?.[0]?.status, 'done')
  assert.equal(projection?.currentStepId, 'skill_write_artifact#1')
  assert.equal(projection?.waitingFor, 'none')
  assert.equal(projection?.recentArtifacts?.[0]?.label, 'report.md')
})

test('SkillTaskTracker records typed action output paths for VEA task cards', () => {
  clearSkillTaskProjection('scope-skill-vea')

  recordSkillTaskEvent({
    sessionId: 'scope-skill-vea',
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    toolName: 'skill_video_expert_pipeline',
    status: 'done',
    artifactPath: '/tmp/video/out',
    artifactLabel: '技能输出目录',
    artifacts: [
      {
        path: '/tmp/video/out',
        label: '技能输出目录',
        kind: 'directory',
        meta: { outputKey: 'outputDir' },
      },
      {
        path: '/tmp/video/out/run_state.json',
        label: 'run_state.json',
        kind: 'artifact',
        meta: { outputKey: 'runStatePath' },
      },
      {
        path: '/tmp/video/out/scene_scores.json',
        label: 'scene_scores.json',
        kind: 'artifact',
        meta: { outputKey: 'sceneScoresPath' },
      },
    ],
  })

  const projection = readSkillTaskProjection({
    sessionId: 'scope-skill-vea',
    skillId: 'video-expert-analyzer',
  })

  assert.equal(projection?.recentArtifacts?.length, 3)
  assert.deepEqual(
    projection?.recentArtifacts?.map((artifact) => artifact.label),
    ['技能输出目录', 'run_state.json', 'scene_scores.json'],
  )
  assert.equal(projection?.recentArtifacts?.[1]?.meta?.outputKey, 'runStatePath')
  assert.equal(projection?.recentArtifacts?.[2]?.meta?.outputKey, 'sceneScoresPath')
})

test('SkillTaskTracker exposes ask_user as an input wait state', () => {
  clearSkillTaskProjection('scope-skill-2')

  recordSkillTaskEvent({
    sessionId: 'scope-skill-2',
    skillId: 'novel_writer_system',
    skillName: 'Novel Writer System',
    toolName: 'skill_ask_user',
    status: 'blocked',
    message: '需要确认章节范围',
  })

  const projection = readSkillTaskProjection({
    sessionId: 'scope-skill-2',
    skillId: 'novel_writer_system',
  })

  assert.equal(projection?.waitingFor, 'input')
  assert.equal(projection?.blockedReason, '需要确认章节范围')
  assert.equal(projection?.resumableActions?.includes('continue'), true)
  assert.equal(projection?.taskContinuation?.blockerType, 'need_input')
})

test('SkillTaskTracker appends repeated primitive steps and stores retry anchor on failure', () => {
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  clearSkillTaskProjection('scope-skill-shell')

  recordSkillTaskEvent({
    sessionId: 'scope-skill-shell',
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    toolName: 'skill_run_shell',
    status: 'done',
  })
  recordSkillTaskEvent({
    sessionId: 'scope-skill-shell',
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    toolName: 'skill_run_shell',
    status: 'error',
    message: 'run_state status=failed',
  })

  const projection = readSkillTaskProjection({
    sessionId: 'scope-skill-shell',
    skillId: 'video-expert-analyzer',
  })
  const stored = Array.from(rows.values())[0]

  assert.deepEqual(projection?.steps.map((step) => step.id), ['skill_run_shell#1', 'skill_run_shell#2'])
  assert.deepEqual(stored?.steps.map((step) => step.id), ['skill_run_shell#1', 'skill_run_shell#2'])
  assert.equal(stored?.status, 'failed')
  assert.deepEqual(projection?.resumableActions, ['retry', 'cancel'])
  assert.equal(projection?.taskContinuation?.blockerType, 'error')
  assert.deepEqual(stored?.resumePayload?.resumableActions, ['retry', 'cancel'])

  registerSkillTaskRunRepository(null)
})

test('SkillTaskTracker archives goal, resources, job and agent for recovery', () => {
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  clearSkillTaskProjection('scope-skill-archive')

  recordSkillTaskEvent({
    scopeId: 'scope-skill-archive',
    sessionId: 'scope-skill-archive',
    runId: 'run-archive',
    agent: 'mimo',
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    toolName: 'skill_video_expert_pipeline',
    action: 'video_expert_pipeline',
    runKind: 'typed_action',
    status: 'running',
    message: '分析公开视频',
    goalText: '分析这个公开视频并输出分镜',
    resourceRefs: [{ type: 'url', url: 'https://example.test/video' }],
    jobId: 'job-archive',
    outputDir: '/tmp/ready/vea/job-archive',
    params: { url: 'https://example.test/video' },
  })

  const stored = Array.from(rows.values())[0]

  assert.equal(stored?.goalText, '分析这个公开视频并输出分镜')
  assert.deepEqual(stored?.resourceRefs, [{ type: 'url', url: 'https://example.test/video' }])
  assert.equal(stored?.jobId, 'job-archive')
  assert.equal(stored?.agent, 'mimo')
  assert.equal(stored?.runId, 'run-archive')
  assert.equal(stored?.outputDir, '/tmp/ready/vea/job-archive')

  registerSkillTaskRunRepository(null)
})

test('SkillTaskTracker updates ask_user blocked step to done in the same task run', () => {
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  clearSkillTaskProjection('scope-skill-ask')

  const blocked = recordSkillTaskEvent({
    sessionId: 'scope-skill-ask',
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    toolName: 'skill_ask_user',
    status: 'blocked',
    message: '请选择范围',
  })
  recordSkillTaskEvent({
    sessionId: 'scope-skill-ask',
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    toolName: 'skill_ask_user',
    stepId: blocked.stepId,
    status: 'done',
    message: '用户已回复',
  })

  const projection = readSkillTaskProjection({
    sessionId: 'scope-skill-ask',
    skillId: 'video-expert-analyzer',
  })
  const stored = Array.from(rows.values())[0]

  assert.deepEqual(projection?.steps.map((step) => step.id), ['skill_ask_user#1'])
  assert.equal(projection?.steps[0]?.status, 'done')
  assert.equal(stored?.status, 'done')
  assert.deepEqual(stored?.steps.map((step) => step.id), ['skill_ask_user#1'])

  registerSkillTaskRunRepository(null)
})

test('SkillTaskTracker records primitive monitor success without closing a running typed parent task', () => {
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  clearSkillTaskProjection('scope-skill-monitor')
  try {
    recordSkillTaskEvent({
      sessionId: 'scope-skill-monitor',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      toolName: 'skill_video_expert_pipeline',
      action: 'video_expert_pipeline',
      runKind: 'typed_action',
      status: 'running',
      message: '视频分析仍在运行',
    })
    recordSkillTaskEvent({
      sessionId: 'scope-skill-monitor',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      toolName: 'skill_run_shell',
      runKind: 'primitive',
      status: 'done',
      message: 'monitor saw status: running',
    })

    const stored = Array.from(rows.values())[0]
    assert.equal(stored?.status, 'running')
    assert.deepEqual(
      stored?.steps.map((step) => ({ id: step.id, status: step.status })),
      [
        { id: 'skill_video_expert_pipeline#1', status: 'running' },
        { id: 'skill_run_shell#1', status: 'done' },
      ],
    )
  } finally {
    registerSkillTaskRunRepository(null)
  }
})

test('SkillTaskTracker records parent lifecycle handoff without pretending a primitive completed the task', () => {
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  clearSkillTaskProjection('scope-skill-lifecycle')
  try {
    recordSkillTaskEvent({
      sessionId: 'scope-skill-lifecycle',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      toolName: 'skill_video_expert_pipeline',
      action: 'video_expert_pipeline',
      runKind: 'typed_action',
      status: 'running',
      message: '正在分析视频',
      outputDir: '/tmp/vea/lifecycle',
      runStatePath: '/tmp/vea/lifecycle/run_state.json',
    })

    const lifecycle = recordSkillParentTaskLifecycleEvent({
      sessionId: 'scope-skill-lifecycle',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      state: 'background_running',
      reason: 'budget_exhausted',
      message: '本轮预算已用完，但技能任务仍在后台运行',
      detachedTaskId: 'dst-lifecycle',
      taskRunId: 'str-lifecycle-parent',
      outputDir: '/tmp/vea/lifecycle',
      runStatePath: '/tmp/vea/lifecycle/run_state.json',
      progressFingerprint: 'score_batches:4/12',
    })

    const projection = readSkillTaskProjection({
      sessionId: 'scope-skill-lifecycle',
      skillId: 'video-expert-analyzer',
    })
    const stored = Array.from(rows.values())[0]

    assert.equal(lifecycle.stepId, 'skill_lifecycle#1')
    assert.equal(projection?.waitingFor, 'background')
    assert.deepEqual(projection?.resumableActions, ['continue', 'cancel'])
    assert.equal(projection?.blockedReason, '本轮预算已用完，但技能任务仍在后台运行')
    assert.equal(projection?.currentStepId, 'skill_lifecycle#1')
    assert.equal(projection?.taskContinuation?.blockerType, 'budget_exhausted')
    assert.equal((projection?.taskContinuation as any)?.detachedTaskId, 'dst-lifecycle')
    assert.equal((projection?.taskContinuation as any)?.runStatePath, '/tmp/vea/lifecycle/run_state.json')
    assert.deepEqual(
      projection?.steps.map((step) => ({ id: step.id, status: step.status })),
      [
        { id: 'skill_video_expert_pipeline#1', status: 'running' },
        { id: 'skill_lifecycle#1', status: 'running' },
      ],
    )
    assert.equal(stored?.status, 'running')
    assert.equal(stored?.interactionState, 'suspended')
    assert.equal(stored?.runKind, 'typed_action')
    assert.equal(stored?.currentStepId, 'skill_lifecycle#1')
    assert.equal(stored?.finishedAt, null)
    assert.equal(stored?.resumePayload?.blockerType, 'budget_exhausted')
    assert.equal(stored?.resumePayload?.detachedTaskId, 'dst-lifecycle')
    assert.equal(stored?.resumePayload?.progressFingerprint, 'score_batches:4/12')
  } finally {
    registerSkillTaskRunRepository(null)
  }
})

test('SkillTaskTracker keeps background parent state when primitive monitor exits 0', () => {
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  clearSkillTaskProjection('scope-skill-background-observation')
  try {
    recordSkillTaskEvent({
      sessionId: 'scope-skill-background-observation',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      toolName: 'skill_video_expert_pipeline',
      action: 'video_expert_pipeline',
      runKind: 'typed_action',
      status: 'running',
      message: '正在分析视频',
    })
    recordSkillParentTaskLifecycleEvent({
      sessionId: 'scope-skill-background-observation',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      state: 'background_running',
      reason: 'budget_exhausted',
      message: '本轮预算已用完，但技能任务仍在后台运行',
      detachedTaskId: 'dst-background',
      runStatePath: '/tmp/vea/background/run_state.json',
    })

    recordSkillTaskEvent({
      sessionId: 'scope-skill-background-observation',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      toolName: 'skill_run_shell',
      runKind: 'primitive',
      status: 'running',
      message: 'monitor exit 0: status=running',
    })

    const projection = readSkillTaskProjection({
      sessionId: 'scope-skill-background-observation',
      skillId: 'video-expert-analyzer',
    })
    const stored = Array.from(rows.values())[0]

    assert.equal(projection?.waitingFor, 'background')
    assert.deepEqual(projection?.resumableActions, ['continue', 'cancel'])
    assert.equal(projection?.blockedReason, '本轮预算已用完，但技能任务仍在后台运行')
    assert.equal(projection?.taskContinuation?.blockerType, 'budget_exhausted')
    assert.equal(projection?.currentStepId, 'skill_lifecycle#1')
    assert.deepEqual(
      projection?.steps.map((step) => ({ id: step.id, status: step.status })),
      [
        { id: 'skill_video_expert_pipeline#1', status: 'running' },
        { id: 'skill_lifecycle#1', status: 'running' },
        { id: 'skill_run_shell#1', status: 'running' },
      ],
    )
    assert.equal(stored?.status, 'running')
    assert.equal(stored?.interactionState, 'suspended')
    assert.equal(stored?.currentStepId, 'skill_lifecycle#1')
    assert.equal(stored?.resumePayload?.blockerType, 'budget_exhausted')
    assert.equal(stored?.finishedAt, null)
  } finally {
    registerSkillTaskRunRepository(null)
  }
})

test('SkillTaskTracker maps budget paused lifecycle to existing blocked suspended state', () => {
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  clearSkillTaskProjection('scope-skill-budget-paused')
  try {
    recordSkillParentTaskLifecycleEvent({
      sessionId: 'scope-skill-budget-paused',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      action: 'video_expert_pipeline',
      state: 'budget_paused',
      reason: 'budget_exhausted',
      message: '预算暂停，等待继续',
      outputDir: '/tmp/vea/budget-paused',
      runStatePath: '/tmp/vea/budget-paused/run_state.json',
    })

    const projection = readSkillTaskProjection({
      sessionId: 'scope-skill-budget-paused',
      skillId: 'video-expert-analyzer',
    })
    const stored = Array.from(rows.values())[0]

    assert.equal(projection?.waitingFor, 'background')
    assert.deepEqual(projection?.resumableActions, ['continue', 'cancel'])
    assert.equal(projection?.steps[0]?.status, 'blocked')
    assert.equal(stored?.status, 'blocked')
    assert.equal(stored?.interactionState, 'suspended')
    assert.equal(stored?.finishedAt, null)
    assert.equal(stored?.resumePayload?.blockerType, 'budget_exhausted')
  } finally {
    registerSkillTaskRunRepository(null)
  }
})

test('SkillTaskTracker applies lifecycle events to the explicit taskRunId before latest active fallback', () => {
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  clearSkillTaskProjection('scope-skill-explicit-task-run')
  try {
    rows.set('str-other', makeStoredRun({
      id: 'str-other',
      sessionId: 'scope-skill-explicit-task-run',
      scopeId: 'scope-skill-explicit-task-run',
      status: 'running',
      updatedAt: '2026-04-28T00:05:00.000Z',
    }))
    rows.set('str-target', makeStoredRun({
      id: 'str-target',
      sessionId: 'scope-skill-explicit-task-run',
      scopeId: 'scope-skill-explicit-task-run',
      status: 'running',
      updatedAt: '2026-04-28T00:01:00.000Z',
    }))

    recordSkillParentTaskLifecycleEvent({
      sessionId: 'scope-skill-explicit-task-run',
      scopeId: 'scope-skill-explicit-task-run',
      skillId: 'video-expert-analyzer',
      state: 'budget_paused',
      reason: 'budget_exhausted',
      message: '预算暂停，等待继续',
      taskRunId: 'str-target',
      runStatePath: '/tmp/target/run_state.json',
    })

    assert.equal(rows.get('str-target')?.currentStepId, 'skill_lifecycle#1')
    assert.equal(rows.get('str-target')?.status, 'blocked')
    assert.equal(rows.get('str-target')?.resumePayload?.runStatePath, '/tmp/target/run_state.json')
    assert.notEqual(rows.get('str-other')?.currentStepId, 'skill_lifecycle#1')
    assert.equal(rows.get('str-other')?.status, 'running')
  } finally {
    registerSkillTaskRunRepository(null)
  }
})

test('SkillTaskTracker does not mark a detached task done while run_state still reports live work', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-detached-terminal-guard-'))
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  try {
    mkdirSync(root, { recursive: true })
    const runStatePath = join(root, 'run_state.json')
    writeFileSync(runStatePath, JSON.stringify({
      task_id: 'dst-terminal-guard',
      status: 'running',
      current_stage: 'finalize',
    }), 'utf8')
    rows.set('str-detached', makeStoredRun({
      id: 'str-detached',
      sessionId: 'scope-skill-detached-terminal',
      scopeId: 'scope-skill-detached-terminal',
      runKind: 'detached',
      status: 'running',
      detachedTaskId: 'dst-terminal-guard',
      jobId: 'dst-terminal-guard',
      outputDir: root,
      runStatePath,
    }))

    upsertDetachedSkillTaskRun({
      id: 'dst-terminal-guard',
      scopeId: 'scope-skill-detached-terminal',
      sessionId: 'scope-skill-detached-terminal',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      params: { outputDir: root },
      status: 'done',
      outputDir: root,
      runStatePath,
      startedAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:10:00.000Z',
      finishedAt: '2026-04-28T00:10:00.000Z',
    })

    const stored = rows.get('str-detached')
    assert.equal(stored?.status, 'running')
    assert.equal(stored?.finishedAt, null)
    assert.equal(stored?.resumePayload?.runStatePath, runStatePath)
  } finally {
    registerSkillTaskRunRepository(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('SkillTaskTracker recovery prefers an active running task over a newer done archive', () => {
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  try {
    rows.set('str-running', makeStoredRun({
      id: 'str-running',
      status: 'running',
      updatedAt: '2026-04-28T00:00:00.000Z',
    }))
    rows.set('str-done', makeStoredRun({
      id: 'str-done',
      status: 'done',
      updatedAt: '2026-04-28T00:05:00.000Z',
      finishedAt: '2026-04-28T00:05:00.000Z',
      steps: [{
        id: 'skill_video_expert_pipeline#1',
        title: '执行视频分析',
        status: 'done',
        updatedAt: '2026-04-28T00:05:00.000Z',
      }],
    }))

    assert.equal(getLatestRecoverableSkillTaskRun('scope-skill-priority')?.id, 'str-running')
  } finally {
    registerSkillTaskRunRepository(null)
  }
})
