import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DetachedSkillTaskTracker,
} from '../main/modules/agent-control/detached-skill-task-tracker'
import { registerSkillTaskRunRepository } from '../main/modules/agent-control/skill-task-tracker'
import type { SkillTaskRunRecord, SkillTaskRunRepository } from '../main/modules/repositories/skill-task-run-repository'
import type { SkillRunRequest, SkillRunResult } from '../main/modules/skills-runtime/runtime-manager'

function storagePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ready-detached-skill-')), 'tasks.json')
}

function successfulLongSkillResult(request: SkillRunRequest): SkillRunResult {
  return {
    success: true,
    skillId: request.skillId,
    action: request.action,
    stdout: '',
    stderr: '',
    outputDir: '/tmp/video/out',
    outputs: {
      outputDir: '/tmp/video/out',
      runStatePath: '/tmp/video/out/run_state.json',
      sceneScoresPath: '/tmp/video/out/scene_scores.json',
    },
    command: [],
    mode: 'direct',
    status: 'done',
  }
}

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
    updateRowSync(id: string, patch: Partial<SkillTaskRunRecord>) {
      const current = rows.get(id)
      if (!current) return
      rows.set(id, {
        ...current,
        ...patch,
        steps: patch.steps ? patch.steps.map((step) => ({ ...step })) : current.steps,
        artifacts: patch.artifacts ? patch.artifacts.map((artifact) => ({ ...artifact })) : current.artifacts,
      })
    },
    findByDetachedTaskId(detachedTaskId: string) {
      return Array.from(rows.values()).find((row) => row.detachedTaskId === detachedTaskId) || null
    },
    listActiveBySession() {
      return []
    },
    findLatestRecoverable() {
      return null
    },
  }
  return { repository: repository as unknown as SkillTaskRunRepository, rows }
}

test('DetachedSkillTaskTracker starts a skill task and persists done outputs', async () => {
  const path = storagePath()
  const tracker = new DetachedSkillTaskTracker({
    storagePath: path,
    runSkill: async (request) => successfulLongSkillResult(request),
  })

  const started = tracker.start({
    scopeId: 'scope-long',
    skillId: 'long-report-skill',
    action: 'run_report',
    params: { url: 'https://example.test/video' },
  })

  assert.equal(started.status, 'running')
  const done = await tracker.waitForTask(started.id)
  assert.equal(done?.status, 'done')
  assert.equal(done?.outputDir, '/tmp/video/out')
  assert.equal(done?.runStatePath, '/tmp/video/out/run_state.json')
  assert.equal(done?.sceneScoresPath, '/tmp/video/out/scene_scores.json')

  const restored = new DetachedSkillTaskTracker({
    storagePath: path,
    runSkill: async (request) => successfulLongSkillResult(request),
  })
  assert.equal(restored.inspect(started.id)?.status, 'done')
})

test('DetachedSkillTaskTracker preserves parent task linkage for detached handoff', async () => {
  const path = storagePath()
  const tracker = new DetachedSkillTaskTracker({
    storagePath: path,
    runSkill: async (request) => successfulLongSkillResult(request),
  })

  const started = tracker.start({
    scopeId: 'scope-long',
    sessionId: 'session-long',
    agent: 'assistant',
    skillId: 'long-report-skill',
    action: 'run_report',
    params: { url: 'https://example.test/video' },
    parentTaskId: 'parent-task',
    parentStepId: 'parent-step',
    taskProjectionId: 'projection-parent',
  })

  assert.equal(started.parentTaskId, 'parent-task')
  assert.equal(started.parentStepId, 'parent-step')
  assert.equal(started.taskProjectionId, 'projection-parent')

  await tracker.waitForTask(started.id)
  const restored = new DetachedSkillTaskTracker({
    storagePath: path,
    runSkill: async (request) => successfulLongSkillResult(request),
  })
  assert.equal(restored.inspect(started.id)?.parentTaskId, 'parent-task')
  assert.equal(restored.inspect(started.id)?.parentStepId, 'parent-step')
  assert.equal(restored.inspect(started.id)?.taskProjectionId, 'projection-parent')
})

test('DetachedSkillTaskTracker cancel aborts the running skill action', async () => {
  const path = storagePath()
  let seenSignal: AbortSignal | undefined
  const tracker = new DetachedSkillTaskTracker({
    storagePath: path,
    runSkill: (request) => new Promise<SkillRunResult>((resolve) => {
      seenSignal = request.signal
      request.signal?.addEventListener('abort', () => {
        resolve({
          success: false,
          skillId: request.skillId,
          action: request.action,
          stdout: '',
          stderr: '',
          command: [],
          error: 'aborted',
        })
      }, { once: true })
    }),
  })

  const started = tracker.start({
    scopeId: 'scope-long',
    skillId: 'long-report-skill',
    action: 'score_report',
    params: { sceneScoresPath: '/tmp/video/out/scene_scores.json' },
  })
  const cancelled = tracker.cancel(started.id)

  assert.equal(cancelled?.status, 'cancelled')
  assert.equal(seenSignal?.aborted, true)
  assert.equal((await tracker.waitForTask(started.id))?.status, 'cancelled')
})

