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

test('inspectSkillProgressArtifacts exposes batch activity without counting incomplete scenes as completed', () => {
  const root = tempRoot()
  try {
    const incomplete = { scene_number: 1, scores: {}, storyboard: {} }
    writeSceneScores(root, [incomplete])
    const hostDir = join(root, 'host_batches')
    mkdirSync(hostDir, { recursive: true })
    writeJson(join(hostDir, 'index.json'), {
      total_scenes: 2,
      batches: [
        {
          batch_id: 'batch-001',
          scene_numbers: [1],
          output: 'batch-001-output.json',
          status: 'completed',
        },
        {
          batch_id: 'batch-002',
          scene_numbers: [2],
          output: 'batch-002-output.json',
          status: 'in_progress',
        },
      ],
    })
    writeJson(join(hostDir, 'batch-001-output.json'), {
      batch_id: 'batch-001',
      receipt: {
        status: 'completed',
        has_todo: false,
        needs_review: [],
      },
      scenes: [incomplete],
    })
    writeJson(join(hostDir, 'batch-002-output.json'), {
      batch_id: 'batch-002',
      receipt: {
        status: 'in_progress',
        has_todo: true,
        needs_review: [],
      },
      scenes: [],
    })

    const progress = inspectSkillProgressArtifacts({ outputDir: root })

    assert.equal(progress.completedScenes, 0)
    assert.equal(progress.hostBatches?.totalBatches, 2)
    assert.equal(progress.hostBatches?.completedBatches, 0)
    assert.deepEqual(progress.activity, {
      completedUnits: 1,
      totalUnits: 2,
      unitLabel: 'batch',
      summary: '1/2 batches completed; 1 in progress',
      updatedAt: progress.activity?.updatedAt,
      fingerprint: progress.activity?.fingerprint,
      estimatedCompletedScenes: 1,
      totalScenes: 2,
    })
    assert.match(progress.activity?.updatedAt || '', /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(typeof progress.activity?.fingerprint, 'string')
    assert.ok((progress.activity?.fingerprint.length || 0) > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inspectSkillProgressArtifacts uses completed scenes from in-progress batch outputs as live activity', () => {
  const root = tempRoot()
  try {
    const first = completeScene(1)
    const second = completeScene(2)
    writeSceneScores(root, [
      first,
      { scene_number: 2, scores: {}, storyboard: {} },
      { scene_number: 3, scores: {}, storyboard: {} },
    ])
    const hostDir = join(root, 'host_batches')
    mkdirSync(hostDir, { recursive: true })
    writeJson(join(hostDir, 'index.json'), {
      total_scenes: 3,
      batches: [
        {
          batch_id: 'batch-001',
          scene_numbers: [1, 2, 3],
          output: 'batch-001-output.json',
          status: 'pending',
        },
      ],
    })
    writeJson(join(hostDir, 'batch-001-output.json'), {
      batch_id: 'batch-001',
      receipt: {
        status: 'in_progress',
        has_todo: true,
        needs_review: [],
      },
      scenes: [
        first,
        second,
        { scene_number: 3, scores: {}, storyboard: {} },
      ],
    })

    const progress = inspectSkillProgressArtifacts({ outputDir: root })

    assert.equal(progress.totalScenes, 3)
    assert.equal(progress.completedScenes, 2)
    assert.equal(progress.coverageRatio, 0.6667)
    assert.deepEqual(progress.activity, {
      completedUnits: 2,
      totalUnits: 3,
      unitLabel: 'scene',
      summary: '评分场景 2/3',
      updatedAt: progress.activity?.updatedAt,
      fingerprint: progress.activity?.fingerprint,
      totalScenes: 3,
    })
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

test('inspectSkillProgressArtifacts exposes structured pending audiovisual handoff state', () => {
  const root = tempRoot()
  try {
    writeSceneScores(root, [completeScene(1)])
    const handoffDir = join(root, 'audiovisual_handoff', 'body')
    mkdirSync(handoffDir, { recursive: true })
    writeJson(join(root, 'audiovisual_handoff', 'receipt.json'), {
      updated_at: '2026-05-04T08:00:00.000Z',
      tasks: {
        body: {
          status: 'pending_retry',
          task: 'audiovisual_handoff/body/task.md',
          output: 'audiovisual_handoff/body/output.md',
          attempts: 2,
          last_error_kind: 'handoff_timeout',
          last_error_message: 'This operation was aborted',
          updated_at: '2026-05-04T08:01:00.000Z',
        },
      },
    })
    writeFileSync(join(handoffDir, 'task.md'), 'write audiovisual body')

    const progress = inspectSkillProgressArtifacts({ outputDir: root })
    const handoff = (progress as unknown as { handoff?: Record<string, unknown> }).handoff

    assert.equal(handoff?.status, 'pending_retry')
    assert.equal(handoff?.kind, 'audiovisual_report')
    assert.equal(handoff?.taskName, 'body')
    assert.equal(handoff?.actionLabel, '继续生成报告')
    assert.equal(handoff?.userMessage, '视听报告正文生成超时，可继续重试。')
    assert.equal(handoff?.attemptCount, 2)
    assert.equal(handoff?.lastErrorKind, 'handoff_timeout')
    assert.equal(handoff?.lastErrorMessage, '报告生成超时，可继续重试')
    assert.ok(String(handoff?.taskPath || '').endsWith('audiovisual_handoff/body/task.md'))
    assert.ok(String(handoff?.outputPath || '').endsWith('audiovisual_handoff/body/output.md'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
