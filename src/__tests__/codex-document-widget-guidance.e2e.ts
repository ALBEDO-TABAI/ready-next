import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { CodexTurnInputBuilder } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import {
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
  codexDocumentWidgetGuidance,
} from '../main/modules/agent-control/codex-runtime/codex-document-widget-guidance'
import {
  currentTurnReadyAdditionalContext,
  digestReadyAdditionalContext,
  instructionTranscriptDigest,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { buildCodexReplacedTurnContext } from '../main/modules/agent-control/codex-runtime/codex-turn-replacement'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'

// 2026-10-06: Codex turns could insert widgets but never saw Ready's component catalog, so the model guessed names.
test('pinned runtime delivers the widget catalog every authorized turn without changing the instruction contract', { timeout: 30_000 }, async () => {
  const manifest = JSON.parse(readFileSync('assets/codex-runtime/runtime-manifest.json', 'utf8'))
  const binary = join(process.cwd(), 'build/codex', manifest.targetTriple, 'codex')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), manifest.binarySha256)
  const root = mkdtempSync(join(tmpdir(), 'ready-widget-guidance-'))
  const codexHome = join(root, 'codex-home')
  mkdirSync(codexHome)
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    const sequence = requests.length
    const item = { type: 'message', id: `answer-${sequence}`, role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: `answer-${sequence}` }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      { type: 'response.created', response: { id: `response-${sequence}` } },
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
  const child = spawn(binary, ['app-server', '--stdio', '--strict-config'], {
    cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: codexHome, TMPDIR: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const completed = new Map<string, (turn: { status: string }) => void>()
  lines.on('line', (line) => {
    const frame = JSON.parse(line)
    if (typeof frame.id === 'number') {
      const waiter = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.error) waiter?.reject(new Error(JSON.stringify(frame.error)))
      else waiter?.resolve(frame.result)
    } else if (frame.method === 'turn/completed') {
      completed.get(frame.params.turn.id)?.(frame.params.turn)
    }
  })
  let id = 0
  const request = <T = unknown>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
    pending.set(++id, { resolve: (value) => resolve(value as T), reject })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  try {
    await request('initialize', { clientInfo: { name: 'ready_widget_guidance_probe', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false } })
    child.stdin.write('{"method":"initialized"}\n')
    const threadId = (await request<{ thread: { id: string } }>('thread/start', { model: 'ready-e0-model', modelProvider: 'fixture',
      cwd: root, approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: [] })).thread.id
    const authorized = (allowedToolNames: string[]) => ({ readyTurnToolAuthorization: { allowedToolNames } }) as never
    const guidance = codexDocumentWidgetGuidance(authorized(['document_read_section', 'document_insert_widget']))
    assert.ok(guidance?.includes('info_card') && guidance.includes('body!(string)'))
    assert.equal(codexDocumentWidgetGuidance(authorized(['document_read_section'])), null, 'a read-only turn gets no catalog')
    assert.equal(codexDocumentWidgetGuidance({
      readyTurnToolAuthorization: { allowedToolNames: ['document_insert_widget'] }, currentDocumentAmbient: true,
    } as never), null, 'a document only available this turn gets no catalog')
    const deliveredValue = JSON.stringify({
      contract: 'ready_document_widget_guidance_v1', readyRunId: 'req-1791226293497-zv0eld', guidance,
    })
    assert.ok(Buffer.byteLength(deliveredValue) <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
      `catalog value ${Buffer.byteLength(deliveredValue)} bytes would be cut by the runtime`)

    const instructionDigests: string[] = []
    for (const [index, turnGuidance] of [guidance, guidance, null].entries()) {
      const marker = `TURN_${index + 1}`
      const readyRunId = `run-${index + 1}`
      const built = new CodexTurnInputBuilder().build({
        kind: 'user_ingress', attemptKind: 'user_ingress', originUserMessageId: marker,
        canonicalCurrentInputRef: { messageId: marker, input: [{ type: 'text', text: marker, text_elements: [] }] },
        explicitResourceEnvelope: { input: [], resourceRefs: [] }, resourceAdditionalContext: [],
        actionAdmissionRef: { headProjectionDigest: 'f'.repeat(64),
          actionProjectionVersion: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: index + 1 },
          actionHeadIdentity: { aliasId: 'scope', aliasGeneration: 1, threadBindingId: 'binding', headRevision: 1 } },
        uncommittedTailAssignments: [], supersededUncommittedItems: [],
      }, {
        threadId, turnRequestId: marker, readyRunId, reasoningEffort: null,
        toolSurfaceDigest: 'f'.repeat(64), turnContractDigest: 'a'.repeat(64),
        upstreamProfileSnapshotDigest: 'b'.repeat(64), readyMemorySnapshot: disabledReadyMemorySnapshot(),
        documentWidgetGuidance: turnGuidance,
      })
      if (!built.ok) throw new Error(built.code)
      const turnId = (await request<{ turn: { id: string } }>('turn/start', built.params)).turn.id
      const turn = await new Promise<{ status: string }>((resolve) => completed.set(turnId, resolve))
      assert.equal(turn.status, 'completed', marker)
      const body = requests.at(-1)!
      const context = currentTurnReadyAdditionalContext(body.input, [], readyRunId)
      assert.equal(context.documentWidgetGuidance, turnGuidance, `${marker}: repeated guidance is still sent`)
      assert.equal(digestReadyAdditionalContext(context), digestReadyAdditionalContext({
        resourceReferences: [], explicitRetry: null, documentWidgetGuidance: turnGuidance,
      }), marker)
      instructionDigests.push(instructionTranscriptDigest(body.instructions, body.input))
    }
    assert.equal(new Set(instructionDigests).size, 1, 'catalog turns leave the thread instruction contract unchanged')
    assert.equal(JSON.stringify(requests.at(-1)!.input).split('<ready-document-widget-guidance>').length - 1, 2,
      'earlier catalogs stay in history; a turn without write tools adds none')

    // 2026-11-17: an edited message replaces the previous turn; the runtime must carry the withdrawn-turn notice
    // to the model as this run's context, in a form the gateway reads back to the same digest.
    const replacing = new CodexTurnInputBuilder().build({
      kind: 'user_ingress', attemptKind: 'user_ingress', originUserMessageId: 'TURN_4',
      canonicalCurrentInputRef: { messageId: 'TURN_4', input: [{ type: 'text', text: 'TURN_4', text_elements: [] }] },
      explicitResourceEnvelope: { input: [], resourceRefs: [] }, resourceAdditionalContext: [],
      actionAdmissionRef: { headProjectionDigest: 'f'.repeat(64),
        actionProjectionVersion: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: 4 },
        actionHeadIdentity: { aliasId: 'scope', aliasGeneration: 1, threadBindingId: 'binding', headRevision: 1 } },
      uncommittedTailAssignments: [], supersededUncommittedItems: [],
    }, {
      threadId, turnRequestId: 'TURN_4', readyRunId: 'run-4', reasoningEffort: null,
      toolSurfaceDigest: 'f'.repeat(64), turnContractDigest: 'a'.repeat(64),
      upstreamProfileSnapshotDigest: 'b'.repeat(64), readyMemorySnapshot: disabledReadyMemorySnapshot(),
      documentWidgetGuidance: guidance, replacedOriginUserMessageId: 'TURN_3',
    })
    if (!replacing.ok) throw new Error(replacing.code)
    const replacingTurnId = (await request<{ turn: { id: string } }>('turn/start', replacing.params)).turn.id
    assert.equal((await new Promise<{ status: string }>((resolve) => completed.set(replacingTurnId, resolve))).status, 'completed')
    const replacingBody = requests.at(-1)!
    const replacingContext = currentTurnReadyAdditionalContext(replacingBody.input, [], 'run-4')
    const expectedReplacedTurn = buildCodexReplacedTurnContext({ readyRunId: 'run-4', replacedOriginUserMessageId: 'TURN_3' })
    assert.deepEqual(replacingContext.replacedTurn, expectedReplacedTurn)
    assert.equal(replacingContext.documentWidgetGuidance, guidance)
    assert.equal(digestReadyAdditionalContext(replacingContext), digestReadyAdditionalContext({
      resourceReferences: [], explicitRetry: null, documentWidgetGuidance: guidance, replacedTurn: expectedReplacedTurn,
    }))
    assert.equal(instructionTranscriptDigest(replacingBody.instructions, replacingBody.input), instructionDigests[0],
      'the notice leaves the thread instruction contract unchanged')
  } finally {
    lines.close()
    child.kill('SIGTERM')
    await exited
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
