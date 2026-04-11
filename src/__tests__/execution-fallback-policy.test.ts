import assert from 'node:assert/strict'
import test from 'node:test'

import {
  annotateFallbackResult,
  buildExecutionFallbackState,
  resolveFallbackPlan,
} from '../main/modules/claude-bridge/execution-fallback-policy'

test('execution fallback policy resolves text bridge, video frame, wire-api, and kimi retry plans', () => {
  const textBridgePlan = resolveFallbackPlan({
    mode: 'openai_missing_native_tools',
    config: {
      provider: 'openai',
      apiKey: 'key',
      model: 'gpt-4.1',
    } as any,
    text: '当前工具不可用，请改用别的方式继续',
    preferTextToolBridge: false,
  })
  const videoPlan = resolveFallbackPlan({
    mode: 'video_frames',
    hasVideoInputs: true,
    error: new Error('HTTP 400: video block unsupported'),
  })
  const wireApiPlan = resolveFallbackPlan({
    mode: 'openai_wire_api',
    error: new Error('HTTP 404: responses not supported'),
  })
  const kimiPlan = resolveFallbackPlan({
    mode: 'kimi_coding',
    error: new Error('HTTP 429: rate limited'),
  })
  const kimiTimeoutPlan = resolveFallbackPlan({
    mode: 'kimi_coding',
    error: new Error('anthropic tools 请求超时（>90s）'),
  })

  assert.equal(textBridgePlan.kind, 'text_bridge')
  assert.equal(textBridgePlan.shouldRetry, true)
  assert.equal(videoPlan.kind, 'video_frames')
  assert.equal(videoPlan.shouldRetry, true)
  assert.equal(wireApiPlan.kind, 'wire_api_retry')
  assert.equal(wireApiPlan.shouldRetry, true)
  assert.equal(kimiPlan.kind, 'kimi_coding_retry')
  assert.equal(kimiPlan.shouldRetry, true)
  assert.equal(kimiTimeoutPlan.kind, 'kimi_coding_retry')
  assert.equal(kimiTimeoutPlan.shouldRetry, true)
})

test('execution fallback policy annotates result metadata only when fallback happened', () => {
  const untouched = annotateFallbackResult({ text: 'ok' }, null)
  const annotated = annotateFallbackResult({ text: 'ok' }, { kind: 'text_bridge', attempts: 1 })

  assert.deepEqual(untouched, { text: 'ok' })
  assert.deepEqual(annotated, {
    text: 'ok',
    fallback: { kind: 'text_bridge', attempts: 1 },
  })
})

test('execution fallback policy builds stable fallback state for diagnostics payloads', () => {
  assert.deepEqual(buildExecutionFallbackState(null), {
    happened: false,
    kind: 'none',
    attempts: 0,
  })

  assert.deepEqual(buildExecutionFallbackState({ kind: 'kimi_coding_retry', attempts: 1 }), {
    happened: true,
    kind: 'kimi_coding_retry',
    attempts: 1,
  })
})
