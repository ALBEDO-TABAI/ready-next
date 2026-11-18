import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { normalizeCodexTurn, type CodexTurn } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { CodexTurnInputBuilder } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'

// Probes for the failed-turn continuity seams: the pinned runtime keeps a failed
// turn's user item, completed tool rounds and completed items exactly once,
// across a restart, and replays them to the next turn on the same thread.

type Respond = (sequence: number, response: ServerResponse) => Promise<void> | void
type TerminalTurn = { id: string; status: string; error: { codexErrorInfo?: unknown; message?: string } | null }

const sendEvent = (response: ServerResponse, event: Record<string, unknown>) => (
  response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
)
const usage = { input_tokens: 12, output_tokens: 4, total_tokens: 16 }

function completedResponse(response: ServerResponse, sequence: number, items: Array<Record<string, unknown>>): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  sendEvent(response, { type: 'response.created', response: { id: `response-${sequence}` } })
  items.forEach((item, index) => sendEvent(response, { type: 'response.output_item.done', output_index: index, item }))
  sendEvent(response, { type: 'response.completed', response: { id: `response-${sequence}`, output: items, usage } })
  response.end()
}

const toolRound = (marker: string) => [
  { type: 'message', id: `commentary-${marker}`, role: 'assistant', phase: 'commentary',
    content: [{ type: 'output_text', text: `COMMENTARY_${marker}` }] },
  { type: 'function_call', id: `call-item-${marker}`, call_id: `CALL_${marker}`, name: 'ready_read_probe',
    arguments: '{"query":"A"}' },
]
const answer = (sequence: number) => [{ type: 'message', id: `answer-${sequence}`, role: 'assistant',
  phase: 'final_answer', content: [{ type: 'output_text', text: `answer-${sequence}` }] }]

