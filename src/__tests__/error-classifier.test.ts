import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyExecutionError } from '../main/modules/claude-bridge/error-classifier'

test('error classifier distinguishes model timeouts, tool timeouts, and runtime recovery kinds', () => {
  const rateLimit = classifyExecutionError(new Error('HTTP 429: rate limited'))
  const contextOverflow = classifyExecutionError(new Error('context length exceeded the maximum'))
  const auth = classifyExecutionError(new Error('HTTP 401: invalid api key'))
  const hostUnavailable = classifyExecutionError(new Error('Browser controller is not available'))
  const transient = classifyExecutionError(new Error('HTTP 503: upstream unavailable'))
  const modelTimeout = classifyExecutionError(new Error('anthropic tools 请求超时（>90s）'))
  const toolTimeout = classifyExecutionError(new Error('Tool execution timed out after 60000ms'), {
    source: 'tool_execution',
  })

  assert.equal(rateLimit.kind, 'rate_limit')
  assert.equal(rateLimit.retryable, true)
  assert.equal(rateLimit.shouldEscalateToFallback, false)
  assert.ok((rateLimit.suggestedDelayMs || 0) >= 350)

  assert.equal(contextOverflow.kind, 'context_overflow')
  assert.equal(contextOverflow.shouldCompressContext, true)

  assert.equal(auth.kind, 'auth')
  assert.equal(auth.retryable, false)

  assert.equal(hostUnavailable.kind, 'host_unavailable')
  assert.equal(hostUnavailable.retryable, false)

  assert.equal(transient.kind, 'transient')
  assert.equal(transient.retryable, true)

  assert.equal(modelTimeout.kind, 'timeout_model')
  assert.equal(modelTimeout.source, 'model_request')

  assert.equal(toolTimeout.kind, 'timeout_tool')
  assert.equal(toolTimeout.source, 'tool_execution')
})

test('stream-cut shapes classify as transient (single policy source)', () => {
  assert.equal(
    classifyExecutionError(new Error('ERR_STREAM_PREMATURE_CLOSE: Premature close')).kind,
    'transient'
  )
  assert.equal(classifyExecutionError(new Error('fetch failed')).kind, 'transient')
  assert.equal(classifyExecutionError(new Error('terminated')).kind, 'transient')
  assert.equal(classifyExecutionError(new Error('HTTP 429 too many requests')).kind, 'rate_limit')
})
