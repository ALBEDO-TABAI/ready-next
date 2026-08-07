import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexAppServerClient,
  CodexAppServerClientError,
  type CodexInboundFramePort,
  type CodexJsonLineTransport,
  type CodexStartDispatchPort,
} from '../main/modules/agent-control/codex-runtime/codex-app-server-client'
import type {
  CodexThread,
  CodexThreadStartParams,
  CodexTurnStartParams,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'

class FakeTransport implements CodexJsonLineTransport {
  readonly writes: string[] = []
  closedReason: string | null = null
  private lineListener: ((line: string) => void) | null = null
  private closeListener: ((error: Error | null) => void) | null = null

  write(line: string, callback: (error: Error | null) => void): void {
    this.writes.push(line)
    queueMicrotask(() => callback(null))
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListener = listener
    return () => { if (this.lineListener === listener) this.lineListener = null }
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.closeListener = listener
    return () => { if (this.closeListener === listener) this.closeListener = null }
  }

  close(reason: string): void {
    this.closedReason = reason
  }

  emit(frame: unknown): void {
    this.lineListener?.(JSON.stringify(frame))
  }

  disconnect(error: Error | null = null): void {
    this.closeListener?.(error)
  }
}

class FakeStartPort implements CodexStartDispatchPort {
  readonly activated: Array<Record<string, unknown>> = []
  readonly writes: Array<Record<string, unknown>> = []
  readonly unresolved: Array<Record<string, unknown>> = []
  readonly accepted: Array<Record<string, unknown>> = []
  readonly rejected: Array<Record<string, unknown>> = []
  readonly late: Array<Record<string, unknown>> = []
  closedEpochs: string[] = []
  rejectionResolution: 'unknown' | 'proven_absent' = 'unknown'
  acceptedBarrier: Promise<void> | null = null

  async activate(input: Record<string, unknown>): Promise<{ bindingId: string }> {
    this.activated.push(input)
    return { bindingId: String(input.bindingLookupKey) }
  }
  async markChildWriteConfirmed(input: Record<string, unknown>): Promise<void> {
    this.writes.push(input)
  }
  async markUnresolved(input: Record<string, unknown>): Promise<void> {
    this.unresolved.push(input)
  }
  async reconcileAccepted(input: Record<string, unknown>): Promise<void> {
    this.accepted.push(input)
    if (this.acceptedBarrier) await this.acceptedBarrier
  }
  async reconcileRejected(input: Record<string, unknown>): Promise<'unknown' | 'proven_absent'> {
    this.rejected.push(input)
    return this.rejectionResolution
  }
  async consumeLateResponse(input: Record<string, unknown>): Promise<boolean> {
    this.late.push(input)
    return false
  }
  async markConnectionClosed(connectionEpoch: string): Promise<void> {
    this.closedEpochs.push(connectionEpoch)
  }
}

class FakeInboundPort implements CodexInboundFramePort {
  notificationDisposition: 'broadcast' | 'buffered' = 'broadcast'
  serverDisposition: 'respond' | 'buffered' = 'buffered'
  readonly notifications: unknown[] = []
  readonly serverRequests: unknown[] = []

  async routeNotification(input: unknown): Promise<'broadcast' | 'buffered'> {
    this.notifications.push(input)
    return this.notificationDisposition
  }

  async routeServerRequest(input: unknown): Promise<
    | { disposition: 'buffered' }
    | { disposition: 'respond'; result: unknown }
  > {
    this.serverRequests.push(input)
    return this.serverDisposition === 'buffered'
      ? { disposition: 'buffered' }
      : { disposition: 'respond', result: { contentItems: [], success: true } }
  }
}

function makeThread(id = 'thread-1', cwd = '/tmp/ready-thread'): CodexThread {
  return {
    id,
    sessionId: id,
    parentThreadId: null,
    forkedFromId: null,
    cwd,
    source: 'vscode',
    threadSource: null,
    modelProvider: 'ready_gateway',
    cliVersion: '0.146.1',
    createdAt: 1,
    ephemeral: false,
    preview: '',
    status: { type: 'idle' },
    updatedAt: 1,
    turns: [],
  }
}

function threadStartParams(): CodexThreadStartParams {
  return {
    model: 'ready-e0-model',
    modelProvider: 'ready_gateway',
    allowProviderModelFallback: false,
    cwd: '/tmp/ready-thread',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    runtimeWorkspaceRoots: [],
    environments: [],
    dynamicTools: [],
    developerInstructions: 'thin overlay',
  }
}

function turnStartParams(): CodexTurnStartParams {
  return {
    threadId: 'thread-1',
    clientUserMessageId: 'message-1',
    input: [{ type: 'text', text: 'hello', text_elements: [] }],
    additionalContext: {},
    responsesapiClientMetadata: {
      readyRunId: 'run-1',
      toolSurfaceDigest: 'tool-digest',
      turnContractDigest: 'turn-digest',
      upstreamProfileSnapshotDigest: 'profile-digest',
    },
  }
}

function makeClient(input: {
  timeoutMs?: number
  transport?: FakeTransport
  startPort?: FakeStartPort
  inboundPort?: FakeInboundPort
  archiveAuthorization?: (threadId: string) => void | Promise<void>
} = {}) {
  const transport = input.transport || new FakeTransport()
  const startPort = input.startPort || new FakeStartPort()
  const inboundPort = input.inboundPort || new FakeInboundPort()
  const client = new CodexAppServerClient({
    transport,
    connectionEpoch: 'epoch-1',
    requestTimeoutMs: input.timeoutMs ?? 100,
    startDispatchPort: startPort,
    inboundFramePort: inboundPort,
    threadArchiveAuthorizationPort: {
      assertEligible: input.archiveAuthorization || (() => undefined),
    },
  })
  return { client, transport, startPort, inboundPort }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition_timeout')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function initializeClient(input: ReturnType<typeof makeClient>): Promise<void> {
  const initializing = input.client.initialize()
  await waitFor(() => input.transport.writes.length === 1)
  const frame = JSON.parse(input.transport.writes[0]) as { id: number; method: string }
  assert.equal(frame.method, 'initialize')
  input.transport.emit({ id: frame.id, result: { userAgent: 'ready-test/1' } })
  await initializing
  await waitFor(() => input.transport.writes.length === 2)
  input.transport.writes.splice(0)
}

test('exact method validators reject unknown parameters before any child byte', async () => {
  const input = makeClient()
  await initializeClient(input)
  const { client, transport, startPort } = input
  const invalidCalls = [
    () => client.threadStart({ ...threadStartParams(), history: [] } as never),
    () => client.turnStart({
      ...turnStartParams(),
      responsesapiClientMetadata: {
        ...turnStartParams().responsesapiClientMetadata,
        historyDigest: 'banned',
      },
    } as never),
    () => client.threadList({ limit: 100, cwd: '/tmp/ready-thread', sourceKinds: ['vscode'], cursor: null } as never),
    () => client.threadRead({ threadId: 'thread-1', includeTurns: true, cwd: '/tmp/override' } as never),
    () => client.threadResume({ threadId: 'thread-1', history: [] } as never),
    () => client.threadArchive({ threadId: 'thread-1', force: true } as never),
    () => client.threadCompactStart({ threadId: 'thread-1', baseInstructions: 'override' } as never),
    () => client.turnInterrupt({ threadId: 'thread-1', turnId: 'turn-1', reason: 'override' } as never),
  ]
  for (const invalidCall of invalidCalls) {
    await assert.rejects(invalidCall, /rpc_params_invalid/)
  }
  assert.equal(transport.writes.length, 0)
  assert.equal(startPort.activated.length, 0)
})

test('initialize and typed methods serialize only their exact public protocol surface', async () => {
  const { client, transport } = makeClient()
  const initializing = client.initialize()
  await waitFor(() => transport.writes.length === 1)
  const initializeFrame = JSON.parse(transport.writes[0]) as Record<string, unknown>
  assert.deepEqual(Object.keys(initializeFrame), ['method', 'id', 'params'])
  assert.equal(initializeFrame.method, 'initialize')
  assert.equal(
    (initializeFrame.params as { clientInfo: { name: string } }).clientInfo.name,
    'ready_codex_experiment',
  )
  transport.emit({ id: initializeFrame.id, result: { userAgent: 'ready-test/1' } })
  assert.deepEqual(await initializing, { userAgent: 'ready-test/1' })
  await waitFor(() => transport.writes.length === 2)
  assert.deepEqual(JSON.parse(transport.writes[1]), { method: 'initialized' })

  const reading = client.threadRead({ threadId: 'thread-1', includeTurns: true })
  await waitFor(() => transport.writes.length === 3)
  const readFrame = JSON.parse(transport.writes[2]) as { id: number; method: string; params: unknown }
  assert.deepEqual(readFrame, {
    method: 'thread/read',
    id: readFrame.id,
    params: { threadId: 'thread-1', includeTurns: true },
  })
  transport.emit({ id: readFrame.id, result: { thread: makeThread() } })
  assert.equal((await reading).thread.id, 'thread-1')
})

test('product methods require one successful initialize handshake', async () => {
  const input = makeClient()
  await assert.rejects(
    input.client.threadRead({ threadId: 'thread-1', includeTurns: true }),
    (error: unknown) => (
      error instanceof CodexAppServerClientError && error.code === 'initialize_required'
    ),
  )
  assert.equal(input.transport.writes.length, 0)
  await initializeClient(input)
  await assert.rejects(
    input.client.initialize(),
    (error: unknown) => (
      error instanceof CodexAppServerClientError && error.code === 'initialize_already_attempted'
    ),
  )
  assert.equal(input.transport.closedReason, 'initialize_already_attempted')
})

test('thread enumeration is sealed before product ingress opens', async () => {
  const input = makeClient()
  await initializeClient(input)
  const { client, transport } = input
  const listing = client.threadList({ limit: 100, cwd: '/tmp/ready-thread', sourceKinds: ['vscode'] })
  await waitFor(() => transport.writes.length === 1)
  const frame = JSON.parse(transport.writes[0]) as { id: number; method: string }
  assert.equal(frame.method, 'thread/list')
  transport.emit({ id: frame.id, result: { data: [makeThread()], nextCursor: null } })
  assert.equal((await listing).data.length, 1)
  client.sealBootReconciliation()
  await assert.rejects(
    client.threadList({ limit: 100, cwd: '/tmp/ready-thread', sourceKinds: ['vscode'] }),
    /thread_list_outside_boot_reconciliation/,
  )
  assert.equal(transport.writes.length, 1)
})

test('thread archive requires durable retirement authority before any child byte', async () => {
  const input = makeClient({
    archiveAuthorization() {
      throw new Error('thread_archive_not_retired')
    },
  })
  await initializeClient(input)
  await assert.rejects(
    input.client.threadArchive({ threadId: 'thread-1' }),
    /thread_archive_not_retired/,
  )
  assert.equal(input.transport.writes.length, 0)
})

test('ordinary request timeout clears its identity and rejects a late response', async () => {
  const input = makeClient({ timeoutMs: 15 })
  await initializeClient(input)
  const reading = input.client.threadRead({ threadId: 'thread-1', includeTurns: true })
  await waitFor(() => input.transport.writes.length === 1)
  const frame = JSON.parse(input.transport.writes[0]) as { id: number }
  await assert.rejects(reading, (error: unknown) => (
    error instanceof CodexAppServerClientError && error.code === 'rpc_timeout'
  ))
  input.transport.emit({ id: frame.id, result: { thread: makeThread() } })
  await waitFor(() => input.transport.closedReason !== null)
  assert.equal(input.transport.closedReason, 'unknown_response_id')
})

test('start timeout retains the known rpc identity until accepted reconciliation', async () => {
  const input = makeClient({ timeoutMs: 15 })
  await initializeClient(input)
  const { client, transport, startPort } = input
  const starting = client.threadStart(threadStartParams())
  await waitFor(() => startPort.unresolved.length === 1)
  assert.equal(startPort.activated.length, 1)
  assert.equal(startPort.writes.length, 1)
  const pending = await Promise.race([
    starting.then(() => 'resolved', () => 'rejected'),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
  ])
  assert.equal(pending, 'pending')
  const frame = JSON.parse(transport.writes[0]) as { id: number }
  await client.settleRecoveredStartAccepted({
    connectionEpoch: 'epoch-1',
    rpcId: frame.id,
    method: 'thread/start',
    bindingId: '/tmp/ready-thread',
    result: { thread: makeThread(), instructionSources: [] },
    responsePending: true,
  })
  assert.equal((await starting).thread.id, 'thread-1')
  assert.equal(startPort.accepted.length, 1)
})

test('response-first turn reconciliation leaves the inbound line open for later client identity', async () => {
  const startPort = new FakeStartPort()
  let releaseAccepted!: () => void
  startPort.acceptedBarrier = new Promise<void>((resolve) => { releaseAccepted = resolve })
  const input = makeClient({ timeoutMs: 500, startPort })
  await initializeClient(input)
  const starting = input.client.turnStart(turnStartParams())
  await waitFor(() => input.transport.writes.length === 1)
  const frame = JSON.parse(input.transport.writes[0]) as { id: number }
  input.transport.emit({
    id: frame.id,
    result: { turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } },
  })
  await waitFor(() => startPort.accepted.length === 1)
  assert.equal(await Promise.race([
    starting.then(() => 'resolved'),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
  ]), 'pending')

  input.transport.emit({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'userMessage',
        id: 'user-item-1',
        clientId: 'message-1',
        content: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
      startedAtMs: 1,
    },
  })
  await waitFor(() => input.inboundPort.notifications.length === 1)
  releaseAccepted()
  assert.equal((await starting).turn.id, 'turn-1')
})

