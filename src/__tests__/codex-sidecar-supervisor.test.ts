import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  CodexChildJsonLineTransport,
  CODEX_SIDECAR_MAX_STDOUT_LINE_BYTES,
  CODEX_SIDECAR_STDOUT_DRAIN_TIMEOUT_MS,
  CodexSidecarSupervisor,
  CodexSidecarSupervisorError,
  MacCodexProcessInspector,
  NodeCodexSidecarSpawnPort,
  type CodexOwnedProcess,
  type CodexProcessInspector,
  type CodexProcessLeaseStore,
  type CodexSidecarChild,
  type CodexSidecarSpawnPort,
} from '../main/modules/agent-control/codex-runtime/codex-sidecar-supervisor'
import { CodexSidecarSession } from '../main/modules/agent-control/codex-runtime/codex-sidecar-session'
import { CodexSidecarRecoveryOwner } from '../main/modules/agent-control/codex-runtime/codex-sidecar-recovery-owner'
import type { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import type { CodexStartIdentityRegistry } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'
import type {
  CodexProcessLeaseIdentity,
  CodexProcessLeaseRow,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import type {
  PreparedCodexRuntimeState,
  VerifiedCodexRuntime,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-host'

const startedAt = Date.parse('2026-08-07T02:00:00.000Z')

test('macOS process evidence preserves the full current executable path', async () => {
  const self = (await new MacCodexProcessInspector().list()).find((row) => row.pid === process.pid)
  assert.ok(self)
  assert.equal(realpathSync(self.executablePath), realpathSync(process.execPath))
  assert.match(self.processStartIdentity, new RegExp(`^${process.pid}:`))
})

test('node spawn port contains an asynchronous spawn error when no child pid exists', async () => {
  const spawnPort = new NodeCodexSidecarSpawnPort()
  assert.throws(() => spawnPort.spawn({
    executablePath: '/ready-does-not-exist/codex',
    argv: ['app-server'],
    cwd: '/tmp',
    env: {},
  }), /sidecar_spawn_failed/)
  await new Promise<void>((resolve) => setImmediate(resolve))
})

test('child transport publishes only the first protocol or process close', () => {
  const child = fakeChild(39)
  const protocolCloses: string[] = []
  const transport = new CodexChildJsonLineTransport(
    child.process,
    (reason) => protocolCloses.push(reason),
    () => undefined,
  )
  const closes: Array<Error | null> = []
  transport.onClose((error) => closes.push(error))

  transport.close('protocol_failure')
  child.process.emit('exit', 1, null)
  child.process.emit('error', new Error('late-process-error'))

  assert.equal(closes.length, 1)
  assert.equal((closes[0] as CodexSidecarSupervisorError).code, 'protocol_failure')
  assert.deepEqual(protocolCloses, ['protocol_failure'])
})

test('child transport drains stdout tail frames before publishing process exit', async () => {
  const child = fakeChild(63)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  const events: string[] = []
  transport.onLine((line) => events.push(`line:${line}`))
  transport.onClose((error) => events.push(`close:${error?.message || 'clean'}`))

  child.process.emit('exit', 0, null)
  assert.deepEqual(events, [])
  child.process.stdout.write('{"id":1}\n')
  child.process.stdout.end()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['line:{"id":1}', 'close:clean'])
})

test('child transport waits for process exit after stdout EOF', async () => {
  const child = fakeChild(64)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  const events: string[] = []
  transport.onLine((line) => events.push(`line:${line}`))
  transport.onClose((error) => events.push(`close:${error?.message || 'clean'}`))

  child.process.stdout.end('{"id":2}\n')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['line:{"id":2}'])
  child.process.emit('exit', 0, null)
  assert.deepEqual(events, ['line:{"id":2}', 'close:clean'])
})

test('child transport preserves a final frame without a trailing newline', async () => {
  const child = fakeChild(65)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  const events: string[] = []
  transport.onLine((line) => events.push(`line:${line}`))
  transport.onClose((error) => events.push(`close:${error?.message || 'clean'}`))

  child.process.emit('exit', 0, null)
  child.process.stdout.end('{"id":3}')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['line:{"id":3}', 'close:clean'])
})

test('child transport bounds raw unterminated lines before parsing and closes exactly once', async () => {
  const child = fakeChild(68)
  const protocolCloses: string[] = []
  const transport = new CodexChildJsonLineTransport(
    child.process,
    (reason) => protocolCloses.push(reason),
    () => undefined,
  )
  const lines: string[] = []
  const closes: Array<Error | null> = []
  transport.onLine((line) => lines.push(line))
  transport.onClose((error) => closes.push(error))

  child.process.stdout.write(Buffer.alloc(CODEX_SIDECAR_MAX_STDOUT_LINE_BYTES, 0x61))
  assert.equal(closes.length, 0)
  child.process.stdout.write(Buffer.from('b'))
  assert.equal((closes[0] as CodexSidecarSupervisorError).code, 'sidecar_stdout_line_too_large')
  assert.deepEqual(lines, [])
  assert.deepEqual(protocolCloses, ['sidecar_stdout_line_too_large'])

  child.process.stdout.write('{"id":"late"}\n')
  child.process.emit('exit', 0, null)
  child.process.stdout.end()
  child.process.emit('close', 0, null)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(lines, [])
  assert.equal(closes.length, 1)
  assert.deepEqual(protocolCloses, ['sidecar_stdout_line_too_large'])
})

test('child transport accepts an exact-limit EOF tail without retaining the source chunk', async () => {
  const child = fakeChild(69)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  const lines: string[] = []
  const closes: Array<Error | null> = []
  transport.onLine((line) => lines.push(line))
  transport.onClose((error) => closes.push(error))
  const prefix = '{"payload":"'
  const suffix = '"}'
  const line = `${prefix}${'x'.repeat(
    CODEX_SIDECAR_MAX_STDOUT_LINE_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix),
  )}${suffix}`

  child.process.stdout.end(line)
  child.process.emit('exit', 0, null)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(Buffer.byteLength(lines[0]), CODEX_SIDECAR_MAX_STDOUT_LINE_BYTES)
  assert.equal(lines[0], line)
  assert.deepEqual(closes, [null])
})

test('child transport bounds process-exit tail drain and drops a timed-out partial line', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = fakeChild(70)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  const lines: string[] = []
  const closes: Array<Error | null> = []
  transport.onLine((line) => lines.push(line))
  transport.onClose((error) => closes.push(error))

  child.process.stdout.write('{"id":5')
  child.process.emit('exit', 1, null)
  t.mock.timers.tick(CODEX_SIDECAR_STDOUT_DRAIN_TIMEOUT_MS - 1)
  assert.deepEqual(closes, [])
  t.mock.timers.tick(1)
  assert.equal((closes[0] as CodexSidecarSupervisorError).code, 'sidecar_stdout_drain_timeout')
  assert.deepEqual(lines, [])

  child.process.stdout.write('}\n')
  child.process.stdout.end()
  child.process.emit('close', 1, null)
  t.mock.timers.tick(CODEX_SIDECAR_STDOUT_DRAIN_TIMEOUT_MS)
  assert.deepEqual(lines, [])
  assert.equal(closes.length, 1)
})

test('child transport accepts a complete tail before deadline and EOF wins the timeout race', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = fakeChild(71)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  const events: string[] = []
  transport.onLine((line) => events.push(`line:${line}`))
  transport.onClose((error) => events.push(`close:${error?.message || 'clean'}`))

  child.process.emit('exit', 0, null)
  t.mock.timers.tick(CODEX_SIDECAR_STDOUT_DRAIN_TIMEOUT_MS - 1)
  child.process.stdout.write('{"id":6}\n')
  child.process.stdout.emit('end')
  t.mock.timers.tick(1)
  child.process.emit('close', 0, null)
  assert.deepEqual(events, ['line:{"id":6}', 'close:clean'])
})

