import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNoVisionRemediation } from '../main/modules/tools/browser-vision'
import type { AIModelConfig } from '../shared/ai-providers'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-vision-remediation declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-vision-remediation transitive sqlite load')
})

// D14 后续：视觉被判不可用时，工具错误必须携带可执行救济指引——区分
// 「用户显式关闭」与「openai-compatible 中转保守默认」，并指到设置页开关，
// 模型才知道该停止重试并告知用户，而不是原地 power_eval 挣扎。

const relayConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://relay.example/v1',
  apiKey: 'k',
  model: 'gpt-5.5',
} as AIModelConfig

test('explicit visionMode=off names the user choice and says do not retry', () => {
  const text = buildNoVisionRemediation({ ...relayConfig, visionMode: 'off' })
  assert.ok(text.includes('显式关闭'), 'must name the explicit off switch')
  assert.ok(text.includes('gpt-5.5'), 'must name the model')
  assert.ok(text.includes('不要重试'), 'must tell the model to stop retrying')
  assert.ok(text.includes('设置'), 'must point at settings')
})

test('auto mode explains the relay-conservative default and the override path', () => {
  const text = buildNoVisionRemediation(relayConfig)
  assert.ok(text.includes('保守默认'), 'must explain the conservative default')
  assert.ok(text.includes('openai-compatible'), 'must name the provider class')
  assert.ok(text.includes('强制开启'), 'must give the override path')
  assert.ok(!text.includes('显式关闭'), 'must not claim the user turned it off')
})
