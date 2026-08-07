import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import type { CodexJsonLineTransport } from './codex-app-server-client'
import type {
  CodexProcessLeaseIdentity,
  CodexProcessLeaseRow,
} from './codex-binding-repository'
import type {
  PreparedCodexRuntimeState,
  VerifiedCodexRuntime,
} from './codex-runtime-host'

const STABLE_ZERO_SAMPLE_COUNT = 4
const STABLE_ZERO_SAMPLE_INTERVAL_MS = 250
const STABLE_ZERO_MAX_OBSERVATIONS = 40
const SPAWN_VISIBILITY_DEADLINE_MS = 5_000
const CRASH_BACKOFF_MS = [100, 250, 500] as const

type MatcherMode = 'pre_cas' | 'post_cas'
type HardResetReason = 'app_quit' | 'protocol_failure' | 'sidecar_crash' | 'test_cleanup'

export type CodexOwnedProcess = {
  pid: number
  parentPid: number
  processGroupId: number
  processStartIdentity: string
  executablePath: string
  executableSha256: string | null
  markers: {
    processLeaseId: string | null
    sidecarSpawnInstanceId: string | null
    connectionEpoch: string | null
    stateDir: string | null
  }
}

export interface CodexProcessInspector {
  list(): Promise<CodexOwnedProcess[]>
}

export interface CodexProcessLeaseStore {
  createProcessLeaseIntent(input: CodexProcessLeaseIdentity & {
    spawnIntentAt: string
    spawnVisibilityDeadlineAt: string
  }): CodexProcessLeaseRow
  confirmProcessLeaseOwnership(input: {
    processLeaseId: string
    expectedRevision: number
    pid: number
    processGroupId: number
    processStartIdentity: string
    confirmedAt: string
  }): CodexProcessLeaseRow
  markProcessConnectionOpened(input: {
    processLeaseId: string
    expectedRevision: number
    openedAt: string
  }): CodexProcessLeaseRow
  markProcessConnectionClosed(input: {
    processLeaseId: string
    expectedRevision: number
    closedAt: string
  }): CodexProcessLeaseRow
  recordOldMainDeath(input: {
    processLeaseId: string
    expectedRevision: number
    deadAt: string
    evidenceDigest: string
  }): CodexProcessLeaseRow
  recordProcessTreeZero(input: {
    processLeaseId: string
    expectedRevision: number
    treeZeroAt: string
    matcherMode: MatcherMode
    sampleTranscriptDigest: string
    evidenceDigest: string
  }): CodexProcessLeaseRow
  readLiveProcessLease(): CodexProcessLeaseRow | null
}

export interface CodexSidecarChild {
  pid: number
  process: ChildProcessWithoutNullStreams
}

export interface CodexSidecarSpawnPort {
  spawn(input: {
    executablePath: string
    argv: string[]
    cwd: string
    env: Record<string, string>
  }): CodexSidecarChild
}