test('child transport process error and explicit protocol close remain immediate and exact-once', async () => {
  for (const mode of ['error', 'protocol'] as const) {
    const child = fakeChild(mode === 'error' ? 66 : 67)
    const protocolCloses: string[] = []
    const transport = new CodexChildJsonLineTransport(
      child.process,
      (reason) => protocolCloses.push(reason),
      () => undefined,
    )
    const closes: Array<Error | null> = []
    transport.onClose((error) => closes.push(error))
    if (mode === 'error') child.process.emit('error', new Error('child_down'))
    else transport.close('protocol_failure')
    assert.equal(closes.length, 1)

    child.process.emit('exit', 1, null)
    child.process.stdout.end('{"id":4}\n')
    child.process.emit('close', 1, null)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closes.length, 1)
    assert.deepEqual(protocolCloses, mode === 'protocol' ? ['protocol_failure'] : [])
  }
})

const runtime = {
  binaryPath: '/opt/ready/codex',
  binarySha256: 'a'.repeat(64),
  manifestDigest: 'runtime-manifest-digest',
  contracts: {
    nativeIsolationConfigContract: {
      launchArgv: ['app-server'],
    },
    childEnvAllowlist: {
      allowedKeys: [
        'PATH',
        'LANG',
        'LC_ALL',
        'TMPDIR',
        'HOME',
        'CODEX_HOME',
        'READY_CODEX_GATEWAY_URL',
        'READY_CODEX_GATEWAY_TOKEN',
        'READY_CODEX_PROCESS_LEASE_ID',
        'READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID',
        'READY_CODEX_CONNECTION_EPOCH',
        'READY_CODEX_STATE_DIR',
      ],
    },
    turnClientIdentityExtractionContract: {
      thread_start: { pinnedAppServerSource: 'appServer' },
    },
  },
} as unknown as VerifiedCodexRuntime

const state = {
  stateDir: '/tmp/ready-codex/state',
  homeDir: '/tmp/ready-codex/home',
  codexHome: '/tmp/ready-codex/codex-home',
  threadCwdRoot: '/tmp/ready-codex/threads',
  tmpDir: '/tmp/ready-codex/tmp',
  configPath: '/tmp/ready-codex/codex-home/config.toml',
  gatewayUrl: 'http://127.0.0.1:4317',
} satisfies PreparedCodexRuntimeState

type MutableLease = CodexProcessLeaseRow

class FakeLeaseStore implements CodexProcessLeaseStore {
  readonly rows: MutableLease[] = []
  readonly events: string[]

  constructor(events: string[] = []) {
    this.events = events
  }

  createProcessLeaseIntent(input: CodexProcessLeaseIdentity & {
    spawnIntentAt: string
    spawnVisibilityDeadlineAt: string
  }): CodexProcessLeaseRow {
    if (this.readLiveProcessLease()) throw new Error('fake_live_lease_exists')
    this.events.push('lease_intent')
    const row: MutableLease = {
      ...input,
      singletonSlot: 1,
      pid: null,
      processGroupId: null,
      processStartIdentity: null,
      ownershipConfirmedAt: null,
      ownerMainDeadAt: null,
      ownerMainDeathEvidenceDigest: null,
      connectionOpenedAt: null,
      closedAt: null,
      treeZeroAt: null,
      treeZeroMatcherMode: null,
      stableZeroSampleTranscriptDigest: null,
      treeZeroEvidenceDigest: null,
      revision: 1,
    }
    this.rows.push(row)
    return structuredClone(row)
  }

  confirmProcessLeaseOwnership(input: {
    processLeaseId: string
    expectedRevision: number
    pid: number
    processGroupId: number
    processStartIdentity: string
    confirmedAt: string
  }): CodexProcessLeaseRow {
    this.events.push('ownership_cas')
    return this.update(input.processLeaseId, input.expectedRevision, (row) => {
      assert.equal(row.pid, null)
      row.pid = input.pid
      row.processGroupId = input.processGroupId
      row.processStartIdentity = input.processStartIdentity
      row.ownershipConfirmedAt = input.confirmedAt
    })
  }

  markProcessConnectionOpened(input: {
    processLeaseId: string
    expectedRevision: number
    openedAt: string
  }): CodexProcessLeaseRow {
    this.events.push('connection_opened')
    return this.update(input.processLeaseId, input.expectedRevision, (row) => {
      row.connectionOpenedAt = input.openedAt
    })
  }

  markProcessConnectionClosed(input: {
    processLeaseId: string
    expectedRevision: number
    closedAt: string
  }): CodexProcessLeaseRow {
    this.events.push('connection_closed')
    return this.update(input.processLeaseId, input.expectedRevision, (row) => {
      row.closedAt = input.closedAt
    })
  }

  recordOldMainDeath(input: {
    processLeaseId: string
    expectedRevision: number
    deadAt: string
    evidenceDigest: string
  }): CodexProcessLeaseRow {
    this.events.push('old_main_death')
    return this.update(input.processLeaseId, input.expectedRevision, (row) => {
      row.ownerMainDeadAt = input.deadAt
      row.ownerMainDeathEvidenceDigest = input.evidenceDigest
    })
  }

  recordProcessTreeZero(input: {
    processLeaseId: string
    expectedRevision: number
    treeZeroAt: string
    matcherMode: 'pre_cas' | 'post_cas'
    sampleTranscriptDigest: string
    evidenceDigest: string
  }): CodexProcessLeaseRow {
    this.events.push(`tree_zero:${input.matcherMode}`)
    return this.update(input.processLeaseId, input.expectedRevision, (row) => {
      row.treeZeroAt = input.treeZeroAt
      row.treeZeroMatcherMode = input.matcherMode
      row.stableZeroSampleTranscriptDigest = input.sampleTranscriptDigest
      row.treeZeroEvidenceDigest = input.evidenceDigest
    })
  }

  readLiveProcessLease(): CodexProcessLeaseRow | null {
    const row = this.rows.find((candidate) => candidate.treeZeroAt === null)
    return row ? structuredClone(row) : null
  }

  readLatestProcessLeaseByOwnerMainBootId(ownerMainBootId: string): CodexProcessLeaseRow | null {
    const row = [...this.rows].reverse().find((candidate) => candidate.ownerMainBootId === ownerMainBootId)
    return row ? structuredClone(row) : null
  }

  seed(row: CodexProcessLeaseRow): void {
    this.rows.push(structuredClone(row))
  }

  private update(
    processLeaseId: string,
    expectedRevision: number,
    mutate: (row: MutableLease) => void,
  ): CodexProcessLeaseRow {
    const row = this.rows.find((candidate) => candidate.processLeaseId === processLeaseId)
    assert.ok(row)
    assert.equal(row.revision, expectedRevision)
    mutate(row)
    row.revision += 1
    return structuredClone(row)
  }
}

class ScriptedInspector implements CodexProcessInspector {
  private index = 0

  constructor(private readonly snapshots: Array<() => CodexOwnedProcess[]>) {}

  async list(): Promise<CodexOwnedProcess[]> {
    const snapshot = this.snapshots[Math.min(this.index, this.snapshots.length - 1)]
    this.index += 1
    return structuredClone(snapshot ? snapshot() : [])
  }
}

function fakeChild(pid: number): CodexSidecarChild {
  const process = new EventEmitter() as EventEmitter & {
    pid: number
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
  }
  process.pid = pid
  process.stdin = new PassThrough()
  process.stdout = new PassThrough()
  process.stderr = new PassThrough()
  return { pid, process: process as unknown as CodexSidecarChild['process'] }
}

