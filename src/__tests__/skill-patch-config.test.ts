import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executePatchConfig } from '../main/modules/tools/skill-primitives/patch-config'
import type { SkillHostRequirements } from '../shared/skill-host-contract'

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ready-skill-patch-config-'))
  const configPath = join(root, 'config.json')
  const modelsPath = join(root, 'models.multi.json')
  writeFileSync(configPath, JSON.stringify({
    auto_scoring: {
      preferred_model: 'xiaomi/mimo-v2-omni',
      fallback_models: ['zai/GLM-5V-Turbo', 'novacode-openai/gpt-5.4'],
      models_json_path: modelsPath,
    },
  }, null, 2), 'utf8')
  writeFileSync(modelsPath, JSON.stringify({
    providers: {
      xiaomi: {
        apiKey: 'old-short-key',
        baseUrl: 'https://xiaomi.example/v1',
        models: [{ id: 'mimo-v2-omni', input: ['text', 'image'] }],
      },
      'novacode-openai': {
        apiKey: 'novacode-key',
        baseUrl: 'https://nova.example/v1',
        models: [{ id: 'gpt-5.4', input: ['text', 'image'] }],
      },
    },
  }, null, 2), 'utf8')
  const hostRequirements: SkillHostRequirements = {
    config_repair: {
      files: [
        { id: 'config', path: configPath, format: 'json' },
        { id: 'models', path: modelsPath, format: 'json' },
      ],
    },
  } as SkillHostRequirements
  return {
    root,
    configPath,
    modelsPath,
    hostRequirements,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('skill_patch_config writes only declared json files, masks secrets, and validates VEA model refs', async () => {
  const fx = makeFixture()
  try {
    const nextKey = 'tp-test-secret-value-that-must-not-echo'
    const result = await executePatchConfig({
      target: 'models',
      operations: [
        { op: 'set', path: '/providers/xiaomi/apiKey', value: nextKey },
      ],
    }, {
      skillId: 'video-expert-analyzer',
      hostRequirements: fx.hostRequirements,
    })

    const models = JSON.parse(readFileSync(fx.modelsPath, 'utf8'))
    assert.equal(models.providers.xiaomi.apiKey, nextKey)
    assert.equal(result.text.includes(nextKey), false, 'tool result must not leak raw key')
    assert.equal((result.data as any)?.validation?.ok, false, 'stale zai fallback should fail validation')
    assert.match(JSON.stringify((result.data as any)?.validation), /zai\/GLM-5V-Turbo/)
  } finally {
    fx.cleanup()
  }
})

test('skill_patch_config accepts deleting a stale fallback and then validates cleanly', async () => {
  const fx = makeFixture()
  try {
    const result = await executePatchConfig({
      target: 'config',
      operations: [
        { op: 'set', path: '/auto_scoring/fallback_models', value: ['novacode-openai/gpt-5.4'] },
      ],
    }, {
      skillId: 'video-expert-analyzer',
      hostRequirements: fx.hostRequirements,
    })

    const config = JSON.parse(readFileSync(fx.configPath, 'utf8'))
    assert.deepEqual(config.auto_scoring.fallback_models, ['novacode-openai/gpt-5.4'])
    assert.equal((result.data as any)?.validation?.ok, true)
  } finally {
    fx.cleanup()
  }
})

test('skill_patch_config clears stale config blocker after validation passes', async () => {
  const fx = makeFixture()
  try {
    const runStatePath = join(fx.root, 'run_state.json')
    writeFileSync(runStatePath, JSON.stringify({
      current_stage: 'score_batches',
      status: 'blocked',
      total_scenes: 97,
      completed_scenes: 0,
      coverage_ratio: 0,
      last_error: '自动并行评分失败：ValueError: 未找到 provider: zai',
    }, null, 2), 'utf8')

    const result = await executePatchConfig({
      target: 'config',
      operations: [
        { op: 'set', path: '/auto_scoring/fallback_models', value: ['novacode-openai/gpt-5.4'] },
      ],
    }, {
      skillId: 'video-expert-analyzer',
      hostRequirements: fx.hostRequirements,
      activeContext: {
        runStatePath,
        outputDir: fx.root,
      },
    })

    const runState = JSON.parse(readFileSync(runStatePath, 'utf8'))
    assert.equal((result.data as any)?.validation?.ok, true)
    assert.equal((result.data as any)?.staleBlocker?.cleared, true)
    assert.equal(runState.status, 'running')
    assert.equal(runState.last_error, '')
    assert.equal(runState.current_stage, 'score_batches')
  } finally {
    fx.cleanup()
  }
})

test('skill_patch_config rejects undeclared config targets', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executePatchConfig({
        target: join(fx.root, 'other.json'),
        operations: [
          { op: 'set', path: '/x', value: 1 },
        ],
      }, {
        skillId: 'video-expert-analyzer',
        hostRequirements: fx.hostRequirements,
      }),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'config_target_not_declared',
    )
  } finally {
    fx.cleanup()
  }
})