export class CodexSidecarSupervisorError extends Error {
  constructor(readonly code: string, readonly details?: unknown) {
    super(code)
    this.name = 'CodexSidecarSupervisorError'
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function markerValue(command: string, key: string): string | null {
  const prefix = `${key}=`
  const start = command.indexOf(prefix)
  if (start < 0) return null
  const rest = command.slice(start + prefix.length)
  const boundary = /\s[A-Z_][A-Z0-9_]*=/.exec(rest)
  return (boundary ? rest.slice(0, boundary.index) : rest).trim() || null
}

function parsePsLine(line: string): Omit<CodexOwnedProcess, 'executableSha256'> | null {
  const match = line.match(
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/,
  )
  if (!match) return null
  const pid = Number(match[1])
  const parentPid = Number(match[2])
  const processGroupId = Number(match[3])
  const startIdentity = `${pid}:${match.slice(4, 9).join(' ')}`
  const command = match[9]
  const executableToken = command.match(/^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/)
  const executablePath = executableToken?.[1] || executableToken?.[2] || executableToken?.[3] || ''
  if (![pid, parentPid, processGroupId].every(Number.isSafeInteger)) return null
  if (!executablePath.startsWith('/')) return null
  return {
    pid,
    parentPid,
    processGroupId,
    processStartIdentity: startIdentity,
    executablePath,
    markers: {
      processLeaseId: markerValue(command, 'READY_CODEX_PROCESS_LEASE_ID'),
      sidecarSpawnInstanceId: markerValue(command, 'READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID'),
      connectionEpoch: markerValue(command, 'READY_CODEX_CONNECTION_EPOCH'),
      stateDir: markerValue(command, 'READY_CODEX_STATE_DIR'),
    },
  }
}

export class MacCodexProcessInspector implements CodexProcessInspector {
  async list(): Promise<CodexOwnedProcess[]> {
    let output: string
    try {
      output = execFileSync('/bin/ps', [
        'axeww',
        '-o',
        'pid=,ppid=,pgid=,lstart=,command=',
      ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    } catch {
      throw new CodexSidecarSupervisorError('process_enumeration_failed')
    }
    return output.split('\n').flatMap((line) => {
      const parsed = parsePsLine(line)
      if (!parsed) return []
      let executableSha256: string | null = null
      if (parsed.markers.processLeaseId && parsed.executablePath.startsWith('/')) {
        try {
          executableSha256 = sha256(readFileSync(parsed.executablePath))
        } catch {
          executableSha256 = null
        }
      }
      return [{ ...parsed, executableSha256 }]
    })
  }
}

export class NodeCodexSidecarSpawnPort implements CodexSidecarSpawnPort {
  spawnChild(input: Parameters<CodexSidecarSpawnPort['spawn']>[0]): CodexSidecarChild {
    return this.spawn(input)
  }

  spawn(input: Parameters<CodexSidecarSpawnPort['spawn']>[0]): CodexSidecarChild {
    const child = spawn(input.executablePath, input.argv, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    if (!child.pid || !child.stdin || !child.stdout || !child.stderr) {
      throw new CodexSidecarSupervisorError('sidecar_spawn_failed')
    }
    return { pid: child.pid, process: child as ChildProcessWithoutNullStreams }
  }
}

export class CodexChildJsonLineTransport implements CodexJsonLineTransport {
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<(error: Error | null) => void>()
  private closed = false

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onProtocolClose: (reason: string) => void,
    onStderr: (text: string) => void,
  ) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      for (const listener of this.lineListeners) listener(line)
    })
    child.stderr.on('data', (chunk) => onStderr(String(chunk)))
    child.once('exit', (code, signal) => {
      this.closed = true
      const expected = signal === 'SIGTERM' || signal === 'SIGKILL' || code === 0
      const error = expected
        ? null
        : new CodexSidecarSupervisorError('sidecar_unexpected_exit')
      for (const listener of this.closeListeners) listener(error)
    })
    child.once('error', () => {
      this.closed = true
      for (const listener of this.closeListeners) {
        listener(new CodexSidecarSupervisorError('sidecar_process_error'))
      }
    })
  }

  write(line: string, callback: (error: Error | null) => void): void {
    if (this.closed || !this.child.stdin.writable) {
      callback(new CodexSidecarSupervisorError('sidecar_stdin_closed'))
      return
    }
    this.child.stdin.write(line, (error) => callback(error || null))
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener)
    return () => this.lineListeners.delete(listener)
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(reason: string, details?: unknown): void {
    if (this.closed) return
    this.closed = true
    this.child.stdin.destroy()
    const error = new CodexSidecarSupervisorError(reason || 'protocol_failure', details)
    for (const listener of this.closeListeners) listener(error)
    this.onProtocolClose(reason)
  }
}

export class CodexSidecarSupervisor {
  private active: {
    lease: CodexProcessLeaseRow
    child: CodexSidecarChild
  } | null = null
  private crashCount = 0

