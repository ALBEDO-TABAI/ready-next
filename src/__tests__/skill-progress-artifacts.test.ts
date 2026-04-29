import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { inspectSkillProgressArtifacts } from '../main/modules/agent-control/skill-progress-artifacts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ready-skill-progress-'))
}

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, JSON.stringify(payload), 'utf8')
}

function completeScene(sceneNumber = 1): Record<string, unknown> {
  return {
    scene_number: sceneNumber,
    type_classification: 'cinematic_vlog',
    description: 'A finished visual description.',
    visual_summary: 'Finished.',
    scores: {
      aesthetic_beauty: 8,
      credibility: 7,
      impact: 8,
      memorability: 7,
      fun_interest: 6,
    },
    weighted_score: 7.4,
    selection: '[USABLE]',
    selection_reasoning: 'Clear enough to keep.',
    edit_suggestion: 'Use as a transition.',
    storyboard: {
      shot_size: 'medium',
      lighting: 'soft',
      camera_movement: 'pan',
      visual_style: 'documentary',
      technique: 'cutaway',
    },
  }
}

function writeSceneScores(root: string, scenes: Record<string, unknown>[]): void {
  writeJson(join(root, 'scene_scores.json'), {
    total_scenes: scenes.length,
    scenes,
  })
}

function writeHostBatch(root: string, scene: Record<string, unknown>, receiptStatus: string): void {
  const hostDir = join(root, 'host_batches')
  mkdirSync(hostDir, { recursive: true })
  writeJson(join(hostDir, 'index.json'), {
    total_scenes: 1,
    total_batches: 1,
    completed_scenes: receiptStatus === 'completed' ? 1 : 0,
    coverage_ratio: receiptStatus === 'completed' ? 1 : 0,
    batches: [{
      batch_id: 'batch-001',
      scene_numbers: [1],
      output: 'batch-001-output.json',
      status: receiptStatus,
    }],
  })
  writeJson(join(hostDir, 'batch-001-output.json'), {
    batch_id: 'batch-001',
    receipt: {
      status: receiptStatus,
      has_todo: receiptStatus !== 'completed',
      needs_review: [],
    },
    scenes: [scene],
  })
}

test('inspectSkillProgressArtifacts counts empty VEA scene templates as zero completed', () => {
  const root = tempRoot()
  try {
    writeSceneScores(root, Array.from({ length: 97 }, (_, index) => ({
      scene_number: index + 1,
      scores: {},
      weighted_score: 0,
      type_classification: '',
      description: '',
      selection_reasoning: '',
      edit_suggestion: '',
      storyboard: {},
    })))

    const progress = inspectSkillProgressArtifacts({ outputDir: root })

    assert.equal(progress.totalScenes, 97)
    assert.equal(progress.completedScenes, 0)
    assert.equal(progress.coverageRatio, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inspectSkillProgressArtifacts rejects scores-only and TODO-like scene data', () => {
  const root = tempRoot()
  try {
    writeSceneScores(root, [
      { ...completeScene(1), scores: {} },
      { ...completeScene(2), weighted_score: 0 },
      { ...completeScene(3), description: 'TODO: fill this later' },
    ])

    const progress = inspectSkillProgressArtifacts({ outputDir: root })

    assert.equal(progress.totalScenes, 3)
    assert.equal(progress.completedScenes, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inspectSkillProgressArtifacts does not trust a completed receipt when scenes are incomplete', () => {
  const root = tempRoot()
  try {
    const incomplete = { scene_number: 1, scores: {}, storyboard: {} }
    writeSceneScores(root, [incomplete])
    writeHostBatch(root, incomplete, 'completed')

    const progress = inspectSkillProgressArtifacts({ outputDir: root })

    assert.equal(progress.completedScenes, 0)
    assert.equal(progress.hostBatches?.totalBatches, 1)
    assert.equal(progress.hostBatches?.completedBatches, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inspectSkillProgressArtifacts counts a completed receipt only when scenes are complete', () => {
  const root = tempRoot()
  try {
    const scene = completeScene(1)
    writeSceneScores(root, [scene])
    writeHostBatch(root, scene, 'completed')

    const progress = inspectSkillProgressArtifacts({ outputDir: root })

    assert.equal(progress.totalScenes, 1)
    assert.equal(progress.completedScenes, 1)
    assert.equal(progress.coverageRatio, 1)
    assert.equal(progress.hostBatches?.completedBatches, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
