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
import test, { afterEach, beforeEach } from 'node:test'

import {
  __setVeaProviderPreflightConfigReaderForTests,
  videoExpertChildDriver,
} from '../main/modules/agent-control/video-expert-child-driver'
import { getSkillChildDriver } from '../main/modules/agent-control/skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
} from '../main/modules/agent-control/skill-child-run-types'
import type { AIModelConfig } from '../shared/ai-providers'

async function makeTempOutputDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ready-vea-child-driver-'))
}

function makeAIConfig(overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4o',
    visionMode: 'on',
    ...overrides,
  }
}

beforeEach(() => {
  __setVeaProviderPreflightConfigReaderForTests(() => null)
})

afterEach(() => {
  __setVeaProviderPreflightConfigReaderForTests(null)
})

async function writeIncompleteSceneArtifacts(outputDir: string, totalScenes: number): Promise<string> {
  const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
  await fs.writeFile(sceneScoresPath, JSON.stringify({
    total_scenes: totalScenes,
    scenes: Array.from({ length: totalScenes }, (_, index) => ({
      scene_number: index + 1,
      scores: {},
      weighted_score: 0,
      type_classification: '',
      description: '',
      selection_reasoning: '',
      edit_suggestion: '',
      storyboard: {},
    })),
  }), 'utf8')
  const hostDir = path.join(outputDir, 'host_batches')
  await fs.mkdir(hostDir)
  await fs.writeFile(path.join(hostDir, 'index.json'), JSON.stringify({
    total_scenes: totalScenes,
    batches: [{
      batch_id: 'batch-001',
      scene_numbers: [1],
      output: 'batch-001-output.json',
      status: 'pending',
    }],
  }), 'utf8')
  return sceneScoresPath
}

