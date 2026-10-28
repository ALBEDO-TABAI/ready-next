import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type DesktopExecutableFileIdentity = Readonly<{
  device: string
  inode: string
  size: number
  mode: number
  mtimeMs: number
}>

export type DesktopExecutableLauncher = Readonly<{
  kind: 'payload' | 'interpreter'
  path: string
  realPath: string
  sha256: string
  fileIdentity: DesktopExecutableFileIdentity
}>

export type FrozenDesktopExecutableAuthority = Readonly<{
  program: string
  outerPath: string
  realPath: string
  payloadPath: string
  payloadSha256: string
  fileIdentity: DesktopExecutableFileIdentity
  launcherChain: readonly DesktopExecutableLauncher[]
  launchPath: string
  spawnPath: string
  launchPrefixArgs: readonly string[]
  version: string
  wrapperExecutionForbidden: boolean
  autoInstallForbidden: boolean
  authorityDigest: string
}>

export class DesktopExecutableAuthorityError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'DesktopExecutableAuthorityError'
  }
}

export type FrozenDesktopExecutableSnapshot = Readonly<{
  spawnPath: string
  launchPrefixArgs: readonly string[]
  release: () => void
}>

const SNAPSHOT_ROOT_MARKER = '{"authority":"ready-desktop-executable-snapshots","schema":1}\n'

function snapshotOwnerMarker(pid: number): string {
  return `${canonicalJson({ pid, schema: 1 })}\n`
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(
      Object.keys(item as Record<string, unknown>)
        .sort()
        .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
    )
  }
  return JSON.stringify(sort(value))
}

function fileIdentity(path: string): DesktopExecutableFileIdentity {
  const stats = statSync(path)
  if (!stats.isFile()) throw new DesktopExecutableAuthorityError('dependency_unavailable')
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    size: stats.size,
    mode: stats.mode,
    mtimeMs: stats.mtimeMs,
  }
}

function launcher(kind: DesktopExecutableLauncher['kind'], path: string): DesktopExecutableLauncher {
  const realPath = realpathSync.native(path)
  return {
    kind,
    path,
    realPath,
    sha256: sha256(readFileSync(realPath)),
    fileIdentity: fileIdentity(realPath),
  }
}

function assertOwnedRegularFile(path: string, mode: number): boolean {
  try {
    const stats = lstatSync(path)
    return stats.isFile()
      && !stats.isSymbolicLink()
      && (stats.mode & 0o777) === mode
      && (typeof process.getuid !== 'function' || stats.uid === process.getuid())
  } catch {
    // silent-catch: a missing or unreadable file fails the ownership/mode check
    return false
  }
}

