import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executeInspectRunState } from '../main/modules/tools/skill-primitives/inspect-run-state'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ready-vea-run-state-'))
}

function outputData(output: unknown): any {
  return (output as { data: any }).data
}

test('skill_inspect_run_state extracts VEA stage and scene progress fields', async () => {
  const dir = makeTempDir()
  try {
    writeFileSync(join(dir, 'run_state.json'), JSON.stringify({
      version: 'vnext',
      status: 'running',
      current_stage: 'score_batches',
      completed_stages: ['prepare'],
      total_scenes: 10,
      completed_scenes: 4,
      coverage_ratio: 0.4,
      updated_at: '2026-04-28T01:00:00Z',
    }), 'utf-8')

    const data = outputData(await executeInspectRunState({ outputDir: dir }))

    assert.equal(data.found, true)
    assert.equal(data.summary.currentStage, 'score_batches')
    assert.deepEqual(data.summary.completedStages, ['prepare'])
    assert.equal(data.summary.totalScenes, 10)
    assert.equal(data.summary.completedScenes, 4)
    assert.equal(data.summary.coverageRatio, 0.4)
    assert.equal(data.summary.status, 'running')
    assert.equal(data.summary.updatedAt, '2026-04-28T01:00:00Z')
    assert.ok(data.summary.knownKeysFound.includes('currentStage'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill_inspect_run_state uses expectedTaskId instead of newest mtime when identity is known', async () => {
  const root = makeTempDir()
  try {
    const targetDir = join(root, 'task-old')
    const otherDir = join(root, 'task-new')
    mkdirSync(targetDir)
    mkdirSync(otherDir)
    const targetRunState = join(targetDir, 'run_state.json')
    const otherRunState = join(otherDir, 'run_state.json')
    writeFileSync(targetRunState, JSON.stringify({
      task_id: 'target',
      current_stage: 'score_batches',
      status: 'running',
    }), 'utf-8')
    writeFileSync(otherRunState, JSON.stringify({
      task_id: 'other',
      current_stage: 'completed',
      status: 'completed',
    }), 'utf-8')
    utimesSync(targetRunState, new Date('2026-04-28T01:00:00Z'), new Date('2026-04-28T01:00:00Z'))
    utimesSync(otherRunState, new Date('2026-04-28T01:05:00Z'), new Date('2026-04-28T01:05:00Z'))

    const data = outputData(await executeInspectRunState({
      outputDir: root,
      expectedTaskId: 'target',
    } as any))

    assert.equal(data.runStatePath, targetRunState)
    assert.equal(data.summary.taskId, 'target')
    assert.equal(data.summary.currentStage, 'score_batches')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill_inspect_run_state skips mismatched root run_state when matching child exists', async () => {
  const root = makeTempDir()
  try {
    const targetDir = join(root, 'task-target')
    mkdirSync(targetDir)
    const rootRunState = join(root, 'run_state.json')
    const targetRunState = join(targetDir, 'run_state.json')
    writeFileSync(rootRunState, JSON.stringify({
      task_id: 'other',
      current_stage: 'completed',
      status: 'completed',
    }), 'utf-8')
    writeFileSync(targetRunState, JSON.stringify({
      task_id: 'target',
      current_stage: 'score_batches',
      status: 'running',
    }), 'utf-8')
    utimesSync(rootRunState, new Date('2026-04-28T01:05:00Z'), new Date('2026-04-28T01:05:00Z'))
    utimesSync(targetRunState, new Date('2026-04-28T01:00:00Z'), new Date('2026-04-28T01:00:00Z'))

    const data = outputData(await executeInspectRunState({
      outputDir: root,
      expectedTaskId: 'target',
    } as any))

    assert.equal(data.runStatePath, targetRunState)
    assert.equal(data.summary.taskId, 'target')
    assert.equal(data.summary.currentStage, 'score_batches')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill_inspect_run_state uses detached task id as default expectedTaskId', async () => {
  const root = makeTempDir()
  try {
    const targetDir = join(root, 'task-target')
    const otherDir = join(root, 'task-other')
    mkdirSync(targetDir)
    mkdirSync(otherDir)
    const targetRunState = join(targetDir, 'run_state.json')
    const otherRunState = join(otherDir, 'run_state.json')
    writeFileSync(targetRunState, JSON.stringify({
      task_id: 'dst-target',
      current_stage: 'score_batches',
      status: 'running',
    }), 'utf-8')
    writeFileSync(otherRunState, JSON.stringify({
      task_id: 'dst-other',
      current_stage: 'completed',
      status: 'completed',
    }), 'utf-8')
    utimesSync(targetRunState, new Date('2026-04-28T01:00:00Z'), new Date('2026-04-28T01:00:00Z'))
    utimesSync(otherRunState, new Date('2026-04-28T01:05:00Z'), new Date('2026-04-28T01:05:00Z'))

    const tracker = {
      inspect: () => ({
        id: 'dst-target',
        scopeId: 'scope-vea',
        sessionId: 'scope-vea',
        skillId: 'video-expert-analyzer',
        action: 'video_expert_pipeline',
        params: { outputDir: root },
        status: 'running',
        outputDir: root,
        runStatePath: null,
        startedAt: '2026-04-28T01:00:00.000Z',
        updatedAt: '2026-04-28T01:00:00.000Z',
      }),
    }
    const detachedModule = await import('../main/modules/agent-control/detached-skill-task-tracker')
    detachedModule.registerDetachedSkillTaskTracker(tracker as any)

    const data = outputData(await executeInspectRunState({ taskId: 'dst-target' }))

    assert.equal(data.runStatePath, targetRunState)
    assert.equal(data.expectedTaskId, 'dst-target')
    assert.equal(data.summary.taskId, 'dst-target')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill_inspect_run_state returns ambiguity instead of silently choosing newest candidate', async () => {
  const root = makeTempDir()
  try {
    const firstDir = join(root, 'a')
    const secondDir = join(root, 'b')
    mkdirSync(firstDir)
    mkdirSync(secondDir)
    writeFileSync(join(firstDir, 'run_state.json'), JSON.stringify({
      current_stage: 'score_batches',
      status: 'running',
    }), 'utf-8')
    writeFileSync(join(secondDir, 'run_state.json'), JSON.stringify({
      current_stage: 'finalize',
      status: 'running',
    }), 'utf-8')

    const data = outputData(await executeInspectRunState({ outputDir: root }))

    assert.equal(data.ambiguous, true)
    assert.equal(data.runStatePath, null)
    assert.equal(data.candidates.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill_inspect_run_state exposes expectedTaskId through schema and dispatch', () => {
  const schemaSource = readFileSync(
    new URL('../main/modules/tools/skill-primitives/primitive-schemas.ts', import.meta.url),
    'utf-8',
  )
  const dispatchSource = readFileSync(
    new URL('../main/modules/tools/skills-tools.ts', import.meta.url),
    'utf-8',
  )

  assert.match(schemaSource, /expectedTaskId/)
  assert.match(schemaSource, /run_state\.json\.task_id/)
  assert.match(dispatchSource, /expectedTaskId/)
  assert.match(dispatchSource, /executeInspectRunState\(\{[\s\S]*expectedTaskId/)
})
