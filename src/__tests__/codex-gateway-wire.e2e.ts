import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { createCodexDownstream } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-common'

// Probes for what the gateway relies on in the pinned runtime's model wire: a quiet stream ends at the SSE idle
// timeout unless a `ready.keepalive` event arrives, and the backend's turn-state token returns within a turn.

type TerminalTurn = { status: string; error: { message?: string } | null }
type Fixture = (request: IncomingMessage, body: Record<string, unknown>, response: ServerResponse) => Promise<void> | void

const sendEvent = (response: ServerResponse, event: Record<string, unknown>) => (
  response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
)

const answersToolResult = (body: Record<string, unknown>) => (
  (body.input as Array<Record<string, unknown>>).at(-1)?.type === 'function_call_output'
)

function finishResponse(response: ServerResponse, body: Record<string, unknown>): void {
  const items = answersToolResult(body)
    ? [{ type: 'message', id: 'answer', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'DONE' }] }]
    : [{ type: 'function_call', id: 'call-item', call_id: 'CALL_LONG', name: 'ready_read_probe', arguments: '{"query":"A"}' }]
  items.forEach((item, index) => sendEvent(response, { type: 'response.output_item.done', output_index: index, item }))
  sendEvent(response, { type: 'response.completed', response: { id: 'response', output: items,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
  response.end()
}

async function withPinnedRuntime(fixture: Fixture, run: (runTurn: (text: string) => Promise<TerminalTurn & {
  toolCalls: number
}>) => Promise<void>): Promise<void> {
  const manifest = JSON.parse(readFileSync('assets/codex-runtime/runtime-manifest.json', 'utf8'))
  const binary = join(process.cwd(), 'build/codex', manifest.targetTriple, 'codex')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), manifest.binarySha256)
  const root = mkdtempSync(join(tmpdir(), 'ready-gateway-wire-'))
  const codexHome = join(root, 'codex-home')
  mkdirSync(codexHome)
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    await fixture(request, JSON.parse(Buffer.concat(chunks).toString()), response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  writeFileSync(join(codexHome, 'config.toml'), `
model = "ready-e0-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[analytics]
enabled = false
[features]
goals = false
apps = false
plugins = false
memories = false
[model_providers.fixture]
name = "isolated fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "fixture-only"
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 1500
supports_websockets = false
`)
  const child = spawn(binary, ['app-server', '--stdio', '--strict-config'], {
    cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: codexHome, TMPDIR: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  const pending = new Map<number, (frame: { result?: unknown; error?: unknown }) => void>()
  const terminal = new Map<string, TerminalTurn>()
  const waiters = new Map<string, (turn: TerminalTurn) => void>()
  let toolCalls = 0
  lines.on('line', (line) => {
    const frame = JSON.parse(line)
    if (frame.method === 'item/tool/call' && frame.id !== undefined) {
      toolCalls += 1
      child.stdin.write(JSON.stringify({ id: frame.id, result: {
        contentItems: [{ type: 'inputText', text: `TOOL_RESULT_${frame.params.callId}` }], success: true,
      } }) + '\n')
    } else if (typeof frame.id === 'number') {
      pending.get(frame.id)?.(frame)
      pending.delete(frame.id)
    } else if (frame.method === 'turn/completed') {
      terminal.set(frame.params.turn.id, frame.params.turn)
      waiters.get(frame.params.turn.id)?.(frame.params.turn)
    }
  })
  let id = 0
  const request = <T>(method: string, params: unknown) => new Promise<T>((resolve, reject) => {
    pending.set(++id, (frame) => frame.error ? reject(new Error(JSON.stringify(frame.error))) : resolve(frame.result as T))
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  try {
    await request('initialize', { clientInfo: { name: 'ready_gateway_wire_probe', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false } })
    child.stdin.write('{"method":"initialized"}\n')
    const thread = await request<{ thread: { id: string } }>('thread/start', { model: 'ready-e0-model',
      modelProvider: 'fixture', cwd: root, approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: [{
        type: 'function', name: 'ready_read_probe', description: 'Read probe.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
          additionalProperties: false },
      }] })
    await run(async (text) => {
      const before = toolCalls
      const started = await request<{ turn: { id: string } }>('turn/start', { threadId: thread.thread.id,
        input: [{ type: 'text', text, text_elements: [] }] })
      const turn = terminal.get(started.turn.id)
        ?? await new Promise<TerminalTurn>((resolve) => waiters.set(started.turn.id, resolve))
      return { ...turn, toolCalls: toolCalls - before }
    })
  } finally {
    lines.close()
    child.kill('SIGTERM')
    await exited
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}

test('pinned runtime keeps a quiet stream alive only on the gateway keepalive event', { timeout: 60_000 }, async () => {
  let quiet: 'silent' | 'comment' | 'keepalive' = 'silent'
  await withPinnedRuntime(async (_request, body, response) => {
    const downstream = createCodexDownstream((chunk) => response.write(chunk), 1)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    sendEvent(response, { type: 'response.created', response: { id: 'response' } })
    if (!answersToolResult(body)) {
      // The gateway holds a tool call until the whole response validates; this is the quiet stretch.
      for (let elapsed = 0; elapsed < 3_000; elapsed += 400) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (quiet === 'comment') response.write(': keepalive\n\n')
        if (quiet === 'keepalive') downstream.upstreamProgressed()
      }
    }
    finishResponse(response, body)
  }, async (runTurn) => {
    for (const mode of ['silent', 'comment'] as const) {
      quiet = mode
      const quietTurn = await runTurn(`WRITE_${mode}`)
      assert.equal(quietTurn.status, 'failed', mode)
      assert.match(quietTurn.error?.message ?? '', /idle timeout waiting for SSE/, mode)
      assert.equal(quietTurn.toolCalls, 0, mode)
    }
    quiet = 'keepalive'
    const kept = await runTurn('WRITE_keepalive')
    assert.equal(kept.status, 'completed', JSON.stringify(kept.error))
    assert.equal(kept.toolCalls, 1)
  })
})

test('pinned runtime returns the backend turn-state token on the rest of the turn only', { timeout: 30_000 }, async () => {
  const seen: Array<string | null> = []
  await withPinnedRuntime((request, body, response) => {
    seen.push(typeof request.headers['x-codex-turn-state'] === 'string' ? request.headers['x-codex-turn-state'] : null)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-turn-state': `STATE_${seen.length}` })
    sendEvent(response, { type: 'response.created', response: { id: 'response' } })
    finishResponse(response, body)
  }, async (runTurn) => {
    for (const text of ['FIRST_TURN', 'SECOND_TURN']) assert.equal((await runTurn(text)).status, 'completed', text)
  })
  // Each turn makes a tool round, then answers; the second request of each turn carries its first token.
  assert.deepEqual(seen, [null, 'STATE_1', null, 'STATE_3'])
})
