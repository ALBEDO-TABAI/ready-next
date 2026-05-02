import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { RequestEnvelopeResource } from '../main/modules/agent-control/request-envelope'
import { resolveExplicitRunStateResource } from '../main/modules/agent-control/run-state-resource-resolver'

function makeResource(path: string, order = 0): RequestEnvelopeResource {
  return {
    id: `resource-${order}`,
    kind: 'attachment',
    source: 'explicit_reference',
    name: 'run_state.json',
    path,
    text: '',
    summary: null,
    order,
    canRead: true,
    canWrite: false,
  }
}

function makeOutputDir(): string {
  return mkdtempSync(join(tmpdir(), 'ready-run-state-resource-'))
}

test('resolveExplicitRunStateResource recognizes a single VEA run_state and derives scene_scores path', () => {
  const outputDir = makeOutputDir()
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(
    runStatePath,
    JSON.stringify({
      version: 'vnext',
      status: 'running',
      current_stage: 'score_batches',
      total_scenes: 97,
      completed_scenes: 0,
      scores_path: 'scene_scores.json',
      video_dir: outputDir,
    }),
    'utf8',
  )

  const resolved = resolveExplicitRunStateResource([makeResource(runStatePath)])

  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.candidate?.skillId, 'video-expert-analyzer')
  assert.equal(resolved.candidate?.outputDir, outputDir)
  assert.equal(resolved.candidate?.runStatePath, runStatePath)
  assert.equal(resolved.candidate?.sceneScoresPath, sceneScoresPath)
  assert.equal(resolved.candidate?.currentStage, 'score_batches')
  assert.equal(resolved.candidate?.explicitAction, 'video_expert_ai_analyze')
})

test('resolveExplicitRunStateResource does not classify unknown run_state JSON as VEA', () => {
  const outputDir = makeOutputDir()
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(runStatePath, JSON.stringify({ status: 'running', step: 'other-skill' }), 'utf8')

  const resolved = resolveExplicitRunStateResource([makeResource(runStatePath)])

  assert.equal(resolved.status, 'invalid')
  assert.match(resolved.reason || '', /unrecognized/)
})

test('resolveExplicitRunStateResource rejects malformed run_state JSON without guessing', () => {
  const outputDir = makeOutputDir()
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(runStatePath, '{not json', 'utf8')

  const resolved = resolveExplicitRunStateResource([makeResource(runStatePath)])

  assert.equal(resolved.status, 'invalid')
  assert.match(resolved.reason || '', /parse/)
})

test('resolveExplicitRunStateResource treats multiple explicit run_state resources as ambiguous', () => {
  const firstDir = makeOutputDir()
  const secondDir = makeOutputDir()
  const firstPath = join(firstDir, 'run_state.json')
  const secondPath = join(secondDir, 'run_state.json')
  mkdirSync(firstDir, { recursive: true })
  mkdirSync(secondDir, { recursive: true })
  writeFileSync(firstPath, JSON.stringify({ version: 'vnext', video_dir: firstDir }), 'utf8')
  writeFileSync(secondPath, JSON.stringify({ version: 'vnext', video_dir: secondDir }), 'utf8')

  const resolved = resolveExplicitRunStateResource([
    makeResource(firstPath, 0),
    makeResource(secondPath, 1),
  ])

  assert.equal(resolved.status, 'ambiguous')
  assert.equal(resolved.candidateCount, 2)
})