test('sidecar session coalesces initialize protocol failure without starting runtime recovery', async () => {
  const child = fakeChild(40)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  let hardResetCount = 0
  let unexpectedCount = 0
  const settlements: Promise<void>[] = []
  const supervisor = {
    async start() {
      return {
        transport,
        lease: { connectionEpoch: 'epoch-coalesced' },
      }
    },
    hardReset() {
      hardResetCount += 1
      return Promise.resolve()
    },
  }
  const session = new CodexSidecarSession({
    runtime,
    state,
    repository: {
      closeLateResponseGuardsForConnection() {},
      markManualCompactionConnectionClosed() {},
    } as unknown as CodexBindingRepository,
    supervisor: supervisor as unknown as CodexSidecarSupervisor,
    evidenceResolver: {
      async resolveTypedRejection() { return { resolution: 'unknown' as const } },
    },
    serverRequestExecutor: {
      async executeServerRequest() { throw new Error('unexpected_server_request') },
      confirmServerResponseTransportWrite() {},
    },
    requestTimeoutMs: 5_000,
    inboundDeadlineMs: 5_000,
    inboundMaxFrames: 8,
    inboundMaxBytes: 8_192,
    now: () => new Date(startedAt).toISOString(),
    nowMs: () => startedAt,
    onUnexpectedClose(settlement) {
      unexpectedCount += 1
      settlements.push(settlement)
    },
  })
  const registry = {
    markConnectionClosed() {},
  } as unknown as CodexStartIdentityRegistry
  const initializing = session.startAndInitialize({
    registry,
    snapshot: {} as never,
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const signal = session.getConnectionAbortSignal('epoch-coalesced')
  assert.ok(signal)
  let abortCount = 0
  signal.addEventListener('abort', () => { abortCount += 1 })

  transport.close('protocol_failure')
  child.process.emit('exit', 1, null)
  child.process.emit('error', new Error('late-process-error'))

  await assert.rejects(initializing)
  await Promise.all(settlements)
  assert.equal(hardResetCount, 1)
  assert.equal(unexpectedCount, 0)
  assert.equal(abortCount, 1)
  assert.equal(session.isConnectionLive('epoch-coalesced'), false)
})

test('initialized sidecar close triggers one reset and one runtime recovery callback', async () => {
  const child = fakeChild(42)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  child.process.stdin.on('data', (chunk) => {
    const frame = JSON.parse(String(chunk).trim()) as { id?: number; method?: string }
    if (frame.method === 'initialize') {
      child.process.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'ready-test/1' } })}\n`)
    }
  })
  let hardResetCount = 0
  let unexpectedCount = 0
  let unexpectedDetected = false
  const protocolFailures: Array<{ code: string; method: string | null }> = []
  const settlements: Promise<void>[] = []
  const supervisor = {
    async start() {
      return { transport, lease: { connectionEpoch: 'epoch-initialized-close' } }
    },
    hardReset() {
      hardResetCount += 1
      return Promise.resolve()
    },
  }
  const session = new CodexSidecarSession({
    runtime,
    state,
    repository: {
      closeLateResponseGuardsForConnection() {},
      markManualCompactionConnectionClosed() {},
    } as unknown as CodexBindingRepository,
    supervisor: supervisor as unknown as CodexSidecarSupervisor,
    evidenceResolver: {
      async resolveTypedRejection() { return { resolution: 'unknown' as const } },
    },
    serverRequestExecutor: {
      async executeServerRequest() { throw new Error('unexpected_server_request') },
      confirmServerResponseTransportWrite() {},
    },
    requestTimeoutMs: 5_000,
    inboundDeadlineMs: 5_000,
    inboundMaxFrames: 8,
    inboundMaxBytes: 8_192,
    now: () => new Date(startedAt).toISOString(),
    nowMs: () => startedAt,
    onProtocolFailure(event) {
      protocolFailures.push(event)
    },
    onUnexpectedCloseDetected() {
      unexpectedDetected = true
    },
    onUnexpectedClose(settlement) {
      unexpectedCount += 1
      settlements.push(settlement)
    },
  })
  await session.startAndInitialize({
    registry: { markConnectionClosed() {} } as unknown as CodexStartIdentityRegistry,
    snapshot: {} as never,
  })
  assert.equal(session.getActiveConnectionEpoch(), 'epoch-initialized-close')
  const signal = session.getConnectionAbortSignal('epoch-initialized-close')
  assert.ok(signal)
  let abortCount = 0
  signal.addEventListener('abort', () => { abortCount += 1 })
  const pendingRead = session.getClient().threadRead({
    threadId: 'thread-pending-at-close',
    includeTurns: true,
  })

  transport.close('notification_unknown_method', { method: 'future/notification', secret: 'not logged' })
  child.process.emit('exit', 1, null)
  child.process.emit('error', new Error('late-process-error'))

  await Promise.all(settlements)
  await assert.rejects(pendingRead)
  assert.equal(unexpectedDetected, true)
  assert.equal(hardResetCount, 1)
  assert.equal(unexpectedCount, 1)
  assert.equal(abortCount, 1)
  assert.deepEqual(protocolFailures, [{
    code: 'notification_unknown_method',
    method: 'future/notification',
  }])
  assert.equal(session.isConnectionLive('epoch-initialized-close'), false)
  assert.throws(() => session.getActiveConnectionEpoch(), /sidecar_session_not_active/)
})

test('ordinary RPC timeout cancels the active recovery generation before rejecting its read', async () => {
  const child = fakeChild(44)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  child.process.stdin.on('data', (chunk) => {
    const frame = JSON.parse(String(chunk).trim()) as { id?: number; method?: string }
    if (frame.method === 'initialize') {
      child.process.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'ready-test/1' } })}\n`)
    }
  })
  const events: string[] = []
  const settlements: Promise<void>[] = []
  const session = new CodexSidecarSession({
    runtime,
    state,
    repository: {
      closeLateResponseGuardsForConnection() {},
      markManualCompactionConnectionClosed() {},
    } as unknown as CodexBindingRepository,
    supervisor: {
      async start() {
        return { transport, lease: { connectionEpoch: 'epoch-rpc-timeout' } }
      },
      async hardReset() {
        events.push('settled')
      },
    } as unknown as CodexSidecarSupervisor,
    evidenceResolver: {
      async resolveTypedRejection() { return { resolution: 'unknown' as const } },
    },
    serverRequestExecutor: {
      async executeServerRequest() { throw new Error('unexpected_server_request') },
      confirmServerResponseTransportWrite() {},
    },
    requestTimeoutMs: 15,
    inboundDeadlineMs: 5_000,
    inboundMaxFrames: 8,
    inboundMaxBytes: 8_192,
    now: () => new Date(startedAt).toISOString(),
    nowMs: () => startedAt,
    onUnexpectedCloseDetected() {
      events.push('generation-cancelled')
    },
    onUnexpectedClose(settlement) {
      settlements.push(settlement)
    },
  })
  await session.startAndInitialize({
    registry: { markConnectionClosed() {} } as unknown as CodexStartIdentityRegistry,
    snapshot: {} as never,
  })

  const pendingRead = session.getClient().threadRead({
    threadId: 'thread-timeout',
    includeTurns: true,
  }).catch((error) => {
    events.push('read-rejected')
    throw error
  })

  await assert.rejects(pendingRead, /rpc_timeout/)
  await Promise.all(settlements)
  assert.ok(events.indexOf('generation-cancelled') >= 0)
  assert.ok(events.indexOf('generation-cancelled') < events.indexOf('read-rejected'))
})