test('typed start rejection remains pending while resolution is unknown', async () => {
  const startPort = new FakeStartPort()
  const input = makeClient({ timeoutMs: 100, startPort })
  await initializeClient(input)
  const { client, transport } = input
  const starting = client.threadStart(threadStartParams())
  await waitFor(() => transport.writes.length === 1)
  const frame = JSON.parse(transport.writes[0]) as { id: number }
  transport.emit({ id: frame.id, error: { code: -32602, message: 'rejected' } })
  await waitFor(() => startPort.rejected.length === 1)
  const state = await Promise.race([
    starting.then(() => 'resolved', () => 'rejected'),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ])
  assert.equal(state, 'pending')
  await client.settleRecoveredStartProvenAbsent({
    connectionEpoch: 'epoch-1',
    rpcId: frame.id,
    method: 'thread/start',
    bindingId: '/tmp/ready-thread',
    evidenceDigest: 'stable-zero-evidence',
  })
  await assert.rejects(starting, (error: unknown) => (
    error instanceof CodexAppServerClientError
    && error.code === 'start_delivery_proven_absent'
  ))
})

test('notifications and server requests produce no effect while provisional routing buffers them', async () => {
  const inboundPort = new FakeInboundPort()
  inboundPort.notificationDisposition = 'buffered'
  inboundPort.serverDisposition = 'buffered'
  const input = makeClient({ inboundPort })
  await initializeClient(input)
  const { client, transport } = input
  const received: unknown[] = []
  client.subscribe((notification) => received.push(notification))
  transport.emit({ method: 'thread/started', params: { thread: makeThread() } })
  transport.emit({
    id: 901,
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' },
  })
  await waitFor(() => inboundPort.serverRequests.length === 1)
  assert.equal(received.length, 0)
  assert.equal(transport.writes.length, 0)

  inboundPort.serverDisposition = 'respond'
  transport.emit({
    id: 902,
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-2' },
  })
  await waitFor(() => transport.writes.length === 1)
  assert.deepEqual(JSON.parse(transport.writes[0]), {
    id: 902,
    result: { contentItems: [], success: true },
  })
})