  constructor(private readonly deps: {
    runtime: VerifiedCodexRuntime
    state: PreparedCodexRuntimeState
    childEnvironment: (identities: {
      processLeaseId: string
      sidecarSpawnInstanceId: string
      connectionEpoch: string
    }) => Record<string, string>
    leaseStore: CodexProcessLeaseStore
    inspector: CodexProcessInspector
    spawnPort: CodexSidecarSpawnPort
    ownerMainBootId: string
    ownerMainPid: number
    ownerMainProcessStartIdentity: string
    nowMs?: () => number
    wait?: (ms: number) => Promise<void>
    killProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => void
    onStderr?: (text: string) => void
  }) {
    const identities = [deps.ownerMainBootId, deps.ownerMainProcessStartIdentity]
    if (!identities.every((value) => value.trim()) || !Number.isSafeInteger(deps.ownerMainPid)) {
      throw new CodexSidecarSupervisorError('main_owner_identity_invalid')
    }
  }

  async start(): Promise<{
    transport: CodexChildJsonLineTransport
    lease: CodexProcessLeaseRow
  }> {
    if (this.active || this.deps.leaseStore.readLiveProcessLease()) {
      throw new CodexSidecarSupervisorError('active_process_lease_exists')
    }
    if (this.crashCount >= 3) throw new CodexSidecarSupervisorError('sidecar_crash_loop_exhausted')
    if (this.crashCount > 0) {
      await this.wait(CRASH_BACKOFF_MS[Math.min(this.crashCount - 1, CRASH_BACKOFF_MS.length - 1)])
    }
    const now = this.nowMs()
    const identities = this.allocateIdentities()
    const environment = this.buildValidatedChildEnvironment(identities)
    let lease = this.deps.leaseStore.createProcessLeaseIntent({
      processLeaseId: identities.processLeaseId,
      ownerMainBootId: this.deps.ownerMainBootId,
      ownerMainPid: this.deps.ownerMainPid,
      ownerMainProcessStartIdentity: this.deps.ownerMainProcessStartIdentity,
      sidecarSpawnInstanceId: identities.sidecarSpawnInstanceId,
      connectionEpoch: identities.connectionEpoch,
      runtimeManifestDigest: this.deps.runtime.manifestDigest,
      binarySha256: this.deps.runtime.binarySha256,
      executablePath: this.deps.runtime.binaryPath,
      isolatedStateDir: this.deps.state.stateDir,
      spawnIntentAt: iso(now),
      spawnVisibilityDeadlineAt: iso(now + SPAWN_VISIBILITY_DEADLINE_MS),
    })
    let child: CodexSidecarChild
    try {
      child = this.deps.spawnPort.spawn({
        executablePath: this.deps.runtime.binaryPath,
        argv: [...this.deps.runtime.contracts.nativeIsolationConfigContract.launchArgv],
        cwd: this.deps.state.stateDir,
        env: environment,
      })
    } catch {
      await this.settlePreCasZero(lease)
      this.crashCount += 1
      throw new CodexSidecarSupervisorError('sidecar_spawn_failed')
    }

    try {
      const owned = await this.waitForSpawnOwnership(lease, child.pid)
      lease = this.deps.leaseStore.confirmProcessLeaseOwnership({
        processLeaseId: lease.processLeaseId,
        expectedRevision: lease.revision,
        pid: owned.pid,
        processGroupId: owned.processGroupId,
        processStartIdentity: owned.processStartIdentity,
        confirmedAt: iso(this.nowMs()),
      })
      lease = this.deps.leaseStore.markProcessConnectionOpened({
        processLeaseId: lease.processLeaseId,
        expectedRevision: lease.revision,
        openedAt: iso(this.nowMs()),
      })
    } catch (error) {
      const liveLease = this.deps.leaseStore.readLiveProcessLease()
      if (liveLease) {
        try {
          if (liveLease.pid === null) await this.settlePreCas(liveLease)
          else await this.settlePostCas(liveLease, 'sidecar_crash')
        } catch (settlementError) {
          this.crashCount += 1
          throw settlementError
        }
      }
      this.crashCount += 1
      throw error
    }

    this.active = { lease, child }
    child.process.once('exit', () => {
      if (this.active?.lease.processLeaseId === lease.processLeaseId) this.crashCount += 1
    })
    const transport = new CodexChildJsonLineTransport(
      child.process,
      () => { void this.hardReset('protocol_failure') },
      this.deps.onStderr || (() => undefined),
    )
    return { transport, lease }
  }