test('sidecar stop retries tree-zero settlement after a transient proof failure', async () => {
  const child = fakeChild(43)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  child.process.stdin.on('data', (chunk) => {
    const frame = JSON.parse(String(chunk).trim()) as { id?: number; method?: string }
    if (frame.method === 'initialize') {
      child.process.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'ready-test/1' } })}\n`)
    }
  })
  let hardResetCount = 0
  const supervisor = {
    async start() {
      return { transport, lease: { connectionEpoch: 'epoch-stop-retry' } }
    },
    async hardReset() {
      hardResetCount += 1
      if (hardResetCount === 1) throw new Error('transient-proof-failure')
    },
  }
  const session = new CodexSidecarSession({
    runtime,
    state,
    repository: {
      closeLateResponseGuardsForConnection() {},
      markManualCompactionConnectionClosed() {},
    } as unknown as CodexBindingRepository,
    supervisor: supervisor as unknown as CodexSidecarSupervisor,
    evidenceResolver: {
      async resolveTypedRejection() { return { resolution: 'unknown' as const } },
    },
    serverRequestExecutor: {
      async executeServerRequest() { throw new Error('unexpected_server_request') },
      confirmServerResponseTransportWrite() {},
    },
    requestTimeoutMs: 5_000,
    inboundDeadlineMs: 5_000,
    inboundMaxFrames: 8,
    inboundMaxBytes: 8_192,
    now: () => new Date(startedAt).toISOString(),
    nowMs: () => startedAt,
  })
  await session.startAndInitialize({
    registry: { markConnectionClosed() {} } as unknown as CodexStartIdentityRegistry,
    snapshot: {} as never,
  })

  await assert.rejects(session.stop(), /transient-proof-failure/)
  await session.stop()
  assert.equal(hardResetCount, 2)
})

test('sidecar stop drains pending RPCs and durable close owners before hard reset', async () => {
  const child = fakeChild(45)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  child.process.stdin.on('data', (chunk) => {
    const frame = JSON.parse(String(chunk).trim()) as { id?: number; method?: string }
    if (frame.method === 'initialize') {
      child.process.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'ready-test/1' } })}\n`)
    }
  })
  let releaseArchive!: () => void
  const archiveBarrier = new Promise<void>((resolve) => { releaseArchive = resolve })
  const events: string[] = []
  const session = new CodexSidecarSession({
    runtime,
    state,
    repository: {
      closeLateResponseGuardsForConnection() { events.push('start-close') },
      markManualCompactionConnectionClosed() { events.push('manual-close') },
    } as unknown as CodexBindingRepository,
    supervisor: {
      async start() { return { transport, lease: { connectionEpoch: 'epoch-stop-drain' } } },
      async hardReset() { events.push('hard-reset') },
    } as unknown as CodexSidecarSupervisor,
    evidenceResolver: {
      async resolveTypedRejection() { return { resolution: 'unknown' as const } },
    },
    serverRequestExecutor: {
      async executeServerRequest() { throw new Error('unexpected_server_request') },
      confirmServerResponseTransportWrite() {},
    },
    threadArchiveDispatchPort: {
      async markConnectionClosed() {
        events.push('archive-enter')
        await archiveBarrier
        events.push('archive-exit')
      },
    } as never,
    requestTimeoutMs: 20,
    inboundDeadlineMs: 5_000,
    inboundMaxFrames: 8,
    inboundMaxBytes: 8_192,
    now: () => new Date(startedAt).toISOString(),
    nowMs: () => startedAt,
  })
  await session.startAndInitialize({
    registry: { markConnectionClosed() {} } as unknown as CodexStartIdentityRegistry,
    snapshot: {} as never,
  })
  const reading = session.getClient().threadRead({ threadId: 'thread-stop-drain', includeTurns: true })
  const rejected = assert.rejects(reading, /sidecar_session_stopped/)
  const stopping = session.stop()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['start-close', 'manual-close', 'archive-enter'])
  releaseArchive()
  await stopping
  await rejected
  assert.deepEqual(events, [
    'start-close', 'manual-close', 'archive-enter', 'archive-exit', 'hard-reset',
  ])
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(events.filter((event) => event === 'hard-reset').length, 1)
})

test('unexpected close recovery prerequisite includes client drain before hard reset', async () => {
  const child = fakeChild(46)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  child.process.stdin.on('data', (chunk) => {
    const frame = JSON.parse(String(chunk).trim()) as { id?: number; method?: string }
    if (frame.method === 'initialize') {
      child.process.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'ready-test/1' } })}\n`)
    }
  })
  let releaseArchive!: () => void
  const archiveBarrier = new Promise<void>((resolve) => { releaseArchive = resolve })
  const events: string[] = []
  const settlements: Promise<void>[] = []
  const session = new CodexSidecarSession({
    runtime,
    state,
    repository: {
      closeLateResponseGuardsForConnection() { events.push('start-close') },
      markManualCompactionConnectionClosed() { events.push('manual-close') },
    } as unknown as CodexBindingRepository,
    supervisor: {
      async start() { return { transport, lease: { connectionEpoch: 'epoch-close-order' } } },
      async hardReset() { events.push('hard-reset') },
    } as unknown as CodexSidecarSupervisor,
    evidenceResolver: {
      async resolveTypedRejection() { return { resolution: 'unknown' as const } },
    },
    serverRequestExecutor: {
      async executeServerRequest() { throw new Error('unexpected_server_request') },
      confirmServerResponseTransportWrite() {},
    },
    threadArchiveDispatchPort: {
      async markConnectionClosed() {
        events.push('archive-enter')
        await archiveBarrier
        events.push('archive-exit')
      },
    } as never,
    requestTimeoutMs: 5_000,
    inboundDeadlineMs: 5_000,
    inboundMaxFrames: 8,
    inboundMaxBytes: 8_192,
    now: () => new Date(startedAt).toISOString(),
    nowMs: () => startedAt,
    onUnexpectedClose(settlement) {
      events.push('recovery-called')
      settlements.push(settlement.then(() => { events.push('recovery-ready') }))
    },
  })
  await session.startAndInitialize({
    registry: { markConnectionClosed() {} } as unknown as CodexStartIdentityRegistry,
    snapshot: {} as never,
  })
  transport.close('protocol_failure')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [
    'recovery-called', 'start-close', 'manual-close', 'archive-enter',
  ])
  releaseArchive()
  await Promise.all(settlements)
  assert.deepEqual(events, [
    'recovery-called', 'start-close', 'manual-close', 'archive-enter',
    'archive-exit', 'hard-reset', 'recovery-ready',
  ])
})

test('stdout drain timeout enters durable close before recovery reset', async (t) => {
  const child = fakeChild(72)
  const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
  child.process.stdin.on('data', (chunk) => {
    const frame = JSON.parse(String(chunk).trim()) as { id?: number; method?: string }
    if (frame.method === 'initialize') {
      child.process.stdout.write(`${JSON.stringify({
        id: frame.id,
        result: { userAgent: 'ready-test/1' },
      })}\n`)
    }
  })
  const events: string[] = []
  const settlements: Promise<void>[] = []
  const session = new CodexSidecarSession({
    runtime,
    state,
    repository: {
      closeLateResponseGuardsForConnection() { events.push('start-close') },
      markManualCompactionConnectionClosed() { events.push('manual-close') },
    } as unknown as CodexBindingRepository,
    supervisor: {
      async start() { return { transport, lease: { connectionEpoch: 'epoch-drain-timeout' } } },
      async hardReset() { events.push('hard-reset') },
    } as unknown as CodexSidecarSupervisor,
    evidenceResolver: {
      async resolveTypedRejection() { return { resolution: 'unknown' as const } },
    },
    serverRequestExecutor: {
      async executeServerRequest() { throw new Error('unexpected_server_request') },
      confirmServerResponseTransportWrite() {},
    },
    threadArchiveDispatchPort: {
      async markConnectionClosed() { events.push('archive-close') },
    } as never,
    requestTimeoutMs: 5_000,
    inboundDeadlineMs: 5_000,
    inboundMaxFrames: 8,
    inboundMaxBytes: 8_192,
    now: () => new Date(startedAt).toISOString(),
    nowMs: () => startedAt,
    onUnexpectedClose(settlement) {
      events.push('recovery-called')
      settlements.push(settlement)
    },
  })
  await session.startAndInitialize({
    registry: {
      markConnectionClosed() { events.push('registry-close') },
    } as unknown as CodexStartIdentityRegistry,
    snapshot: {} as never,
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })

  child.process.stdout.write('{"partial":')
  child.process.emit('exit', 1, null)
  t.mock.timers.tick(CODEX_SIDECAR_STDOUT_DRAIN_TIMEOUT_MS)
  assert.equal(settlements.length, 1)
  await Promise.all(settlements)
  assert.equal(events.filter((event) => event === 'start-close').length, 1)
  assert.equal(events.filter((event) => event === 'registry-close').length, 1)
  assert.equal(events.filter((event) => event === 'manual-close').length, 1)
  assert.equal(events.filter((event) => event === 'archive-close').length, 1)
  assert.equal(events.filter((event) => event === 'hard-reset').length, 1)
  assert.equal(events.indexOf('hard-reset') > events.indexOf('archive-close'), true)

  child.process.stdout.write('"late"}\n')
  child.process.stdout.end()
  child.process.emit('close', 1, null)
  t.mock.timers.tick(CODEX_SIDECAR_STDOUT_DRAIN_TIMEOUT_MS)
  assert.equal(events.filter((event) => event === 'hard-reset').length, 1)
})

test('unexpected close audit failures block reset and retry the exact failed epoch despite older success', async () => {
  for (const failingOwner of ['start', 'manual', 'archive'] as const) {
    const child = fakeChild(60)
    const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
    child.process.stdin.on('data', (chunk) => {
      const frame = JSON.parse(String(chunk).trim()) as { id?: number; method?: string }
      if (frame.method === 'initialize') {
        child.process.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'ready-test/1' } })}\n`)
      }
    })
    let failAudit = true
    let hardResetCount = 0
    let bootCount = 0
    const closeEvents: string[] = []
    const settlements: Promise<void>[] = []
    const recoveries: Promise<boolean>[] = []
    let recoveryOwner!: CodexSidecarRecoveryOwner
    const session = new CodexSidecarSession({
      runtime,
      state,
      repository: {
        closeLateResponseGuardsForConnection() {
          closeEvents.push('start')
          if (failAudit && failingOwner === 'start') throw new Error('start_close_down')
        },
        markManualCompactionConnectionClosed() {
          closeEvents.push('manual')
          if (failAudit && failingOwner === 'manual') throw new Error('manual_close_down')
        },
      } as unknown as CodexBindingRepository,
      supervisor: {
        async start() { return { transport, lease: { connectionEpoch: `epoch-${failingOwner}` } } },
        async hardReset() { hardResetCount += 1 },
      } as unknown as CodexSidecarSupervisor,
      evidenceResolver: {
        async resolveTypedRejection() { return { resolution: 'unknown' as const } },
      },
      serverRequestExecutor: {
        async executeServerRequest() { throw new Error('unexpected_server_request') },
        confirmServerResponseTransportWrite() {},
      },
      threadArchiveDispatchPort: {
        async markConnectionClosed() {
          closeEvents.push('archive')
          if (failAudit && failingOwner === 'archive') throw new Error('archive_close_down')
        },
      } as never,
      requestTimeoutMs: 5_000,
      inboundDeadlineMs: 5_000,
      inboundMaxFrames: 8,
      inboundMaxBytes: 8_192,
      now: () => new Date(startedAt).toISOString(),
      nowMs: () => startedAt,
      onUnexpectedClose(settlement) {
        settlements.push(settlement)
        recoveries.push(recoveryOwner.recover({ trigger: 'unexpected_close', prerequisite: settlement }))
      },
    })
    recoveryOwner = new CodexSidecarRecoveryOwner({
      maxAttempts: 1,
      async bootOnce() { bootCount += 1; return true },
      async settleFailedAttempt() { await session.stop() },
      resetAttemptBudget() {},
      shouldRetryFailure() { return true },
    })
    const internal = session as unknown as {
      settleOnce(epoch: string, reason: 'app_quit'): Promise<void>
    }
    await internal.settleOnce(`older-${failingOwner}`, 'app_quit')
    assert.equal(hardResetCount, 1)
    await session.startAndInitialize({
      registry: { markConnectionClosed() {} } as unknown as CodexStartIdentityRegistry,
      snapshot: {} as never,
    })
    const reading = session.getClient().threadRead({
      threadId: `thread-${failingOwner}`,
      includeTurns: true,
    })
    transport.close('protocol_failure')
    assert.equal(settlements.length, 1)
    await assert.rejects(settlements[0], /connection_close_audit_failed/)
    await assert.rejects(recoveries[0], /sidecar_recovery_exhausted/)
    await assert.rejects(reading, /protocol_failure/)
    assert.deepEqual(closeEvents, ['start', 'manual', 'archive'])
    assert.equal(hardResetCount, 1)
    assert.equal(bootCount, 0)
    await assert.rejects(session.startAndInitialize({
      registry: { markConnectionClosed() {} } as unknown as CodexStartIdentityRegistry,
      snapshot: {} as never,
    }), /sidecar_session_already_active/)

    failAudit = false
    assert.equal(await recoveryOwner.ensureReadyForUserIngress(), true)
    assert.equal(hardResetCount, 2)
    assert.equal(bootCount, 1)
    assert.deepEqual(closeEvents, ['start', 'manual', 'archive', 'start', 'manual', 'archive'])
  }
})