async function withPinnedRuntime(respond: Respond, run: (probe: {
  requests: Array<Record<string, unknown>>
  toolCalls: Array<Record<string, unknown>>
  threadId: string
  runTurn(sequence: number, marker: string): Promise<TerminalTurn>
  startTurn(sequence: number, marker: string): Promise<{ turnId: string; done: Promise<TerminalTurn> }>
  interrupt(turnId: string): Promise<void>
  readTurns(): Promise<CodexTurn[]>
  restart(): Promise<void>
}) => Promise<void>): Promise<void> {
  const manifest = JSON.parse(readFileSync('assets/codex-runtime/runtime-manifest.json', 'utf8'))
  const binary = join(process.cwd(), 'build/codex', manifest.targetTriple, 'codex.exe')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), manifest.binarySha256)
  const root = mkdtempSync(join(tmpdir(), 'ready-failed-turn-continuity-'))
  const codexHome = join(root, 'codex-home')
  mkdirSync(codexHome)
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    await respond(requests.length, response)
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
  const toolCalls: Array<Record<string, unknown>> = []
  // A tool whose marker names it slow is left running, as a Ready tool the user stops waiting for.
  const answersTool = (params: Record<string, unknown>) => !String(params.callId).includes('SLOW')
  const startClient = () => {
    const child = spawn(binary, ['app-server', '--stdio', '--strict-config'], {
      cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: codexHome, TMPDIR: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.stderr.resume()
    const lines = createInterface({ input: child.stdout })
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
    const terminal = new Map<string, TerminalTurn>()
    const waiters = new Map<string, (value: TerminalTurn) => void>()
    lines.on('line', (line) => {
      const frame = JSON.parse(line)
      if (frame.method === 'item/tool/call' && frame.id !== undefined) {
        toolCalls.push(frame.params)
        if (!answersTool(frame.params)) return
        child.stdin.write(JSON.stringify({ id: frame.id, result: {
          contentItems: [{ type: 'inputText', text: `TOOL_RESULT_${frame.params.callId}` }], success: true,
        } }) + '\n')
      } else if (typeof frame.id === 'number') {
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
      request<T>(method: string, params: unknown): Promise<T> {
        return new Promise<T>((resolve, reject) => {
          pending.set(++id, { resolve: (value) => resolve(value as T), reject })
          child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
        })
      },
      async initialize() {
        await this.request('initialize', { clientInfo: { name: 'ready_failed_turn_probe', version: '1' },
          capabilities: { experimentalApi: true, requestAttestation: false } })
        child.stdin.write('{"method":"initialized"}\n')
      },
      async complete(turnId: string): Promise<TerminalTurn> {
        return terminal.get(turnId) ?? new Promise<TerminalTurn>((resolve) => waiters.set(turnId, resolve))
      },
      async close() { lines.close(); child.kill('SIGTERM'); await exited },
    }
  }
  let client = startClient()
  try {
    await client.initialize()
    const started = await client.request<{ thread: { id: string } }>('thread/start', { model: 'ready-e0-model', modelProvider: 'fixture',
      cwd: root, approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: [{
        type: 'function', name: 'ready_read_probe', description: 'Read probe.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
          additionalProperties: false },
      }] })
    const threadId = started.thread.id
    const startTurn = async (sequence: number, marker: string) => {
      const ingress = {
        kind: 'user_ingress' as const, attemptKind: 'user_ingress' as const, originUserMessageId: marker,
        canonicalCurrentInputRef: { messageId: marker, input: [{ type: 'text' as const, text: marker, text_elements: [] }] },
        explicitResourceEnvelope: { input: [], resourceRefs: [] }, resourceAdditionalContext: [],
        actionAdmissionRef: { headProjectionDigest: 'f'.repeat(64),
          actionProjectionVersion: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: sequence },
          actionHeadIdentity: { aliasId: 'scope', aliasGeneration: 1, threadBindingId: 'binding', headRevision: 1 } },
        uncommittedTailAssignments: [], supersededUncommittedItems: [],
      }
      const built = new CodexTurnInputBuilder().build(ingress, {
        threadId, turnRequestId: marker, readyRunId: `run-${sequence}`, reasoningEffort: null,
        toolSurfaceDigest: 'f'.repeat(64), turnContractDigest: 'a'.repeat(64),
        upstreamProfileSnapshotDigest: 'b'.repeat(64), readyMemorySnapshot: disabledReadyMemorySnapshot(),
      })
      if (!built.ok) throw new Error(built.code)
      const startedTurn = await client.request<{ turn: { id: string } }>('turn/start', built.params)
      return { turnId: startedTurn.turn.id, done: client.complete(startedTurn.turn.id) }
    }
    await run({
      requests, toolCalls, threadId, startTurn,
      async runTurn(sequence, marker) { return (await startTurn(sequence, marker)).done },
      async interrupt(turnId) { await client.request('turn/interrupt', { threadId, turnId }) },
      async readTurns() {
        return (await client.request<{ thread: { turns: unknown[] } }>('thread/read', { threadId, includeTurns: true }))
          .thread.turns.map((turn) => normalizeCodexTurn(turn)!)
      },
      async restart() {
        await client.close(); client = startClient(); await client.initialize()
        await client.request('thread/resume', { threadId })
      },
    })
  } finally {
    await client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}

const turnItems = (turn: CodexTurn) => turn.items.flatMap((item) => (
  item.type === 'userMessage' ? [`user:${item.clientId}`]
    : item.type === 'agentMessage' ? [`agent:${item.phase}:${item.text}`]
      : item.type === 'dynamicToolCall' ? [`tool:${item.tool}:${item.status}`]
        : []
))

test('pinned runtime retains completed tool rounds when a later request fails transiently', { timeout: 30_000 }, async () => {
  // Every transient status the Ready gateway can hand Codex: retryable upstream
  // HTTP codes pass through; transport failures surface as 502 and 504.
  const userOnlyStatuses = [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]
  const failures = new Map<number, number>([[2, 500], ...userOnlyStatuses.map((status, index) => (
    [4 + index * 2, status] as [number, number]
  ))])
  await withPinnedRuntime((sequence, response) => {
    const status = failures.get(sequence)
    if (status) {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'fixture upstream failure', type: 'server_error' } }))
      return
    }
    completedResponse(response, sequence, sequence === 1 ? toolRound('A') : answer(sequence))
  }, async ({ requests, toolCalls, runTurn, readTurns, restart }) => {
    // Seam failed_after_completed_rounds_v1: one completed tool round, then a 500.
    const failedAfterRound = await runTurn(1, 'TASK_A')
    assert.equal(failedAfterRound.status, 'failed')
    assert.equal(failedAfterRound.error?.codexErrorInfo, 'internalServerError')
    assert.equal(toolCalls.length, 1)
    // Pinned 0.160.1 reads back the finished dynamic tool call too; the wire replay below stays the authority.
    const expectedRoundItems = ['user:TASK_A', 'agent:commentary:COMMENTARY_A', 'tool:ready_read_probe:completed']
    assert.deepEqual(turnItems((await readTurns())[0]), expectedRoundItems)
    await restart()
    assert.deepEqual(turnItems((await readTurns())[0]), expectedRoundItems)
    const continued = await runTurn(2, 'CONTINUE_B')
    assert.equal(continued.status, 'completed')
    const replay = JSON.stringify(requests.at(-1)?.input)
    for (const marker of ['TASK_A', 'COMMENTARY_A', '"call_id":"CALL_A"', 'TOOL_RESULT_CALL_A', 'CONTINUE_B']) {
      assert.equal(replay.split(marker).length - 1, marker === '"call_id":"CALL_A"' ? 2 : 1, marker)
    }

    // Seam failed_user_only_no_suffix_v1 with transient statuses instead of 400/429.
    const priorMarkers = ['TASK_A', 'TOOL_RESULT_CALL_A', 'CONTINUE_B']
    for (const [index, status] of userOnlyStatuses.entries()) {
      const failedUserOnly = await runTurn(3 + index * 2, `TASK_${status}`)
      assert.equal(failedUserOnly.status, 'failed', String(status))
      assert.deepEqual(turnItems((await readTurns()).at(-1)!), [`user:TASK_${status}`], String(status))
      if (index === 0) await restart()
      const continuedUserOnly = await runTurn(4 + index * 2, `CONTINUE_${status}`)
      assert.equal(continuedUserOnly.status, 'completed', String(status))
      const userOnlyReplay = JSON.stringify(requests.at(-1)?.input)
      for (const marker of [...priorMarkers, `TASK_${status}`, `CONTINUE_${status}`]) {
        assert.equal(userOnlyReplay.split(marker).length - 1, 1, `${status}:${marker}`)
      }
      priorMarkers.push(`TASK_${status}`, `CONTINUE_${status}`)
    }
    assert.equal(requests.length, 3 + userOnlyStatuses.length * 2, 'failed requests are not silently retried by the runtime')
  })
})

