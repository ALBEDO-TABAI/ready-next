/**
 * Stage R W5.4 — auto-title middleware fallback behavior.
 *
 * Asserts that:
 *   - LLM success → returns the (truncated) LLM title
 *   - LLM failure → falls back to localFallbackTitle (no exception thrown)
 *   - long input → truncated with ellipsis
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generateTaskTitle,
  localFallbackTitle,
} from '../main/modules/agent-control/auto-title'

test('generateTaskTitle returns LLM result when llmCall succeeds', async () => {
  const title = await generateTaskTitle(
    '帮我研究一下 deerflow 项目',
    null,
    { llmCall: async () => 'DeerFlow 调研' },
  )
  assert.equal(title, 'DeerFlow 调研')
})

test('generateTaskTitle falls back to localFallbackTitle on LLM error', async () => {
  const title = await generateTaskTitle(
    '一个非常长的用户消息，超过本地兜底的 16 字符上限',
    null,
    { llmCall: async () => { throw new Error('llm failed') } },
  )
  // local fallback truncates at 16 chars + ellipsis
  assert.match(title, /…$/)
  assert.equal(title.endsWith('…'), true)
})

test('localFallbackTitle returns "未命名任务" for empty input', () => {
  assert.equal(localFallbackTitle(''), '未命名任务')
  assert.equal(localFallbackTitle('   '), '未命名任务')
})

test('localFallbackTitle truncates long input with ellipsis', () => {
  const long = '这是一段很长的用户输入超过十六个字符'
  const title = localFallbackTitle(long)
  assert.equal(title.endsWith('…'), true)
})