test('explicit stop reports each close audit failure and retries before reset', async () => {
  for (const failingOwner of ['start', 'manual', 'archive'] as const) {
    const child = fakeChild(61)
    const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
    child.process.stdin.on('data', (chunk) => {
      const frame = JSON.parse(String(chunk).trim()) as { id?: number; method?: string }
      if (frame.method === 'initialize') {
        child.process.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'ready-test/1' } })}\n`)
      }
    })
    let failAudit = true
    let hardResetCount = 0
    const closeEvents: string[] = []
    const session = new CodexSidecarSession({
      runtime,
      state,
      repository: {
        closeLateResponseGuardsForConnection() {
          closeEvents.push('start')
          if (failAudit && failingOwner === 'start') throw new Error('start_close_down')
        },
        markManualCompactionConnectionClosed() {
          closeEvents.push('manual')
          if (failAudit && failingOwner === 'manual') throw new Error('manual_close_down')
        },
      } as unknown as CodexBindingRepository,
      supervisor: {
        async start() { return { transport, lease: { connectionEpoch: `stop-${failingOwner}` } } },
        async hardReset() { hardResetCount += 1 },
      } as unknown as CodexSidecarSupervisor,
      evidenceResolver: {
        async resolveTypedRejection() { return { resolution: 'unknown' as const } },
      },
      serverRequestExecutor: {
        async executeServerRequest() { throw new Error('unexpected_server_request') },
        confirmServerResponseTransportWrite() {},
      },
      threadArchiveDispatchPort: {
        async markConnectionClosed() {
          closeEvents.push('archive')
          if (failAudit && failingOwner === 'archive') throw new Error('archive_close_down')
        },
      } as never,
      requestTimeoutMs: 5_000,
      inboundDeadlineMs: 5_000,
      inboundMaxFrames: 8,
      inboundMaxBytes: 8_192,
      now: () => new Date(startedAt).toISOString(),
      nowMs: () => startedAt,
    })
    await session.startAndInitialize({
      registry: { markConnectionClosed() {} } as unknown as CodexStartIdentityRegistry,
      snapshot: {} as never,
    })
    await assert.rejects(session.stop(), /connection_close_audit_failed/)
    assert.deepEqual(closeEvents, ['start', 'manual', 'archive'])
    assert.equal(hardResetCount, 0)
    failAudit = false
    await session.stop()
    assert.equal(hardResetCount, 1)
    assert.deepEqual(closeEvents, ['start', 'manual', 'archive', 'start', 'manual', 'archive'])
  }
})

test('sidecar retry replays a failed ambiguous-owner quarantine and never resets while it remains unproven', async () => {
  for (const eventuallySucceeds of [true, false]) {
    const child = fakeChild(62)
    const transport = new CodexChildJsonLineTransport(child.process, () => undefined, () => undefined)
    child.process.stdin.on('data', (chunk) => {
      const frame = JSON.parse(String(chunk).trim()) as { id?: number; method?: string }
      if (frame.method === 'initialize') {
        child.process.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'ready-test/1' } })}\n`)
      }
    })
    let quarantineAttempts = 0
    let hardResetCount = 0
    let currentMs = startedAt
    const session = new CodexSidecarSession({
      runtime,
      state,
      repository: {
        closeLateResponseGuardsForConnection() {},
        markManualCompactionConnectionClosed() {},
        quarantineStartInbound() {
          quarantineAttempts += 1
          if (!eventuallySucceeds || quarantineAttempts <= 2) throw new Error('quarantine_down')
        },
      } as unknown as CodexBindingRepository,
      supervisor: {
        async start() { return { transport, lease: { connectionEpoch: 'epoch-quarantine' } } },
        async hardReset() { hardResetCount += 1 },
      } as unknown as CodexSidecarSupervisor,
      evidenceResolver: {
        async resolveTypedRejection() { return { resolution: 'unknown' as const } },
      },
      serverRequestExecutor: {
        async executeServerRequest() { throw new Error('unexpected_server_request') },
        confirmServerResponseTransportWrite() {},
      },
      requestTimeoutMs: 5_000,
      inboundDeadlineMs: 5_000,
      inboundMaxFrames: 8,
      inboundMaxBytes: 8_192,
      now: () => new Date(startedAt).toISOString(),
      nowMs: () => currentMs,
    })
    await session.startAndInitialize({
      registry: { markConnectionClosed() {} } as unknown as CodexStartIdentityRegistry,
      snapshot: {} as never,
    })
    session.getInboundBuffer().registerProvisionalTurn({
      bindingId: 'run-quarantine',
      connectionEpoch: 'epoch-quarantine',
      threadId: 'secret-thread',
      clientUserMessageId: 'secret-message',
      deadlineAtMs: startedAt + 5_000,
    })
    currentMs = startedAt + 5_001
    assert.throws(() => session.getInboundBuffer().expireDue(), /quarantine_down/)
    await assert.rejects(session.stop(), /connection_close_audit_failed/)
    assert.equal(quarantineAttempts, 2)
    assert.equal(hardResetCount, 0)

    if (eventuallySucceeds) {
      await session.stop()
      assert.equal(quarantineAttempts, 3)
      assert.equal(hardResetCount, 1)
    } else {
      await assert.rejects(session.stop(), /connection_close_audit_failed/)
      assert.equal(quarantineAttempts, 3)
      assert.equal(hardResetCount, 0)
    }
  }
})

