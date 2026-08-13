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

test('maps renderer infrastructure timeout separately from model outage', () => {
  const result = mapBackendErrorToFriendly({
    error: 'renderer watchdog fired',
    errorKind: 'renderer_infrastructure_timeout',
  })

  assert.equal(result.friendlyMessage, '这次请求超时，Ready 已接管收口，可以继续发送')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
  assert.doesNotMatch(result.friendlyMessage, /模型服务|模型响应/)
})

test('maps main no-progress timeout as takeover rather than model outage', () => {
  const result = mapBackendErrorToFriendly({
    error: 'main no-progress guard fired',
    errorKind: 'main_no_progress_timeout',
  })

  assert.equal(result.friendlyMessage, '这次请求长时间没有进展，Ready 已接管收口，可以继续发送')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
  assert.doesNotMatch(result.friendlyMessage, /模型服务|模型响应|发送失败/)
})

test('maps the delivery wall-clock limit without claiming Boost collaboration or verification', () => {
  const result = mapBackendErrorToFriendly({
    error: 'delivery_wall_clock_exceeded',
    errorKind: 'delivery_failed',
  })

  assert.equal(
    result.friendlyMessage,
    '这次任务持续一段时间没有新进展，Ready 已安全停止；目标尚未完成，可以继续这项任务',
  )
  assert.doesNotMatch(result.friendlyMessage, /深度协作|复核|草稿/)
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
})

test('maps tool timeout separately from model timeout', () => {
  const tool = mapBackendErrorToFriendly({
    error: 'renderer-watchdog:15000',
    errorKind: 'timeout_tool',
  })
  const model = mapBackendErrorToFriendly({
    error: 'provider timed out',
    errorKind: 'timeout_model',
  })

  assert.equal(tool.friendlyMessage, '工具响应超时，请稍后重试或继续这项任务')
  assert.equal(tool.retryStrategy, 'user_action')
  assert.equal(model.friendlyMessage, '模型响应超时，请稍后重试')
  assert.equal(model.retryStrategy, 'auto')
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

test('keeps pre-persistence configuration and external-service failures distinct', () => {
  const configuration = mapBackendErrorToFriendly({
    error: 'codex_active_profile_missing',
    errorKind: 'configuration_unavailable',
  })
  const external = mapBackendErrorToFriendly({
    error: 'gateway_credential_unavailable',
    errorKind: 'external_service_unavailable',
  })

  assert.equal(configuration.friendlyMessage, 'API Key 无效或没有权限，请检查设置里的模型配置')
  assert.equal(configuration.retryStrategy, 'user_action')
  assert.equal(external.friendlyMessage, '模型服务暂时不可用，请稍后重试')
  assert.equal(external.retryStrategy, 'auto')
})

test('maps website HTML responses to an API address correction instead of an outage', () => {
  const result = mapBackendErrorToFriendly({
    error: 'API 返回了网页内容，不是 JSON。请检查 API 地址是否填成了官网页或登录页。',
    errorKind: 'blocked_external',
  })

  assert.equal(result.friendlyMessage, 'API 地址不是模型接口，请在设置中检查地址（OpenAI 兼容服务通常以 /v1 结尾）')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
  assert.doesNotMatch(result.friendlyMessage, /暂时不可用/)
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

test('maps proof gaps without exposing internal evidence wording', () => {
  const result = mapBackendErrorToFriendly({
    error: 'proof_gap',
    errorKind: 'proof_gap',
  })

  assert.equal(result.friendlyMessage, '这轮还没完整完成，可以继续发送')
  assert.equal(result.recoverable, true)
  assert.equal(result.retryStrategy, 'user_action')
  assert.doesNotMatch(result.friendlyMessage, /证据/)
})

test('unknown errors fall back to generic copy with technical details separated', () => {
  const result = mapBackendErrorToFriendly({ error: 'opaque backend detail' })

  assert.equal(result.friendlyMessage, '发送失败')
  assert.equal(result.recoverable, false)
  assert.equal(result.retryStrategy, 'none')
  assert.equal(result.technicalDetails, 'opaque backend detail')
})
