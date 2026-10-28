import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createOpenAIOAuthFetchHandler } from 'openai-oauth'
import { createCodexRoutingRelay } from '../main/modules/settings-engine/chatgpt-oauth-routing'

const jwt = (claims: Record<string, unknown>) => [
  Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify(claims)).toString('base64url'),
  'signature',
].join('.')

test('the OAuth proxy carries Codex routing headers to the responses endpoint and nothing else', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ready-oauth-routing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const authClaims = { exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-fixture' } }
  const accessToken = jwt(authClaims)
  writeFileSync(join(root, 'auth.json'), JSON.stringify({
    tokens: { id_token: jwt(authClaims), access_token: accessToken, refresh_token: 'refresh-fixture', account_id: 'account-fixture' },
    last_refresh: new Date().toISOString(),
  }))
  const upstream: Array<{ url: string; headers: Headers; body: string }> = []
  const relay = createCodexRoutingRelay(async (input, init) => {
    const url = String(input)
    upstream.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? '') })
    if (!new URL(url).pathname.endsWith('/responses')) return Response.json({ models: [] })
    return new Response('event: response.created\ndata: {"type":"response.created"}\n\n', {
      headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'turn-state-2', 'x-oai-request-id': 'oai-request-2' },
    })
  })
  const handler = createOpenAIOAuthFetchHandler({ authFilePath: join(root, 'auth.json'), fetch: relay.fetch })
  const send = (extra: Record<string, string>) => {
    const request = new Request('http://127.0.0.1:10532/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local-proxy-key', ...extra },
      body: JSON.stringify({ model: 'gpt-fixture', instructions: 'fixed', stream: true, store: false,
        prompt_cache_key: 'thread-1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
    })
    return relay.run(request.headers, () => handler(request))
  }

  const response = await send({ 'session-id': 'thread-1', 'thread-id': 'thread-1', 'x-client-request-id': 'thread-1',
    'x-codex-window-id': 'thread-1:0', 'x-codex-turn-state': 'turn-state-1', 'x-unrelated': 'stays-local' })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(response.headers.get('x-codex-turn-state'), 'turn-state-2', 'the token returns to the gateway')
  assert.equal(response.headers.get('x-oai-request-id'), 'oai-request-2')
  const forwarded = upstream.filter((entry) => new URL(entry.url).pathname.endsWith('/responses'))
  assert.equal(forwarded.length, 1)
  const headers = forwarded[0].headers
  for (const [name, value] of [['session-id', 'thread-1'], ['thread-id', 'thread-1'], ['x-client-request-id', 'thread-1'],
    ['x-codex-window-id', 'thread-1:0'], ['x-codex-turn-state', 'turn-state-1']]) {
    assert.equal(headers.get(name), value, name)
  }
  assert.equal(headers.get('authorization'), `Bearer ${accessToken}`, 'the local proxy key never leaves the machine')
  assert.equal(headers.get('x-unrelated'), null)
  assert.equal(JSON.parse(forwarded[0].body).prompt_cache_key, 'thread-1')
  assert.ok(upstream.filter((entry) => !new URL(entry.url).pathname.endsWith('/responses'))
    .every((entry) => entry.headers.get('session-id') === null), 'other upstream calls carry no routing headers')

  await send({})
  assert.equal(upstream.filter((entry) => new URL(entry.url).pathname.endsWith('/responses')).at(-1)?.headers.get('session-id'), null)
})