  async settleBootLease(): Promise<'none' | 'settled'> {
    let lease = this.deps.leaseStore.readLiveProcessLease()
    if (!lease) return 'none'
    lease = await this.proveLeaseOwner(lease)
    if (lease.pid === null) await this.settlePreCas(lease)
    else await this.settlePostCas(lease, 'sidecar_crash')
    return 'settled'
  }

  async hardReset(reason: HardResetReason): Promise<void> {
    if (!['app_quit', 'protocol_failure', 'sidecar_crash', 'test_cleanup'].includes(reason)) {
      throw new CodexSidecarSupervisorError('hard_reset_reason_invalid')
    }
    const lease = this.deps.leaseStore.readLiveProcessLease()
    if (!lease) {
      this.active = null
      return
    }
    const owned = await this.proveLeaseOwner(lease)
    if (owned.pid === null) await this.settlePreCas(owned)
    else await this.settlePostCas(owned, reason)
    this.active = null
  }

  private async settlePreCas(lease: CodexProcessLeaseRow): Promise<void> {
    const deadline = Date.parse(lease.spawnVisibilityDeadlineAt)
    if (this.nowMs() < deadline) await this.wait(deadline - this.nowMs())
    const candidates = this.preCasCandidates(await this.deps.inspector.list(), lease)
    if (candidates.length > 1) throw new CodexSidecarSupervisorError('pre_cas_multiple_candidates')
    if (candidates.length === 1) {
      const candidate = candidates[0]
      if (!this.isExactExecutable(candidate, lease)) {
        throw new CodexSidecarSupervisorError('pre_cas_exec_transient_unsettled')
      }
      const confirmed = this.deps.leaseStore.confirmProcessLeaseOwnership({
        processLeaseId: lease.processLeaseId,
        expectedRevision: lease.revision,
        pid: candidate.pid,
        processGroupId: candidate.processGroupId,
        processStartIdentity: candidate.processStartIdentity,
        confirmedAt: iso(this.nowMs()),
      })
      await this.settlePostCas(confirmed, 'sidecar_crash')
      return
    }
    await this.settlePreCasZero(lease)
  }

  private async settlePreCasZero(lease: CodexProcessLeaseRow): Promise<void> {
    const deadline = Date.parse(lease.spawnVisibilityDeadlineAt)
    if (this.nowMs() < deadline) await this.wait(deadline - this.nowMs())
    const evidence = await this.sampleStableZero(lease, 'pre_cas')
    if (evidence.kind === 'bindable') {
      const confirmed = this.deps.leaseStore.confirmProcessLeaseOwnership({
        processLeaseId: lease.processLeaseId,
        expectedRevision: lease.revision,
        pid: evidence.process.pid,
        processGroupId: evidence.process.processGroupId,
        processStartIdentity: evidence.process.processStartIdentity,
        confirmedAt: iso(this.nowMs()),
      })
      await this.settlePostCas(confirmed, 'sidecar_crash')
      return
    }
    this.deps.leaseStore.recordProcessTreeZero({
      processLeaseId: lease.processLeaseId,
      expectedRevision: lease.revision,
      treeZeroAt: iso(this.nowMs()),
      matcherMode: 'pre_cas',
      sampleTranscriptDigest: evidence.transcriptDigest,
      evidenceDigest: evidence.evidenceDigest,
    })
  }