async function writeCompleteSceneArtifacts(outputDir: string): Promise<string> {
  const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
  await fs.writeFile(sceneScoresPath, JSON.stringify({
    total_scenes: 1,
    scenes: [{
      scene_number: 1,
      scores: {
        aesthetic_beauty: 7,
        credibility: 8,
        impact: 6,
        memorability: 6,
        fun_interest: 5,
      },
      weighted_score: 6.6,
      type_classification: 'TYPE-C Aesthetic',
      description: '完整场景描述',
      selection: '[USABLE]',
      selection_reasoning: '完整选择理由',
      edit_suggestion: '完整剪辑建议',
      storyboard: {
        shot_size: '中景',
        lighting: '自然光',
        camera_movement: '轻微移动',
        visual_style: '纪实',
        technique: '环境铺垫',
      },
    }],
  }), 'utf8')
  const hostDir = path.join(outputDir, 'host_batches')
  await fs.mkdir(hostDir)
  await fs.writeFile(path.join(hostDir, 'index.json'), JSON.stringify({
    total_scenes: 1,
    batches: [{
      batch_id: 'batch-001',
      scene_numbers: [1],
      output: 'batch-001-output.json',
      status: 'completed',
    }],
  }), 'utf8')
  await fs.writeFile(path.join(hostDir, 'batch-001-output.json'), JSON.stringify({
    batch_id: 'batch-001',
    receipt: {
      status: 'completed',
      has_todo: false,
      needs_review: [],
    },
    scenes: [{
      scene_number: 1,
      scores: {
        aesthetic_beauty: 7,
        credibility: 8,
        impact: 6,
        memorability: 6,
        fun_interest: 5,
      },
      weighted_score: 6.6,
      type_classification: 'TYPE-C Aesthetic',
      description: '完整场景描述',
      selection: '[USABLE]',
      selection_reasoning: '完整选择理由',
      edit_suggestion: '完整剪辑建议',
      storyboard: {
        shot_size: '中景',
        lighting: '自然光',
        camera_movement: '轻微移动',
        visual_style: '纪实',
        technique: '环境铺垫',
      },
    }],
  }), 'utf8')
  return sceneScoresPath
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

test('Worker F: stale completed run_state with 0/97 scored scenes resumes ai_analyze instead of completing', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = await writeIncompleteSceneArtifacts(outputDir, 97)
  await fs.writeFile(
    path.join(outputDir, 'run_state.json'),
    JSON.stringify({
      status: 'completed',
      current_stage: 'finalize',
      scene_scores_path: sceneScoresPath,
      total_scenes: 97,
      completed_scenes: 97,
      coverage_ratio: 1,
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

test('Worker E: text-only current model blocks cold pipeline before dispatching host batches', async () => {
  const outputDir = await makeTempOutputDir()
  __setVeaProviderPreflightConfigReaderForTests(() => makeAIConfig({
    provider: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-for-coding',
    visionMode: 'off',
  }))

  const state = await videoExpertChildDriver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { url: 'https://example.com/video.mp4', outputDir },
    parentNextHint: 'wait_for_close_event',
    outputDir,
  })

  const next = await videoExpertChildDriver.planNextAction(state)
  const close = asClose(next)
  assert.equal(close.status, 'blocked')
  assert.equal(close.terminalReason, 'blocked_config')
  assert.equal(close.error?.kind, 'blocked_config')
  assert.match(close.error?.message || '', /moonshot\/kimi-for-coding/)
  await assert.rejects(() => fs.stat(path.join(outputDir, 'host_batches')))
})

test('VEA driver adopts the actual pipeline output directory returned by runtime', async () => {
  const outputRoot = await makeTempOutputDir()
  const actualOutputDir = path.join(outputRoot, 'p4ahGSFTY-c')
  await fs.mkdir(actualOutputDir)
  await fs.writeFile(path.join(actualOutputDir, 'run_state.json'), JSON.stringify({
    status: 'running',
    current_stage: 'prepare',
  }), 'utf8')

  const state = await videoExpertChildDriver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { url: 'https://www.youtube.com/watch?v=p4ahGSFTY-c', outputDir: outputRoot },
    parentNextHint: 'wait_for_close_event',
    outputDir: outputRoot,
  })

  const after = await videoExpertChildDriver.observeAfterAction(state, {
    success: true,
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    stdout: '',
    stderr: '',
    outputDir: actualOutputDir,
    command: [],
  } as any)

  assert.equal((after as any).outputDir, actualOutputDir)
  assert.equal((after as any).runStatePath, path.join(actualOutputDir, 'run_state.json'))
})

test('Worker E: stale VEA config and delivery_report do not override current text-only model', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = await writeIncompleteSceneArtifacts(outputDir, 3)
  await fs.writeFile(path.join(outputDir, 'run_state.json'), JSON.stringify({
    status: 'running',
    current_stage: 'score_batches',
    scene_scores_path: sceneScoresPath,
  }), 'utf8')
  await fs.writeFile(path.join(outputDir, 'delivery_report.json'), JSON.stringify({
    status: 'completed',
    missing_outputs: [],
    missing_screenshot_scenes: [],
    missing_sample_scenes: [],
    blocked_batches: [],
    incomplete_scene_numbers: [],
    required_outputs: {},
  }), 'utf8')

  const home = await makeTempOutputDir()
  const configDir = path.join(home, '.config', 'video-expert-analyzer-vnext')
  const modelsPath = path.join(configDir, 'models.multi.json')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    auto_scoring: {
      preferred_model: 'vision-provider/gpt-vision',
      models_json_path: modelsPath,
    },
  }), 'utf8')
  await fs.writeFile(modelsPath, JSON.stringify({
    providers: {
      'vision-provider': {
        models: [{ id: 'gpt-vision', input: ['text', 'image'] }],
      },
    },
  }), 'utf8')
  __setVeaProviderPreflightConfigReaderForTests(() => makeAIConfig({
    provider: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-for-coding',
    visionMode: 'off',
  }))

  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const state = await videoExpertChildDriver.createInitialState({
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      scopeId: 'scope-1',
      sessionId: 'session-1',
      requestedInput: { outputDir },
      parentNextHint: 'wait_for_close_event',
      outputDir,
    })

    const next = await videoExpertChildDriver.planNextAction(state)
    const close = asClose(next)
    assert.equal(close.status, 'blocked')
    assert.equal(close.terminalReason, 'blocked_config')
    assert.match(close.error?.message || '', /moonshot\/kimi-for-coding/)
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
  }
})

test('Worker E: unverified custom OpenAI-compatible provider blocks even when protocol inference says vision', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
  await fs.writeFile(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
  __setVeaProviderPreflightConfigReaderForTests(() => makeAIConfig({
    provider: 'openai-compatible',
    baseUrl: 'https://custom.example.test/v1',
    model: 'gpt-4o',
    visionMode: 'auto',
  }))

  const state = await videoExpertChildDriver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_ai_analyze',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { sceneScoresPath, outputDir },
    parentNextHint: 'wait_for_close_event',
    outputDir,
  })

  const next = await videoExpertChildDriver.planNextAction(state)
  const close = asClose(next)
  assert.equal(close.status, 'blocked')
  assert.equal(close.terminalReason, 'blocked_config')
  assert.match(close.error?.message || '', /openai-compatible\/gpt-4o/)
  assert.match(close.error?.message || '', /unverified/i)
})

