import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  CodexSidecarSupervisor,
  CodexSidecarSupervisorError,
  MacCodexProcessInspector,
  type CodexOwnedProcess,
  type CodexProcessInspector,
  type CodexProcessLeaseStore,
  type CodexSidecarChild,
  type CodexSidecarSpawnPort,
} from '../main/modules/agent-control/codex-runtime/codex-sidecar-supervisor'
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
  },
} as unknown as VerifiedCodexRuntime

const state = {
  stateDir: '/tmp/ready-codex/state',
  homeDir: '/tmp/ready-codex/home',
  codexHome: '/tmp/ready-codex/codex-home',
  threadCwdRoot: '/tmp/ready-codex/threads',
  tmpDir: '/tmp/ready-codex/tmp',
  configPath: '/tmp/ready-codex/codex-home/config.toml',
  configDigest: 'config-digest',
  gatewayUrl: 'http://127.0.0.1:4317',
  gatewayTokenDigest: 'gateway-token-digest',
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
} = {}) {
  let now = startedAt
  const waits: number[] = []
  const kills: Array<{ processGroupId: number; signal: NodeJS.Signals }> = []
  const store = input.store || new FakeLeaseStore()
  const supervisor = new CodexSidecarSupervisor({
    runtime,
    state,
    childEnvironment: input.childEnvironment || exactEnvironment,
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
  const { supervisor } = harness({ store, inspector, spawnPort })
  const result = await supervisor.start()

  assert.deepEqual(events.slice(0, 4), [
    'lease_intent',
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
    childEnvironment: exactEnvironment,
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
})
