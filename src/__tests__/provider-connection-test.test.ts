import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { testCodexProviderConnection } from '../main/modules/agent-control/codex-runtime/codex-provider-connection-test'

test('connection test rejects HTTP errors and fake success bodies through the real gateway', async () => {
  let status = 400
  let count = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain diagnostic input */ }
    count++
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'probe failure' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const config = { provider: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'test', model: 'test', wireApi: 'responses' as const }
  try {
    for (status of [400, 401, 403, 404, 200]) await assert.rejects(testCodexProviderConnection(config), /连接失败/)
    assert.equal(count, 5, 'no semantic retry or model-list false positives')
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})