test('DetachedSkillTaskTracker double writes start and cancel to the same task run', async () => {
  const { repository, rows } = createTaskRunRepositoryHarness()
  registerSkillTaskRunRepository(repository)
  const path = storagePath()
  const tracker = new DetachedSkillTaskTracker({
    storagePath: path,
    runSkill: (request) => new Promise<SkillRunResult>((resolve) => {
      request.signal?.addEventListener('abort', () => {
        resolve({
          success: false,
          skillId: request.skillId,
          action: request.action,
          stdout: '',
          stderr: '',
          command: [],
          error: 'aborted',
        })
      }, { once: true })
    }),
  })

  const started = tracker.start({
    scopeId: 'scope-long',
    sessionId: 'session-long',
    skillId: 'long-report-skill',
    action: 'score_report',
    params: { sceneScoresPath: '/tmp/video/out/scene_scores.json' },
  })
  assert.equal(rows.size, 1)
  const runAfterStart = Array.from(rows.values())[0]
  assert.equal(runAfterStart?.detachedTaskId, started.id)
  assert.equal(runAfterStart?.status, 'running')

  tracker.cancel(started.id)
  await tracker.waitForTask(started.id)

  assert.equal(rows.size, 1)
  const runAfterCancel = Array.from(rows.values())[0]
  assert.equal(runAfterCancel?.id, runAfterStart?.id)
  assert.equal(runAfterCancel?.detachedTaskId, started.id)
  assert.equal(runAfterCancel?.status, 'cancelled')

  registerSkillTaskRunRepository(null)
})

test('DetachedSkillTaskTracker marks running tasks blocked after restart', () => {
  const path = storagePath()
  const root = mkdtempSync(join(tmpdir(), 'ready-detached-skill-out-'))
  const videoDir = join(root, 'video-slug')
  mkdirSync(videoDir, { recursive: true })
  writeFileSync(join(videoDir, 'run_state.json'), '{"task_id":"dst-restart","status":"blocked"}', 'utf-8')
  writeFileSync(path, JSON.stringify({
    tasks: [{
      id: 'dst-restart',
      scopeId: 'scope-long',
      sessionId: 'scope-long',
      skillId: 'long-report-skill',
      action: 'run_report',
      params: { outputDir: root },
      status: 'running',
      startedAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    }],
  }), 'utf-8')

  const tracker = new DetachedSkillTaskTracker({
    storagePath: path,
    runSkill: async (request) => successfulLongSkillResult(request),
  })

  const restored = tracker.inspect('dst-restart')
  assert.equal(restored?.status, 'blocked')
  assert.equal(restored?.outputDir, videoDir)
  assert.equal(restored?.runStatePath, join(videoDir, 'run_state.json'))
  assert.match(restored?.error || '', /restart/i)
})

