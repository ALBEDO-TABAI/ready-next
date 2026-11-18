import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { canonicalJson, digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  activateCodexGatewaySpawnConfig,
  prepareCodexRuntimeState,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-host'
import { CODEX_HOST_OVERLAY } from '../main/modules/agent-control/codex-runtime/codex-thread-instructions'
import {
  buildReadyToolSurface,
  codexRequestToolsDigest,
  selectCodexRootToolDefinitions,
} from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { listLiveCodexThreadToolDefinitions } from '../main/modules/agent-control/runtime-core/agent-sdk-tool-executor'

// 2026-10-07: 0.160.1 started sending `minItems` in dynamic tool schemas while Ready still predicted the 0.149 shape,
// so every product request failed the gateway's tool check. The native capture registers one simple tool and the
// evidence gate compares names only; this registers Ready's whole production tool set with the pinned runtime.
test('pinned runtime sends exactly the request tools Ready derives for its production surface', { timeout: 60_000 }, async () => {
  const manifest = JSON.parse(readFileSync('assets/codex-runtime/runtime-manifest.json', 'utf8'))
  const contracts = JSON.parse(readFileSync('assets/codex-runtime/contracts/runtime-contracts.json', 'utf8'))
  const binary = join(process.cwd(), 'build/codex', manifest.targetTriple, 'codex.exe')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), manifest.binarySha256)
  const surface = buildReadyToolSurface({
    surfaceId: 'production-tool-wire',
    toolDefinitions: selectCodexRootToolDefinitions(listLiveCodexThreadToolDefinitions()),
  })
  assert.ok(surface.dynamicTools.some((tool) => JSON.stringify(tool.inputSchema).includes('minItems')))

  const root = mkdtempSync(join(tmpdir(), 'ready-production-tool-wire-'))
  let sentTools: unknown[] | null = null
  let resolveRequest!: () => void
  const requested = new Promise<void>((resolve) => { resolveRequest = resolve })
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[] }
    sentTools ??= Array.isArray(body.tools) ? body.tools : null
    const item = { type: 'message', id: 'answer-1', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'ok' }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      { type: 'response.created', response: { id: 'response-1' } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'response-1', output: [item],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    resolveRequest()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const gatewayUrl = `http://127.0.0.1:${address.port}/v1`
  // Ready's own config writer, so the runtime runs with exactly the production features and isolation.
  const state = prepareCodexRuntimeState({ userDataPath: root, gatewayUrl, contracts })
  activateCodexGatewaySpawnConfig({
    state, sidecarSpawnInstanceId: 'production-tool-wire', gatewayUrl, gatewayToken: 'tool-wire-token', contracts,
  })
  const workRoot = join(root, 'work')
  mkdirSync(workRoot, { recursive: true })
  const child = spawn(binary, contracts.nativeIsolationConfigContract.launchArgv, {
    cwd: workRoot,
    env: { PATH: '/usr/bin:/bin', HOME: state.homeDir, CODEX_HOME: state.codexHome, TMPDIR: state.tmpDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  lines.on('line', (line) => {
    const frame = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
    if (typeof frame.id !== 'number' || !pending.has(frame.id)) return
    const waiter = pending.get(frame.id)!
    pending.delete(frame.id)
    if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)))
    else waiter.resolve(frame.result)
  })
  let nextId = 0
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    nextId += 1
    pending.set(nextId, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ method, id: nextId, params })}\n`)
  })
  try {
    await request('initialize', {
      clientInfo: { name: 'ready_tool_wire_test', title: 'Ready Tool Wire Test', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    const cwd = join(workRoot, 'thread')
    mkdirSync(cwd, { recursive: true })
    const started = await request('thread/start', {
      model: 'ready-e0-model', modelProvider: 'ready_gateway', allowProviderModelFallback: false, cwd,
      approvalPolicy: 'never', sandbox: 'read-only', runtimeWorkspaceRoots: [], environments: [],
      config: { model_context_window: 272000 }, dynamicTools: surface.dynamicTools,
      developerInstructions: CODEX_HOST_OVERLAY,
    }) as { thread: { id: string } }
    await request('turn/start', {
      threadId: started.thread.id,
      clientUserMessageId: 'message-tool-wire',
      collaborationMode: {
        mode: 'default', settings: { model: 'ready-e0-model', reasoning_effort: null, developer_instructions: null },
      },
      environments: [],
      input: [{ type: 'text', text: 'tool wire', text_elements: [] }],
      additionalContext: {},
      responsesapiClientMetadata: {
        readyRunId: 'run-tool-wire', toolSurfaceDigest: surface.toolSurfaceDigest,
        turnContractDigest: digestCanonicalJson('turn-contract'),
        upstreamProfileSnapshotDigest: digestCanonicalJson('snapshot'),
      },
    })
    await requested
    assert.ok(sentTools, 'the provider request carries tools')
    const sent = new Map((sentTools as Array<{ name: string }>).map((tool) => [tool.name, tool]))
    const differing = surface.responsesTools
      .filter((tool) => canonicalJson(sent.get(tool.name) ?? null) !== canonicalJson(tool))
      .map((tool) => tool.name)
    assert.deepEqual(differing, [], 'every production tool is sent exactly as Ready derives it')
    assert.equal(digestCanonicalJson(sentTools), surface.toolSurfaceDigest)
    assert.equal(digestCanonicalJson(sentTools), codexRequestToolsDigest(surface))
  } finally {
    lines.close()
    child.kill('SIGTERM')
    await exited
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
