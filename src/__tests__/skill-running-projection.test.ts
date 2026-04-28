import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildLongSkillRunningProjection } from '../main/modules/agent-control/skill-running-projection'

test('long skill running projection includes run_state and intermediate artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-'))
  try {
    const jobDir = join(root, 'job-1')
    mkdirSync(jobDir, { recursive: true })
    const runStatePath = join(jobDir, 'run_state.json')
    const sceneScoresPath = join(jobDir, 'scene_scores.json')
    const reportPath = join(jobDir, 'analysis_report.md')

    writeFileSync(runStatePath, JSON.stringify({
      status: 'running',
      current_step: 'score_batches',
      completed_steps: ['prepare'],
      waiting_for: 'scene scoring',
      updated_at: '2026-04-27T06:10:00.000Z',
    }), 'utf8')
    writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
    writeFileSync(reportPath, '# report\n', 'utf8')

    const projection = buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: root },
      startedAt: 0,
      now: 65_000,
    })

    assert.match(String(projection.taskSummary), /score_batches/)
    assert.match(String(projection.taskSummary), /中间文件/)
    assert.match(String((projection.steps as Array<{ detail?: string }>)[0]?.detail), /scene scoring/)
    const artifacts = projection.recentArtifacts as Array<{ label: string; path?: string | null }>
    assert.ok(artifacts.some((artifact) => artifact.path === runStatePath && artifact.label === 'run_state.json'))
    assert.ok(artifacts.some((artifact) => artifact.path === sceneScoresPath && artifact.label === 'scene_scores.json'))
    assert.ok(artifacts.some((artifact) => artifact.path === reportPath && artifact.label === 'analysis_report.md'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection infers output directory from sceneScoresPath', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-'))
  try {
    const sceneScoresPath = join(root, 'scene_scores.json')
    const runStatePath = join(root, 'run_state.json')
    writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
    writeFileSync(runStatePath, JSON.stringify({
      status: 'running',
      currentStep: 'merge_validate',
    }), 'utf8')

    const projection = buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_ai_analyze',
      toolInput: { sceneScoresPath },
      startedAt: 0,
      now: 5_000,
    })

    assert.match(String(projection.taskSummary), /merge_validate/)
    const artifacts = projection.recentArtifacts as Array<{ label: string; path?: string | null }>
    assert.ok(artifacts.some((artifact) => artifact.path === sceneScoresPath))
    assert.ok(artifacts.some((artifact) => artifact.path === runStatePath))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection still shows a live confirmation before artifacts exist', () => {
  const projection = buildLongSkillRunningProjection({
    sessionId: 's1',
    toolName: 'skill_video_expert_pipeline',
    toolInput: {},
    startedAt: 0,
    now: 10_000,
  })

  assert.match(String(projection.taskSummary), /工具仍在运行/)
})
