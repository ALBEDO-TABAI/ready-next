import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

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
export const CODEX_SIDECAR_CRASH_ATTEMPT_LIMIT = 3
export const CODEX_SIDECAR_MAX_STDOUT_LINE_BYTES = 2 * 1024 * 1024
export const CODEX_SIDECAR_STDOUT_DRAIN_TIMEOUT_MS = 1_000

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
  readLatestProcessLeaseByOwnerMainBootId?(ownerMainBootId: string): CodexProcessLeaseRow | null
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

export interface CodexSidecarSpawnCapabilityPort {
  activate(identities: {
    processLeaseId: string
    sidecarSpawnInstanceId: string
    connectionEpoch: string
  }): Record<string, string>
  revoke(sidecarSpawnInstanceId: string): void
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

/**
 * One `ps -o pid=,ppid=,pgid=,lstart=,command=` row. `ps` prints the command unquoted, so a path with a space
 * ("/Applications/Ready Next.app/…") cannot be cut out of it by whitespace: `executable` is that process's `comm`
 * (the full executable path, from a second `ps` read) and is used when the command really starts with it.
 */
export function parsePsLine(line: string, executable?: string): Omit<CodexOwnedProcess, 'executableSha256'> | null {
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
  const executablePath = executable && (command === executable || command.startsWith(`${executable} `))
    ? executable
    : executableToken?.[1] || executableToken?.[2] || executableToken?.[3] || ''
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

/**
 * `ps` follows the caller's locale: with none (an app opened from Finder) it prints non-ASCII path bytes as
 * `M-g…`, and under e.g. zh_CN its start time has four tokens instead of five. Either way an owned process stops
 * matching, so the listing always runs in one fixed UTF-8 locale.
 */
const PS_OPTIONS = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { LC_ALL: 'en_US.UTF-8' } } as const

/** The runtime binary is hundreds of megabytes and is listed on every ownership poll; hash it once per version. */
const executableDigests = new Map<string, { stamp: string; sha256: string }>()
function executableDigest(path: string): string {
  const stat = statSync(path)
  const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  const known = executableDigests.get(path)
  if (known?.stamp === stamp) return known.sha256
  const digest = sha256(readFileSync(path))
  executableDigests.set(path, { stamp, sha256: digest })
  return digest
}

export class MacCodexProcessInspector implements CodexProcessInspector {
  async list(): Promise<CodexOwnedProcess[]> {
    let output: string
    // pid → full executable path, spaces included (see parsePsLine).
    const executables = new Map<number, string>()
    try {
      output = execFileSync('/bin/ps', [
        'axeww',
        '-o',
        'pid=,ppid=,pgid=,lstart=,command=',
      ], PS_OPTIONS)
      for (const row of execFileSync('/bin/ps', ['axww', '-o', 'pid=,comm='], PS_OPTIONS).split('\n')) {
        const match = row.match(/^\s*(\d+)\s(.+)$/)
        if (match) executables.set(Number(match[1]), match[2])
      }
    } catch {
      throw new CodexSidecarSupervisorError('process_enumeration_failed')
    }
    return output.split('\n').flatMap((line) => {
      const parsed = parsePsLine(line, executables.get(Number(line.trim().split(/\s+/, 1)[0])))
      if (!parsed) return []
      let executableSha256: string | null = null
      if (parsed.markers.processLeaseId && parsed.executablePath.startsWith('/')) {
        try {
          executableSha256 = executableDigest(parsed.executablePath)
        } catch {
          // silent-catch: an unreadable executable gets no digest, so the process cannot match a lease binary digest
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
    child.once('error', () => undefined)
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
  private processExit: { error: Error | null } | null = null
  private stdoutDrained = false
  private stdoutLineBytes = 0
  private stdoutLineChunks: Buffer[] = []
  private stdoutDrainTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onProtocolClose: (reason: string) => void,
    onStderr: (text: string) => void,
  ) {
    child.stdout.on('data', (chunk) => {
      this.acceptStdoutChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.stdout.once('end', () => this.drainStdout())
    child.stderr.on('data', (chunk) => onStderr(String(chunk)))
    child.once('exit', (code, signal) => {
      this.recordProcessExit(code, signal)
    })
    child.once('close', (code, signal) => {
      this.drainStdout()
      this.recordProcessExit(code, signal)
    })
    child.once('error', () => {
      this.closeOnce(new CodexSidecarSupervisorError('sidecar_process_error'))
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
    this.child.stdin.destroy()
    const error = new CodexSidecarSupervisorError(reason || 'protocol_failure', details)
    if (!this.closeOnce(error)) return
    this.onProtocolClose(reason)
  }

  private closeOnce(error: Error | null): boolean {
    if (this.closed) return false
    this.closed = true
    if (this.stdoutDrainTimer) clearTimeout(this.stdoutDrainTimer)
    this.stdoutDrainTimer = null
    this.stdoutLineChunks = []
    this.stdoutLineBytes = 0
    const listeners = [...this.closeListeners]
    this.closeListeners.clear()
    this.lineListeners.clear()
    for (const listener of listeners) listener(error)
    return true
  }

  private acceptStdoutChunk(chunk: Buffer): void {
    if (this.closed || this.stdoutDrained) return
    let cursor = 0
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor)
      const segmentEnd = newline === -1 ? chunk.length : newline
      const segmentBytes = segmentEnd - cursor
      if (this.stdoutLineBytes + segmentBytes > CODEX_SIDECAR_MAX_STDOUT_LINE_BYTES) {
        this.stdoutLineChunks = []
        this.stdoutLineBytes = 0
        this.close('sidecar_stdout_line_too_large', {
          maxBytes: CODEX_SIDECAR_MAX_STDOUT_LINE_BYTES,
        })
        return
      }
      if (segmentBytes > 0) {
        this.stdoutLineChunks.push(Buffer.from(chunk.subarray(cursor, segmentEnd)))
        this.stdoutLineBytes += segmentBytes
      }
      if (newline === -1) return
      this.publishStdoutLine()
      if (this.closed) return
      cursor = newline + 1
    }
  }

  private publishStdoutLine(): void {
    let line = Buffer.concat(this.stdoutLineChunks, this.stdoutLineBytes).toString('utf8')
    this.stdoutLineChunks = []
    this.stdoutLineBytes = 0
    if (line.endsWith('\r')) line = line.slice(0, -1)
    for (const listener of [...this.lineListeners]) listener(line)
  }

  private drainStdout(): void {
    if (this.stdoutDrained) return
    this.stdoutDrained = true
    if (!this.closed && this.stdoutLineBytes > 0) this.publishStdoutLine()
    this.stdoutLineChunks = []
    this.stdoutLineBytes = 0
    this.closeAfterProcessExit()
  }

  private recordProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.processExit) {
      const expected = signal === 'SIGTERM' || signal === 'SIGKILL' || code === 0
      this.processExit = {
        error: expected ? null : new CodexSidecarSupervisorError('sidecar_unexpected_exit'),
      }
    }
    if (!this.stdoutDrained && !this.closed && !this.stdoutDrainTimer) {
      this.stdoutDrainTimer = setTimeout(() => {
        this.stdoutDrainTimer = null
        if (this.closed || this.stdoutDrained) return
        this.stdoutLineChunks = []
        this.stdoutLineBytes = 0
        this.closeOnce(new CodexSidecarSupervisorError('sidecar_stdout_drain_timeout'))
        this.child.stdout.destroy()
      }, CODEX_SIDECAR_STDOUT_DRAIN_TIMEOUT_MS)
      this.stdoutDrainTimer.unref?.()
    }
    this.closeAfterProcessExit()
  }

  private closeAfterProcessExit(): void {
    if (!this.processExit || !this.stdoutDrained) return
    this.closeOnce(this.processExit.error)
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
    spawnCapability: CodexSidecarSpawnCapabilityPort
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
    if (this.crashCount >= CODEX_SIDECAR_CRASH_ATTEMPT_LIMIT) {
      throw new CodexSidecarSupervisorError('sidecar_crash_loop_exhausted')
    }
    if (this.crashCount > 0) {
      await this.wait(CRASH_BACKOFF_MS[Math.min(this.crashCount - 1, CRASH_BACKOFF_MS.length - 1)])
    }
    const now = this.nowMs()
    const identities = this.allocateIdentities()
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
    let environment: Record<string, string>
    try {
      environment = this.buildValidatedChildEnvironment(identities)
    } catch (error) {
      this.deps.spawnCapability.revoke(identities.sidecarSpawnInstanceId)
      await this.settlePreCasZero(lease)
      this.crashCount += 1
      throw error
    }
    let child: CodexSidecarChild
    try {
      child = this.deps.spawnPort.spawn({
        executablePath: this.deps.runtime.binaryPath,
        argv: [...this.deps.runtime.contracts.nativeIsolationConfigContract.launchArgv],
        cwd: this.deps.state.stateDir,
        env: environment,
      })
    } catch {
      this.deps.spawnCapability.revoke(identities.sidecarSpawnInstanceId)
      await this.settlePreCasZero(lease)
      this.crashCount += 1
      throw new CodexSidecarSupervisorError('sidecar_spawn_failed')
    }
    let childExited = false
    let childError: Error | null = null
    const processLeaseId = lease.processLeaseId
    child.process.once('exit', () => {
      childExited = true
      this.deps.spawnCapability.revoke(identities.sidecarSpawnInstanceId)
      if (this.active?.lease.processLeaseId === processLeaseId) this.crashCount += 1
    })
    child.process.once('error', (error) => {
      childError = error instanceof Error ? error : new Error('sidecar_process_error')
      this.deps.spawnCapability.revoke(identities.sidecarSpawnInstanceId)
    })

    try {
      const owned = await this.waitForSpawnOwnership(lease, child.pid)
      if (childExited) throw new CodexSidecarSupervisorError('sidecar_exited_during_start')
      if (childError) throw new CodexSidecarSupervisorError('sidecar_errored_during_start', childError)
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
      if (childExited) throw new CodexSidecarSupervisorError('sidecar_exited_during_start')
      if (childError) throw new CodexSidecarSupervisorError('sidecar_errored_during_start', childError)
    } catch (error) {
      this.deps.spawnCapability.revoke(identities.sidecarSpawnInstanceId)
      const liveLease = this.deps.leaseStore.readLiveProcessLease()
      if (liveLease) {
        try {
          // A child the listing never showed cannot be found by the settlement below, which would then record
          // "nothing left" over a live process. This handle is the child this call spawned, so end it here.
          if (liveLease.pid === null && !childExited && !childError) child.process.kill('SIGKILL')
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
    const transport = new CodexChildJsonLineTransport(
      child.process,
      () => undefined,
      this.deps.onStderr || (() => undefined),
    )
    return { transport, lease }
  }

  async settleBootLease(): Promise<'none' | 'settled'> {
    let lease = this.deps.leaseStore.readLiveProcessLease()
    if (!lease) return 'none'
    this.deps.spawnCapability.revoke(lease.sidecarSpawnInstanceId)
    lease = await this.proveLeaseOwner(lease)
    if (lease.pid === null) await this.settlePreCas(lease)
    else await this.settlePostCas(lease, 'sidecar_crash')
    return 'settled'
  }

  resetCrashBudgetForExplicitRetry(): void {
    if (this.active || this.deps.leaseStore.readLiveProcessLease()) {
      throw new CodexSidecarSupervisorError('sidecar_retry_requires_settled_lease')
    }
    this.crashCount = 0
  }

  async settleFenceOwnerLease(ownerMainBootId: string): Promise<'current' | 'settled'> {
    if (!ownerMainBootId.trim()) throw new CodexSidecarSupervisorError('fence_owner_identity_invalid')
    if (ownerMainBootId === this.deps.ownerMainBootId) return 'current'
    const lease = this.deps.leaseStore.readLatestProcessLeaseByOwnerMainBootId?.(ownerMainBootId)
    if (!lease || !lease.treeZeroAt || !lease.treeZeroEvidenceDigest) {
      throw new CodexSidecarSupervisorError('fence_owner_settled_lease_missing')
    }
    if (lease.ownerMainDeadAt && lease.ownerMainDeathEvidenceDigest) return 'settled'
    const owner = (await this.deps.inspector.list()).find((process) => (
      process.pid === lease.ownerMainPid
      && process.processStartIdentity === lease.ownerMainProcessStartIdentity
    ))
    if (owner) throw new CodexSidecarSupervisorError('old_main_owner_still_alive')
    this.deps.leaseStore.recordOldMainDeath({
      processLeaseId: lease.processLeaseId,
      expectedRevision: lease.revision,
      deadAt: iso(this.nowMs()),
      evidenceDigest: sha256(JSON.stringify({
        pid: lease.ownerMainPid,
        processStartIdentity: lease.ownerMainProcessStartIdentity,
        observed: 'absent_or_reused_after_tree_zero',
      })),
    })
    return 'settled'
  }

  async hardReset(reason: HardResetReason): Promise<void> {
    if (!['app_quit', 'protocol_failure', 'sidecar_crash', 'test_cleanup'].includes(reason)) {
      throw new CodexSidecarSupervisorError('hard_reset_reason_invalid')
    }
    const lease = this.deps.leaseStore.readLiveProcessLease()
    if (!lease) {
      if (this.active) this.deps.spawnCapability.revoke(this.active.lease.sidecarSpawnInstanceId)
      this.active = null
      return
    }
    this.deps.spawnCapability.revoke(lease.sidecarSpawnInstanceId)
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
      environment = this.deps.spawnCapability.activate(identities)
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