test('sidecar settlement memory is bounded while recent epochs remain exact-once', async () => {
  let hardResetCount = 0
  const session = new CodexSidecarSession({
    runtime,
    state,
    repository: {} as CodexBindingRepository,
    supervisor: {
      async hardReset() { hardResetCount += 1 },
    } as CodexSidecarSupervisor,
    evidenceResolver: {} as never,
    serverRequestExecutor: {} as never,
    requestTimeoutMs: 5_000,
    inboundDeadlineMs: 5_000,
    inboundMaxFrames: 8,
    inboundMaxBytes: 8_192,
    now: () => new Date(startedAt).toISOString(),
    nowMs: () => startedAt,
  })
  const internal = session as unknown as {
    settleOnce(epoch: string, reason: 'protocol_failure'): Promise<void>
    settlements: Map<string, Promise<void>>
    recentSettlements: Set<string>
  }
  for (let index = 0; index < 10_000; index += 1) {
    await internal.settleOnce(`epoch-${index}`, 'protocol_failure')
  }
  assert.equal(internal.settlements.size, 0)
  assert.equal(internal.recentSettlements.size, 2_048)
  assert.equal(hardResetCount, 10_000)
  await internal.settleOnce('epoch-9999', 'protocol_failure')
  assert.equal(hardResetCount, 10_000)
})

function exactEnvironment(identities: {
  processLeaseId: string
  sidecarSpawnInstanceId: string
  connectionEpoch: string
}): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: state.tmpDir,
    HOME: state.homeDir,
    CODEX_HOME: state.codexHome,
    READY_CODEX_GATEWAY_URL: state.gatewayUrl,
    READY_CODEX_GATEWAY_TOKEN: 'short-lived-token',
    READY_CODEX_PROCESS_LEASE_ID: identities.processLeaseId,
    READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID: identities.sidecarSpawnInstanceId,
    READY_CODEX_CONNECTION_EPOCH: identities.connectionEpoch,
    READY_CODEX_STATE_DIR: state.stateDir,
  }
}

function owned(row: CodexProcessLeaseRow, overrides: Partial<CodexOwnedProcess> = {}): CodexOwnedProcess {
  return {
    pid: row.pid || 41,
    parentPid: row.ownerMainPid,
    processGroupId: row.processGroupId || 41,
    processStartIdentity: row.processStartIdentity || 'child-start-41',
    executablePath: row.executablePath,
    executableSha256: row.binarySha256,
    markers: {
      processLeaseId: row.processLeaseId,
      sidecarSpawnInstanceId: row.sidecarSpawnInstanceId,
      connectionEpoch: row.connectionEpoch,
      stateDir: row.isolatedStateDir,
    },
    ...overrides,
  }
}

function seededLease(overrides: Partial<CodexProcessLeaseRow> = {}): CodexProcessLeaseRow {
  return {
    processLeaseId: 'lease-old',
    singletonSlot: 1,
    ownerMainBootId: 'main-boot-1',
    ownerMainPid: 100,
    ownerMainProcessStartIdentity: 'main-start-100',
    sidecarSpawnInstanceId: 'spawn-old',
    connectionEpoch: 'epoch-old',
    runtimeManifestDigest: runtime.manifestDigest,
    binarySha256: runtime.binarySha256,
    executablePath: runtime.binaryPath,
    isolatedStateDir: state.stateDir,
    spawnIntentAt: new Date(startedAt - 6_000).toISOString(),
    spawnVisibilityDeadlineAt: new Date(startedAt - 1_000).toISOString(),
    pid: null,
    processGroupId: null,
    processStartIdentity: null,
    ownershipConfirmedAt: null,
    ownerMainDeadAt: null,
    ownerMainDeathEvidenceDigest: null,
    connectionOpenedAt: null,
    closedAt: null,
    treeZeroAt: null,
    treeZeroMatcherMode: null,
    stableZeroSampleTranscriptDigest: null,
    treeZeroEvidenceDigest: null,
    revision: 1,
    ...overrides,
  }
}

function harness(input: {
  store?: FakeLeaseStore
  inspector?: CodexProcessInspector
  spawnPort?: CodexSidecarSpawnPort
  ownerMainBootId?: string
  ownerMainPid?: number
  ownerMainProcessStartIdentity?: string
  childEnvironment?: typeof exactEnvironment
  spawnCapability?: {
    activate: typeof exactEnvironment
    revoke: (sidecarSpawnInstanceId: string) => void
  }
} = {}) {
  let now = startedAt
  const waits: number[] = []
  const kills: Array<{ processGroupId: number; signal: NodeJS.Signals }> = []
  const store = input.store || new FakeLeaseStore()
  const supervisor = new CodexSidecarSupervisor({
    runtime,
    state,
    spawnCapability: input.spawnCapability || {
      activate: input.childEnvironment || exactEnvironment,
      revoke() {},
    },
    leaseStore: store,
    inspector: input.inspector || new ScriptedInspector([() => []]),
    spawnPort: input.spawnPort || { spawn: () => fakeChild(41) },
    ownerMainBootId: input.ownerMainBootId || 'main-boot-1',
    ownerMainPid: input.ownerMainPid || 100,
    ownerMainProcessStartIdentity: input.ownerMainProcessStartIdentity || 'main-start-100',
    nowMs: () => now,
    wait: async (ms) => {
      waits.push(ms)
      now += ms
    },
    killProcessGroup: (processGroupId, signal) => kills.push({ processGroupId, signal }),
  })
  return { supervisor, store, waits, kills, now: () => now }
}