  private async settlePostCas(
    lease: CodexProcessLeaseRow,
    _reason: HardResetReason,
  ): Promise<void> {
    const processes = await this.deps.inspector.list()
    const root = processes.find((process) => process.pid === lease.pid)
    if (root) {
      if (!this.matchesPostCasRoot(root, lease)) {
        throw new CodexSidecarSupervisorError('post_cas_owner_mismatch')
      }
      this.killGroup(lease.processGroupId as number, 'SIGTERM')
      await this.wait(100)
      const remaining = (await this.deps.inspector.list()).filter((process) => (
        process.processGroupId === lease.processGroupId
      ))
      if (remaining.length > 0) this.killGroup(lease.processGroupId as number, 'SIGKILL')
    } else if (processes.some((process) => process.processGroupId === lease.processGroupId)) {
      throw new CodexSidecarSupervisorError('post_cas_orphan_group_unproven')
    }
    let current = lease
    if (current.closedAt === null) {
      current = this.deps.leaseStore.markProcessConnectionClosed({
        processLeaseId: current.processLeaseId,
        expectedRevision: current.revision,
        closedAt: iso(this.nowMs()),
      })
    }
    const evidence = await this.sampleStableZero(current, 'post_cas')
    if (evidence.kind !== 'zero') {
      throw new CodexSidecarSupervisorError('post_cas_matcher_mode_violation')
    }
    this.deps.leaseStore.recordProcessTreeZero({
      processLeaseId: current.processLeaseId,
      expectedRevision: current.revision,
      treeZeroAt: iso(this.nowMs()),
      matcherMode: 'post_cas',
      sampleTranscriptDigest: evidence.transcriptDigest,
      evidenceDigest: evidence.evidenceDigest,
    })
  }

  private async proveLeaseOwner(lease: CodexProcessLeaseRow): Promise<CodexProcessLeaseRow> {
    if (
      lease.ownerMainBootId === this.deps.ownerMainBootId
      && lease.ownerMainPid === this.deps.ownerMainPid
      && lease.ownerMainProcessStartIdentity === this.deps.ownerMainProcessStartIdentity
    ) return lease
    const owner = (await this.deps.inspector.list()).find((process) => (
      process.pid === lease.ownerMainPid
      && process.processStartIdentity === lease.ownerMainProcessStartIdentity
    ))
    if (owner) throw new CodexSidecarSupervisorError('old_main_owner_still_alive')
    if (lease.ownerMainDeadAt) return lease
    return this.deps.leaseStore.recordOldMainDeath({
      processLeaseId: lease.processLeaseId,
      expectedRevision: lease.revision,
      deadAt: iso(this.nowMs()),
      evidenceDigest: sha256(JSON.stringify({
        pid: lease.ownerMainPid,
        processStartIdentity: lease.ownerMainProcessStartIdentity,
        observed: 'absent_or_reused',
      })),
    })
  }

  private async waitForSpawnOwnership(
    lease: CodexProcessLeaseRow,
    pid: number,
  ): Promise<CodexOwnedProcess> {
    const deadline = Date.parse(lease.spawnVisibilityDeadlineAt)
    while (this.nowMs() <= deadline) {
      const candidate = (await this.deps.inspector.list()).find((process) => process.pid === pid)
      if (candidate && this.matchesPreCas(candidate, lease) && this.isExactExecutable(candidate, lease)) {
        return candidate
      }
      await this.wait(20)
    }
    throw new CodexSidecarSupervisorError('spawn_ownership_visibility_timeout')
  }

  private async sampleStableZero(
    lease: CodexProcessLeaseRow,
    mode: MatcherMode,
  ): Promise<
    | { kind: 'zero'; transcriptDigest: string; evidenceDigest: string }
    | { kind: 'bindable'; process: CodexOwnedProcess }
  > {
    const transcript: Array<{ at: string; candidates: number[] }> = []
    let consecutiveZero = 0
    for (let observation = 0; observation < STABLE_ZERO_MAX_OBSERVATIONS; observation += 1) {
      const processes = await this.deps.inspector.list()
      const candidates = mode === 'pre_cas'
        ? this.preCasCandidates(processes, lease)
        : processes.filter((process) => process.processGroupId === lease.processGroupId)
      transcript.push({ at: iso(this.nowMs()), candidates: candidates.map((item) => item.pid).sort() })
      if (mode === 'pre_cas' && candidates.length > 1) {
        throw new CodexSidecarSupervisorError('pre_cas_multiple_candidates')
      }
      if (mode === 'pre_cas' && candidates.length === 1 && this.isExactExecutable(candidates[0], lease)) {
        return { kind: 'bindable', process: candidates[0] }
      }
      consecutiveZero = candidates.length === 0 ? consecutiveZero + 1 : 0
      if (consecutiveZero === STABLE_ZERO_SAMPLE_COUNT) {
        const transcriptDigest = sha256(JSON.stringify(transcript))
        return {
          kind: 'zero',
          transcriptDigest,
          evidenceDigest: sha256(JSON.stringify({
            processLeaseId: lease.processLeaseId,
            matcherMode: mode,
            transcriptDigest,
            sampleCount: STABLE_ZERO_SAMPLE_COUNT,
            sampleIntervalMs: STABLE_ZERO_SAMPLE_INTERVAL_MS,
          })),
        }
      }
      await this.wait(STABLE_ZERO_SAMPLE_INTERVAL_MS)
    }
    throw new CodexSidecarSupervisorError('process_tree_zero_unproven')
  }