test('DetachedSkillTaskTracker restart recovery uses task identity instead of newest run_state mtime', () => {
  const path = storagePath()
  const root = mkdtempSync(join(tmpdir(), 'ready-detached-skill-out-'))
  try {
    const targetDir = join(root, 'task-a')
    const otherDir = join(root, 'task-b')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(otherDir, { recursive: true })
    const targetRunState = join(targetDir, 'run_state.json')
    const otherRunState = join(otherDir, 'run_state.json')
    writeFileSync(targetRunState, JSON.stringify({
      task_id: 'task-a',
      current_stage: 'score_batches',
    }), 'utf-8')
    writeFileSync(otherRunState, JSON.stringify({
      task_id: 'task-b',
      current_stage: 'completed',
    }), 'utf-8')
    utimesSync(targetRunState, new Date('2026-04-28T00:00:00.000Z'), new Date('2026-04-28T00:00:00.000Z'))
    utimesSync(otherRunState, new Date('2026-04-28T00:05:00.000Z'), new Date('2026-04-28T00:05:00.000Z'))
    writeFileSync(path, JSON.stringify({
      tasks: [{
        id: 'dst-task-identity',
        scopeId: 'scope-long',
        sessionId: 'scope-long',
        skillId: 'long-report-skill',
        action: 'run_report',
        params: { outputDir: root, taskId: 'task-a' },
        status: 'running',
        startedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      }],
    }), 'utf-8')

    const tracker = new DetachedSkillTaskTracker({
      storagePath: path,
      runSkill: async (request) => successfulLongSkillResult(request),
    })

    const restored = tracker.inspect('dst-task-identity')
    assert.equal(restored?.outputDir, targetDir)
    assert.equal(restored?.runStatePath, targetRunState)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DetachedSkillTaskTracker restart recovery skips mismatched root run_state', () => {
  const path = storagePath()
  const root = mkdtempSync(join(tmpdir(), 'ready-detached-skill-out-'))
  try {
    const targetDir = join(root, 'task-a')
    mkdirSync(targetDir, { recursive: true })
    const rootRunState = join(root, 'run_state.json')
    const targetRunState = join(targetDir, 'run_state.json')
    writeFileSync(rootRunState, JSON.stringify({
      task_id: 'task-b',
      current_stage: 'completed',
    }), 'utf-8')
    writeFileSync(targetRunState, JSON.stringify({
      task_id: 'task-a',
      current_stage: 'score_batches',
    }), 'utf-8')
    writeFileSync(path, JSON.stringify({
      tasks: [{
        id: 'dst-root-mismatch',
        scopeId: 'scope-long',
        sessionId: 'scope-long',
        skillId: 'long-report-skill',
        action: 'run_report',
        params: { outputDir: root, taskId: 'task-a' },
        status: 'running',
        startedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      }],
    }), 'utf-8')

    const tracker = new DetachedSkillTaskTracker({
      storagePath: path,
      runSkill: async (request) => successfulLongSkillResult(request),
    })

    const restored = tracker.inspect('dst-root-mismatch')
    assert.equal(restored?.outputDir, targetDir)
    assert.equal(restored?.runStatePath, targetRunState)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DetachedSkillTaskTracker restart recovery does not fall back to mismatched root run_state', () => {
  const path = storagePath()
  const root = mkdtempSync(join(tmpdir(), 'ready-detached-skill-out-'))
  try {
    const rootRunState = join(root, 'run_state.json')
    writeFileSync(rootRunState, JSON.stringify({
      task_id: 'other-task',
      current_stage: 'completed',
    }), 'utf-8')
    writeFileSync(path, JSON.stringify({
      tasks: [{
        id: 'dst-no-match',
        scopeId: 'scope-long',
        sessionId: 'scope-long',
        skillId: 'long-report-skill',
        action: 'run_report',
        params: { outputDir: root, taskId: 'expected-task' },
        status: 'running',
        startedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      }],
    }), 'utf-8')

    const tracker = new DetachedSkillTaskTracker({
      storagePath: path,
      runSkill: async (request) => successfulLongSkillResult(request),
    })

    const restored = tracker.inspect('dst-no-match')
    assert.equal(restored?.status, 'blocked')
    assert.equal(restored?.outputDir, null)
    assert.equal(restored?.runStatePath, null)
    assert.match(restored?.error || '', /No run_state path was found/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DetachedSkillTaskTracker restart recovery falls back to detached id as run_state identity', () => {
  const path = storagePath()
  const root = mkdtempSync(join(tmpdir(), 'ready-detached-skill-out-'))
  try {
    const targetDir = join(root, 'target')
    const otherDir = join(root, 'other')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(otherDir, { recursive: true })
    const targetRunState = join(targetDir, 'run_state.json')
    const otherRunState = join(otherDir, 'run_state.json')
    writeFileSync(targetRunState, JSON.stringify({
      task_id: 'dst-fallback-id',
      current_stage: 'score_batches',
    }), 'utf-8')
    writeFileSync(otherRunState, JSON.stringify({
      task_id: 'other-task',
      current_stage: 'completed',
    }), 'utf-8')
    utimesSync(targetRunState, new Date('2026-04-28T00:00:00.000Z'), new Date('2026-04-28T00:00:00.000Z'))
    utimesSync(otherRunState, new Date('2026-04-28T00:05:00.000Z'), new Date('2026-04-28T00:05:00.000Z'))
    writeFileSync(path, JSON.stringify({
      tasks: [{
        id: 'dst-fallback-id',
        scopeId: 'scope-long',
        sessionId: 'scope-long',
        skillId: 'long-report-skill',
        action: 'run_report',
        params: { outputDir: root },
        status: 'running',
        startedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      }],
    }), 'utf-8')

    const tracker = new DetachedSkillTaskTracker({
      storagePath: path,
      runSkill: async (request) => successfulLongSkillResult(request),
    })

    const restored = tracker.inspect('dst-fallback-id')
    assert.equal(restored?.outputDir, targetDir)
    assert.equal(restored?.runStatePath, targetRunState)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
