import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { APP_VERSION } from '../shared/app-version'
import {
  CodexAppServerClient,
  CodexAppServerClientError,
  type CodexInboundFramePort,
  type CodexInboundFrameReleasePort,
  type CodexJsonLineTransport,
  type CodexManualCompactionDispatchPort,
  type CodexStartDispatchPort,
  type CodexThreadArchiveDispatchPort,
} from '../main/modules/agent-control/codex-runtime/codex-app-server-client'
import {
  CODEX_OPT_OUT_NOTIFICATION_METHODS,
  CODEX_PASSIVE_NOTIFICATION_METHODS,
  CODEX_PROJECTED_NOTIFICATION_METHODS,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import type {
  CodexThread,
  CodexThreadStartParams,
  CodexTurnStartParams,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  buildCodexToolResponseDeliveryAttemptId,
  type CodexToolResponseDeliveryAttemptIdentity,
} from '../main/modules/agent-control/codex-runtime/codex-tool-response-delivery'

class FakeTransport implements CodexJsonLineTransport {
  readonly writes: string[] = []
  closedReason: string | null = null
  private lineListener: ((line: string) => void) | null = null
  private closeListener: ((error: Error | null) => void) | null = null
  nextWriteError: Error | null = null
  closeError: Error | null = null
  reenterClose = false
  deferWrites = false
  readonly deferredWriteCallbacks: Array<(error: Error | null) => void> = []

  write(line: string, callback: (error: Error | null) => void): void {
    this.writes.push(line)
    const error = this.nextWriteError
    this.nextWriteError = null
    if (this.deferWrites) {
      this.deferredWriteCallbacks.push(callback)
      return
    }
    queueMicrotask(() => callback(error))
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
    if (this.reenterClose) this.closeListener?.(new Error('transport_close_reentered'))
    if (this.closeError) throw this.closeError
  }

  emit(frame: unknown): void {
    this.lineListener?.(JSON.stringify(frame))
  }

  disconnect(error: Error | null = null): void {
    this.closeListener?.(error)
  }

  settleNextWrite(error: Error | null = null): void {
    const callback = this.deferredWriteCallbacks.shift()
    if (!callback) throw new Error('deferred_write_missing')
    callback(error)
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
  activationBarrier: Promise<void> | null = null
  unresolvedError: Error | null = null
  closeError: Error | null = null

  async activate(input: Record<string, unknown>): Promise<{ bindingId: string }> {
    this.activated.push(input)
    if (this.activationBarrier) await this.activationBarrier
    return { bindingId: String(input.bindingLookupKey) }
  }
  async markChildWriteConfirmed(input: Record<string, unknown>): Promise<void> {
    this.writes.push(input)
  }
  async markUnresolved(input: Record<string, unknown>): Promise<void> {
    this.unresolved.push(input)
    if (this.unresolvedError) throw this.unresolvedError
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
    if (this.closeError) throw this.closeError
  }
}

class FakeManualCompactionPort implements CodexManualCompactionDispatchPort {
  readonly events: Array<{ kind: string; input: Record<string, unknown> }> = []
  consumeLate = false
  activationBarrier: Promise<void> | null = null
  unresolvedError: Error | null = null
  closeError: Error | null = null

  async activate(input: Record<string, unknown>): Promise<{ manualCompactionId: string }> {
    this.events.push({ kind: 'activate', input })
    if (this.activationBarrier) await this.activationBarrier
    return { manualCompactionId: 'manual-1' }
  }
  async markWriteAttempted(input: Record<string, unknown>): Promise<void> {
    this.events.push({ kind: 'attempted', input })
  }
  async markChildWriteConfirmed(input: Record<string, unknown>): Promise<void> {
    this.events.push({ kind: 'confirmed', input })
  }
  async markUnresolved(input: Record<string, unknown>): Promise<void> {
    this.events.push({ kind: 'unresolved', input })
    if (this.unresolvedError) throw this.unresolvedError
  }
  async reconcileResponse(input: Record<string, unknown>): Promise<void> {
    this.events.push({ kind: 'response', input })
  }
  async consumeLateResponse(input: Record<string, unknown>): Promise<boolean> {
    this.events.push({ kind: 'late-response', input })
    return this.consumeLate
  }
  async markConnectionClosed(connectionEpoch: string): Promise<void> {
    this.events.push({ kind: 'connection-closed', input: { connectionEpoch } })
    if (this.closeError) throw this.closeError
  }
}

class FakeThreadArchivePort implements CodexThreadArchiveDispatchPort {
  readonly events: Array<{ kind: string; input: Record<string, unknown> }> = []
  consumeLate = false
  consumeNotification = true
  activationBarrier: Promise<void> | null = null
  unresolvedError: Error | null = null
  closeError: Error | null = null

  assertReadbackListEligible(input: Record<string, unknown>): void {
    this.events.push({ kind: 'readback-authorized', input })
  }

  async activate(input: Record<string, unknown>): Promise<{ archiveIntentId: string }> {
    this.events.push({ kind: 'activate', input })
    if (this.activationBarrier) await this.activationBarrier
    return { archiveIntentId: 'archive-intent-1' }
  }
  async markWriteAttempted(input: Record<string, unknown>): Promise<void> {
    this.events.push({ kind: 'attempted', input })
  }
  async markChildWriteConfirmed(input: Record<string, unknown>): Promise<void> {
    this.events.push({ kind: 'confirmed', input })
  }
  async markUnresolved(input: Record<string, unknown>): Promise<void> {
    this.events.push({ kind: 'unresolved', input })
    if (this.unresolvedError) throw this.unresolvedError
  }
  async reconcileResponse(input: Record<string, unknown>): Promise<void> {
    this.events.push({ kind: 'response', input })
  }
  async consumeLateResponse(input: Record<string, unknown>): Promise<boolean> {
    this.events.push({ kind: 'late-response', input })
    return this.consumeLate
  }
  async reconcileArchivedNotification(input: Record<string, unknown>): Promise<boolean> {
    this.events.push({ kind: 'notification', input })
    return this.consumeNotification
  }
  async markConnectionClosed(connectionEpoch: string): Promise<void> {
    this.events.push({ kind: 'connection-closed', input: { connectionEpoch } })
    if (this.closeError) throw this.closeError
  }
}

class FakeInboundPort implements CodexInboundFramePort {
  notificationDisposition: 'broadcast' | 'buffered' = 'broadcast'
  serverDisposition: 'respond' | 'buffered' = 'buffered'
  readonly notifications: unknown[] = []
  readonly serverRequests: unknown[] = []
  readonly confirmedAttempts: CodexToolResponseDeliveryAttemptIdentity[] = []
  readonly retiredThreads: Array<{ connectionEpoch: string; threadId: string }> = []
  confirmBarrier: Promise<void> | null = null
  notificationBarrier: Promise<void> | null = null
  serverBarrier: Promise<void> | null = null
  attemptCallIdOverride: string | null = null
  releasePort: CodexInboundFrameReleasePort | null = null

  attachReleasePort(port: CodexInboundFrameReleasePort): () => void {
    this.releasePort = port
    return () => { if (this.releasePort === port) this.releasePort = null }
  }

  retireThread(connectionEpoch: string, threadId: string): void {
    this.retiredThreads.push({ connectionEpoch, threadId })
  }

  async routeNotification(input: unknown): Promise<'broadcast' | 'buffered'> {
    this.notifications.push(input)
    if (this.notificationBarrier) await this.notificationBarrier
    return this.notificationDisposition
  }

  async routeServerRequest(input: unknown): Promise<
    | { disposition: 'buffered' }
    | {
      disposition: 'respond'
      result: unknown
      deliveryAttempt: CodexToolResponseDeliveryAttemptIdentity
    }
  > {
    this.serverRequests.push(input)
    if (this.serverBarrier) await this.serverBarrier
    if (this.serverDisposition === 'buffered') return { disposition: 'buffered' }
    const request = input as {
      connectionEpoch: string
      requestId: number | string
      params: { threadId: string; turnId: string; callId: string }
    }
    const result = { contentItems: [], success: true }
    const identity = {
      codexThreadId: request.params.threadId,
      codexTurnId: request.params.turnId,
      codexCallId: this.attemptCallIdOverride || request.params.callId,
      readyActionId: `action-${request.params.callId}`,
      connectionEpoch: request.connectionEpoch,
      requestRpcId: String(request.requestId),
      toolResponseDigest: digestCanonicalJson(result),
    }
    return {
      disposition: 'respond',
      result,
      deliveryAttempt: {
        attemptId: buildCodexToolResponseDeliveryAttemptId(identity),
        ...identity,
      },
    }
  }

  confirmServerResponseTransportWrite(
    attempt: CodexToolResponseDeliveryAttemptIdentity,
  ): void | Promise<void> {
    this.confirmedAttempts.push(attempt)
    return this.confirmBarrier || undefined
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
    config: { model_context_window: 272_000 },
    dynamicTools: [],
    developerInstructions: 'thin overlay',
  }
}

function turnStartParams(): CodexTurnStartParams {
  return {
    threadId: 'thread-1',
    clientUserMessageId: 'message-1',
    collaborationMode: {
      mode: 'default',
      settings: {
        model: 'ready-e0-model',
        reasoning_effort: 'xhigh',
        developer_instructions: null,
      },
    },
    environments: [],
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
  manualPort?: FakeManualCompactionPort
  archivePort?: FakeThreadArchivePort
  archiveAuthorization?: (threadId: string) => void | Promise<void>
} = {}) {
  const transport = input.transport || new FakeTransport()
  const startPort = input.startPort || new FakeStartPort()
  const inboundPort = input.inboundPort || new FakeInboundPort()
  const manualPort = input.manualPort || new FakeManualCompactionPort()
  const archivePort = input.archivePort || new FakeThreadArchivePort()
  const client = new CodexAppServerClient({
    transport,
    connectionEpoch: 'epoch-1',
    requestTimeoutMs: input.timeoutMs ?? 100,
    startDispatchPort: startPort,
    manualCompactionDispatchPort: manualPort,
    threadArchiveDispatchPort: archivePort,
    inboundFramePort: inboundPort,
    threadArchiveAuthorizationPort: {
      assertEligible: input.archiveAuthorization || (() => undefined),
    },
  })
  return { client, transport, startPort, inboundPort, manualPort, archivePort }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition_timeout')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
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
    () => client.threadStart({
      ...threadStartParams(),
      config: { model_context_window: 0 },
    } as never),
    () => client.turnStart({
      ...turnStartParams(),
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'ready-e0-model',
          reasoning_effort: 'turbo',
          developer_instructions: null,
        },
      },
    } as never),
    () => client.turnStart({
      ...turnStartParams(),
      environments: [{ environmentId: 'local', cwd: '/tmp/ready-thread' }],
    } as never),
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
  assert.equal(
    (initializeFrame.params as { clientInfo: { version: string } }).clientInfo.version,
    APP_VERSION,
  )
  assert.deepEqual(
    (initializeFrame.params as {
      capabilities: { optOutNotificationMethods: string[] }
    }).capabilities.optOutNotificationMethods,
    CODEX_OPT_OUT_NOTIFICATION_METHODS,
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

test('pinned 0.146.1 notifications close exactly as 9 projected, 10 passive, 1 reroute, and 50 opted out', () => {
  const schema = JSON.parse(readFileSync(resolve(
    'assets/codex-runtime/schemas/stable/codex_app_server_protocol.v2.schemas.json',
  ), 'utf8')) as {
    definitions: {
      ServerNotification: {
        oneOf: Array<{ properties: { method: { enum: string[] } } }>
      }
    }
  }
  const pinnedMethods = schema.definitions.ServerNotification.oneOf.map((entry) => (
    entry.properties.method.enum[0]
  ))
  const classifiedMethods = [
    ...CODEX_PROJECTED_NOTIFICATION_METHODS,
    ...CODEX_PASSIVE_NOTIFICATION_METHODS,
    'model/rerouted',
    ...CODEX_OPT_OUT_NOTIFICATION_METHODS,
  ]

  assert.equal(CODEX_PROJECTED_NOTIFICATION_METHODS.length, 9)
  assert.equal(CODEX_PASSIVE_NOTIFICATION_METHODS.length, 10)
  assert.equal(CODEX_OPT_OUT_NOTIFICATION_METHODS.length, 50)
  assert.equal(pinnedMethods.length, 70)
  assert.equal(new Set(pinnedMethods).size, 70)
  assert.equal(new Set(classifiedMethods).size, 70)
  assert.deepEqual([...classifiedMethods].sort(), [...pinnedMethods].sort())
})

test('thread start serializes the frozen 0/1/2 Ready dynamic-tool surface exactly', async () => {
  for (const toolNames of [[], ['ready_read_a'], ['ready_read_a', 'ready_read_b']]) {
    const input = makeClient()
    await initializeClient(input)
    const surface = createCodexToolFixture(toolNames).readyToolSurface
    const params = {
      ...threadStartParams(),
      cwd: `/tmp/ready-thread-${toolNames.length}`,
      dynamicTools: [...surface.dynamicTools],
    }
    const starting = input.client.threadStart(params)
    await waitFor(() => input.transport.writes.length === 1)
    const frame = JSON.parse(input.transport.writes[0]) as {
      id: number
      method: string
      params: CodexThreadStartParams
    }
    assert.equal(frame.method, 'thread/start')
    assert.deepEqual(frame.params.dynamicTools, surface.dynamicTools)
    assert.deepEqual(Object.keys(frame.params), Object.keys(threadStartParams()))
    input.transport.emit({
      id: frame.id,
      result: { thread: makeThread(`thread-${toolNames.length}`, params.cwd), instructionSources: [] },
    })
    assert.equal((await starting).thread.id, `thread-${toolNames.length}`)
  }
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
  transport.writes.splice(0)
  const archivedListing = client.threadList({
    limit: 100,
    cwd: '/tmp/ready-thread',
    sourceKinds: ['vscode'],
    archived: true,
    cursor: null,
    useStateDbOnly: true,
  })
  await waitFor(() => transport.writes.length === 1)
  const archivedFrame = JSON.parse(transport.writes[0]) as {
    id: number
    method: string
    params: unknown
  }
  assert.deepEqual(archivedFrame, {
    method: 'thread/list',
    id: archivedFrame.id,
    params: {
      limit: 100,
      cwd: '/tmp/ready-thread',
      sourceKinds: ['vscode'],
      archived: true,
      cursor: null,
      useStateDbOnly: true,
    },
  })
  transport.emit({ id: archivedFrame.id, result: { data: [], nextCursor: null } })
  assert.deepEqual(await archivedListing, { data: [], nextCursor: null })
  assert.deepEqual(input.archivePort.events, [{
    kind: 'readback-authorized',
    input: {
      cwd: '/tmp/ready-thread',
      sourceKinds: ['vscode'],
      archived: true,
      cursor: null,
      useStateDbOnly: true,
    },
  }])
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

test('thread archive persists rpc/write seams and consumes the exact archived notification', async () => {
  const input = makeClient()
  await initializeClient(input)
  const archiving = input.client.threadArchive({ threadId: 'thread-1' })
  await waitFor(() => input.transport.writes.length === 1)
  await waitFor(() => input.archivePort.events.some((event) => event.kind === 'confirmed'))
  const frame = JSON.parse(input.transport.writes[0]) as {
    id: number
    method: string
    params: unknown
  }
  assert.deepEqual(frame, {
    method: 'thread/archive',
    id: frame.id,
    params: { threadId: 'thread-1' },
  })
  assert.deepEqual(
    input.archivePort.events.map((event) => event.kind),
    ['activate', 'attempted', 'confirmed'],
  )
  input.transport.emit({
    method: 'thread/archived',
    params: { threadId: 'thread-1' },
  })
  await waitFor(() => input.archivePort.events.some((event) => event.kind === 'notification'))
  input.transport.emit({ id: frame.id, result: {} })
  assert.deepEqual(await archiving, {})
  assert.deepEqual(
    input.archivePort.events.map((event) => event.kind),
    ['activate', 'attempted', 'confirmed', 'notification', 'response'],
  )
})

test('thread archive timeout persists unknown and closes the old connection before any retry', async () => {
  const input = makeClient({ timeoutMs: 15 })
  await initializeClient(input)
  const archiving = input.client.threadArchive({ threadId: 'thread-1' })
  await assert.rejects(archiving, (error: unknown) => (
    error instanceof CodexAppServerClientError && error.code === 'rpc_timeout'
  ))
  await waitFor(() => input.transport.closedReason === 'rpc_timeout')
  await waitFor(() => input.archivePort.events.some((event) => event.kind === 'connection-closed'))
  assert.deepEqual(
    input.archivePort.events.map((event) => event.kind),
    ['activate', 'attempted', 'confirmed', 'unresolved', 'connection-closed'],
  )
})

test('ordinary request timeout closes the unhealthy connection immediately', async () => {
  const input = makeClient({ timeoutMs: 15 })
  await initializeClient(input)
  const reading = input.client.threadRead({ threadId: 'thread-1', includeTurns: true })
  await waitFor(() => input.transport.writes.length === 1)
  const frame = JSON.parse(input.transport.writes[0]) as { id: number }
  await assert.rejects(reading, (error: unknown) => (
    error instanceof CodexAppServerClientError && error.code === 'rpc_timeout'
  ))
  await waitFor(() => input.transport.closedReason !== null)
  assert.equal(input.transport.closedReason, 'rpc_timeout')
  assert.ok(frame.id > 0)
})

test('manual compaction persists write seams and consumes a late response without closing protocol', async () => {
  const input = makeClient({ timeoutMs: 15 })
  input.manualPort.consumeLate = true
  await initializeClient(input)
  const compacting = input.client.threadCompactStart({ threadId: 'thread-1' })
  await waitFor(() => input.transport.writes.length === 1)
  const frame = JSON.parse(input.transport.writes[0]) as { id: number; method: string; params: unknown }
  assert.deepEqual(frame, {
    method: 'thread/compact/start',
    id: frame.id,
    params: { threadId: 'thread-1' },
  })
  await assert.rejects(compacting, (error: unknown) => (
    error instanceof CodexAppServerClientError && error.code === 'rpc_timeout'
  ))
  assert.deepEqual(
    input.manualPort.events.map((event) => event.kind),
    ['activate', 'attempted', 'confirmed', 'unresolved'],
  )
  input.transport.emit({ id: frame.id, result: {} })
  await waitFor(() => input.manualPort.events.some((event) => event.kind === 'late-response'))
  assert.equal(input.transport.closedReason, null)
})

test('manual compaction consumes exact late error responses while unknown errors fail closed', async () => {
  const input = makeClient({ timeoutMs: 15 })
  input.manualPort.consumeLate = true
  await initializeClient(input)
  const compacting = input.client.threadCompactStart({ threadId: 'thread-1' })
  await waitFor(() => input.transport.writes.length === 1)
  const frame = JSON.parse(input.transport.writes[0]) as { id: number }
  await assert.rejects(compacting, /rpc_timeout/)
  input.transport.emit({ id: frame.id, error: { code: -32_000, message: 'late rejected' } })
  await waitFor(() => input.manualPort.events.some((event) => event.kind === 'late-response'))
  assert.equal(input.transport.closedReason, null)

  input.manualPort.consumeLate = false
  input.transport.emit({ id: frame.id + 10_000, error: { code: -32_000, message: 'unknown' } })
  await waitFor(() => input.transport.closedReason === 'unknown_response_id')
})

test('thread archived notification retires only an exact durable archive owner', async () => {
  for (const owned of [true, false]) {
    const archivePort = new FakeThreadArchivePort()
    archivePort.consumeNotification = owned
    const input = makeClient({ archivePort })
    await initializeClient(input)
    input.transport.emit({
      method: 'thread/archived',
      params: { threadId: 'thread-archived-1', schemaExtension: 'allowed' },
      schemaExtension: 'allowed',
    })
    await waitFor(() => archivePort.events.some((event) => event.kind === 'notification'))
    if (owned) {
      await waitFor(() => input.inboundPort.retiredThreads.length === 1)
      assert.equal(input.transport.closedReason, null)
      assert.deepEqual(input.inboundPort.retiredThreads, [{
        connectionEpoch: 'epoch-1',
        threadId: 'thread-archived-1',
      }])
    } else {
      await waitFor(() => input.transport.closedReason === 'thread_archive_notification_unowned')
      assert.deepEqual(input.inboundPort.retiredThreads, [])
    }
  }
})

test('start timeout seals the old connection and leaves durable recovery as the only owner', async () => {
  const input = makeClient({ timeoutMs: 15 })
  await initializeClient(input)
  const { client, transport, startPort } = input
  const starting = client.threadStart(threadStartParams())
  const rejected = assert.rejects(starting, (error: unknown) => (
    error instanceof CodexAppServerClientError && error.code === 'start_delivery_unknown'
  ))
  await waitFor(() => startPort.unresolved.length === 1)
  assert.equal(startPort.activated.length, 1)
  assert.equal(startPort.writes.length, 1)
  await rejected
  assert.equal(transport.closedReason, 'start_delivery_unknown')
  assert.deepEqual(startPort.closedEpochs, ['epoch-1'])
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

test('safe reasoning summary notifications broadcast while raw reasoning stays passive', async () => {
  const input = makeClient()
  await initializeClient(input)
  const observed: string[] = []
  input.client.subscribe((notification) => observed.push(notification.method))

  const frames = [
    {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'reasoning', id: 'reasoning-1', summary: [], content: [] },
        startedAtMs: 1,
      },
    },
    {
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0 },
    },
    {
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        summaryIndex: 0,
        delta: 'thinking',
      },
    },
    {
      method: 'item/reasoning/textDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        contentIndex: 0,
        delta: 'private reasoning',
      },
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'reasoning', id: 'reasoning-1', summary: ['thinking'], content: [] },
        completedAtMs: 2,
      },
    },
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', delta: 'done' },
    },
    {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [{ type: 'agentMessage', id: 'answer-1', text: 'done', phase: 'final_answer' }],
          status: 'completed',
          error: null,
        },
      },
    },
  ]
  for (const frame of frames) input.transport.emit(frame)

  await waitFor(() => observed.includes('turn/completed'))
  assert.equal(input.transport.closedReason, null)
  assert.deepEqual(observed, [
    'item/started',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/summaryTextDelta',
    'item/completed',
    'item/agentMessage/delta',
    'turn/completed',
  ])
})

