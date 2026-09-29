import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { normalizeCodexTurn } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { projectCodexUserInputReadback, type CodexUserInput } from '../main/modules/agent-control/codex-runtime/codex-user-input'

test('pinned runtime retains resource inputs and quota failures across restart on the same thread', { timeout: 30_000 }, async () => {
  const manifest = JSON.parse(readFileSync('assets/codex-runtime/runtime-manifest.json', 'utf8'))
  const binary = join(process.cwd(), 'build/codex', manifest.targetTriple, 'codex')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), manifest.binarySha256)
  const root = mkdtempSync(join(tmpdir(), 'ready-input-continuity-'))
  const codexHome = join(root, 'codex-home')
  mkdirSync(codexHome)
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    const sequence = requests.length
    if ([2, 4, 5].includes(sequence)) {
      response.writeHead(sequence === 2 ? 400 : 429, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: sequence === 2 ? 'invalid_request_error' : 'usage_limit_reached' } }))
      return
    }
    const item = { type: 'message', id: `answer-${sequence}`, role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: `answer-${sequence}` }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      { type: 'response.created', response: { id: `response-${sequence}` } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: `answer-${sequence}` },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `response-${sequence}`, output: [item],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
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
supports_websockets = false
`)
  const startClient = () => {
    const child = spawn(binary, ['app-server', '--stdio', '--strict-config'], {
      cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: codexHome, TMPDIR: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.stderr.resume()
    const lines = createInterface({ input: child.stdout })
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
    const terminal = new Map<string, any>()
    const waiters = new Map<string, (value: any) => void>()
    lines.on('line', (line) => {
      const frame = JSON.parse(line)
      if (typeof frame.id === 'number') {
        const waiter = pending.get(frame.id)
        pending.delete(frame.id)
        if (frame.error) waiter?.reject(new Error(JSON.stringify(frame.error)))
        else waiter?.resolve(frame.result)
      } else if (frame.method === 'turn/completed') {
        terminal.set(frame.params.turn.id, frame.params.turn)
        waiters.get(frame.params.turn.id)?.(frame.params.turn)
      }
    })
    let id = 0
    return {
      request(method: string, params: unknown): Promise<any> {
        return new Promise((resolve, reject) => {
          pending.set(++id, { resolve, reject })
          child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
        })
      },
      async initialize() {
        await this.request('initialize', { clientInfo: { name: 'ready_input_probe', version: '1' },
          capabilities: { experimentalApi: true, requestAttestation: false } })
        child.stdin.write('{"method":"initialized"}\n')
      },
      async complete(turnId: string) {
        return terminal.get(turnId) ?? new Promise((resolve) => waiters.set(turnId, resolve))
      },
      async close() { lines.close(); child.kill('SIGTERM'); await exited },
    }
  }
  let client = startClient()
  try {
    await client.initialize()
    const started = await client.request('thread/start', { model: 'ready-e0-model', modelProvider: 'fixture',
      cwd: root, approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: [] })
    const threadId = started.thread.id
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLzQAAAAASUVORK5CYII='
    writeFileSync(join(root, 'pixel.png'), Buffer.from(png, 'base64'))
    writeFileSync(join(root, 'audio.wav'), Buffer.alloc(44))
    writeFileSync(join(root, 'SKILL.md'), '---\nname: fixture\ndescription: Fixture.\n---\nFixture only.\n')
    const resources: CodexUserInput[] = [
      { type: 'localAudio', path: join(root, 'audio.wav') },
      { type: 'text', text: 'project directory fixture', text_elements: [] },
      { type: 'localImage', path: join(root, 'pixel.png'), detail: 'high' },
      { type: 'mention', name: 'project', path: root },
      { type: 'audio', url: 'data:audio/wav;base64,UklGRg==' },
      { type: 'skill', name: 'fixture', path: join(root, 'SKILL.md') },
      { type: 'image', url: `data:image/png;base64,${png}`, detail: 'original' },
    ]
    const expected: Array<{ marker: string; content: CodexUserInput[] }> = []
    for (let sequence = 1; sequence <= 6; sequence++) {
      const marker = `CURRENT_${sequence}_END`
      const input: CodexUserInput[] = [{ type: 'text', text: marker, text_elements: [] }, ...resources]
      const startedTurn = await client.request('turn/start', { threadId, clientUserMessageId: marker, input })
      const completed = await client.complete(startedTurn.turn.id)
      assert.equal(completed.status, [2, 4, 5].includes(sequence) ? 'failed' : 'completed')
      if ([4, 5].includes(sequence)) assert.equal(completed.error.codexErrorInfo, 'usageLimitExceeded')
      expected.push({ marker, content: projectCodexUserInputReadback(input) })
      const checkReadback = async () => {
        const read = await client.request('thread/read', { threadId, includeTurns: true })
        assert.equal(read.thread.id, threadId)
        assert.equal(read.thread.turns.length, expected.length)
        for (const [index, turn] of read.thread.turns.entries()) {
          const user = normalizeCodexTurn(turn)?.items.filter((item) => item.type === 'userMessage')
          assert.equal(user?.length, 1)
          assert.equal(user![0].clientId, expected[index].marker)
          assert.deepEqual(user![0].content, expected[index].content)
        }
      }
      await checkReadback()
      if ([2, 5].includes(sequence)) {
        await client.close(); client = startClient(); await client.initialize()
        await checkReadback()
        await client.request('thread/resume', { threadId })
      }
      const wire = JSON.stringify(requests.at(-1)?.input)
      for (const previous of expected) assert.equal(wire.split(previous.marker).length - 1, 1)
    }
    assert.equal(requests.length, 6, 'failed turns are not silently retried')
  } finally {
    await client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
