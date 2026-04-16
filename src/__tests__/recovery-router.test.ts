import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecoveryPlan } from '../main/modules/claude-bridge/recovery-router'

test('recovery router maps runtime classifications to stable recovery actions', () => {
  assert.deepEqual(buildRecoveryPlan({
    kind: 'rate_limit',
    source: 'model_request',
    retryable: true,
    suggestedDelayMs: 350,
    shouldCompressContext: false,
    shouldEscalateToFallback: false,
    message: 'HTTP 429',
  }), {
    shouldRetry: true,
    retryDelayMs: 350,
    shouldCompressContext: false,
    shouldSurfaceDirectly: false,
  })

  assert.deepEqual(buildRecoveryPlan({
    kind: 'context_overflow',
    source: 'model_request',
    retryable: true,
    shouldCompressContext: true,
    shouldEscalateToFallback: false,
    message: 'context length exceeded',
  }), {
    shouldRetry: true,
    shouldCompressContext: true,
    shouldSurfaceDirectly: false,
  })

  assert.deepEqual(buildRecoveryPlan({
    kind: 'host_unavailable',
    source: 'runtime',
    retryable: false,
    shouldCompressContext: false,
    shouldEscalateToFallback: false,
    message: 'Browser controller is not available',
  }), {
    shouldRetry: false,
    shouldCompressContext: false,
    shouldSurfaceDirectly: true,
  })
})
