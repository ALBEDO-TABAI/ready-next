import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { completeRSSModel, validateRSSModelRequest } from '../main/modules/rss-engine/model-completion'
import { ProviderOutputIncompleteError, ProviderOutputMissingTextError } from '../main/modules/agent-control/runtime-core/provider-output-status'
import type { AIModelConfig } from '../shared/ai-providers'

const data = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
const usage = { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
function native(text: string, mode = 'complete', commentary = false): string {
  const messages = [...(commentary ? [{ text: 'Checking facts.', phase: 'commentary' }] : []), { text, phase: 'final_answer' }]
  const output = messages.map((message, index) => ({ type: 'message', id: `message-${index}`, role: 'assistant', status: 'completed', phase: message.phase, content: [{ type: 'output_text', text: message.text }] }))
  const response = { id: 'response-1', model: 'test-model', status: 'in_progress', output: [] }
  const events: unknown[] = [{ type: 'response.created', response }]
  for (let i = 0; i < output.length; i++) {
    const item = output[i], ref = { output_index: i, item_id: item.id, content_index: 0 }
    events.push({ type: 'response.output_item.added', output_index: i, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', ...ref, delta: item.content[0].text },
      { type: 'response.output_text.done', ...ref, text: item.content[0].text },
      { type: 'response.output_item.done', output_index: i, item })
  }
  if (mode !== 'missing-terminal') events.push({ type: mode === 'length' ? 'response.incomplete' : 'response.completed', response: { ...response, status: mode === 'length' ? 'incomplete' : 'completed', output: mode === 'empty-terminal' ? [] : output, usage, ...(mode === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) } })
  return events.map(data).join('')
}
function stream(protocol: string, text: string, mode = 'complete'): string {
  if (protocol === 'responses') return native(text, mode)
  if (protocol === 'anthropic') return [
    { type: 'message_start', message: { id: 'message-1', model: 'test-model', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    ...(mode === 'missing-terminal' ? [] : [{ type: 'message_delta', delta: { stop_reason: mode === 'length' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 20 } }, { type: 'message_stop' }]),
  ].map(data).join('')
  return data({ id: 'chat-1', model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
    + (mode === 'missing-terminal' ? '' : data({ id: 'chat-1', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: mode === 'length' ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }) + 'data: [DONE]\n\n')
}
async function fixture(protocol: string, reply: string | 'disconnect' | '503', run: (config: AIModelConfig, requests: Record<string, unknown>[]) => Promise<void>) {
  const requests: Record<string, unknown>[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (reply === 'disconnect') { res.destroy(); return }
    if (reply === '503') { res.writeHead(503).end('{"error":{"message":"Unavailable"}}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(reply)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    await run({ provider: protocol === 'anthropic' ? 'anthropic' : 'openai-compatible', wireApi: protocol === 'responses' ? 'responses' : 'chat/completions',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic-key', model: 'test-model' } as AIModelConfig, requests)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
}

for (const protocol of ['chat', 'responses', 'anthropic']) {
  test(`RSS ${protocol} uses one current gateway request, no tools, and the full original input`, async () => {
    const source = '完整原文。'.repeat(5000) + 'LAST-PARAGRAPH'
    await fixture(protocol, stream(protocol, 'accepted'), async (config, requests) => {
      assert.equal(await completeRSSModel(config, { system: 'Only facts.', user: source, maxTokens: 256 }), 'accepted')
      assert.equal(requests.length, 1); assert.equal(requests[0].stream, true); assert.deepEqual(requests[0].tools || [], [])
      assert.ok(JSON.stringify(requests[0]).includes('LAST-PARAGRAPH'))
      const serialized = JSON.stringify(requests[0]); assert.ok(serialized.includes(source), 'provider handoff must not truncate the source')
    })
  })
  for (const failure of ['503', 'disconnect', 'missing-terminal', 'length']) test(`RSS ${protocol} rejects ${failure} without another paid request`, async () => {
    await fixture(protocol, failure === '503' || failure === 'disconnect' ? failure : stream(protocol, 'Plausible report', failure), async (config, requests) => {
      await assert.rejects(completeRSSModel(config, { system: 'Analyze.', user: 'Source', maxTokens: 256 }), failure === 'length' ? ProviderOutputIncompleteError : undefined)
      assert.equal(requests.length, 1)
    })
  })
}

test('RSS excludes commentary from a validated final answer and rejects an inconsistent empty terminal', async () => {
  await fixture('responses', native('{"accepted":true}', 'complete', true), async (config, requests) => {
    assert.equal(await completeRSSModel(config, { system: 'Only JSON.', user: 'Source', maxTokens: 256 }), '{"accepted":true}')
    assert.equal(requests.length, 1)
  })
  await fixture('responses', native('{"accepted":true}', 'empty-terminal'), async (config, requests) => {
    await assert.rejects(completeRSSModel(config, { system: 'Only JSON.', user: 'Source', maxTokens: 256 }), /output_mismatch/)
    assert.equal(requests.length, 1)
  })
})

test('RSS confirmed completion without final text is an acknowledged failure', async () => {
  await fixture('responses', data({ type: 'response.created', response: { id: 'empty', model: 'test-model', status: 'in_progress', output: [] } }) + data({ type: 'response.completed', response: { id: 'empty', model: 'test-model', status: 'completed', output: [], usage } }), async (config, requests) => {
    await assert.rejects(completeRSSModel(config, { system: 'Analyze.', user: 'Source', maxTokens: 256 }), ProviderOutputMissingTextError)
    assert.equal(requests.length, 1)
  })
})

test('RSS missing configuration, oversized source, and already aborted request fail before sending', async () => {
  await assert.rejects(completeRSSModel(null, { system: '', user: 'source', maxTokens: 256 }), /配置/)
  const config = { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic', model: 'test-model', contextWindowOverride: 4096 } as AIModelConfig
  assert.throws(() => validateRSSModelRequest(config, { system: '', user: '很长的原文'.repeat(5000), maxTokens: 256 }), /容量不足/)
  await assert.rejects(completeRSSModel(config, { system: '', user: 'source', maxTokens: 256, signal: AbortSignal.abort() }))
})
