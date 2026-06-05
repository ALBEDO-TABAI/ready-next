import assert from 'node:assert/strict'
import test from 'node:test'

import { mapBackendErrorToFriendly } from '../renderer/modules/agent/error-message-mapping'

test('maps scope missing without exposing the internal id', () => {
  const result = mapBackendErrorToFriendly({
    error: 'Conversation scope not found: conv-local-123',
    errorKind: 'scope_missing',
  })

  assert.equal(result.friendlyMessage, '会话信息异常，正在尝试恢复')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'auto')
  assert.doesNotMatch(result.friendlyMessage, /conv-local/)
})

test('maps attachment missing to user action', () => {
  const result = mapBackendErrorToFriendly({
    error: 'Attachment not found: attach-1',
    errorKind: 'attachment_unavailable',
  })

  assert.equal(result.friendlyMessage, '附件读取失败，请重新选择文件')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
})

test('maps host and circuit failures to a retryable service message', () => {
  for (const errorKind of ['host_unavailable', 'circuit_break']) {
    const result = mapBackendErrorToFriendly({ error: errorKind, errorKind })
    assert.equal(result.friendlyMessage, '服务暂时不可用，稍后重试')
    assert.equal(result.recoverable, true)
    assert.equal(result.retryStrategy, 'auto')
  }
})

test('maps message persistence failures without raw sqlite text', () => {
  const result = mapBackendErrorToFriendly({
    error: 'SQLITE constraint failed: chat_messages.id',
    errorKind: 'message_persist_failed',
  })

  assert.equal(result.friendlyMessage, '消息保存失败，请重试')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
  assert.doesNotMatch(result.friendlyMessage, /SQLITE/i)
})

test('maps superseded sends to a user-action handoff message', () => {
  const result = mapBackendErrorToFriendly({
    error: 'newer send took ownership',
    errorKind: 'superseded',
  })

  assert.equal(result.friendlyMessage, '已由新消息接管，可以继续发送')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
})

test('maps provider quota failures to a recovery-specific message', () => {
  const result = mapBackendErrorToFriendly({
    error: 'HTTP 402: Insufficient balance',
    errorKind: 'unknown',
  })

  assert.equal(result.friendlyMessage, '模型额度不足，请检查外部服务配置或账号余额')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
})

test('maps provider auth failures to settings action', () => {
  const result = mapBackendErrorToFriendly({
    error: 'HTTP 401: invalid_api_key',
    errorKind: 'blocked_config',
  })

  assert.equal(result.friendlyMessage, 'API Key 无效或没有权限，请检查设置里的模型配置')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
})

test('maps provider rate limits to retry guidance', () => {
  const result = mapBackendErrorToFriendly({
    error: 'HTTP 429: Too Many Requests; Retry-After: 45',
    errorKind: 'rate_limit',
  })

  assert.equal(result.friendlyMessage, '模型服务限流，请稍后重试')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'auto')
})

test('maps local max-turn exhaustion without calling it model unavailable', () => {
  const result = mapBackendErrorToFriendly({
    error: 'Max turns (16) exceeded',
    errorKind: 'blocked_external',
  })

  assert.equal(result.friendlyMessage, '本轮步骤已用完，请继续这项任务')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
  assert.doesNotMatch(result.friendlyMessage, /模型服务|暂时不可用/)
})

test('unknown errors fall back to generic copy with technical details separated', () => {
  const result = mapBackendErrorToFriendly({ error: 'opaque backend detail' })

  assert.equal(result.friendlyMessage, '发送失败')
  assert.equal(result.recoverable, false)
  assert.equal(result.retryStrategy, 'none')
  assert.equal(result.technicalDetails, 'opaque backend detail')
})
