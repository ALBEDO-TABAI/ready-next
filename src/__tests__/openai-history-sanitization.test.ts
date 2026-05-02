import assert from 'node:assert/strict'
import test from 'node:test'

import { KimiCodingClient } from '../main/modules/claude-bridge/kimi-coding-client'
import { sanitizeOpenAICompatibleMessageHistory } from '../main/modules/claude-bridge/openai-history-sanitization'

function collectPartTypes(value: unknown, types: string[] = []): string[] {
  if (!value || typeof value !== 'object') return types
  if (Array.isArray(value)) {
    for (const item of value) collectPartTypes(item, types)
    return types
  }
  const record = value as Record<string, unknown>
  if (typeof record.type === 'string') types.push(record.type)
  for (const child of Object.values(record)) collectPartTypes(child, types)
  return types
}

test('OpenAI-compatible history strips Anthropic tool blocks left by previous tool turns', () => {
  const messages = sanitizeOpenAICompatibleMessageHistory([
    { role: 'user', content: '查看 RSS 订阅' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先查看订阅状态。' },
        { type: 'tool_use', id: 'toolu_1', name: 'skill_rss_list', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '当前 RSS 订阅为空。' },
      ],
    },
    { role: 'user', content: '使用 Video Expert Analyzer 分析视频' },
  ])

  const partTypes = collectPartTypes(messages)
  assert.equal(partTypes.includes('tool_use'), false)
  assert.equal(partTypes.includes('tool_result'), false)

  assert.equal(messages[1]?.role, 'assistant')
  assert.match(String(messages[1]?.content || ''), /查看订阅状态/)
  assert.equal(messages[2]?.role, 'user')
  assert.match(String(messages[2]?.content || ''), /当前 RSS 订阅为空/)
})

test('Kimi Coding simple requests do not resend Anthropic tool blocks from prior turns', async () => {
  let capturedBody: Record<string, unknown> | null = null
  const client = new KimiCodingClient({
    fetchWithTimeout: async (_url, init) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>
      const partTypes = collectPartTypes(capturedBody)

      assert.equal(partTypes.includes('tool_use'), false)
      assert.equal(partTypes.includes('tool_result'), false)

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    log: () => {},
  })

  const result = await client.requestSimple({
    session: {
      messages: [
        { role: 'user', content: '查看 RSS 订阅' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我先查看订阅状态。' },
            { type: 'tool_use', id: 'toolu_1', name: 'skill_rss_list', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '当前 RSS 订阅为空。' },
          ],
        },
        { role: 'user', content: '使用 Video Expert Analyzer 分析视频' },
      ],
    },
    config: {
      provider: 'moonshot',
      baseUrl: 'https://api.kimi.com/coding',
      apiKey: 'test-key',
      model: 'k2.6-code-preview',
    },
    baseUrl: 'https://api.kimi.com/coding',
    signal: new AbortController().signal,
  })

  assert.equal(result.text, 'ok')
  assert.ok(capturedBody)
})
