import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { completeRSSModel, validateRSSModelRequest } from '../main/modules/rss-engine/model-completion'
import { ProviderOutputIncompleteError, ProviderOutputMissingTextError } from '../main/modules/agent-control/runtime-core/provider-output-status'
import type { AIModelConfig } from '../shared/ai-providers'
import { MemorySession } from '@openai/agents'
import { resolveAgentSdkProvider, runWithOpenAIAgentsSdk } from '../main/modules/agent-control/runtime-core/agent-sdk-provider'
import { ResponsesStreamAccumulator } from '../main/modules/agent-control/runtime-core/provider-sse'
import { extractResponsesText } from '../main/modules/agent-control/runtime-core/agent-sdk-model-message-utils'

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

test('RSS refuses oversized input rather than letting SDK compaction silently change the evidence', () => {
  const config = { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key', model: 'test-model', contextWindowOverride: 4096 } as AIModelConfig
  assert.throws(() => validateRSSModelRequest(config, { system: 'Classify.', user: '很长的原文'.repeat(5000), maxTokens: 256 }), /容量不足/)
})

test('RSS external cancellation aborts the real provider request without retry', async () => {
  let received!: () => void, calls = 0
  const requestReceived = new Promise<void>((resolve) => { received = resolve })
  const server = createServer((_req, res) => { calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); received() }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const controller = new AbortController()
    const config = { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'test-key', model: 'test-model' } as AIModelConfig
    const pending = completeRSSModel(config, { system: 'Classify.', user: 'source', maxTokens: 256, signal: controller.signal, runId: 'rss-cancel-test' })
    const rejection = assert.rejects(pending)
    await requestReceived
    controller.abort()
    await rejection
    assert.equal(calls, 1)
    await assert.rejects(completeRSSModel(config, { system: '', user: '', maxTokens: 256, signal: controller.signal }))
    assert.equal(calls, 1)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
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
      await assert.rejects(completeRSSModel(config, { system: 'Analyze.', user: 'Source', maxTokens: 256 }), incomplete === 'length' ? ProviderOutputIncompleteError : undefined)
      assert.equal(calls, 1)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
}

for (const status of ['incomplete', 'completed', 'failed'] as const) {
  test(`one-shot native Responses keeps ${status} evidence when only reasoning was returned`, async () => {
    let calls = 0
    const server = createServer((_req, res) => {
      calls++
      const response = { id: 'reasoning-only', object: 'response', status,
        output: [{ type: 'reasoning', id: 'thought', summary: [] }],
        ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        ...(status === 'failed' ? { error: { code: 'server_error', message: 'Confirmed provider failure' } } : {}),
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })}\n\n`
        + `data: ${JSON.stringify({ type: `response.${status}`, response })}\n\n`)
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const config = { provider: 'openai', wireApi: 'responses', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic', model: 'test-model' } as AIModelConfig
      await assert.rejects(completeRSSModel(config, { system: 'Only JSON.', user: 'Synthetic source.', maxTokens: 256 }), (error: unknown) => {
        assert.ok(status === 'completed' ? error instanceof ProviderOutputMissingTextError : error instanceof ProviderOutputIncompleteError)
        assert.equal((error as Error & { iterationsUsed?: number }).iterationsUsed, 1)
        return true
      })
      assert.equal(calls, 1)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
}

test('a prior terminal receipt cannot turn a later shared-runner request failure into a known output failure', async () => {
  let calls = 0
  const server = createServer((_req, res) => {
    if (++calls === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ type: 'response.incomplete', response: { id: 'prior', object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning', id: 'thought', summary: [] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
    } else { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Later request failed"}}') }
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const config = { provider: 'openai', wireApi: 'responses', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic', model: 'test-model' } as AIModelConfig
    const { provider, model } = resolveAgentSdkProvider(config, { fetchWithTimeout: (url, init, signal) => fetch(url, { ...init, signal }), openAIClientMaxRetries: 0 })
    await assert.rejects(runWithOpenAIAgentsSdk({ agentName: 'Synthetic receipt test', runId: 'terminal-two-turn', taskId: 'terminal-two-turn', instructions: 'Return text', input: 'Source',
      provider, model, session: new MemorySession(), tools: [], signal: new AbortController().signal, maxTurns: 2, contextWindowTokens: 10000, maxOutputTokens: 128, onTextDelta: () => {} }), (error: unknown) => {
      assert.ok(!(error instanceof ProviderOutputIncompleteError) && !(error instanceof ProviderOutputMissingTextError))
      assert.match((error as Error).message, /Later request failed/)
      assert.equal((error as Error & { iterationsUsed?: number }).iterationsUsed, 2)
      return true
    })
    assert.equal(calls, 2)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('completed Responses messages supplement only an empty matching successful terminal payload', () => {
  const message = { type: 'message', id: 'answer', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: '{"accepted":true}' }] }
  const seeded = () => { const stream = new ResponsesStreamAccumulator(); stream.feed('', { type: 'response.created', response: { id: 'r' } }); return stream }
  const done = (stream: ResponsesStreamAccumulator, item = message) => stream.feed('', { type: 'response.output_item.done', output_index: 0, item })
  const terminal = { id: 'r', status: 'completed', output: [] }
  const complete = seeded(); done(complete)
  assert.deepEqual(complete.completePayload(terminal).output, [message])
  assert.equal(complete.final(), null, 'a completed item is not a completed response')
  for (const status of ['incomplete', 'failed']) assert.equal(complete.completePayload({ ...terminal, status }).output, terminal.output)
  assert.equal(complete.completePayload({ ...terminal, id: 'foreign' }).output, terminal.output)
  const canonical = { ...terminal, output: [{ ...message, id: 'canonical' }] }
  assert.equal(complete.completePayload(canonical), canonical)
  const partial = seeded(); partial.feed('', { type: 'response.output_text.delta', delta: '{"accepted":true}' })
  assert.equal(partial.completePayload(terminal), terminal)
  const commentary = seeded(); done(commentary, { ...message, phase: 'commentary' })
  assert.equal(commentary.completePayload(terminal), terminal)
  const withTool = seeded(); done(withTool)
  withTool.feed('', { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'tool', name: 'not-exposed', arguments: '{}' } })
  assert.equal(withTool.completePayload(terminal), terminal, 'never silently drop an unconverted tool result')
})

test('Responses final text excludes commentary even when an aggregate text field is present', () => {
  const commentary = { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking the facts.' }] }
  assert.equal(extractResponsesText({ output: [commentary], output_text: 'Checking the facts.' }), '')
  assert.equal(extractResponsesText({ output_text: 'Unphased aggregate answer' }), 'Unphased aggregate answer')
  assert.equal(extractResponsesText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Unphased answer' }] }] }), 'Unphased answer')
})

for (const provider of ['openai', 'openai-compatible'] as const) for (const terminalOutput of ['empty', 'canonical']) for (const withCommentary of [false, true]) {
  test(`${provider} Responses delivers final text with ${terminalOutput} output and commentary=${withCommentary} through the real SDK without another turn`, async () => {
    let calls = 0
    const message = { type: 'message', id: 'complete-message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: '{"accepted":true}', annotations: [] }] }
    const messages = [...(withCommentary ? [{ ...message, id: 'commentary', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking the facts.', annotations: [] }] }] : []), message]
    const server = createServer((_req, res) => {
      calls++; res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        { type: 'response.created', response: { id: 'complete-response', status: 'in_progress', output: [] } },
        ...messages.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
        { type: 'response.completed', response: { id: 'complete-response', status: 'completed', output: terminalOutput === 'empty' ? [] : messages, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const config = { provider, wireApi: 'responses', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic', model: 'test-model' } as AIModelConfig
      assert.equal(await completeRSSModel(config, { system: 'Only JSON.', user: 'Source', maxTokens: 128 }), '{"accepted":true}')
      assert.equal(calls, 1)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
}

for (const provider of ['openai', 'openai-compatible'] as const) for (const kind of ['commentary', 'tool']) {
  test(`${provider} does not promote aggregate text over completed ${kind} with empty terminal output`, async () => {
    let calls = 0
    const item = kind === 'commentary'
      ? { type: 'message', id: 'commentary', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking the facts.', annotations: [] }] }
      : { type: 'function_call', id: 'tool', call_id: 'tool-call', name: 'not-exposed', arguments: '{}' }
    const server = createServer((_req, res) => {
      calls++; res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        { type: 'response.created', response: { id: 'aggregate-response', status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'aggregate-response', status: 'completed', output: [], output_text: 'Checking the facts.', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const config = { provider, wireApi: 'responses', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic', model: 'test-model' } as AIModelConfig
      await assert.rejects(completeRSSModel(config, { system: 'Only JSON.', user: 'Source', maxTokens: 128 }), ProviderOutputMissingTextError)
      assert.equal(calls, 1)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
}
