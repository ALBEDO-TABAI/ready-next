import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { completeRSSModel } from '../main/modules/rss-engine/model-completion'
import type { AIModelConfig } from '../shared/ai-providers'

test('RSS analysis uses the shared streaming provider with the entire source and no tools', async () => {
  const source = '# Original\n\n' + '完整原文。'.repeat(5000) + 'LAST-PARAGRAPH'
  const calls: Record<string, unknown>[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      `data: ${JSON.stringify({ id: 'local-response', choices: [{ index: 0, delta: { role: 'assistant', content: '已分析完整原文' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'local-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30000, completion_tokens: 9, total_tokens: 30009 } })}`,
      'data: [DONE]', '',
    ].join('\n\n'))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address() as { port: number }
    const config = { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', model: 'test-model' } as AIModelConfig
    assert.equal(await completeRSSModel(config, { system: 'Analyze supplied material.', user: source, maxTokens: 256 }), '已分析完整原文')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].stream, true)
    assert.deepEqual(calls[0].tools ?? [], [])
    assert.ok(JSON.stringify(calls[0].messages).includes('LAST-PARAGRAPH'))
    const messages = calls[0].messages as { role: string; content: string | { text?: string }[] }[]
    const user = messages.find((message) => message.role === 'user')!
    const sent = typeof user.content === 'string' ? user.content : user.content.map((part) => part.text || '').join('')
    assert.ok(sent === source, 'the entire source must survive the SDK and HTTP boundary unchanged')
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

for (const failure of ['503', 'disconnect']) for (const provider of ['openai', 'openai-compatible', 'anthropic']) {
  test(`RSS ${provider} ${failure} does not turn into empty output or another paid request`, async () => {
    let calls = 0
    const server = createServer((_req, res) => {
      calls += 1
      if (failure === 'disconnect') { res.destroy(); return }
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Temporary provider failure' } }))
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address() as { port: number }
      const config = { provider, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'test-model' } as AIModelConfig
      await assert.rejects(completeRSSModel(config, { system: 'Analyze.', user: 'Source', maxTokens: 256 }))
      assert.equal(calls, 1)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
}

test('RSS missing configuration fails before a model request', async () => {
  await assert.rejects(completeRSSModel(null, { system: '', user: 'source', maxTokens: 256 }), /配置/)
})

for (const protocol of ['chat', 'openai-chat', 'anthropic', 'responses', 'openai-responses']) for (const incomplete of ['missing-terminal', 'length']) {
  test(`RSS ${protocol} does not publish or retry a plausible report with ${incomplete}`, async () => {
    let calls = 0
    const report = '## 一、TextContent Analysis 视角\nA\n## 二、Viral-Abstract-Script 视角\nB\n## 三、Brainstorming 视角\n建议首先'
    const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
    const server = createServer((_req, res) => {
      calls += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (protocol.endsWith('responses')) {
        res.end(data({ type: 'response.created', response: { id: 'unfinished', status: 'in_progress', output: [] } })
          + data({ type: 'response.output_text.delta', delta: report })
          + (incomplete === 'length' ? data({ type: 'response.incomplete', response: { id: 'unfinished', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: report, annotations: [] }] }] } }) : ''))
      } else if (protocol === 'anthropic') {
        res.end(data({ type: 'message_start', message: { id: 'unfinished' } })
          + data({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          + data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: report } })
          + (incomplete === 'length' ? data({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }) + data({ type: 'message_stop' }) : ''))
      } else {
        res.end(data({ id: 'unfinished', choices: [{ index: 0, delta: { content: report }, finish_reason: incomplete === 'length' ? 'length' : null }] })
          + (incomplete === 'length' ? 'data: [DONE]\n\n' : ''))
      }
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address() as { port: number }
      const config = { provider: protocol.startsWith('openai-') ? 'openai' : protocol === 'anthropic' ? 'anthropic' : 'openai-compatible',
        wireApi: protocol.endsWith('responses') ? 'responses' : 'chat/completions',
        baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'test-model' } as AIModelConfig
      await assert.rejects(completeRSSModel(config, { system: 'Analyze.', user: 'Source', maxTokens: 256 }))
      assert.equal(calls, 1)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
}
