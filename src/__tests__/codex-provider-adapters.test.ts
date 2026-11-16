import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeZaiResponseEvent } from '../main/modules/agent-control/codex-runtime/codex-zai-responses'
import { messagesAsResponses } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-messages'
import { hasExplicitCurrentDocumentAccessExclusion, hasExplicitCurrentDocumentAccessIntent } from '../main/modules/agent-control/codex-runtime/codex-product-turn-authorization'
import { providerGatewayFixture } from './utils/provider-gateway-fixture'
import { createCodexUpstreamProfileSnapshot } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'

const usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } }

function reasoningEvents() {
  const response = { id: 'resp-test', model: 'test-model', object: 'response', created_at: 1, status: 'in_progress', output: [] }
  const added = { id: 'rs-test', type: 'reasoning', status: 'in_progress', summary: [], content: [] }
  const part = { type: 'reasoning_text', text: 'private thought' }
  const done = { ...added, status: 'completed', content: [part] }
  const ref = { output_index: 0, item_id: added.id, content_index: 0 }
  return [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', ...ref, part: { ...part, text: '' } },
    { type: 'response.reasoning_text.delta', ...ref, delta: part.text },
    { type: 'response.reasoning_text.done', ...ref, text: part.text },
    { type: 'response.content_part.done', ...ref, part },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: { ...response, status: 'completed', output: [done], usage } },
  ]
}

test('Responses raw reasoning retains its full lifecycle and rejects changed or unfinished content', async () => {
  const f = await providerGatewayFixture()
  try {
    assert.match(await f.call(reasoningEvents()), /event: response.completed/)
    const changed = reasoningEvents()
    changed[4] = { ...changed[4], text: 'changed' }
    assert.match(await f.call(changed), /event: response.failed/)
    assert.match(await f.call(reasoningEvents().filter((_, i) => i !== 5)), /event: response.failed/)
    assert.equal(f.admissions.length, 0)
  } finally { await f.close() }
})

test('GLM Responses thinking admission is limited to the official endpoint and tested models', () => {
  const config = { provider: 'openai-compatible' as const, baseUrl: 'https://api.z.ai/api/v1', model: 'glm-5.3', apiKey: 'test', wireApi: 'responses' as const, thinkingMode: 'on' as const, reasoningEffort: 'high' as const }
  const snapshot = createCodexUpstreamProfileSnapshot({ profileId: 'test', config, maxRetries: 0 }).snapshot
  assert.equal(snapshot.multiTurnThinkingPolicy, 'echo_required')
  assert.throws(() => createCodexUpstreamProfileSnapshot({ profileId: 'test', config: { ...config, baseUrl: 'https://other.example/v1' }, maxRetries: 0 }), /gateway_reasoning_policy_unsupported/)
})

test('Messages streams pass the same tool admission and preserve tool results in the next request', async () => {
  const f = await providerGatewayFixture({ agentProtocol: 'anthropic' })
  const events = [
    { type: 'message_start', message: { id: 'msg-test', model: 'test-model', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-test', name: 'read_token', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
  try {
    const stream = await f.call(events)
    assert.match(stream, /event: response.completed/)
    assert.equal(f.admissions.length, 1)
    assert.equal(f.requests[0].path, '/v1/messages')
    f.request.input.push({ type: 'function_call', call_id: 'call-test', name: 'read_token', arguments: '{}' }, { type: 'function_call_output', call_id: 'call-test', output: 'TOKEN' })
    await f.call(events)
    assert.deepEqual(f.requests[1].body.messages.at(-1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-test', content: 'TOKEN' }] })
    const forbidden = structuredClone(events)
    forbidden[1].content_block!.name = 'forbidden'
    assert.match(await f.call(forbidden), /response.failed/)
    assert.equal(f.admissions.length, 2)
  } finally { await f.close() }
})

test('Messages signed thinking survives native history and truncated tools never execute', async () => {
  const f = await providerGatewayFixture({ agentProtocol: 'anthropic' })
  const events: any[] = [
    { type: 'message_start', message: { id: 'msg-thought', model: 'test-model', content: [], usage: { input_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-original' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-thought', name: 'read_token', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
  try {
    const stream = await f.call(events)
    const terminal = stream.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).find((e) => e.type === 'response.completed')
    assert.ok(terminal)
    assert.equal(terminal.response.usage.input_tokens, 10)
    assert.equal(terminal.response.usage.input_tokens_details.cached_tokens, 2)
    assert.doesNotMatch(stream, /reasoning_summary_text/)
    f.request.input.push(...terminal.response.output, { type: 'function_call_output', call_id: 'call-thought', output: 'token' })
    await f.call(events)
    assert.deepEqual(f.requests[1].body.messages[1].content[0], { type: 'thinking', thinking: 'private thought', signature: 'signed-original' })
    const truncated = structuredClone(events)
    truncated[8].delta.stop_reason = 'max_tokens'
    assert.match(await f.call(truncated), /gateway_upstream_output_truncated/)
    assert.equal(f.admissions.length, 2)
    assert.match(await f.call(events.slice(0, -1)), /gateway_messages_terminal_missing/)
    assert.equal(f.admissions.length, 2)
  } finally { await f.close() }
})


test('an API-key Responses provider may echo the request and pad deltas; an unknown field is still refused', async () => {
  const f = await providerGatewayFixture()
  try {
    // The shape the public Responses API sends: the full `response` object, empty logprobs, obfuscation padding.
    const echo = { instructions: 'x', metadata: {}, parallel_tool_calls: true, reasoning: { effort: null, summary: null },
      store: false, temperature: 1, text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], top_p: 1,
      truncation: 'disabled', user: null, service_tier: 'auto', background: false, max_output_tokens: null,
      previous_response_id: null, prompt_cache_key: 'k', safety_identifier: null, top_logprobs: 0 }
    const official = reasoningEvents().map((event) => ({
      ...event,
      ...(event.type === 'response.reasoning_text.delta' ? { obfuscation: 'aB3xY9', logprobs: [] } : {}),
      ...(event.response ? { response: { ...event.response, ...echo } } : {}),
    }))
    const text = await f.call(official)
    assert.match(text, /event: response.completed/)
    assert.doesNotMatch(text, /obfuscation|truncation|aB3xY9/)
    const unknown = structuredClone(official)
    unknown[0].response = { ...(unknown[0].response as object), execute: 'not metadata' }
    assert.match(await f.call(unknown), /gateway_response_shape_invalid/)
    const padded = structuredClone(official)
    ;(padded[3] as Record<string, unknown>).obfuscation = { not: 'padding' }
    assert.match(await f.call(padded), /gateway_response_event_shape_invalid/)
  } finally { await f.close() }
})

test('Zai normalization removes only known inert fields, preserving unknown actions for rejection', async () => {
  const f = await providerGatewayFixture()
  try {
    const events = reasoningEvents().map((event) => normalizeZaiResponseEvent({ ...event, ...(event.type === 'response.reasoning_text.delta' ? { logprobs: [] } : {}), ...(event.response ? { response: { ...event.response, prompt_cache_key: 'echo', instructions: 'echo' } } : {}) }))
    assert.match(await f.call(events), /event: response.completed/)
    assert.equal((normalizeZaiResponseEvent({ item: { type: 'message', phase: 'commentary', content: [] } }).item as any).phase, 'commentary')
    const malicious = structuredClone(events)
    malicious[0].response = { ...(malicious[0].response as object), execute: 'not metadata' }
    assert.match(await f.call(malicious), /gateway_response_shape_invalid/)
  } finally { await f.close() }
})

test('Messages text arrives before terminal and downstream cancellation closes upstream', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller }, cancel() { cancelled = true } })
  const push = (value: unknown) => source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
  const reader = messagesAsResponses(body, 'test-model', { maxBytes: 10000, maxEvents: 100, maxItemBytes: 1000 }).getReader()
  push({ type: 'message_start', message: { id: 'msg-stream', model: 'test-model', content: [], usage: { input_tokens: 1 } } })
  push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'visible now' } })
  let text = ''
  for (let i = 0; i < 3; i++) text += new TextDecoder().decode((await reader.read()).value)
  assert.match(text, /visible now/)
  assert.doesNotMatch(text, /response.completed/)
  await reader.cancel()
  assert.equal(cancelled, true)
})

