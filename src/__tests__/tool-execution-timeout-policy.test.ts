import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveToolExecutionTimeoutMs,
  withToolExecutionTimeout,
} from '../main/modules/tools/tool-execution-timeout-policy'

test('tool execution timeout policy assigns stable budgets by tool family and resource tags', () => {
  assert.equal(resolveToolExecutionTimeoutMs('memory_search'), 15_000)
  assert.equal(resolveToolExecutionTimeoutMs('document_save_tab'), 30_000)
  assert.equal(resolveToolExecutionTimeoutMs('browser_click'), 60_000)
  assert.equal(resolveToolExecutionTimeoutMs('skill_get_state'), 120_000)
  assert.equal(resolveToolExecutionTimeoutMs('feishu_message_send'), 30_000)
})

test('tool execution timeout wrapper fails long-running tools with a timeout result', async () => {
  await assert.rejects(
    withToolExecutionTimeout(
      'browser_wait',
      () => new Promise((resolve) => setTimeout(resolve, 25)),
      {
        timeoutMs: 5,
      },
    ),
    /Tool execution timed out/,
  )
})
