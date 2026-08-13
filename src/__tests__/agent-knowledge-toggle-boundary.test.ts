import assert from 'node:assert/strict'
import test from 'node:test'
import { getMemoryAnthropicTools, getMemoryOpenAITools } from '../main/modules/tools/memory-tools'

test('historical memory tools no longer depend on a knowledge-system setting', () => {
  const anthropic = getMemoryAnthropicTools().map((tool) => String(tool.name))
  const openai = getMemoryOpenAITools().map((tool) => String((tool.function as { name: string }).name))
  assert.deepEqual(anthropic, openai)
  assert.ok(anthropic.includes('memory_read_card'))
  assert.ok(anthropic.includes('memory_write_card'))
})