  private preCasCandidates(
    processes: CodexOwnedProcess[],
    lease: CodexProcessLeaseRow,
  ): CodexOwnedProcess[] {
    return processes.filter((process) => this.matchesPreCas(process, lease))
  }

  private matchesPreCas(process: CodexOwnedProcess, lease: CodexProcessLeaseRow): boolean {
    return process.markers.processLeaseId === lease.processLeaseId
      && process.markers.sidecarSpawnInstanceId === lease.sidecarSpawnInstanceId
      && process.markers.connectionEpoch === lease.connectionEpoch
      && process.markers.stateDir === lease.isolatedStateDir
  }

  private matchesPostCasRoot(process: CodexOwnedProcess, lease: CodexProcessLeaseRow): boolean {
    return this.matchesPreCas(process, lease)
      && process.pid === lease.pid
      && process.processGroupId === lease.processGroupId
      && process.processStartIdentity === lease.processStartIdentity
      && this.isExactExecutable(process, lease)
  }

  private isExactExecutable(process: CodexOwnedProcess, lease: CodexProcessLeaseRow): boolean {
    return process.executablePath === lease.executablePath
      && process.executableSha256 === lease.binarySha256
  }

  private allocateIdentities(): {
    processLeaseId: string
    sidecarSpawnInstanceId: string
    connectionEpoch: string
  } {
    const result = {
      processLeaseId: randomUUID(),
      sidecarSpawnInstanceId: randomUUID(),
      connectionEpoch: randomUUID(),
    }
    if (new Set(Object.values(result)).size !== 3) {
      throw new CodexSidecarSupervisorError('spawn_identity_reused')
    }
    return result
  }

  private buildValidatedChildEnvironment(identities: {
    processLeaseId: string
    sidecarSpawnInstanceId: string
    connectionEpoch: string
  }): Record<string, string> {
    let environment: Record<string, string>
    try {
      environment = this.deps.childEnvironment(identities)
    } catch {
      throw new CodexSidecarSupervisorError('child_environment_construction_failed')
    }
    const allowedKeys = this.deps.runtime.contracts.childEnvAllowlist.allowedKeys
    if (
      !environment
      || typeof environment !== 'object'
      || Array.isArray(environment)
      || JSON.stringify(Object.keys(environment)) !== JSON.stringify(allowedKeys)
      || Object.values(environment).some((value) => typeof value !== 'string')
      || environment.READY_CODEX_PROCESS_LEASE_ID !== identities.processLeaseId
      || environment.READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID !== identities.sidecarSpawnInstanceId
      || environment.READY_CODEX_CONNECTION_EPOCH !== identities.connectionEpoch
      || environment.READY_CODEX_STATE_DIR !== this.deps.state.stateDir
    ) throw new CodexSidecarSupervisorError('child_environment_allowlist_mismatch')
    return environment
  }

  private nowMs(): number {
    return (this.deps.nowMs || Date.now)()
  }

  private wait(ms: number): Promise<void> {
    return (this.deps.wait || delay)(Math.max(0, ms))
  }

  private killGroup(processGroupId: number, signal: NodeJS.Signals): void {
    if (this.deps.killProcessGroup) {
      this.deps.killProcessGroup(processGroupId, signal)
      return
    }
    process.kill(-processGroupId, signal)
  }
}