function ensureSnapshotAuthorityRoot(input?: string): string {
  const requestedRoot = input || join(
    tmpdir(),
    `ready-desktop-executable-snapshots-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
  )
  const parentRealPath = realpathSync.native(dirname(requestedRoot))
  const rootPath = join(parentRealPath, basename(requestedRoot))
  if (!existsSync(rootPath)) {
    const stagingRoot = mkdtempSync(join(parentRealPath, `.${basename(rootPath)}.staging-${process.pid}-`))
    try {
      writeFileSync(join(stagingRoot, '.ready-owner'), SNAPSHOT_ROOT_MARKER, { flag: 'wx', mode: 0o600 })
      try {
        renameSync(stagingRoot, rootPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
          && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
      }
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true })
    }
  }
  const stats = lstatSync(rootPath)
  const markerPath = join(rootPath, '.ready-owner')
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || (stats.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && stats.uid !== process.getuid())
    || !assertOwnedRegularFile(markerPath, 0o600)
    || readFileSync(markerPath, 'utf8') !== SNAPSHOT_ROOT_MARKER) {
    throw new DesktopExecutableAuthorityError('dependency_snapshot_unavailable')
  }
  return realpathSync.native(rootPath)
}

function cleanupDeadExecutableSnapshots(authorityRoot: string): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(authorityRoot, { encoding: 'utf8', withFileTypes: true })
  } catch {
    // silent-catch: an unreadable snapshot authority root leaves nothing to sweep; dead-snapshot cleanup is best-effort
    return
  }
  for (const entry of entries) {
    const finalMatch = /^\.ready-executable-(\d+)-[A-Za-z0-9]+$/.exec(entry.name)
    const stagingMatch = /^\.ready-executable-staging-(\d+)-[A-Za-z0-9]+$/.exec(entry.name)
    const match = finalMatch || stagingMatch
    if (!match || !entry.isDirectory() || Number(match[1]) === process.pid) continue
    const ownerPid = Number(match[1])
    try {
      process.kill(ownerPid, 0)
      continue
    } catch (error) {
      // silent-catch: only ESRCH proves the owner pid is dead; any other probe error keeps its snapshot as possibly live
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
    }
    const candidate = join(authorityRoot, entry.name)
    try {
      const stats = lstatSync(candidate)
      if (!stats.isDirectory() || stats.isSymbolicLink()
        || (typeof process.getuid === 'function' && stats.uid !== process.getuid())) continue
      const candidateEntries = readdirSync(candidate).sort()
      if (finalMatch) {
        if ((stats.mode & 0o777) !== 0o500
          || !assertOwnedRegularFile(join(candidate, '.ready-owner'), 0o600)
          || !assertOwnedRegularFile(join(candidate, '0-payload'), 0o500)
          || readFileSync(join(candidate, '.ready-owner'), 'utf8') !== snapshotOwnerMarker(ownerPid)
          || candidateEntries.join('\n') !== '.ready-owner\n0-payload') continue
      } else {
        const directoryMode = stats.mode & 0o777
        const shape = candidateEntries.join('\n')
        if ((directoryMode !== 0o700 && directoryMode !== 0o500)
          || !['', '.ready-owner', '.ready-owner\n0-payload'].includes(shape)) continue
        if (candidateEntries.includes('.ready-owner')
          && (!assertOwnedRegularFile(join(candidate, '.ready-owner'), 0o600)
            || readFileSync(join(candidate, '.ready-owner'), 'utf8') !== snapshotOwnerMarker(ownerPid))) continue
        if (candidateEntries.includes('0-payload')) {
          const payloadStats = lstatSync(join(candidate, '0-payload'))
          if (!payloadStats.isFile() || payloadStats.isSymbolicLink()
            || (payloadStats.mode & 0o111) === 0
            || (typeof process.getuid === 'function' && payloadStats.uid !== process.getuid())) continue
        }
      }
      chmodSync(candidate, 0o700)
      rmSync(candidate, { recursive: true, force: true })
    } catch {
      // silent-catch: best-effort removal of a dead process snapshot; a failure leaves it for the next sweep
      // Cleanup is maintenance only and must not change a later tool result.
    }
  }
}

function materializeLauncherChainSnapshot(
  launcherChain: readonly DesktopExecutableLauncher[],
  authorityRootInput?: string,
): FrozenDesktopExecutableSnapshot {
  const authorityRoot = ensureSnapshotAuthorityRoot(authorityRootInput)
  cleanupDeadExecutableSnapshots(authorityRoot)
  let snapshotRoot = mkdtempSync(join(authorityRoot, `.ready-executable-staging-${process.pid}-`))
  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      chmodSync(snapshotRoot, 0o700)
    } catch {
      // silent-catch: best-effort permission reset before removing the snapshot directory
      // The directory may already be gone after a failed setup.
    }
    try {
      rmSync(snapshotRoot, { recursive: true, force: true })
    } catch {
      // silent-catch: best-effort snapshot removal; a leftover is swept by cleanupDeadExecutableSnapshots once this pid is dead
      // Cleanup failure cannot erase an already observed executable result.
    }
  }
  try {
    const payload = launcherChain[0]
    writeFileSync(join(snapshotRoot, '.ready-owner'), snapshotOwnerMarker(process.pid), {
      flag: 'wx',
      mode: 0o600,
    })
    const payloadPath = join(snapshotRoot, '0-payload')
    copyFileSync(payload.realPath, payloadPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    chmodSync(payloadPath, 0o500)
    const snapshotDescriptor = openSync(payloadPath, 'r')
    try {
      fsyncSync(snapshotDescriptor)
    } finally {
      closeSync(snapshotDescriptor)
    }
    if (sha256(readFileSync(payloadPath)) !== payload.sha256) {
      throw new DesktopExecutableAuthorityError('dependency_identity_drift')
    }
    const directoryDescriptor = openSync(snapshotRoot, 'r')
    try {
      fsyncSync(directoryDescriptor)
    } finally {
      closeSync(directoryDescriptor)
    }
    // Removing directory write permission prevents normal same-user updaters
    // from replacing the verified snapshot between validation and spawn.
    chmodSync(snapshotRoot, 0o500)
    const finalRoot = join(
      authorityRoot,
      `.ready-executable-${process.pid}-${randomUUID().replaceAll('-', '')}`,
    )
    renameSync(snapshotRoot, finalRoot)
    snapshotRoot = finalRoot
    const authorityRootDescriptor = openSync(authorityRoot, 'r')
    try {
      fsyncSync(authorityRootDescriptor)
    } finally {
      closeSync(authorityRootDescriptor)
    }
    const finalPayloadPath = join(snapshotRoot, '0-payload')
    // A shebang payload still uses its separately frozen interpreter. The
    // production lark-cli authority forbids wrappers, so the executable that
    // can perform external effects is always the private payload snapshot.
    const interpreterPath = launcherChain.length === 2 ? launcherChain[1].realPath : null
    return Object.freeze({
      spawnPath: interpreterPath || finalPayloadPath,
      launchPrefixArgs: Object.freeze(interpreterPath ? [finalPayloadPath] : []),
      release,
    })
  } catch (error) {
    release()
    if (error instanceof DesktopExecutableAuthorityError) throw error
    throw new DesktopExecutableAuthorityError('dependency_snapshot_unavailable')
  }
}

export function materializeFrozenDesktopExecutableSnapshot(input: {
  authority: FrozenDesktopExecutableAuthority
  authorityRoot?: string
}): FrozenDesktopExecutableSnapshot {
  assertFrozenDesktopExecutableAuthority(input.authority)
  return materializeLauncherChainSnapshot(input.authority.launcherChain, input.authorityRoot)
}

function platformSearchDirectories(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const fromPath = String(env.PATH || '').split(delimiter).filter(Boolean)
  if (platform === 'darwin') return [...fromPath, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  if (platform === 'win32') {
    return [
      ...fromPath,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : '',
      env.ProgramFiles || '',
    ].filter(Boolean)
  }
  return [...fromPath, '/usr/local/bin', '/usr/bin', '/bin']
}

function resolveExecutablePath(input: {
  program: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  additionalSearchDirectories?: readonly string[]
}): string {
  const program = input.program.trim()
  if (!program || (!isAbsolute(program) && !/^[A-Za-z0-9._+-]+$/.test(program))) {
    throw new DesktopExecutableAuthorityError('dependency_name_invalid')
  }
  const candidates = isAbsolute(program)
    ? [program]
    : [
        ...(input.additionalSearchDirectories || []).map((directory) => join(directory, program)),
        ...platformSearchDirectories(input.platform, input.env).map((directory) => join(directory, program)),
      ]
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!existsSync(candidate)) continue
      accessSync(candidate, constants.X_OK)
      if (statSync(realpathSync.native(candidate)).isFile()) return candidate
    } catch {
      // silent-catch: a candidate that vanishes, is not executable or cannot be resolved is skipped for the next search path
      continue
    }
  }
  throw new DesktopExecutableAuthorityError('dependency_unavailable')
}

function shebangInterpreter(path: string): string | null {
  const descriptor = openSync(path, 'r')
  const prefix = Buffer.alloc(4096)
  let bytesRead = 0
  try {
    bytesRead = readSync(descriptor, prefix, 0, prefix.length, 0)
  } finally {
    closeSync(descriptor)
  }
  const firstLine = prefix.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0] || ''
  if (!firstLine.startsWith('#!')) return null
  const tokens = firstLine.slice(2).trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) throw new DesktopExecutableAuthorityError('dependency_launcher_invalid')
  if (tokens[0] === '/usr/bin/env') {
    if (tokens.length !== 2 || !/^[A-Za-z0-9._+-]+$/.test(tokens[1])) {
      throw new DesktopExecutableAuthorityError('dependency_launcher_invalid')
    }
    return tokens[1]
  }
  if (!isAbsolute(tokens[0]) || tokens.length !== 1) {
    throw new DesktopExecutableAuthorityError('dependency_launcher_invalid')
  }
  return tokens[0]
}

export async function resolveFrozenDesktopExecutableAuthority(input: {
  program: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  additionalSearchDirectories?: readonly string[]
  versionArgs?: readonly string[]
  directPayloadRequired?: boolean
}): Promise<FrozenDesktopExecutableAuthority> {
  const env = input.env || process.env
  const platform = input.platform || process.platform
  const outerPath = resolveExecutablePath({
    program: input.program,
    env,
    platform,
    additionalSearchDirectories: input.additionalSearchDirectories,
  })
  const payload = launcher('payload', outerPath)
  const interpreterName = shebangInterpreter(payload.realPath)
  if (input.directPayloadRequired && interpreterName) {
    throw new DesktopExecutableAuthorityError('dependency_wrapper_forbidden')
  }
  const interpreter = interpreterName
    ? launcher('interpreter', resolveExecutablePath({
        program: interpreterName,
        env,
        platform,
        additionalSearchDirectories: input.additionalSearchDirectories,
      }))
    : null
  const launchPath = interpreter?.realPath || payload.realPath
  const launchPrefixArgs = interpreter ? [payload.realPath] : []
  let version = ''
  try {
    const result = await execFileAsync(
      launchPath,
      [...launchPrefixArgs, ...(input.versionArgs || ['--version'])],
      { env, timeout: 10_000, maxBuffer: 1024 * 1024 },
    )
    version = `${result.stdout} ${result.stderr}`.trim()
  } catch {
    throw new DesktopExecutableAuthorityError('dependency_version_unavailable')
  }
  if (!version) throw new DesktopExecutableAuthorityError('dependency_version_unavailable')
  if (canonicalJson(launcher('payload', outerPath)) !== canonicalJson(payload)
    || (interpreter && canonicalJson(launcher('interpreter', interpreter.path)) !== canonicalJson(interpreter))) {
    throw new DesktopExecutableAuthorityError('dependency_identity_drift')
  }
  const unsigned = {
    program: input.program,
    outerPath,
    realPath: payload.realPath,
    payloadPath: payload.realPath,
    payloadSha256: payload.sha256,
    fileIdentity: payload.fileIdentity,
    launcherChain: interpreter ? [payload, interpreter] : [payload],
    launchPath,
    spawnPath: launchPath,
    launchPrefixArgs,
    version,
    wrapperExecutionForbidden: input.directPayloadRequired === true,
    autoInstallForbidden: input.directPayloadRequired === true,
  }
  return Object.freeze({
    ...unsigned,
    launcherChain: Object.freeze(unsigned.launcherChain.map((entry) => Object.freeze(entry))),
    launchPrefixArgs: Object.freeze([...launchPrefixArgs]),
    authorityDigest: sha256(canonicalJson(unsigned)),
  })
}

export function assertFrozenDesktopExecutableAuthority(
  authority: FrozenDesktopExecutableAuthority,
): void {
  const payload = launcher('payload', authority.outerPath)
  if (payload.realPath !== authority.realPath
    || payload.sha256 !== authority.payloadSha256
    || canonicalJson(payload.fileIdentity) !== canonicalJson(authority.fileIdentity)) {
    throw new DesktopExecutableAuthorityError('dependency_identity_drift')
  }
  if (authority.launcherChain.length === 2) {
    const interpreter = launcher('interpreter', authority.launcherChain[1].path)
    if (canonicalJson(interpreter) !== canonicalJson(authority.launcherChain[1])) {
      throw new DesktopExecutableAuthorityError('dependency_identity_drift')
    }
  }
  const unsigned = {
    program: authority.program,
    outerPath: authority.outerPath,
    realPath: authority.realPath,
    payloadPath: authority.payloadPath,
    payloadSha256: authority.payloadSha256,
    fileIdentity: authority.fileIdentity,
    launcherChain: authority.launcherChain,
    launchPath: authority.launchPath,
    spawnPath: authority.spawnPath,
    launchPrefixArgs: authority.launchPrefixArgs,
    version: authority.version,
    wrapperExecutionForbidden: authority.wrapperExecutionForbidden,
    autoInstallForbidden: authority.autoInstallForbidden,
  }
  if (authority.wrapperExecutionForbidden && (
    authority.launcherChain.length !== 1
    || authority.payloadPath !== authority.spawnPath
    || authority.launchPath !== authority.spawnPath
    || authority.launchPrefixArgs.length !== 0
    || authority.autoInstallForbidden !== true
  )) {
    throw new DesktopExecutableAuthorityError('dependency_identity_drift')
  }
  if (sha256(canonicalJson(unsigned)) !== authority.authorityDigest) {
    throw new DesktopExecutableAuthorityError('dependency_identity_drift')
  }
}

export type DesktopExecutableOutcome = 'exited' | 'killed' | 'launch_failed'

/** How an `execFile` rejection ended: a numeric code is the program's exit, `killed` a timeout or output limit. */
export function classifyDesktopExecutableFailure(error: unknown): DesktopExecutableOutcome {
  const failure = error as { code?: unknown; killed?: unknown } | null
  if (typeof failure?.code === 'number') return 'exited'
  if (failure?.killed === true) return 'killed'
  return 'launch_failed'
}

export async function executeFrozenDesktopExecutable(input: {
  authority: FrozenDesktopExecutableAuthority
  args: readonly string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}): Promise<Readonly<{
  exitCode: number
  /** Whether the program ran to an exit code, was killed (timeout or output limit), or never started. */
  outcome: DesktopExecutableOutcome
  stdout: string
  stderr: string
  executableReadbackDigest: string
}>> {
  assertFrozenDesktopExecutableAuthority(input.authority)
  const snapshot = materializeFrozenDesktopExecutableSnapshot({
    authority: input.authority,
  })
  const args = [...snapshot.launchPrefixArgs, ...input.args]
  try {
    const result = await execFileAsync(snapshot.spawnPath, args, {
      env: input.env || process.env,
      encoding: 'utf8',
      timeout: input.timeoutMs || 10_000,
      maxBuffer: 1024 * 1024,
    })
    return Object.freeze({
      exitCode: 0,
      outcome: 'exited' as const,
      stdout: result.stdout,
      stderr: result.stderr,
      executableReadbackDigest: input.authority.authorityDigest,
    })
  } catch (error) {
    // silent-catch: a non-zero exit, timeout or launch failure is returned with its outcome and captured output
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown }
    const exitCode = typeof failure.code === 'number' ? failure.code : -1
    return Object.freeze({
      exitCode,
      outcome: classifyDesktopExecutableFailure(error),
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
      executableReadbackDigest: input.authority.authorityDigest,
    })
  } finally {
    snapshot.release()
  }
}