test('model reroute is routed as an exact typed turn notification without closing the connection', async () => {
  const input = makeClient()
  await initializeClient(input)
  const observed: unknown[] = []
  input.client.subscribe((notification) => observed.push(notification))

  input.transport.emit({
    method: 'model/rerouted',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      fromModel: 'ready-e0-model',
      toModel: 'fallback-model',
      reason: 'highRiskCyberActivity',
    },
  })

  await waitFor(() => observed.length === 1)
  assert.deepEqual(observed, [{
    method: 'model/rerouted',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      fromModel: 'ready-e0-model',
      toModel: 'fallback-model',
      reason: 'highRiskCyberActivity',
    },
  }])
  assert.equal(input.transport.closedReason, null)
})

test('an opted-out notification and a schema-outside notification both fail closed', async () => {
  for (const fixture of [
    {
      frame: { method: 'thread/deleted', params: { threadId: 'thread-1' } },
      reason: 'notification_opted_out_method',
    },
    {
      frame: { method: 'future/notification', params: {} },
      reason: 'notification_unknown_method',
    },
  ]) {
    const input = makeClient()
    await initializeClient(input)
    input.transport.emit(fixture.frame)
    await waitFor(() => input.transport.closedReason !== null)
    assert.equal(input.transport.closedReason, fixture.reason)
    assert.equal(input.inboundPort.notifications.length, 0)
  }
})