test('pinned runtime keeps completed items and drops partial ones when a stream breaks mid-response', { timeout: 30_000 }, async () => {
  // Seam failed_mid_stream_v1. Request 2 and 5 break after a completed commentary item and a partial one:
  // first with the gateway's own `response.failed`, then by the runtime's stream idle timeout.
  const broken = new Map<number, { marker: string; wire: 'gateway_response_failed' | 'runtime_stream_idle_timeout' }>([
    [2, { marker: 'GW', wire: 'gateway_response_failed' }],
    [5, { marker: 'IDLE', wire: 'runtime_stream_idle_timeout' }],
  ])
  await withPinnedRuntime(async (sequence, response) => {
    const failure = broken.get(sequence)
    if (!failure) {
      const round = sequence === 1 ? 'GW' : sequence === 4 ? 'IDLE' : null
      return completedResponse(response, sequence, round ? toolRound(round) : answer(sequence))
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    sendEvent(response, { type: 'response.created', response: { id: `response-${sequence}` } })
    sendEvent(response, { type: 'response.output_item.done', output_index: 0, item: { type: 'message',
      id: `written-${failure.marker}`, role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: `WRITTEN_${failure.marker}` }] } })
    sendEvent(response, { type: 'response.output_item.added', output_index: 1, item: { type: 'message',
      id: `partial-${failure.marker}`, role: 'assistant', phase: 'commentary', content: [] } })
    sendEvent(response, { type: 'response.output_text.delta', output_index: 1, content_index: 0,
      item_id: `partial-${failure.marker}`, delta: `PARTIAL_${failure.marker}` })
    if (failure.wire === 'gateway_response_failed') {
      sendEvent(response, { type: 'response.failed', sequence_number: 0, response: {
        id: `response-${sequence}`, model: 'ready-e0-model', status: 'failed', output: [],
        error: { code: 'gateway_native_stream_failed', message: 'gateway_native_stream_failed', type: 'gateway_error', param: null },
      } })
    } else {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
    response.end()
  }, async ({ requests, runTurn, readTurns, restart }) => {
    const priorMarkers: string[] = []
    for (const [index, marker] of ['GW', 'IDLE'].entries()) {
      const failed = await runTurn(1 + index * 2, `TASK_${marker}`)
      assert.equal(failed.status, 'failed', marker)
      assert.match(failed.error?.message ?? '', /stream disconnected before completion/, marker)
      const expected = [`user:TASK_${marker}`, `agent:commentary:COMMENTARY_${marker}`,
        'tool:ready_read_probe:completed', `agent:commentary:WRITTEN_${marker}`]
      assert.deepEqual(turnItems((await readTurns()).at(-1)!), expected, marker)
      await restart()
      assert.deepEqual(turnItems((await readTurns()).at(-1)!), expected, marker)
      const continued = await runTurn(2 + index * 2, `CONTINUE_${marker}`)
      assert.equal(continued.status, 'completed', marker)
      const replay = JSON.stringify(requests.at(-1)?.input)
      for (const expectedMarker of [...priorMarkers, `TASK_${marker}`, `COMMENTARY_${marker}`, `TOOL_RESULT_CALL_${marker}`,
        `WRITTEN_${marker}`, `CONTINUE_${marker}`]) {
        assert.equal(replay.split(expectedMarker).length - 1, 1, expectedMarker)
      }
      assert.equal(replay.split(`"call_id":"CALL_${marker}"`).length - 1, 2, marker)
      assert.equal(replay.includes(`PARTIAL_${marker}`), false, 'a partial item never reaches history')
      priorMarkers.push(`TASK_${marker}`, `CONTINUE_${marker}`)
    }
    assert.equal(requests.length, 6, 'a broken stream is not silently retried by the runtime')
  })
})