test('Worker F: fresh ai_analyze blocks when preferred provider is missing from models catalog', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
  await fs.writeFile(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
  const home = await makeTempOutputDir()
  const configDir = path.join(home, '.config', 'video-expert-analyzer-vnext')
  const modelsPath = path.join(configDir, 'models.multi.json')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    auto_scoring: {
      preferred_model: 'missing-provider/gpt-vision',
      models_json_path: modelsPath,
    },
  }), 'utf8')
  await fs.writeFile(modelsPath, JSON.stringify({
    providers: {
      available: {
        models: [{ id: 'gpt-vision' }],
      },
    },
  }), 'utf8')

  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const state = await videoExpertChildDriver.createInitialState({
      skillId: 'video-expert-analyzer',
      action: 'video_expert_ai_analyze',
      scopeId: 'scope-1',
      sessionId: 'session-1',
      requestedInput: { sceneScoresPath, outputDir },
      parentNextHint: 'wait_for_close_event',
      outputDir,
    })

    const next = await videoExpertChildDriver.planNextAction(state)
    const close = asClose(next)
    assert.equal(close.status, 'blocked')
    assert.equal(close.terminalReason, 'blocked_config')
    assert.equal(close.error?.kind, 'blocked_config')
    assert.match(close.error?.message || '', /missing-provider\/gpt-vision/)
    assert.doesNotMatch(close.error?.message || '', /apiKey|secret|token/i)
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
  }
})

test('Worker F: score_batches resume preflights provider before planning ai_analyze', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
  await fs.writeFile(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
  await fs.writeFile(path.join(outputDir, 'run_state.json'), JSON.stringify({
    status: 'running',
    current_stage: 'score_batches',
    scene_scores_path: sceneScoresPath,
  }), 'utf8')
  const home = await makeTempOutputDir()
  const configDir = path.join(home, '.config', 'video-expert-analyzer-vnext')
  const modelsPath = path.join(configDir, 'models.multi.json')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    auto_scoring: {
      preferred_model: 'missing-provider/gpt-vision',
      models_json_path: modelsPath,
    },
  }), 'utf8')
  await fs.writeFile(modelsPath, JSON.stringify({
    providers: {
      available: {
        models: [{ id: 'gpt-vision' }],
      },
    },
  }), 'utf8')

  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const state = await videoExpertChildDriver.createInitialState({
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      scopeId: 'scope-1',
      sessionId: 'session-1',
      requestedInput: { outputDir },
      parentNextHint: 'wait_for_close_event',
      outputDir,
    })

    const next = await videoExpertChildDriver.planNextAction(state)
    const close = asClose(next)
    assert.equal(close.status, 'blocked')
    assert.equal(close.terminalReason, 'blocked_config')
    assert.match(close.error?.message || '', /missing-provider\/gpt-vision/)
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
  }
})

test('Worker F: missing configured models path can fall back to OpenClaw main catalog', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
  await fs.writeFile(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
  const home = await makeTempOutputDir()
  const configDir = path.join(home, '.config', 'video-expert-analyzer-vnext')
  const openclawDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(openclawDir, { recursive: true })
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    auto_scoring: {
      preferred_model: 'kcode/K2.6-code-preview',
      models_json_path: path.join(home, 'missing-models.json'),
    },
  }), 'utf8')
  await fs.writeFile(path.join(openclawDir, 'models.json'), JSON.stringify({
    providers: {
      kcode: {
        baseUrl: 'https://example.invalid',
        models: [{ id: 'K2.6-code-preview', input: ['text', 'image'] }],
      },
    },
  }), 'utf8')

  const previousHome = process.env.HOME
  const previousOpenClawRoot = process.env.OPENCLAW_ROOT
  process.env.HOME = home
  delete process.env.OPENCLAW_ROOT
  try {
    const state = await videoExpertChildDriver.createInitialState({
      skillId: 'video-expert-analyzer',
      action: 'video_expert_ai_analyze',
      scopeId: 'scope-1',
      sessionId: 'session-1',
      requestedInput: { sceneScoresPath, outputDir },
      parentNextHint: 'wait_for_close_event',
      outputDir,
    })

    const next = await videoExpertChildDriver.planNextAction(state)
    const action = asAction(next)
    assert.equal(action.action, 'video_expert_ai_analyze')
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
    if (previousOpenClawRoot === undefined) {
      delete process.env.OPENCLAW_ROOT
    } else {
      process.env.OPENCLAW_ROOT = previousOpenClawRoot
    }
  }
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

