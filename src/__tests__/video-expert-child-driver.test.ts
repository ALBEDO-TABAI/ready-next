/**
 * Phase 5 — VEA child driver acceptance tests.
 *
 * Lock the driver's behavior across the four canonical run-state shapes:
 *   1. score_batches stage with scene_scores.json present and no `url`
 *      → drive picks `video_expert_ai_analyze`.
 *   2. status='completed' → close event status='completed'.
 *   3. score_batches stage with NO scene_scores.json → close
 *      `recoverable_paused` + `error.kind='missing_scene_scores'`.
 *   4. status='blocked' → close `blocked` + `terminalReason='blocked_external'`.
 *
 * Driver registry exposure: the VEA driver claims ownership of
 * `video-expert-analyzer` so the parent turn-engine can skip its
 * `force_tool` synthesis once a child run owns the work.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { videoExpertChildDriver } from '../main/modules/agent-control/video-expert-child-driver'
import { getSkillChildDriver } from '../main/modules/agent-control/skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
} from '../main/modules/agent-control/skill-child-run-types'

async function makeTempOutputDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ready-vea-child-driver-'))
}

function isClose(value: unknown): value is SkillChildCloseEvent {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.status === 'string' && typeof v.terminalReason === 'string'
}

function asAction(value: SkillChildDriverAction | SkillChildCloseEvent): SkillChildDriverAction {
  if (isClose(value)) {
    throw new Error(`expected action plan, got close event: ${JSON.stringify(value)}`)
  }
  return value
}

function asClose(value: SkillChildDriverAction | SkillChildCloseEvent): SkillChildCloseEvent {
  if (!isClose(value)) {
    throw new Error(`expected close event, got action: ${JSON.stringify(value)}`)
  }
  return value
}

test('Phase 5: VEA driver is registered under skillId video-expert-analyzer', () => {
  const driver = getSkillChildDriver('video-expert-analyzer')
  assert.ok(driver, 'expected VEA child driver to be registered')
  assert.equal(driver, videoExpertChildDriver)
})

test('Phase 5: VEA driver claims ownership of video-expert-analyzer', () => {
  const driver = getSkillChildDriver('video-expert-analyzer')
  assert.ok(driver, 'expected VEA child driver to be registered')
  const ownership = driver.ownsSkill
  assert.equal(typeof ownership, 'function', 'driver must expose ownsSkill(skillId)')
  assert.equal(ownership!('video-expert-analyzer'), true)
  assert.equal(ownership!('lets-go-rss'), false)
})

test('Phase 5: score_batches stage routes to video_expert_ai_analyze, not video_expert_pipeline', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
  await fs.writeFile(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')

  const runStatePath = path.join(outputDir, 'run_state.json')
  await fs.writeFile(
    runStatePath,
    JSON.stringify({
      current_stage: 'score_batches',
      scene_scores_path: sceneScoresPath,
    }),
    'utf8',
  )

  const driver = getSkillChildDriver('video-expert-analyzer')!
  const state = await driver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { outputDir },
    parentNextHint: 'wait_for_close_event',
    outputDir,
  })

  const next = await driver.planNextAction(state)
  const action = asAction(next)
  assert.equal(action.action, 'video_expert_ai_analyze')
  assert.equal(action.input.sceneScoresPath, sceneScoresPath)
})

test('Phase 5: completed run_state returns close event status=completed', async () => {
  const outputDir = await makeTempOutputDir()
  const runStatePath = path.join(outputDir, 'run_state.json')
  await fs.writeFile(
    runStatePath,
    JSON.stringify({ status: 'completed', current_stage: 'finalize' }),
    'utf8',
  )

  const driver = getSkillChildDriver('video-expert-analyzer')!
  const state = await driver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { outputDir },
    parentNextHint: 'wait_for_close_event',
    outputDir,
  })

  const next = await driver.planNextAction(state)
  const close = asClose(next)
  assert.equal(close.status, 'completed')
  assert.equal(close.terminalReason, 'completed')
})

test('Phase 5: missing scene_scores in score_batches stage closes recoverable_paused', async () => {
  const outputDir = await makeTempOutputDir()
  const runStatePath = path.join(outputDir, 'run_state.json')
  await fs.writeFile(
    runStatePath,
    JSON.stringify({
      current_stage: 'score_batches',
      // intentionally NO scene_scores_path field
    }),
    'utf8',
  )

  const driver = getSkillChildDriver('video-expert-analyzer')!
  const state = await driver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { outputDir },
    parentNextHint: 'wait_for_close_event',
    outputDir,
  })

  const next = await driver.planNextAction(state)
  const close = asClose(next)
  assert.equal(close.status, 'recoverable_paused')
  assert.equal(close.terminalReason, 'checkpoint_background')
  assert.ok(close.error)
  assert.equal(close.error!.kind, 'missing_scene_scores')
})

test('Phase 5: blocked run_state closes terminalReason=blocked_external', async () => {
  const outputDir = await makeTempOutputDir()
  const runStatePath = path.join(outputDir, 'run_state.json')
  await fs.writeFile(
    runStatePath,
    JSON.stringify({
      status: 'blocked',
      current_stage: 'merge_validate',
      blocker_kind: 'external_review',
    }),
    'utf8',
  )

  const driver = getSkillChildDriver('video-expert-analyzer')!
  const state = await driver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { outputDir },
    parentNextHint: 'wait_for_close_event',
    outputDir,
  })

  const next = await driver.planNextAction(state)
  const close = asClose(next)
  assert.equal(close.status, 'blocked')
  assert.equal(close.terminalReason, 'blocked_external')
})

test('Phase 5: blocked + config_repair blocker uses terminalReason=blocked_config', async () => {
  const outputDir = await makeTempOutputDir()
  const runStatePath = path.join(outputDir, 'run_state.json')
  await fs.writeFile(
    runStatePath,
    JSON.stringify({
      status: 'blocked',
      current_stage: 'finalize',
      blocker_kind: 'config_repair',
    }),
    'utf8',
  )

  const driver = getSkillChildDriver('video-expert-analyzer')!
  const state = await driver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { outputDir },
    parentNextHint: 'wait_for_close_event',
    outputDir,
  })

  const next = await driver.planNextAction(state)
  const close = asClose(next)
  assert.equal(close.status, 'blocked')
  assert.equal(close.terminalReason, 'blocked_config')
})

test('Phase 5: cold start with url plans video_expert_pipeline', async () => {
  const outputDir = await makeTempOutputDir()
  // No run_state.json yet — cold start.
  const driver = getSkillChildDriver('video-expert-analyzer')!
  const state = await driver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { url: 'https://example.com/video.mp4', outputDir },
    parentNextHint: 'wait_for_close_event',
    outputDir,
  })

  const next = await driver.planNextAction(state)
  const action = asAction(next)
  assert.equal(action.action, 'video_expert_pipeline')
  assert.equal(action.input.url, 'https://example.com/video.mp4')
  assert.equal(action.input.outputDir, outputDir)
})