test('spawn intent precedes child creation and ownership CAS precedes protocol use', async () => {
  const events: string[] = []
  const store = new FakeLeaseStore(events)
  let captured: Parameters<CodexSidecarSpawnPort['spawn']>[0] | null = null
  const spawnPort: CodexSidecarSpawnPort = {
    spawn(input) {
      events.push('spawn')
      captured = input
      return fakeChild(41)
    },
  }
  const inspector: CodexProcessInspector = {
    async list() {
      const row = store.readLiveProcessLease()
      return row ? [owned(row)] : []
    },
  }
  const { supervisor } = harness({
    store,
    inspector,
    spawnPort,
    spawnCapability: {
      activate(identities) {
        events.push('capability_activate')
        return exactEnvironment(identities)
      },
      revoke() { events.push('capability_revoke') },
    },
  })
  const result = await supervisor.start()

  assert.deepEqual(events.slice(0, 5), [
    'lease_intent',
    'capability_activate',
    'spawn',
    'ownership_cas',
    'connection_opened',
  ])
  assert.ok(captured)
  assert.deepEqual(captured.argv, ['app-server'])
  assert.equal(captured.executablePath, runtime.binaryPath)
  assert.equal(captured.cwd, state.stateDir)
  assert.deepEqual(Object.keys(captured.env), runtime.contracts.childEnvAllowlist.allowedKeys)
  assert.equal(captured.env.READY_CODEX_PROCESS_LEASE_ID, result.lease.processLeaseId)
  assert.equal(captured.env.READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID, result.lease.sidecarSpawnInstanceId)
  assert.equal(captured.env.READY_CODEX_CONNECTION_EPOCH, result.lease.connectionEpoch)
  assert.equal(new Set([
    result.lease.processLeaseId,
    result.lease.sidecarSpawnInstanceId,
    result.lease.connectionEpoch,
  ]).size, 3)
})

test('first zero followed by a visible exact child is CAS-bound and settled post-CAS', async () => {
  const store = new FakeLeaseStore()
  store.seed(seededLease())
  const inspector = new ScriptedInspector([
    () => [],
    () => [],
    () => [owned(store.readLiveProcessLease() as CodexProcessLeaseRow)],
    () => [owned(store.readLiveProcessLease() as CodexProcessLeaseRow)],
    () => [],
    () => [],
    () => [],
    () => [],
  ])
  const { supervisor, kills } = harness({ store, inspector })

  assert.equal(await supervisor.settleBootLease(), 'settled')
  const row = store.rows[0]
  assert.equal(row.treeZeroMatcherMode, 'post_cas')
  assert.equal(row.pid, 41)
  assert.ok(row.stableZeroSampleTranscriptDigest)
  assert.deepEqual(kills, [{ processGroupId: 41, signal: 'SIGTERM' }])
  assert.equal(store.events.includes('tree_zero:pre_cas'), false)
})

test('multiple or partial pre-CAS candidates block without tree kill or false zero', async () => {
  for (const fixture of ['multiple', 'partial'] as const) {
    const store = new FakeLeaseStore()
    store.seed(seededLease())
    const row = store.readLiveProcessLease() as CodexProcessLeaseRow
    const candidates = fixture === 'multiple'
      ? [owned(row), owned(row, { pid: 42, processGroupId: 42, processStartIdentity: 'child-start-42' })]
      : [owned(row, { executableSha256: 'b'.repeat(64) })]
    const { supervisor, kills } = harness({
      store,
      inspector: new ScriptedInspector([() => candidates]),
    })
    await assert.rejects(
      supervisor.settleBootLease(),
      new RegExp(fixture === 'multiple'
        ? 'pre_cas_multiple_candidates'
        : 'pre_cas_exec_transient_unsettled'),
    )
    assert.deepEqual(kills, [])
    assert.equal(store.rows[0].treeZeroAt, null)
  }
})

test('new Main persists old-Main death evidence before settling its lease', async () => {
  const store = new FakeLeaseStore()
  store.seed(seededLease({
    ownerMainBootId: 'old-main-boot',
    ownerMainPid: 77,
    ownerMainProcessStartIdentity: 'old-main-start-77',
  }))
  const aliveOldMain = owned(store.rows[0], {
    pid: 77,
    processGroupId: 77,
    processStartIdentity: 'old-main-start-77',
    executablePath: '/Applications/Ready.app/Contents/MacOS/Ready',
    executableSha256: null,
    markers: {
      processLeaseId: null,
      sidecarSpawnInstanceId: null,
      connectionEpoch: null,
      stateDir: null,
    },
  })
  const blocked = harness({
    store,
    inspector: new ScriptedInspector([() => [aliveOldMain]]),
    ownerMainBootId: 'new-main-boot',
    ownerMainPid: 100,
    ownerMainProcessStartIdentity: 'new-main-start-100',
  })
  await assert.rejects(blocked.supervisor.settleBootLease(), /old_main_owner_still_alive/)
  assert.equal(store.rows[0].ownerMainDeadAt, null)

  const takeover = harness({
    store,
    inspector: new ScriptedInspector([() => []]),
    ownerMainBootId: 'new-main-boot',
    ownerMainPid: 100,
    ownerMainProcessStartIdentity: 'new-main-start-100',
  })
  assert.equal(await takeover.supervisor.settleBootLease(), 'settled')
  assert.deepEqual(store.events.slice(-2), ['old_main_death', 'tree_zero:pre_cas'])
  assert.ok(store.rows[0].ownerMainDeathEvidenceDigest)
})

test('new Main settles a cleanly stopped old owner only after proving that Main exited', async () => {
  const settled = seededLease({
    ownerMainBootId: 'old-main-boot', ownerMainPid: 77,
    ownerMainProcessStartIdentity: 'old-main-start-77',
    closedAt: '2026-08-07T02:00:01.000Z', treeZeroAt: '2026-08-07T02:00:02.000Z',
    treeZeroMatcherMode: 'post_cas', stableZeroSampleTranscriptDigest: 'stable-zero',
    treeZeroEvidenceDigest: 'tree-zero', revision: 4,
  })
  const store = new FakeLeaseStore()
  store.seed(settled)
  const aliveOldMain = owned(settled, {
    pid: 77, processGroupId: 77, processStartIdentity: 'old-main-start-77',
    executablePath: '/Applications/Ready.app/Contents/MacOS/Ready', executableSha256: null,
    markers: { processLeaseId: null, sidecarSpawnInstanceId: null, connectionEpoch: null, stateDir: null },
  })
  const blocked = harness({
    store, inspector: new ScriptedInspector([() => [aliveOldMain]]),
    ownerMainBootId: 'new-main-boot', ownerMainPid: 100,
    ownerMainProcessStartIdentity: 'new-main-start-100',
  })
  await assert.rejects(
    blocked.supervisor.settleFenceOwnerLease('old-main-boot'),
    /old_main_owner_still_alive/,
  )
  assert.equal(store.rows[0].ownerMainDeadAt, null)

  const takeover = harness({
    store, inspector: new ScriptedInspector([() => []]),
    ownerMainBootId: 'new-main-boot', ownerMainPid: 100,
    ownerMainProcessStartIdentity: 'new-main-start-100',
  })
  assert.equal(await takeover.supervisor.settleFenceOwnerLease('old-main-boot'), 'settled')
  assert.ok(store.rows[0].ownerMainDeadAt)
  assert.ok(store.rows[0].ownerMainDeathEvidenceDigest)
})

test('post-CAS identity conflict blocks without killing a reused pid or group', async () => {
  const store = new FakeLeaseStore()
  store.seed(seededLease({
    pid: 41,
    processGroupId: 41,
    processStartIdentity: 'bound-child-start-41',
    ownershipConfirmedAt: new Date(startedAt - 500).toISOString(),
    revision: 2,
  }))
  const conflicting = owned(store.rows[0], { processStartIdentity: 'reused-child-start-41' })
  const { supervisor, kills } = harness({
    store,
    inspector: new ScriptedInspector([() => [conflicting]]),
  })
  await assert.rejects(supervisor.settleBootLease(), /post_cas_owner_mismatch/)
  assert.deepEqual(kills, [])
  assert.equal(store.rows[0].treeZeroAt, null)
})