test('VEA driver resumes blocked score_batches when artifacts prove scoring is incomplete', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = await writeIncompleteSceneArtifacts(outputDir, 97)
  await fs.writeFile(
    path.join(outputDir, 'run_state.json'),
    JSON.stringify({
      status: 'blocked',
      current_stage: 'score_batches',
      scores_path: 'scene_scores.json',
      total_scenes: 97,
      completed_scenes: 0,
      coverage_ratio: 0,
      last_error: '自动并行评分仍有 97 个场景失败，请检查 host_batches 输出',
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
  assert.equal(action.input.outputDir, outputDir)
})

test('VEA driver resumes blocked finalize when scoring is complete but delivery outputs are missing', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = await writeCompleteSceneArtifacts(outputDir)
  await fs.writeFile(
    path.join(outputDir, 'run_state.json'),
    JSON.stringify({
      status: 'blocked',
      current_stage: 'finalize',
      scores_path: 'scene_scores.json',
      total_scenes: 1,
      completed_scenes: 1,
      coverage_ratio: 1,
      last_error: '抽样校验发现需复核场景：Scene 001',
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
  assert.equal(action.input.outputDir, outputDir)
})

test('VEA driver preflights from launch agentContext before reading settings DB', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = await writeIncompleteSceneArtifacts(outputDir, 3)
  await fs.writeFile(
    path.join(outputDir, 'run_state.json'),
    JSON.stringify({
      status: 'blocked',
      current_stage: 'score_batches',
      scores_path: 'scene_scores.json',
      total_scenes: 3,
      completed_scenes: 0,
    }),
    'utf8',
  )
  __setVeaProviderPreflightConfigReaderForTests(() => {
    throw new Error('settings DB should not be read when launch agentContext is available')
  })

  const driver = getSkillChildDriver('video-expert-analyzer')!
  const state = await driver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { outputDir },
    parentNextHint: 'wait_for_close_event',
    outputDir,
    agentContext: {
      provider: 'xiaomi',
      model_id: 'mimo-v2.5',
      base_url: 'https://token-plan-cn.xiaomimimo.com/anthropic',
      api_key: 'test-key',
      api_kind: 'anthropic-messages',
      fallback_chain: [],
      input_modes: ['text', 'image'],
    },
  })

  const next = await driver.planNextAction(state)
  const action = asAction(next)
  assert.equal(action.action, 'video_expert_ai_analyze')
  assert.equal(action.input.sceneScoresPath, sceneScoresPath)
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

test('T3: cold start with explicit sceneScoresPath (no url, no run_state) plans video_expert_ai_analyze', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
  await fs.writeFile(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
  // Intentionally NO run_state.json — direct AI-analyze cold start.

  const driver = videoExpertChildDriver
  const state = await driver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_ai_analyze',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { sceneScoresPath, mode: 'api', outputDir },
    parentNextHint: 'wait_for_close_event',
    outputDir,
  })

  const next = await driver.planNextAction(state)
  const action = asAction(next)
  assert.equal(action.action, 'video_expert_ai_analyze')
  assert.equal(action.input.sceneScoresPath, sceneScoresPath)
  assert.equal(action.input.mode, 'api')
})

test('T3: cold start with sceneScoresPath but no outputDir derives outputDir from dirname', async () => {
  const outputDir = await makeTempOutputDir()
  const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
  await fs.writeFile(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
  // No run_state.json, no outputDir on requestedInput or launch params.

  const driver = videoExpertChildDriver
  const state = await driver.createInitialState({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_ai_analyze',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    requestedInput: { sceneScoresPath, mode: 'api' },
    parentNextHint: 'wait_for_close_event',
  })

  const next = await driver.planNextAction(state)
  const action = asAction(next)
  assert.equal(action.action, 'video_expert_ai_analyze')
  assert.equal(action.input.sceneScoresPath, sceneScoresPath)
  assert.equal(action.input.mode, 'api')
})