test('typed start rejection with unknown evidence seals the old connection for recovery', async () => {
  const startPort = new FakeStartPort()
  const input = makeClient({ timeoutMs: 100, startPort })
  await initializeClient(input)
  const { client, transport } = input
  const starting = client.threadStart(threadStartParams())
  const rejected = assert.rejects(starting, (error: unknown) => (
    error instanceof CodexAppServerClientError
    && error.code === 'start_delivery_unknown'
  ))
  await waitFor(() => transport.writes.length === 1)
  const frame = JSON.parse(transport.writes[0]) as { id: number }
  transport.emit({ id: frame.id, error: { code: -32602, message: 'rejected' } })
  await waitFor(() => startPort.rejected.length === 1)
  await rejected
  assert.equal(transport.closedReason, 'start_delivery_unknown')
  assert.deepEqual(startPort.closedEpochs, ['epoch-1'])
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
  await waitFor(() => inboundPort.confirmedAttempts.length === 1)
  assert.equal(inboundPort.confirmedAttempts[0].requestRpcId, '902')
})

test('tool response transport failure leaves its durable delivery attempt unacknowledged', async () => {
  const inboundPort = new FakeInboundPort()
  inboundPort.serverDisposition = 'respond'
  const input = makeClient({ inboundPort })
  await initializeClient(input)
  input.transport.nextWriteError = new Error('fixture_transport_write_failed')

  input.transport.emit({
    id: 910,
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' },
  })

  await waitFor(() => input.transport.closedReason !== null)
  assert.equal(input.transport.closedReason, 'protocol_failure')
  assert.equal(input.transport.writes.length, 1)
  assert.equal(inboundPort.confirmedAttempts.length, 0)
})