test('same Main can respawn only after exact tree-zero with fresh spawn and connection identities', async () => {
  const store = new FakeLeaseStore()
  let visible: CodexOwnedProcess[] = []
  let nextPid = 41
  const spawnPort: CodexSidecarSpawnPort = {
    spawn() {
      const row = store.readLiveProcessLease() as CodexProcessLeaseRow
      const pid = nextPid
      nextPid += 1
      visible = [owned(row, {
        pid,
        processGroupId: pid,
        processStartIdentity: `child-start-${pid}`,
      })]
      return fakeChild(pid)
    },
  }
  const inspector: CodexProcessInspector = { async list() { return structuredClone(visible) } }
  const kills: Array<{ processGroupId: number; signal: NodeJS.Signals }> = []
  let now = startedAt
  const supervisor = new CodexSidecarSupervisor({
    runtime,
    state,
    spawnCapability: { activate: exactEnvironment, revoke() {} },
    leaseStore: store,
    inspector,
    spawnPort,
    ownerMainBootId: 'main-boot-1',
    ownerMainPid: 100,
    ownerMainProcessStartIdentity: 'main-start-100',
    nowMs: () => now,
    wait: async (ms) => { now += ms },
    killProcessGroup: (processGroupId, signal) => {
      kills.push({ processGroupId, signal })
      visible = []
    },
  })

  await supervisor.start()
  await supervisor.hardReset('test_cleanup')
  await supervisor.start()

  assert.equal(store.rows.length, 2)
  assert.ok(store.rows[0].treeZeroAt)
  assert.equal(store.rows[0].ownerMainBootId, store.rows[1].ownerMainBootId)
  assert.notEqual(store.rows[0].processLeaseId, store.rows[1].processLeaseId)
  assert.notEqual(store.rows[0].sidecarSpawnInstanceId, store.rows[1].sidecarSpawnInstanceId)
  assert.notEqual(store.rows[0].connectionEpoch, store.rows[1].connectionEpoch)
  assert.deepEqual(kills, [{ processGroupId: 41, signal: 'SIGTERM' }])
})

test('spawn failure revokes its capability and the next spawn receives a fresh one', async () => {
  const events: string[] = []
  const store = new FakeLeaseStore(events)
  const activated: Array<{ spawnId: string; token: string }> = []
  const revoked: string[] = []
  let spawnAttempt = 0
  let visible: CodexOwnedProcess[] = []
  let secondChild: CodexSidecarChild | null = null
  const spawnPort: CodexSidecarSpawnPort = {
    spawn() {
      spawnAttempt += 1
      events.push(`spawn:${spawnAttempt}`)
      if (spawnAttempt === 1) throw new Error('fixture_spawn_failure')
      const row = store.readLiveProcessLease() as CodexProcessLeaseRow
      visible = [owned(row, {
        pid: 42,
        processGroupId: 42,
        processStartIdentity: 'child-start-42',
      })]
      secondChild = fakeChild(42)
      return secondChild
    },
  }
  const { supervisor } = harness({
    store,
    spawnPort,
    inspector: { async list() { return structuredClone(visible) } },
    spawnCapability: {
      activate(identities) {
        const token = `token-${identities.sidecarSpawnInstanceId}`
        activated.push({ spawnId: identities.sidecarSpawnInstanceId, token })
        events.push(`activate:${identities.sidecarSpawnInstanceId}`)
        return { ...exactEnvironment(identities), READY_CODEX_GATEWAY_TOKEN: token }
      },
      revoke(spawnId) {
        revoked.push(spawnId)
        events.push(`revoke:${spawnId}`)
      },
    },
  })

  await assert.rejects(supervisor.start(), /sidecar_spawn_failed/)
  assert.equal(activated.length, 1)
  assert.deepEqual(revoked, [activated[0].spawnId])
  assert.ok(events.indexOf('lease_intent') < events.indexOf(`activate:${activated[0].spawnId}`))
  assert.ok(events.indexOf(`activate:${activated[0].spawnId}`) < events.indexOf('spawn:1'))
  assert.ok(events.indexOf('spawn:1') < events.indexOf(`revoke:${activated[0].spawnId}`))

  const restarted = await supervisor.start()
  assert.equal(activated.length, 2)
  assert.notEqual(activated[0].spawnId, activated[1].spawnId)
  assert.notEqual(activated[0].token, activated[1].token)
  assert.equal(restarted.lease.sidecarSpawnInstanceId, activated[1].spawnId)
  assert.ok(secondChild)
  secondChild.process.emit('exit', 1, null)
  assert.equal(revoked.at(-1), activated[1].spawnId)
})

test('a child that exits during ownership confirmation revokes its capability and cannot become active', async () => {
  const store = new FakeLeaseStore()
  const revoked: string[] = []
  const spawnPort: CodexSidecarSpawnPort = {
    spawn() {
      const child = fakeChild(43)
      queueMicrotask(() => child.process.emit('exit', 1, null))
      return child
    },
  }
  let inspectionCount = 0
  const inspector: CodexProcessInspector = {
    async list() {
      inspectionCount += 1
      if (inspectionCount > 1) return []
      const row = store.readLiveProcessLease() as CodexProcessLeaseRow
      return [owned(row, {
        pid: 43,
        processGroupId: 43,
        processStartIdentity: 'child-start-43',
      })]
    },
  }
  const { supervisor } = harness({
    store,
    spawnPort,
    inspector,
    spawnCapability: {
      activate: exactEnvironment,
      revoke(spawnId) { revoked.push(spawnId) },
    },
  })

  await assert.rejects(supervisor.start(), /sidecar_exited_during_start/)
  assert.ok(revoked.length >= 1)
  assert.deepEqual([...new Set(revoked)], [store.rows[0].sidecarSpawnInstanceId])
  assert.ok(store.rows[0].treeZeroAt)
})

test('a child error during ownership confirmation is contained, revoked and never becomes active', async () => {
  const store = new FakeLeaseStore()
  const revoked: string[] = []
  const spawnPort: CodexSidecarSpawnPort = {
    spawn() {
      const child = fakeChild(44)
      queueMicrotask(() => child.process.emit('error', new Error('fixture_early_child_error')))
      return child
    },
  }
  let inspectionCount = 0
  const inspector: CodexProcessInspector = {
    async list() {
      inspectionCount += 1
      if (inspectionCount > 1) return []
      const row = store.readLiveProcessLease() as CodexProcessLeaseRow
      return [owned(row, {
        pid: 44,
        processGroupId: 44,
        processStartIdentity: 'child-start-44',
      })]
    },
  }
  const { supervisor } = harness({
    store,
    spawnPort,
    inspector,
    spawnCapability: {
      activate: exactEnvironment,
      revoke(spawnId) { revoked.push(spawnId) },
    },
  })

  await assert.rejects(supervisor.start(), /sidecar_errored_during_start/)
  assert.ok(revoked.length >= 1)
  assert.deepEqual([...new Set(revoked)], [store.rows[0].sidecarSpawnInstanceId])
  assert.ok(store.rows[0].treeZeroAt)
})

test('child environment drift is rejected before spawn and repeated crashes back off then stop', async () => {
  const envStore = new FakeLeaseStore()
  let unsafeSpawnCount = 0
  const unsafe = harness({
    store: envStore,
    childEnvironment: (identities) => ({
      ...exactEnvironment(identities),
      READY_E2_HOST_SECRET_CANARY: 'must-not-cross',
    }),
    spawnPort: { spawn: () => { unsafeSpawnCount += 1; return fakeChild(41) } },
  })
  await assert.rejects(unsafe.supervisor.start(), /child_environment_allowlist_mismatch/)
  assert.equal(unsafeSpawnCount, 0)

  const crashStore = new FakeLeaseStore()
  const spawnTimes: number[] = []
  const crashing = harness({
    store: crashStore,
    spawnPort: {
      spawn() {
        spawnTimes.push(crashing.now())
        throw new CodexSidecarSupervisorError('fixture_spawn_failure')
      },
    },
  })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(crashing.supervisor.start(), /sidecar_spawn_failed/)
  }
  await assert.rejects(crashing.supervisor.start(), /sidecar_crash_loop_exhausted/)
  assert.equal(spawnTimes.length, 3)
  assert.ok(spawnTimes[1] - spawnTimes[0] >= 5_850)
  assert.ok(spawnTimes[2] - spawnTimes[1] >= 6_000)

  crashing.supervisor.resetCrashBudgetForExplicitRetry()
  await assert.rejects(crashing.supervisor.start(), /sidecar_spawn_failed/)
  assert.equal(spawnTimes.length, 4)
})
