import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SkillTaskSupervisor,
  inspectLatestSkillTask,
  inspectSkillTask,
  type SkillTaskSupervisorDependencies,
} from '../main/modules/agent-control/skill-task-supervisor'
import type { DetachedSkillTaskRecord } from '../main/modules/agent-control/detached-skill-task-tracker'
import type { SkillTaskRunRecord } from '../main/modules/repositories/skill-task-run-repository'

const NOW = Date.parse('2026-04-28T02:00:00.000Z')

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ready-skill-supervisor-'))
}

function writeRunState(dir: string, payload: Record<string, unknown>, mtime = '2026-04-28T01:59:00.000Z'): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'run_state.json')
  writeFileSync(path, JSON.stringify(payload), 'utf8')
  const date = new Date(mtime)
  utimesSync(path, date, date)
  return path
}

function makeDetached(overrides: Partial<DetachedSkillTaskRecord>): DetachedSkillTaskRecord {
  return {
    id: overrides.id || 'dst-1',
    scopeId: overrides.scopeId ?? 'scope-supervisor',
    sessionId: overrides.sessionId ?? 'scope-supervisor',
    agent: overrides.agent ?? 'assistant',
    skillId: overrides.skillId || 'video-expert-analyzer',
    action: overrides.action || 'video_expert_pipeline',
    params: overrides.params || {},
    status: overrides.status || 'running',
    outputDir: overrides.outputDir ?? null,
    runStatePath: overrides.runStatePath ?? null,
    sceneScoresPath: overrides.sceneScoresPath ?? null,
    deliveryReportPath: overrides.deliveryReportPath ?? null,
    error: overrides.error ?? null,
    startedAt: overrides.startedAt || '2026-04-28T01:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-04-28T01:59:00.000Z',
    finishedAt: overrides.finishedAt ?? null,
  }
}

function makeRun(overrides: Partial<SkillTaskRunRecord>): SkillTaskRunRecord {
  return {
    id: overrides.id || 'str-1',
    scopeId: overrides.scopeId ?? 'scope-supervisor',
    sessionId: overrides.sessionId ?? 'scope-supervisor',
    agent: overrides.agent ?? 'assistant',
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
      title: '视频分析',
      status: overrides.status === 'done' ? 'done' : 'running',
      updatedAt: overrides.updatedAt || '2026-04-28T01:59:00.000Z',
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
    createdAt: overrides.createdAt || '2026-04-28T01:00:00.000Z',
    startedAt: overrides.startedAt ?? '2026-04-28T01:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-04-28T01:59:00.000Z',
    finishedAt: overrides.finishedAt ?? null,
  }
}

function makeSupervisor(deps: Partial<SkillTaskSupervisorDependencies>): SkillTaskSupervisor {
  return new SkillTaskSupervisor({
    now: () => NOW,
    ...deps,
  })
}