test('pinned runtime keeps finished rounds when the user stops mid-stream or while a tool runs', { timeout: 30_000 }, async () => {
  // Seam interrupted_after_completed_items_v1. Request 2 stays open mid-answer; request 5 leaves a tool running.
  const holds: Array<() => void> = []
  await withPinnedRuntime(async (sequence, response) => {
    if (sequence === 1) return completedResponse(response, sequence, toolRound('STREAM'))
    if (sequence === 4) return completedResponse(response, sequence, toolRound('TOOL'))
    if (sequence === 5) {
      return completedResponse(response, sequence, [
        { type: 'message', id: 'written-TOOL', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'WRITTEN_TOOL' }] },
        { type: 'function_call', id: 'call-item-slow', call_id: 'CALL_SLOW', name: 'ready_read_probe', arguments: '{"query":"B"}' },
      ])
    }
    if (sequence !== 2) return completedResponse(response, sequence, answer(sequence))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    sendEvent(response, { type: 'response.created', response: { id: 'response-2' } })
    sendEvent(response, { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'written-STREAM',
      role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'WRITTEN_STREAM' }] } })
    sendEvent(response, { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'partial-STREAM',
      role: 'assistant', phase: 'final_answer', content: [] } })
    sendEvent(response, { type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: 'partial-STREAM', delta: 'PARTIAL_STREAM' })
    await new Promise<void>((resolve) => { holds.push(resolve); response.once('close', () => resolve()) })
    response.end()
  }, async ({ requests, toolCalls, startTurn, interrupt, readTurns, restart, runTurn }) => {
    const priorMarkers: string[] = []
    for (const [index, marker] of ['STREAM', 'TOOL'].entries()) {
      const started = await startTurn(1 + index * 3, `TASK_${marker}`)
      const waitFor = marker === 'STREAM' ? () => requests.length >= 2 : () => toolCalls.some((call) => call.callId === 'CALL_SLOW')
      for (let turn = 0; turn < 200 && !waitFor(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 20))
      await interrupt(started.turnId)
      holds.splice(0).forEach((release) => release())
      const stopped = await started.done
      assert.equal(stopped.status, 'interrupted', marker)
      const expected = [`user:TASK_${marker}`, `agent:commentary:COMMENTARY_${marker}`,
        'tool:ready_read_probe:completed', `agent:commentary:WRITTEN_${marker}`]
      assert.deepEqual(turnItems((await readTurns()).at(-1)!), expected, marker)
      await restart()
      assert.deepEqual(turnItems((await readTurns()).at(-1)!), expected, marker)
      const continued = await runTurn(2 + index * 3 + (marker === 'TOOL' ? 1 : 0), `CONTINUE_${marker}`)
      assert.equal(continued.status, 'completed', marker)
      const replay = JSON.stringify(requests.at(-1)?.input)
      for (const expectedMarker of [...priorMarkers, `TASK_${marker}`, `COMMENTARY_${marker}`, `TOOL_RESULT_CALL_${marker}`,
        `WRITTEN_${marker}`, `CONTINUE_${marker}`]) {
        assert.equal(replay.split(expectedMarker).length - 1, 1, expectedMarker)
      }
      assert.equal(replay.includes('PARTIAL_STREAM'), false, 'a partial answer never reaches history')
      assert.equal(replay.split('<turn_aborted>').length - 1, index + 1, 'the runtime tells the model about each stop')
      priorMarkers.push(`TASK_${marker}`, `CONTINUE_${marker}`)
    }
    const slowCall = JSON.stringify(requests.at(-1)?.input)
    assert.equal(slowCall.split('"call_id":"CALL_SLOW"').length - 1, 2, 'the open call is closed, not dropped')
    assert.match(slowCall, /aborted by user/)
    assert.equal(requests.length, 6, 'a stop is not followed by a silent retry')
  })
})
