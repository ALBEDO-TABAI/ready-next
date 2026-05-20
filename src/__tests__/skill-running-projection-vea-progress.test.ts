import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildLongSkillRunningProjection } from '../main/modules/agent-control/skills/skill-running-projection'

test('long skill running projection surfaces VEA current_stage and scene coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-vea-projection-'))
  try {
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({
      status: 'running',
      current_stage: 'score_batches',
      total_scenes: 10,
      completed_scenes: 4,
      coverage_ratio: 0.4,
      updated_at: '2026-04-28T01:00:00Z',
    }), 'utf-8')

    const projection = buildLongSkillRunningProjection({
      sessionId: 'scope-vea-projection',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: root },
      startedAt: 0,
      now: 60_000,
    })

    assert.match(String(projection.taskSummary), /score_batches/)
    assert.match(String(projection.taskSummary), /(4\/10|40%)/)
    const steps = projection.steps as Array<{ title?: string; detail?: string }>
    assert.match(String(steps[0]?.title), /score_batches/)
    assert.match(String(steps[0]?.detail), /(4\/10|40%)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection prefers artifact-derived VEA progress over stale run_state progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-vea-projection-stale-'))
  try {
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({
      status: 'running',
      current_stage: 'score_batches',
      total_scenes: 97,
      completed_scenes: 97,
      coverage_ratio: 1,
      updated_at: '2026-04-28T01:00:00Z',
    }), 'utf-8')
    writeFileSync(join(root, 'scene_scores.json'), JSON.stringify({
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

    const projection = buildLongSkillRunningProjection({
      sessionId: 'scope-vea-projection',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: root },
      startedAt: 0,
      now: 60_000,
    })

    assert.match(String(projection.taskSummary), /0\/97/)
    assert.doesNotMatch(String(projection.taskSummary), /97\/97/)
    const steps = projection.steps as Array<{ detail?: string }>
    assert.match(String(steps[0]?.detail), /0\/97/)
    assert.doesNotMatch(String(steps[0]?.detail), /97\/97/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