test('tool response from a different call identity is rejected before transport write', async () => {
  const inboundPort = new FakeInboundPort()
  inboundPort.serverDisposition = 'respond'
  inboundPort.attemptCallIdOverride = 'call-forged'
  const input = makeClient({ inboundPort })
  await initializeClient(input)

  input.transport.emit({
    id: 912,
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' },
  })

  await waitFor(() => input.transport.closedReason !== null)
  assert.equal(input.transport.closedReason, 'server_response_delivery_identity_mismatch')
  assert.equal(input.transport.writes.length, 0)
  assert.equal(inboundPort.confirmedAttempts.length, 0)
})

test('duplicate tool request id on one live connection cannot produce a second response', async () => {
  const inboundPort = new FakeInboundPort()
  inboundPort.serverDisposition = 'respond'
  inboundPort.confirmBarrier = new Promise<void>(() => undefined)
  const input = makeClient({ inboundPort })
  await initializeClient(input)
  const frame = {
    id: 911,
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' },
  }

  input.transport.emit(frame)
  await waitFor(() => inboundPort.confirmedAttempts.length === 1)
  input.transport.emit(frame)

  await waitFor(() => input.transport.closedReason !== null)
  assert.equal(input.transport.closedReason, 'server_request_duplicate')
  assert.equal(input.transport.writes.length, 1)
  assert.equal(inboundPort.confirmedAttempts.length, 1)
})