test('Responses tool done name is accepted only when it matches the admitted item', async () => {
  const f = await providerGatewayFixture()
  const tool = { type: 'function_call', id: 'fc-test', call_id: 'call-test', name: 'read_token', arguments: '', status: 'in_progress' }
  const done = { ...tool, arguments: '{}', status: 'completed' }
  const events: any[] = [
    { type: 'response.created', response: { id: 'r-tool', model: 'test-model', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: tool },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: tool.id, delta: '{}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: tool.id, name: tool.name, arguments: '{}' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: { id: 'r-tool', model: 'test-model', status: 'completed', output: [done], usage } },
  ]
  try {
    assert.match(await f.call(events), /response.completed/)
    assert.equal(f.admissions.length, 1)
    events[3].name = 'another_tool'
    assert.match(await f.call(events), /gateway_response_tool_name_invalid/)
    assert.equal(f.admissions.length, 1)
  } finally { await f.close() }
})

test('Opus 5.5 explicit effort is sent as adaptive thinking without changing its level', async () => {
  const f = await providerGatewayFixture({ provider: 'anthropic', model: 'claude-opus-5-5', agentProtocol: 'anthropic', reasoningEffort: 'xhigh' })
  try {
    await f.call([{ type: 'error', error: { type: 'overloaded_error', message: 'fixture' } }])
    assert.deepEqual(f.requests[0].body.thinking, { type: 'adaptive' })
    assert.deepEqual(f.requests[0].body.output_config, { effort: 'xhigh' })
    assert.equal(f.requests.length, 1)
  } finally { await f.close() }
})


test('a follow-up declining another document read does not acquire a new read obligation', () => {
  const followup = '不需要再读取文档或使用工具。只重复上一条回复中的完整代号。'
  assert.equal(hasExplicitCurrentDocumentAccessExclusion(followup), true)
  assert.equal(hasExplicitCurrentDocumentAccessIntent(followup), false)
  assert.equal(hasExplicitCurrentDocumentAccessExclusion('读取当前文档，不需要修改。'), false)
})

test('prose preceding a tool is commentary; only a tool-free final reply is a final answer', async () => {
  const f = await providerGatewayFixture({ agentProtocol: 'anthropic' })
  const opening: any[] = [
    { type: 'message_start', message: { id: 'msg-phase', model: 'test-model', content: [], usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will read the document.' } },
    { type: 'content_block_stop', index: 0 },
  ]
  const terminal = (reason: string) => [
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  try {
    const toolStream = await f.call([...opening,
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-phase', name: 'read_token', input: {} } },
      { type: 'content_block_stop', index: 1 }, ...terminal('tool_use'),
    ])
    assert.match(toolStream, /response.completed/)
    assert.match(toolStream, /"phase":"commentary"/)
    assert.doesNotMatch(toolStream, /"phase":"final_answer"/)
    const finalStream = await f.call([...opening, ...terminal('end_turn')])
    assert.match(finalStream, /response.completed/)
    assert.match(finalStream, /"phase":"final_answer"/)
  } finally { await f.close() }
})