test('unsupported server requests close the protocol without reaching Ready', async () => {
  const input = makeClient()
  await initializeClient(input)
  input.transport.emit({
    id: 903,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1' },
  })
  await waitFor(() => input.transport.closedReason !== null)
  assert.equal(input.transport.closedReason, 'server_request_invalid')
  assert.equal(input.inboundPort.serverRequests.length, 0)
  assert.equal(input.transport.writes.length, 0)
})

test('unknown response identities close the protocol connection', async () => {
  const { transport } = makeClient()
  transport.emit({ id: 404, result: {} })
  await waitFor(() => transport.closedReason !== null)
  assert.equal(transport.closedReason, 'unknown_response_id')
})

test('duplicate start responses close the protocol while reconciliation is pending', async () => {
  const startPort = new FakeStartPort()
  startPort.acceptedBarrier = new Promise<void>(() => undefined)
  const input = makeClient({ timeoutMs: 500, startPort })
  await initializeClient(input)
  void input.client.turnStart(turnStartParams())
  await waitFor(() => input.transport.writes.length === 1)
  const request = JSON.parse(input.transport.writes[0]) as { id: number }
  const response = {
    id: request.id,
    result: { turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } },
  }
  input.transport.emit(response)
  await waitFor(() => startPort.accepted.length === 1)
  input.transport.emit(response)
  await waitFor(() => input.transport.closedReason !== null)
  assert.equal(input.transport.closedReason, 'duplicate_start_response')
})

test('connection close moves unresolved starts to recovery without rejecting their operation', async () => {
  const input = makeClient({ timeoutMs: 100 })
  await initializeClient(input)
  const { client, transport, startPort } = input
  const starting = client.turnStart({
    threadId: 'thread-1',
    clientUserMessageId: 'message-1',
    input: [{ type: 'text', text: 'hello', text_elements: [] }],
    additionalContext: {},
    responsesapiClientMetadata: {
      readyRunId: 'run-1',
      toolSurfaceDigest: 'tool-digest',
      turnContractDigest: 'turn-digest',
      upstreamProfileSnapshotDigest: 'profile-digest',
    },
  })
  await waitFor(() => transport.writes.length === 1)
  transport.disconnect(new Error('child exited'))
  await waitFor(() => startPort.closedEpochs.length === 1)
  const state = await Promise.race([
    starting.then(() => 'resolved', () => 'rejected'),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ])
  assert.equal(state, 'pending')
})