test('buffer release cannot write two responses for the same live RPC', async () => {
  const inboundPort = new FakeInboundPort()
  inboundPort.serverDisposition = 'buffered'
  const input = makeClient({ inboundPort })
  await initializeClient(input)
  input.transport.emit({
    id: 913,
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' },
  })
  await waitFor(() => inboundPort.serverRequests.length === 1)
  assert.ok(inboundPort.releasePort)
  const result = { contentItems: [], success: true }
  const identity = {
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    codexCallId: 'call-1',
    readyActionId: 'action-call-1',
    connectionEpoch: 'epoch-1',
    requestRpcId: '913',
    toolResponseDigest: digestCanonicalJson(result),
  }
  const attempt = {
    attemptId: buildCodexToolResponseDeliveryAttemptId(identity),
    ...identity,
  }

  inboundPort.releasePort.respondServerRequest(913, result, attempt)
  inboundPort.releasePort.respondServerRequest(913, result, attempt)

  await waitFor(() => input.transport.closedReason !== null)
  assert.equal(input.transport.closedReason, 'server_response_duplicate')
  assert.equal(input.transport.writes.length, 1)
  assert.equal(inboundPort.confirmedAttempts.length, 0)
})

test('active buffered server-request identities have a hard bound without eviction', async () => {
  const inboundPort = new FakeInboundPort()
  inboundPort.serverDisposition = 'respond'
  const input = makeClient({ inboundPort })
  await initializeClient(input)
  const handleServerRequest = (input.client as unknown as {
    handleServerRequest: (frame: Record<string, unknown>) => Promise<void>
  }).handleServerRequest.bind(input.client)

  const completedState = input.client as unknown as {
    serverRequestIdentities: Map<string, unknown>
    serverResponseWrites: Set<string>
  }
  inboundPort.serverDisposition = 'buffered'
  for (let index = 0; index < 2_048; index += 1) {
    await handleServerRequest({
      id: index + 30_000,
      method: 'item/tool/call',
      params: { threadId: 'thread-buffered', turnId: 'turn-buffered', callId: `buffered-${index}` },
    })
  }
  assert.equal(completedState.serverRequestIdentities.size, 2_048)
  assert.equal(completedState.serverResponseWrites.size, 0)
  await assert.rejects(handleServerRequest({
    id: 99_999,
    method: 'item/tool/call',
    params: { threadId: 'thread-buffered', turnId: 'turn-buffered', callId: 'overflow' },
  }), /server_request_capacity_exhausted/)
  assert.equal(completedState.serverRequestIdentities.size, 2_048)
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

test('protocol failure seals locally before a throwing reentrant transport close', async () => {
  const transport = new FakeTransport()
  transport.reenterClose = true
  transport.closeError = new Error('transport_close_failed')
  const input = makeClient({ transport })

  transport.emit({ id: 404, result: {} })

  await waitFor(() => input.startPort.closedEpochs.length === 1)
  await input.client.shutdown()
  assert.equal(transport.closedReason, 'unknown_response_id')
  assert.deepEqual(input.startPort.closedEpochs, ['epoch-1'])
  assert.equal(
    input.manualPort.events.filter((event) => event.kind === 'connection-closed').length,
    1,
  )
  assert.equal(
    input.archivePort.events.filter((event) => event.kind === 'connection-closed').length,
    1,
  )
  const writesBeforeRetry = transport.writes.length
  await assert.rejects(
    input.client.threadRead({ threadId: 'thread-1', includeTurns: true }),
    /connection_closed/,
  )
  assert.equal(transport.writes.length, writesBeforeRetry)
  assert.equal((input.client as unknown as { pending: Map<number, unknown> }).pending.size, 0)
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

test('connection close rejects the old operation after durable close ownership is recorded', async () => {
  const input = makeClient({ timeoutMs: 100 })
  await initializeClient(input)
  const { client, transport, startPort } = input
  const starting = client.turnStart({
    threadId: 'thread-1',
    clientUserMessageId: 'message-1',
    collaborationMode: turnStartParams().collaborationMode,
    environments: [],
    input: [{ type: 'text', text: 'hello', text_elements: [] }],
    additionalContext: {},
    responsesapiClientMetadata: {
      readyRunId: 'run-1',
      toolSurfaceDigest: 'tool-digest',
      turnContractDigest: 'turn-digest',
      upstreamProfileSnapshotDigest: 'profile-digest',
    },
  })
  const rejected = assert.rejects(starting, /child exited/)
  await waitFor(() => transport.writes.length === 1)
  transport.disconnect(new Error('child exited'))
  await waitFor(() => startPort.closedEpochs.length === 1)
  await rejected
})

test('connection close drains a received start reconciliation before rejecting the old operation', async () => {
  const startPort = new FakeStartPort()
  let releaseAccepted!: () => void
  startPort.acceptedBarrier = new Promise<void>((resolve) => { releaseAccepted = resolve })
  const input = makeClient({ timeoutMs: 500, startPort })
  await initializeClient(input)
  const starting = input.client.turnStart(turnStartParams())
  await waitFor(() => input.transport.writes.length === 1)
  const request = JSON.parse(input.transport.writes[0]) as { id: number }
  input.transport.emit({
    id: request.id,
    result: { turn: { id: 'turn-accepted', items: [], status: 'inProgress', error: null } },
  })
  await waitFor(() => startPort.accepted.length === 1)
  input.transport.disconnect(new Error('child exited after response'))
  await waitFor(() => startPort.closedEpochs.length === 1)
  assert.equal(startPort.unresolved.length, 0)
  releaseAccepted()
  await assert.rejects(starting, /child exited after response/)
})

test('observer failure is isolated for both live and provisionally replayed notifications', async () => {
  const input = makeClient()
  await initializeClient(input)
  const observed: string[] = []
  input.client.subscribe(() => { throw new Error('observer_down') })
  input.client.subscribe(async () => { throw new Error('async_observer_down') })
  input.client.subscribe((notification) => observed.push(notification.method))
  const rerouted = {
    method: 'model/rerouted' as const,
    params: {
      threadId: 'thread-1', turnId: 'turn-1', fromModel: 'ready-e0-model',
      toModel: 'fallback-model', reason: 'highRiskCyberActivity',
    },
  }

  input.transport.emit(rerouted)
  await waitFor(() => observed.length === 1)
  input.inboundPort.releasePort?.broadcastNotification(rerouted)

  assert.deepEqual(observed, ['model/rerouted', 'model/rerouted'])
  assert.equal(input.transport.closedReason, null)
})

test('response-first completion ignores a late child write error for every request owner', async () => {
  const cases = [
    {
      name: 'ordinary',
      invoke: (input: ReturnType<typeof makeClient>) => input.client.threadRead({
        threadId: 'thread-1', includeTurns: true,
      }),
      result: { thread: makeThread() },
    },
    {
      name: 'start',
      invoke: (input: ReturnType<typeof makeClient>) => input.client.threadStart(threadStartParams()),
      result: { thread: makeThread(), instructionSources: [] },
    },
    {
      name: 'manual',
      invoke: (input: ReturnType<typeof makeClient>) => input.client.threadCompactStart({ threadId: 'thread-1' }),
      result: {},
    },
    {
      name: 'archive',
      invoke: (input: ReturnType<typeof makeClient>) => input.client.threadArchive({ threadId: 'thread-1' }),
      result: {},
    },
  ] as const
  for (const fixture of cases) {
    const input = makeClient({ timeoutMs: 500 })
    await initializeClient(input)
    input.transport.deferWrites = true
    let settlements = 0
    const operation = fixture.invoke(input).then((result) => {
      settlements += 1
      return result
    }, (error) => {
      settlements += 1
      throw error
    })
    await waitFor(() => input.transport.deferredWriteCallbacks.length === 1)
    const frame = JSON.parse(input.transport.writes[0]) as { id: number }
    input.transport.emit({ id: frame.id, result: fixture.result })
    await operation
    input.transport.settleNextWrite(new Error(`${fixture.name}_late_write_error`))
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(settlements, 1)
    assert.equal(input.transport.closedReason, null)
    assert.equal(input.startPort.unresolved.length, 0)
    assert.equal(input.manualPort.events.filter((event) => event.kind === 'unresolved').length, 0)
    assert.equal(input.archivePort.events.filter((event) => event.kind === 'unresolved').length, 0)
  }
})

test('connection close waits for earlier inbound routing and suppresses its late broadcast', async () => {
  const barrier = deferred()
  const inboundPort = new FakeInboundPort()
  inboundPort.notificationBarrier = barrier.promise
  const input = makeClient({ inboundPort })
  await initializeClient(input)
  const observed: string[] = []
  input.client.subscribe((notification) => observed.push(notification.method))
  input.transport.emit({
    method: 'model/rerouted',
    params: {
      threadId: 'thread-1', turnId: 'turn-1', fromModel: 'ready-e0-model',
      toModel: 'fallback-model', reason: 'highRiskCyberActivity',
    },
  })
  await waitFor(() => inboundPort.notifications.length === 1)
  input.transport.disconnect(new Error('line_then_close'))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(input.startPort.closedEpochs.length, 0)
  barrier.resolve()
  await waitFor(() => input.startPort.closedEpochs.length === 1)
  assert.deepEqual(observed, [])
})

test('connection close seals later inbound frames before routing', async () => {
  const input = makeClient()
  await initializeClient(input)
  input.transport.disconnect(new Error('close_then_line'))
  await waitFor(() => input.startPort.closedEpochs.length === 1)
  input.transport.emit({
    method: 'model/rerouted',
    params: {
      threadId: 'thread-1', turnId: 'turn-1', fromModel: 'ready-e0-model',
      toModel: 'fallback-model', reason: 'highRiskCyberActivity',
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(input.inboundPort.notifications.length, 0)
})

test('connection close waits for earlier server request routing and suppresses its late response', async () => {
  const barrier = deferred()
  const inboundPort = new FakeInboundPort()
  inboundPort.serverDisposition = 'respond'
  inboundPort.serverBarrier = barrier.promise
  const input = makeClient({ inboundPort })
  await initializeClient(input)
  input.transport.emit({
    id: 81,
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-81' },
  })
  await waitFor(() => inboundPort.serverRequests.length === 1)
  input.transport.disconnect(new Error('server_line_then_close'))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(input.startPort.closedEpochs.length, 0)
  barrier.resolve()
  await waitFor(() => input.startPort.closedEpochs.length === 1)
  assert.equal(input.transport.writes.length, 0)
  assert.equal(inboundPort.confirmedAttempts.length, 0)
})

test('close during durable activation produces no pending request or child write for every dispatch method', async () => {
  const cases = [
    { name: 'thread/start', invoke: (input: ReturnType<typeof makeClient>) => input.client.threadStart(threadStartParams()) },
    { name: 'turn/start', invoke: (input: ReturnType<typeof makeClient>) => input.client.turnStart(turnStartParams()) },
    { name: 'thread/compact/start', invoke: (input: ReturnType<typeof makeClient>) => input.client.threadCompactStart({ threadId: 'thread-1' }) },
    { name: 'thread/archive', invoke: (input: ReturnType<typeof makeClient>) => input.client.threadArchive({ threadId: 'thread-1' }) },
  ] as const
  for (const fixture of cases) {
    const activation = deferred()
    const input = makeClient()
    await initializeClient(input)
    if (fixture.name === 'thread/start' || fixture.name === 'turn/start') {
      input.startPort.activationBarrier = activation.promise
    } else if (fixture.name === 'thread/compact/start') {
      input.manualPort.activationBarrier = activation.promise
    } else {
      input.archivePort.activationBarrier = activation.promise
    }
    const operation = fixture.invoke(input)
    const rejected = assert.rejects(operation, /connection_closed/)
    await waitFor(() => (
      input.startPort.activated.length
      + input.manualPort.events.filter((event) => event.kind === 'activate').length
      + input.archivePort.events.filter((event) => event.kind === 'activate').length
    ) === 1)
    input.transport.disconnect(new Error(`closed_during_${fixture.name}`))
    activation.resolve()
    await rejected
    await waitFor(() => input.startPort.closedEpochs.length === 1)
    assert.equal(input.transport.writes.length, 0)
    assert.equal((input.client as unknown as { pending: Map<number, unknown> }).pending.size, 0)
  }
})

test('timeout audit failures close safely and drain start, compaction, and archive requests', async () => {
  const cases = [
    { name: 'start', invoke: (input: ReturnType<typeof makeClient>) => input.client.turnStart(turnStartParams()) },
    { name: 'manual', invoke: (input: ReturnType<typeof makeClient>) => input.client.threadCompactStart({ threadId: 'thread-1' }) },
    { name: 'archive', invoke: (input: ReturnType<typeof makeClient>) => input.client.threadArchive({ threadId: 'thread-1' }) },
  ] as const
  for (const fixture of cases) {
    const input = makeClient({ timeoutMs: 10 })
    await initializeClient(input)
    const auditError = new Error(`${fixture.name}_audit_down`)
    if (fixture.name === 'start') input.startPort.unresolvedError = auditError
    if (fixture.name === 'manual') input.manualPort.unresolvedError = auditError
    if (fixture.name === 'archive') input.archivePort.unresolvedError = auditError
    const operation = fixture.invoke(input)
    const rejected = assert.rejects(operation, new RegExp(`${fixture.name}_audit_down`))
    await rejected
    await waitFor(() => input.startPort.closedEpochs.length === 1)
    assert.equal((input.client as unknown as { pending: Map<number, unknown> }).pending.size, 0)
    assert.equal(input.transport.closedReason, 'protocol_failure')
  }
})

test('connection cleanup isolates every durable owner failure before rejecting pending reads', async () => {
  const input = makeClient({ timeoutMs: 500 })
  await initializeClient(input)
  input.startPort.closeError = new Error('start_close_down')
  input.manualPort.closeError = new Error('manual_close_down')
  input.archivePort.closeError = new Error('archive_close_down')
  const reading = input.client.threadRead({ threadId: 'thread-1', includeTurns: true })
  const rejected = assert.rejects(reading, /transport_closed/)
  await waitFor(() => input.transport.writes.length === 1)
  input.transport.disconnect(new Error('transport_closed'))
  await rejected
  await waitFor(() => input.archivePort.events.some((event) => event.kind === 'connection-closed'))
  assert.deepEqual(input.startPort.closedEpochs, ['epoch-1'])
  assert.equal(input.manualPort.events.filter((event) => event.kind === 'connection-closed').length, 1)
  assert.equal(input.archivePort.events.filter((event) => event.kind === 'connection-closed').length, 1)
  assert.equal((input.client as unknown as { pending: Map<number, unknown> }).pending.size, 0)
})

test('server response acknowledgement is async, fail-closed, and ignored after connection close', async () => {
  const confirmation = deferred()
  const inboundPort = new FakeInboundPort()
  inboundPort.serverDisposition = 'respond'
  inboundPort.confirmBarrier = confirmation.promise
  const input = makeClient({ inboundPort })
  await initializeClient(input)
  input.transport.emit({
    id: 71,
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' },
  })
  await waitFor(() => inboundPort.confirmedAttempts.length === 1)
  assert.equal((input.client as unknown as { serverRequestIdentities: Map<string, unknown> })
    .serverRequestIdentities.size, 1)
  confirmation.reject(new Error('durable_ack_down'))
  await waitFor(() => input.transport.closedReason === 'protocol_failure')

  const delayedInbound = new FakeInboundPort()
  delayedInbound.serverDisposition = 'respond'
  const delayed = makeClient({ inboundPort: delayedInbound })
  await initializeClient(delayed)
  delayed.transport.deferWrites = true
  delayed.transport.emit({
    id: 72,
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-2' },
  })
  await waitFor(() => delayed.transport.deferredWriteCallbacks.length === 1)
  delayed.transport.disconnect(new Error('closed_before_write_callback'))
  await waitFor(() => delayed.startPort.closedEpochs.length === 1)
  delayed.transport.settleNextWrite(null)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(delayedInbound.confirmedAttempts.length, 0)
})

test('numeric and padded-string server request ids share one active identity', async () => {
  const inboundPort = new FakeInboundPort()
  inboundPort.serverDisposition = 'buffered'
  const input = makeClient({ inboundPort })
  await initializeClient(input)
  input.transport.emit({
    id: 1,
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' },
  })
  await waitFor(() => inboundPort.serverRequests.length === 1)
  input.transport.emit({
    id: ' 1 ',
    method: 'item/tool/call',
    params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-2' },
  })
  await waitFor(() => input.transport.closedReason === 'server_request_duplicate')
  assert.equal(inboundPort.serverRequests.length, 1)
})
