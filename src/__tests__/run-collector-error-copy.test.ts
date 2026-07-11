/**
 * 2026-07-03 真机回归 R1 — error 终态的用户可读文案（E2：失败有出路）。
 *
 * 实锚：run req-1783090899003-uzzrkn 以 browser_transaction_unconfirmed 收口，
 * renderer 却收到泛化 "Agent execution failed"。本测试钉住：已登记 reason
 * 走特定文案（带下一步），runtimeError 优先，未知 reason 才回泛化兜底。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createScopedRunCollector,
  userFacingTerminalErrorText,
} from '../main/modules/agent-control/task-projection/run-collector'

const MATCH = { agent: 'butler', sessionId: 'scope-1', runId: 'run-1' }
const EVENT_BASE = { agent: 'butler', sessionId: 'scope-1', runId: 'run-1' }

test('browser_transaction_unconfirmed surfaces the recoverable copy, not the generic failure', async () => {
  const collector = createScopedRunCollector(MATCH)
  collector.handleStatus({ ...EVENT_BASE, status: 'error', terminalReason: 'browser_transaction_unconfirmed' })
  const result = await collector.result
  assert.equal(result.success, false)
  assert.equal(result.terminalReason, 'browser_transaction_unconfirmed')
  assert.match(result.error || '', /继续/)
  assert.doesNotMatch(result.error || '', /Agent execution failed/)
})

test('runtime error text still wins over the reason copy', async () => {
  const collector = createScopedRunCollector(MATCH)
  collector.handleError({ ...EVENT_BASE, error: 'provider exploded' })
  collector.handleStatus({ ...EVENT_BASE, status: 'error', terminalReason: 'browser_transaction_unconfirmed' })
  const result = await collector.result
  assert.equal(result.error, 'provider exploded')
})

test('unknown reasons keep the generic fallback', async () => {
  const collector = createScopedRunCollector(MATCH)
  collector.handleStatus({ ...EVENT_BASE, status: 'error', terminalReason: 'some_new_reason' })
  const result = await collector.result
  assert.equal(result.error, 'Agent execution failed')
})

test('reason copy table: registered reasons return actionable text, others null', () => {
  for (const reason of ['browser_transaction_unconfirmed', 'proof_gap', 'no_artifact', 'blocked_tool_error']) {
    const text = userFacingTerminalErrorText(reason)
    assert.ok(text && text.length > 10, `${reason} 必须有可读文案`)
  }
  assert.equal(userFacingTerminalErrorText('done'), null)
  assert.equal(userFacingTerminalErrorText(null), null)
})

test('blocked_tool_error surfaces the tool-block copy, not the generic failure (W10-F5, 2026-07-11 dogfood)', async () => {
  const collector = createScopedRunCollector(MATCH)
  collector.handleStatus({ ...EVENT_BASE, status: 'error', terminalReason: 'blocked_tool_error' })
  const result = await collector.result
  assert.equal(result.success, false)
  assert.match(result.error || '', /工具/)
  assert.match(result.error || '', /重试/)
  assert.doesNotMatch(result.error || '', /Agent execution failed/)
})