test('SkillTaskSupervisor keeps detached running work over a done SQLite row', () => {
  const root = tempRoot()
  try {
    const runStatePath = writeRunState(root, { task_id: 'dst-1', status: 'running', current_stage: 'score_batches' })
    const detached = makeDetached({ id: 'dst-1', outputDir: root, runStatePath })
    const doneRun = makeRun({
      id: 'str-done',
      status: 'done',
      detachedTaskId: 'dst-1',
      finishedAt: '2026-04-28T01:30:00.000Z',
    })
    const snapshot = makeSupervisor({
      getDetachedTask: () => detached,
      findTaskRunByDetachedTaskId: () => doneRun,
    }).inspectSkillTask({ detachedTaskId: 'dst-1' })

    assert.equal(snapshot.status, 'background_running')
    assert.equal(snapshot.hasLiveWork, true)
    assert.equal(snapshot.closeAllowed, false)
    assert.equal(snapshot.taskRunId, 'str-done')
    assert.equal(snapshot.detachedTaskId, 'dst-1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SkillTaskSupervisor keeps detached running work over a done projection', () => {
  const root = tempRoot()
  try {
    const runStatePath = writeRunState(root, { task_id: 'dst-2', status: 'running' })
    const snapshot = makeSupervisor({
      getDetachedTask: () => makeDetached({ id: 'dst-2', outputDir: root, runStatePath }),
      readProjection: () => ({
        module: 'skill',
        taskId: 'skill:scope-supervisor:video-expert-analyzer',
        taskTitle: '技能执行',
        taskSummary: '已完成',
        steps: [{ id: 'done', title: 'done', status: 'done', updatedAt: '2026-04-28T01:50:00.000Z' }],
        currentStepId: 'done',
        waitingFor: 'none',
        resumableActions: ['none'],
        blockedReason: null,
        taskContinuation: null,
        recentArtifacts: [],
      }),
    }).inspectSkillTask({ detachedTaskId: 'dst-2' })

    assert.equal(snapshot.status, 'background_running')
    assert.equal(snapshot.hasLiveWork, true)
    assert.equal(snapshot.closeAllowed, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SkillTaskSupervisor prefers an active parent over primitive monitor success', () => {
  const active = makeRun({
    id: 'str-active',
    status: 'running',
    runKind: 'typed_action',
    steps: [
      { id: 'skill_video_expert_pipeline#1', title: '视频分析', status: 'running', updatedAt: '2026-04-28T01:58:00.000Z' },
      { id: 'skill_run_shell#1', title: '监控 run_state', status: 'done', updatedAt: '2026-04-28T01:59:00.000Z' },
    ],
  })
  const done = makeRun({
    id: 'str-monitor',
    status: 'done',
    runKind: 'primitive',
    toolName: 'skill_run_shell',
    updatedAt: '2026-04-28T01:59:30.000Z',
  })

  const snapshot = makeSupervisor({
    listActiveTaskRuns: () => [active],
    findLatestRecoverableTaskRun: () => done,
  }).inspectLatestSkillTask({ sessionId: 'scope-supervisor' })

  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.taskRunId, 'str-active')
  assert.equal(snapshot.closeAllowed, false)
})

test('SkillTaskSupervisor treats live pid with stale run_state as background running', () => {
  const root = tempRoot()
  try {
    const runStatePath = writeRunState(
      root,
      {
        task_id: 'pid-task',
        status: 'running',
        pid: 43210,
        current_stage: 'score_batches',
        updated_at: '2026-04-28T01:40:00.000Z',
      },
      '2026-04-28T01:40:00.000Z',
    )
    const snapshot = makeSupervisor({
      pidExists: (pid) => pid === 43210,
    }).inspectSkillTask({
      runStatePath,
      expectedTaskId: 'pid-task',
      skillId: 'video-expert-analyzer',
    })

    assert.equal(snapshot.status, 'background_running')
    assert.equal(snapshot.hasLiveWork, true)
    assert.equal(snapshot.stale, true)
    assert.equal(snapshot.progress.currentStage, 'score_batches')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SkillTaskSupervisor marks multiple run_state files ambiguous without identity', () => {
  const root = tempRoot()
  try {
    writeRunState(join(root, 'a'), { task_id: 'a', status: 'running' })
    writeRunState(join(root, 'b'), { task_id: 'b', status: 'completed' }, '2026-04-28T01:59:30.000Z')
    const snapshot = makeSupervisor({}).inspectSkillTask({
      outputDir: root,
      skillId: 'video-expert-analyzer',
    })

    assert.equal(snapshot.ambiguous, true)
    assert.equal(snapshot.runStatePath, null)
    assert.equal(snapshot.closeAllowed, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SkillTaskSupervisor selects older matching run_state by task identity', () => {
  const root = tempRoot()
  try {
    const target = writeRunState(join(root, 'target'), {
      task_id: 'target',
      status: 'running',
      current_stage: 'score_batches',
    }, '2026-04-28T01:55:00.000Z')
    writeRunState(join(root, 'other'), {
      task_id: 'other',
      status: 'completed',
      current_stage: 'completed',
    }, '2026-04-28T01:59:00.000Z')

    const snapshot = makeSupervisor({}).inspectSkillTask({
      outputDir: root,
      expectedTaskId: 'target',
      skillId: 'video-expert-analyzer',
    })

    assert.equal(snapshot.runStatePath, target)
    assert.equal(snapshot.progress.currentStage, 'score_batches')
    assert.equal(snapshot.status, 'background_running')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SkillTaskSupervisor preserves resume payload for blocked run_state', () => {
  const root = tempRoot()
  try {
    const runStatePath = writeRunState(root, {
      task_id: 'blocked-task',
      status: 'blocked',
      last_error: 'awaiting audiovisual handoff',
      current_stage: 'finalize',
    }, '2026-04-28T01:40:00.000Z')
    utimesSync(root, new Date('2026-04-28T01:40:00.000Z'), new Date('2026-04-28T01:40:00.000Z'))
    const blockedRun = makeRun({
      id: 'str-blocked',
      status: 'blocked',
      runStatePath,
      outputDir: root,
      resumePayload: {
        detachedTaskId: 'dst-blocked',
        runStatePath,
        outputDir: root,
        skillId: 'video-expert-analyzer',
        action: 'video_expert_pipeline',
      },
    })

    const snapshot = makeSupervisor({
      listActiveTaskRuns: () => [blockedRun],
    }).inspectLatestSkillTask({ sessionId: 'scope-supervisor' })

    assert.equal(snapshot.status, 'blocked')
    assert.equal(snapshot.resumePayload?.runStatePath, runStatePath)
    assert.deepEqual(snapshot.blockers, ['awaiting audiovisual handoff'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SkillTaskSupervisor keeps failed detached output paths', () => {
  const failed = makeDetached({
    id: 'dst-failed',
    status: 'failed',
    outputDir: '/tmp/vea/out',
    runStatePath: '/tmp/vea/out/run_state.json',
    sceneScoresPath: '/tmp/vea/out/scene_scores.json',
    deliveryReportPath: '/tmp/vea/out/delivery_report.json',
    error: 'provider unauthorized',
    finishedAt: '2026-04-28T01:30:00.000Z',
  })

  const snapshot = makeSupervisor({
    getDetachedTask: () => failed,
  }).inspectSkillTask({ detachedTaskId: 'dst-failed' })

  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.closeAllowed, true)
  assert.equal(snapshot.outputDir, '/tmp/vea/out')
  assert.equal(snapshot.runStatePath, '/tmp/vea/out/run_state.json')
  assert.deepEqual(snapshot.blockers, ['provider unauthorized'])
})

test('default inspect helpers return unknown rather than throwing without state', () => {
  assert.equal(inspectSkillTask({ detachedTaskId: 'missing-task' }).status, 'unknown')
  assert.equal(inspectLatestSkillTask({ sessionId: 'missing-session' }).status, 'unknown')
})
