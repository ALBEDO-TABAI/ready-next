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

test('unknown errors fall back to generic copy with technical details separated', () => {
  const result = mapBackendErrorToFriendly({ error: 'opaque backend detail' })

  assert.equal(result.friendlyMessage, '发送失败')
  assert.equal(result.recoverable, false)
  assert.equal(result.retryStrategy, 'none')
  assert.equal(result.technicalDetails, 'opaque backend detail')
})
