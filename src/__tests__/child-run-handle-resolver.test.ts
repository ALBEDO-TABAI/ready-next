import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { resolveCanonicalChildRunHandle } from '../main/modules/agent-control/child-run/child-run-handle-resolver'

test('VEA resume-only child action accepts a trusted /tmp continuation handle', () => {
  const outputDir = mkdtempSync('/tmp/ready-vea-handle-')
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  const runStatePath = join(outputDir, 'run_state.json')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
  writeFileSync(runStatePath, '{"status":"running","current_stage":"score_batches"}', 'utf8')

  const resolved = resolveCanonicalChildRunHandle({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_ai_analyze',
    requestedInput: { sceneScoresPath },
    runtimeOutputsRoot: '/some/other/runtime-root',
  })

  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  assert.equal(resolved.outputDir, resolve(outputDir))
  assert.equal(resolved.runStatePath, resolve(runStatePath))
  assert.equal(resolved.sceneScoresPath, resolve(sceneScoresPath))
  assert.equal(resolved.input.outputDir, resolve(outputDir))
  assert.equal(resolved.input.sceneScoresPath, resolve(sceneScoresPath))
})

test('VEA resume-only child action still blocks system paths', () => {
  const resolved = resolveCanonicalChildRunHandle({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_ai_analyze',
    requestedInput: { sceneScoresPath: '/etc/ready-scene_scores.json' },
    runtimeOutputsRoot: '/some/other/runtime-root',
  })

  assert.equal(resolved.ok, false)
})
