import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { executeSkillTool } from '../main/modules/tools/skills-tools'
import { executeInspectRunState } from '../main/modules/tools/skill-primitives/inspect-run-state'
import { executeReadArtifact } from '../main/modules/tools/skill-primitives/read-artifact'

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

test('skill_inspect_run_state accepts explicit runStatePath and derives outputDir', async () => {
  const dir = makeTempDir()
  try {
    const runStatePath = join(dir, 'run_state.json')
    writeFileSync(runStatePath, JSON.stringify({
      version: 'vnext',
      status: 'running',
      current_stage: 'score_batches',
      total_scenes: 12,
      completed_scenes: 3,
    }), 'utf-8')

    const data = outputData(await executeInspectRunState({ runStatePath } as any))

    assert.equal(data.found, true)
    assert.equal(data.outputDir, dirname(runStatePath))
    assert.equal(data.runStatePath, runStatePath)
    assert.equal(data.summary.currentStage, 'score_batches')
    assert.equal(data.summary.totalScenes, 12)
    assert.equal(data.summary.completedScenes, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill_inspect_run_state reports missing explicit runStatePath without throwing', async () => {
  const dir = makeTempDir()
  try {
    const runStatePath = join(dir, 'new-task', 'run_state.json')

    const data = outputData(await executeInspectRunState({ runStatePath } as any))

    assert.equal(data.found, false)
    assert.equal(data.errorKind, 'not_found')
    assert.equal(data.runStatePath, null)
    assert.equal(data.outputDir, dirname(runStatePath))
    assert.equal(data.summary, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill_inspect_run_state reports missing outputDir without throwing', async () => {
  const dir = makeTempDir()
  const outputDir = join(dir, 'does-not-exist')
  try {
    const data = outputData(await executeInspectRunState({ outputDir }))

    assert.equal(data.found, false)
    assert.equal(data.errorKind, 'outputdir_not_found')
    assert.equal(data.outputDir, outputDir)
    assert.equal(data.runStatePath, null)
    assert.equal(data.summary, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill_inspect_run_state returns artifact progress and reconciled paused liveness for stale VEA output', async () => {
  const dir = makeTempDir()
  try {
    writeFileSync(join(dir, 'run_state.json'), JSON.stringify({
      version: 'vnext',
      status: 'running',
      current_stage: 'score_batches',
      total_scenes: 97,
      completed_scenes: 97,
      coverage_ratio: 1,
      updated_at: '2026-04-28T01:00:00Z',
    }), 'utf-8')
    writeFileSync(join(dir, 'scene_scores.json'), JSON.stringify({
      total_scenes: 97,
      scenes: Array.from({ length: 97 }, (_, index) => ({
        scene_number: index + 1,
        scores: {},
        weighted_score: 0,
        type_classification: '',
        description: '',
        selection_reasoning: '',
        edit_suggestion: '',
        storyboard: {},
      })),
    }), 'utf-8')
    const hostDir = join(dir, 'host_batches')
    mkdirSync(hostDir)
    writeFileSync(join(hostDir, 'index.json'), JSON.stringify({
      total_scenes: 97,
      total_batches: 17,
      completed_scenes: 0,
      coverage_ratio: 0,
      batches: Array.from({ length: 17 }, (_, index) => ({
        batch_id: `batch-${String(index + 1).padStart(3, '0')}`,
        scene_numbers: [index + 1],
        output: `batch-${String(index + 1).padStart(3, '0')}-output.json`,
        status: 'pending',
      })),
    }), 'utf-8')

    const data = outputData(await executeInspectRunState({ outputDir: dir }))

    assert.equal(data.summary.completedScenes, 97)
    assert.equal(data.artifactProgress.totalScenes, 97)
    assert.equal(data.artifactProgress.completedScenes, 0)
    assert.equal(data.artifactProgress.coverageRatio, 0)
    assert.equal(data.artifactProgress.hostBatches.totalBatches, 17)
    assert.equal(data.artifactProgress.hostBatches.completedBatches, 0)
    assert.equal(data.artifactProgress.hostBatches.statusCounts.pending, 17)
    assert.equal(data.reconciledLiveness, 'recoverable_paused')
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

test('skill_inspect_run_state returns identity_mismatch with candidate summaries', async () => {
  const root = makeTempDir()
  try {
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({
      task_id: 'other-task',
      current_stage: 'completed',
      status: 'completed',
    }), 'utf-8')

    const data = outputData(await executeInspectRunState({
      outputDir: root,
      expectedTaskId: 'target-task',
    } as any))

    assert.equal(data.found, false)
    assert.equal(data.ambiguous, false)
    assert.equal(data.identityMismatch, true)
    assert.equal(data.errorKind, 'identity_mismatch')
    assert.equal(data.candidates.length, 1)
    assert.equal(data.candidates[0].taskId, 'other-task')
    assert.equal(data.summary, null)
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

test('skill_read_artifact accepts VEA outputDir when additionalAllowedReadRoots includes it (Stage 5)', async () => {
  // Mirrors the VEA fixture from route §3.4: the active task's run_state.json
  // lives outside `<outputsRoot>/<skillId>/`. With the Stage 5 additional
  // read roots wiring, the model can read it via `skill_read_artifact`
  // without falling back to `skill_run_shell cat`.
  const fs = await import('node:fs')
  const taskOutputDir = fs.realpathSync.native(makeTempDir())
  const skillArtifactRoot = fs.realpathSync.native(makeTempDir())
  try {
    const runStatePath = join(taskOutputDir, 'run_state.json')
    writeFileSync(runStatePath, JSON.stringify({
      status: 'running',
      current_stage: 'score_batches',
      total_scenes: 97,
      completed_scenes: 0,
    }), 'utf-8')

    const output = await executeReadArtifact(
      { relativePath: runStatePath },
      {
        skillId: 'video-expert-analyzer',
        lookupSkillRoots: () => ({
          skillId: 'video-expert-analyzer',
          artifactRoot: skillArtifactRoot,
          assetRoot: skillArtifactRoot,
        }),
        additionalAllowedReadRoots: [taskOutputDir],
      },
    )
    const data = (output as any).data as Record<string, unknown>
    assert.equal(data.absolutePath, runStatePath)
    assert.match(String(data.content), /score_batches/)
    assert.match(String(data.content), /completed_scenes/)
  } finally {
    rmSync(taskOutputDir, { recursive: true, force: true })
    rmSync(skillArtifactRoot, { recursive: true, force: true })
  }
})

test('skill_inspect_run_state dispatch forwards expectedTaskId to select the matching run_state', async () => {
  const root = makeTempDir()
  try {
    const targetDir = join(root, 'task-target')
    const otherDir = join(root, 'task-other')
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

    const output = await executeSkillTool(
      'skill_inspect_run_state',
      { outputDir: root, expectedTaskId: 'target' },
      undefined,
      undefined,
      undefined,
      undefined,
      { frameSkillId: 'video-expert-analyzer' },
    )
    const data = outputData(output)
    assert.equal(data.runStatePath, targetRunState)
    assert.equal(data.expectedTaskId, 'target')
    assert.equal(data.summary.taskId, 'target')
    assert.equal(data.summary.currentStage, 'score_batches')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill_inspect_run_state dispatch forwards runStatePath instead of forcing read_artifact fallback', async () => {
  const root = makeTempDir()
  try {
    const runStatePath = join(root, 'run_state.json')
    writeFileSync(runStatePath, JSON.stringify({
      task_id: 'target',
      current_stage: 'score_batches',
      status: 'running',
    }), 'utf-8')

    const output = await executeSkillTool(
      'skill_inspect_run_state',
      { runStatePath },
      undefined,
      undefined,
      undefined,
      undefined,
      { frameSkillId: 'video-expert-analyzer' },
    )
    const data = outputData(output)
    assert.equal(data.runStatePath, runStatePath)
    assert.equal(data.summary.taskId, 'target')
    assert.equal(data.summary.currentStage, 'score_batches')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * Stage A3 — next-frame artifact continuity assertion.
 *
 * After `executeInspectRunState` discovers `sceneScoresPath` (because the
 * VEA output dir contains `scene_scores.json`), the tool result MUST emit a
 * `framePatch` carrying that path so the next frame sees it WITHOUT
 * re-resolving from summary text or re-running the inspect.
 *
 * Currently fails (Stage A3 contract): `inspect-run-state.ts` only returns
 * `data` — no `framePatch`. Gamma (Wave 2 Step D3) will land the framePatch
 * emission. After Gamma's change + Beta's durable slot persistence (already
 * in `applyTurnFramePatch`), this assertion turns GREEN.
 *
 * Plan §6 Stage A3 expected current result:
 *   "FAIL because framePatch producers are missing or roots are re-resolved
 *    elsewhere"
 */
test('A3: skill_inspect_run_state result carries framePatch.runContract.artifactPaths.sceneScoresPath into the next frame', async () => {
  const dir = makeTempDir()
  try {
    // Synthetic VEA output: run_state.json + scene_scores.json so the
    // inspect tool discovers `sceneScoresPath` via inspectSkillProgressArtifacts.
    writeFileSync(join(dir, 'run_state.json'), JSON.stringify({
      version: 'vnext',
      status: 'running',
      current_stage: 'score_batches',
      total_scenes: 5,
      completed_scenes: 2,
      coverage_ratio: 0.4,
      updated_at: '2026-04-29T01:00:00Z',
    }), 'utf-8')
    const scenesPath = join(dir, 'scene_scores.json')
    writeFileSync(scenesPath, JSON.stringify({
      total_scenes: 5,
      scenes: Array.from({ length: 5 }, (_, index) => ({
        scene_number: index + 1,
        scores: {},
      })),
    }), 'utf-8')

    const output = await executeInspectRunState({ outputDir: dir })

    // Sanity: the tool DOES discover the scene scores path in `data.artifactProgress`.
    const data = (output as { data?: any }).data
    assert.ok(data, 'expected structured tool output')
    assert.equal(
      data.artifactProgress.sceneScoresPath,
      scenesPath,
      'baseline: inspect-run-state should discover sceneScoresPath via artifactProgress',
    )

    // Stage A3 assertion — discovered path MUST flow into the next frame
    // through `framePatch.runContract.artifactPaths.sceneScoresPath`. Without
    // this, the next frame's steering layer has to re-guess from summary
    // text or re-run inspect, which is the gap Stage D3 closes.
    const framePatch = (output as { framePatch?: unknown }).framePatch
    assert.ok(
      framePatch && typeof framePatch === 'object',
      'Stage A3 regression: skill_inspect_run_state did not emit a framePatch — next frame cannot see the discovered sceneScoresPath without re-guessing.',
    )
    const runContract = (framePatch as { runContract?: { artifactPaths?: { sceneScoresPath?: string | null } } }).runContract
    assert.ok(
      runContract && runContract.artifactPaths,
      'Stage A3 regression: framePatch.runContract.artifactPaths missing — discovered paths cannot survive into the next turn frame.',
    )
    assert.equal(
      runContract.artifactPaths!.sceneScoresPath,
      scenesPath,
      'Stage A3 regression: framePatch.runContract.artifactPaths.sceneScoresPath did not match the path the inspect already discovered.',
    )
    assert.equal(
      (framePatch as any).runContract?.action,
      'video_expert_ai_analyze',
      'VEA progress stage score_batches must resolve to the executable ai_analyze action when scene_scores.json exists.',
    )
    assert.equal(
      (framePatch as any).runContract?.progress?.stage,
      'score_batches',
      'VEA progress stage must remain visible as progress, not disappear into action.',
    )
    assert.equal(
      (framePatch as any).skillStatusUpdates?.action,
      'video_expert_ai_analyze',
      'skillStatusUpdates.action must never receive the raw VEA progress stage.',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
