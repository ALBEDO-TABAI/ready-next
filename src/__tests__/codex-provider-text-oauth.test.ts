import assert from 'node:assert/strict'
import test from 'node:test'

import { requestCodexProviderText } from '../main/modules/agent-control/codex-runtime/codex-provider-text'
import { buildChatGptOAuthConfig, CHATGPT_OAUTH_BASE_URL } from '../shared/chatgpt-oauth'

// The local ChatGPT OAuth proxy streams Responses events but labels them application/json.
// RSS background judgments reach it through requestCodexProviderText; before the fix every
// call failed with gateway_upstream_not_sse because the request did not carry the OAuth profile.
function oauthUpstreamBody(text: string): string {
  const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  return [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-oauth-test', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-oauth-test', status: 'completed', output: [], usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 7 } } },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function withOAuthUpstream(t: import('node:test').TestContext, contentType: string): string[] {
  const original = globalThis.fetch
  const upstreamCalls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith(CHATGPT_OAUTH_BASE_URL)) return original(input, init)
    upstreamCalls.push(url)
    return new Response(oauthUpstreamBody('{"decision":1}'), { status: 200, headers: { 'content-type': contentType } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return upstreamCalls
}

test('a ChatGPT OAuth profile completes a tool-free text request through its JSON-labelled stream', async (t) => {
  const upstreamCalls = withOAuthUpstream(t, 'application/json')
  const config = buildChatGptOAuthConfig(null, ['gpt-oauth-test'], 'p'.repeat(40))
  const result = await requestCodexProviderText(config, { system: 'Classify.', user: 'Item', maxTokens: 512, timeoutMs: 10_000 })
  assert.equal(result.text, '{"decision":1}')
  assert.equal(upstreamCalls.length, 1, 'one request, no retry')
})

test('other providers still require a real event stream', async (t) => {
  withOAuthUpstream(t, 'application/json')
  const config = { ...buildChatGptOAuthConfig(null, ['gpt-oauth-test'], 'p'.repeat(40)), authMode: undefined, reasoningEffort: undefined }
  await assert.rejects(
    requestCodexProviderText(config, { system: 'Classify.', user: 'Item', maxTokens: 512, timeoutMs: 10_000 }),
    /gateway_upstream_not_sse/,
  )
})
