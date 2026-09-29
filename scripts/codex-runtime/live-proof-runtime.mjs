import { sha256File, computeTreeIdentity } from './live-proof-file-identity.cjs'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lookup } from 'node:dns/promises'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const identities = createRequire(import.meta.url)('./live-proof-identities.cjs')

const {
  TRUSTED_RUNTIME_PATH,
  TRUSTED_NODE,
  TRUSTED_NPM_CLI,
  TRUSTED_SQLITE3,
  TRUSTED_BUILD_SHELL,
  TRUSTED_PACKAGE_LOCK,
  TRUSTED_NODE_MODULES,
  NON_DEPENDENCY_NODE_MODULE_PATHS,
  TRUSTED_ELECTRON,
  TRUSTED_BUILD_SCRIPTS,
  TRUSTED_BUILD_COMMAND,
  TRUSTED_SIDECAR_PYTHON,
  TRUSTED_SIDECAR_ENVIRONMENT,
  TRUSTED_ELECTRON_GYP,
} = identities

export { sha256File, computeTreeIdentity } from './live-proof-file-identity.cjs'

export function computeTrustedNodeModulesIdentity(rootPath) {
  return computeTreeIdentity(resolve(rootPath, TRUSTED_NODE_MODULES.path), {
    excludeRelativePaths: NON_DEPENDENCY_NODE_MODULE_PATHS,
  })
}

function assertPinnedFile(identity, code) {
  if (!existsSync(identity.path) || sha256File(identity.path) !== identity.sha256) {
    throw new Error(code)
  }
  return identity.path
}

export function trustedSqlite3Path() {
  return assertPinnedFile(TRUSTED_SQLITE3, 'sqlite3_identity_mismatch')
}

export function assertTrustedBuildProvenance(rootPath) {
  const root = resolve(rootPath)
  assertPinnedFile(TRUSTED_NODE, 'node_identity_mismatch')
  assertPinnedFile(TRUSTED_NPM_CLI, 'npm_identity_mismatch')
  assertPinnedFile({
    path: resolve(root, TRUSTED_PACKAGE_LOCK.path),
    sha256: TRUSTED_PACKAGE_LOCK.sha256,
  }, 'package_lock_identity_mismatch')
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (Object.entries(TRUSTED_BUILD_SCRIPTS).some(
    ([name, command]) => packageJson.scripts?.[name] !== command,
  )) throw new Error('package_build_script_identity_mismatch')
  const dependencies = computeTrustedNodeModulesIdentity(root)
  if (dependencies.digest !== TRUSTED_NODE_MODULES.digest
    || dependencies.entryCount !== TRUSTED_NODE_MODULES.entryCount
    || dependencies.fileBytes !== TRUSTED_NODE_MODULES.fileBytes) {
    throw new Error('node_modules_identity_mismatch')
  }
  const executablePath = resolve(root, TRUSTED_ELECTRON.relativePath)
  assertPinnedFile({ path: executablePath, sha256: TRUSTED_ELECTRON.sha256 }, 'electron_identity_mismatch')
  return Object.freeze({
    packageLockSha256: TRUSTED_PACKAGE_LOCK.sha256,
    dependencyTreeDigest: dependencies.digest,
    dependencyEntryCount: dependencies.entryCount,
    dependencyFileBytes: dependencies.fileBytes,
    electronExecutablePath: executablePath,
    electronExecutableSha256: TRUSTED_ELECTRON.sha256,
  })
}

export function trustedSidecarPythonProvenance() {
  const pythonPath = assertPinnedFile(TRUSTED_SIDECAR_PYTHON, 'sidecar_python_identity_mismatch')
  const runtime = computeTreeIdentity(TRUSTED_SIDECAR_PYTHON.runtimeRoot, {
    excludePythonBytecode: true,
  })
  if (runtime.digest !== TRUSTED_SIDECAR_PYTHON.runtimeDigest
    || runtime.entryCount !== TRUSTED_SIDECAR_PYTHON.runtimeEntryCount
    || runtime.fileBytes !== TRUSTED_SIDECAR_PYTHON.runtimeFileBytes) {
    throw new Error('sidecar_python_runtime_identity_mismatch')
  }
  const probeEnv = {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONPYCACHEPREFIX: '/var/empty/ready-codex-e6-python-cache',
  }
  const version = execFileSync(pythonPath, ['--version'], {
    encoding: 'utf8', env: probeEnv, timeout: 5_000,
  }).trim()
  const sslVersion = execFileSync(pythonPath, ['-I', '-c', 'import ssl; print(ssl.OPENSSL_VERSION)'], {
    encoding: 'utf8', env: probeEnv, timeout: 5_000,
  }).trim()
  if (version !== TRUSTED_SIDECAR_PYTHON.version || sslVersion !== TRUSTED_SIDECAR_PYTHON.sslVersion) {
    throw new Error('sidecar_python_probe_mismatch')
  }
  return Object.freeze({
    path: pythonPath,
    sha256: TRUSTED_SIDECAR_PYTHON.sha256,
    runtimeRoot: runtime.root,
    runtimeDigest: runtime.digest,
    runtimeEntryCount: runtime.entryCount,
    runtimeFileBytes: runtime.fileBytes,
    version,
    sslVersion,
  })
}

export function trustedSidecarEnvironmentProvenance(rootPath) {
  const environment = computeTreeIdentity(TRUSTED_SIDECAR_ENVIRONMENT.path, {
    excludePythonBytecode: true,
  })
  if (environment.digest !== TRUSTED_SIDECAR_ENVIRONMENT.digest
    || environment.entryCount !== TRUSTED_SIDECAR_ENVIRONMENT.entryCount
    || environment.fileBytes !== TRUSTED_SIDECAR_ENVIRONMENT.fileBytes) {
    throw new Error('sidecar_environment_identity_mismatch')
  }
  assertPinnedFile({
    path: resolve(rootPath, TRUSTED_SIDECAR_ENVIRONMENT.requirementsPath),
    sha256: TRUSTED_SIDECAR_ENVIRONMENT.requirementsSha256,
  }, 'sidecar_requirements_identity_mismatch')
  const pythonPath = resolve(environment.root, 'bin/python')
  assertTrustedSidecarVenvPython(environment.root)
  const probe = execFileSync(pythonPath, ['-I', '-c', [
    'import apscheduler,cryptography,fastapi,lark_oapi,pydantic,requests,uvicorn',
    'print("sidecar-imports-ok")',
  ].join(';')], {
    encoding: 'utf8',
    env: {
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONPYCACHEPREFIX: '/var/empty/ready-codex-e6-sidecar-cache',
    },
    timeout: 10_000,
  }).trim()
  if (probe !== 'sidecar-imports-ok') throw new Error('sidecar_environment_probe_mismatch')
  return Object.freeze({
    sourceRoot: environment.root,
    digest: environment.digest,
    entryCount: environment.entryCount,
    fileBytes: environment.fileBytes,
    requirementsSha256: TRUSTED_SIDECAR_ENVIRONMENT.requirementsSha256,
    requirementsInstallDigest: TRUSTED_SIDECAR_ENVIRONMENT.requirementsInstallDigest,
  })
}

export function assertTrustedSidecarVenvPython(venvRoot) {
  const executableNames = ['python', 'python3', 'python3.11']
  for (const name of executableNames) {
    const candidate = resolve(venvRoot, 'bin', name)
    if (realpathSync(candidate) !== TRUSTED_SIDECAR_PYTHON.path
      || sha256File(candidate) !== TRUSTED_SIDECAR_PYTHON.sha256) {
      throw new Error('sidecar_venv_python_identity_mismatch')
    }
  }
  return resolve(venvRoot, 'bin/python')
}

export function trustedElectronGypProvenance() {
  const identity = computeTreeIdentity(TRUSTED_ELECTRON_GYP.path)
  if (identity.digest !== TRUSTED_ELECTRON_GYP.digest
    || identity.entryCount !== TRUSTED_ELECTRON_GYP.entryCount
    || identity.fileBytes !== TRUSTED_ELECTRON_GYP.fileBytes) {
    throw new Error('electron_gyp_identity_mismatch')
  }
  return identity
}

export function prepareTrustedBuildToolchain(binPath) {
  if (!isAbsolute(binPath) || existsSync(binPath)) throw new Error('build_toolchain_path_invalid')
  const nodePath = assertPinnedFile(TRUSTED_NODE, 'node_identity_mismatch')
  const npmCliPath = assertPinnedFile(TRUSTED_NPM_CLI, 'npm_identity_mismatch')
  mkdirSync(binPath, { recursive: false, mode: 0o700 })
  symlinkSync(nodePath, resolve(binPath, 'node'))
  const npmWrapper = `#!/bin/sh\nexec ${JSON.stringify(nodePath)} ${JSON.stringify(npmCliPath)} "$@"\n`
  writeFileSync(resolve(binPath, 'npm'), npmWrapper, { mode: 0o700 })
  return assertTrustedBuildToolchain(binPath)
}

export function assertTrustedBuildToolchain(binPath) {
  const nodeLink = resolve(binPath, 'node')
  const npmWrapperPath = resolve(binPath, 'npm')
  const expectedWrapper = `#!/bin/sh\nexec ${JSON.stringify(TRUSTED_NODE.path)} ${JSON.stringify(TRUSTED_NPM_CLI.path)} "$@"\n`
  if (!lstatSync(nodeLink).isSymbolicLink() || realpathSync(nodeLink) !== TRUSTED_NODE.path
    || sha256File(nodeLink) !== TRUSTED_NODE.sha256
    || !lstatSync(npmWrapperPath).isFile()
    || readFileSync(npmWrapperPath, 'utf8') !== expectedWrapper) {
    throw new Error('build_toolchain_identity_mismatch')
  }
  return Object.freeze({
    binPath,
    nodePath: TRUSTED_NODE.path,
    nodeSha256: TRUSTED_NODE.sha256,
    npmCliPath: TRUSTED_NPM_CLI.path,
    npmCliSha256: TRUSTED_NPM_CLI.sha256,
    npmWrapperSha256: sha256File(npmWrapperPath),
  })
}

export async function runTrustedNpmBuild(options = {}) {
  const nodePath = assertPinnedFile(TRUSTED_NODE, 'node_identity_mismatch')
  const shellPath = assertPinnedFile(TRUSTED_BUILD_SHELL, 'build_shell_identity_mismatch')
  if (process.execPath !== nodePath) throw new Error('node_identity_mismatch')
  if (typeof options.homePath !== 'string' || !isAbsolute(options.homePath)
    || !existsSync(options.homePath) || typeof options.toolchainBinPath !== 'string'
    || !isAbsolute(options.toolchainBinPath)
    || !/^ready-codex-e6-build-[a-f0-9]{40}$/.test(options.processIdentityArgument || '')) {
    throw new Error('build_environment_invalid')
  }
  const toolchain = assertTrustedBuildToolchain(options.toolchainBinPath)
  const outputPath = resolve(options.cwd || process.cwd(), 'out')
  const tscCachePath = resolve(options.homePath, '.cache/tsc')
  const userConfigPath = resolve(options.homePath, '.npmrc')
  const globalConfigPath = resolve(options.homePath, '.npm-globalrc')
  if (existsSync(userConfigPath) || existsSync(globalConfigPath)) {
    throw new Error('build_npm_config_not_fresh')
  }
  writeFileSync(userConfigPath, '', { mode: 0o600 })
  writeFileSync(globalConfigPath, '', { mode: 0o600 })
  mkdirSync(tscCachePath, { recursive: true, mode: 0o700 })
  rmSync(outputPath, { recursive: true, force: true })
  if (existsSync(outputPath)) throw new Error('build_output_not_fresh')
  await runCommand(shellPath, ['-c', TRUSTED_BUILD_COMMAND, options.processIdentityArgument], {
    ...options,
    env: {
      HOME: options.homePath,
      LANG: 'C',
      LC_ALL: 'C',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_GLOBALCONFIG: globalConfigPath,
      NPM_CONFIG_OFFLINE: 'true',
      NPM_CONFIG_SCRIPT_SHELL: shellPath,
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_USERCONFIG: userConfigPath,
      PATH: `${toolchain.binPath}:${resolve(options.cwd || process.cwd(), 'node_modules/.bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
      READY_CODEX_E6_TSC_CACHE: tscCachePath,
      XDG_CONFIG_HOME: resolve(options.homePath, '.config'),
    },
  })
  assertTrustedBuildToolchain(options.toolchainBinPath)
  if (!existsSync(outputPath)) throw new Error('build_output_missing')
  if (readFileSync(userConfigPath, 'utf8') !== ''
    || readFileSync(globalConfigPath, 'utf8') !== '') {
    throw new Error('build_npm_config_changed')
  }
}

function isPublicIpAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224)
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::' || normalized === '::1'
      || normalized.startsWith('fc') || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)) return false
    if (normalized.startsWith('::ffff:')) {
      return isPublicIpAddress(normalized.slice('::ffff:'.length))
    }
    return true
  }
  return false
}

export async function assertTrustedPublicHttpsEndpoint(baseUrl, options = {}) {
  let parsed
  try { parsed = new URL(baseUrl) } catch { throw new Error('external_endpoint_invalid') }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const allowedHosts = new Set((options.allowedHosts || []).map((host) => host.toLowerCase()))
  const allowedPathnames = new Set(options.allowedPathnames || [])
  let decodedPathname
  try { decodedPathname = decodeURIComponent(parsed.pathname) } catch {
    throw new Error('external_endpoint_untrusted')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || !hostname
    || (allowedHosts.size > 0 && !allowedHosts.has(hostname))
    || (allowedPathnames.size > 0 && !allowedPathnames.has(parsed.pathname))
    || /(?:^|[/_.-])(?:mock|test|fixture)(?:[/_.-]|$)/i.test(decodedPathname)
    || /(?:^|[.-])(?:localhost|local|internal|mock|test|fixture)(?:[.-]|$)/i.test(hostname)) {
    throw new Error('external_endpoint_untrusted')
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw new Error('external_endpoint_not_public')
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw new Error('external_endpoint_not_public')
  }
  return Object.freeze({
    endpointClass: 'trusted_public_https',
    hostname,
    origin: parsed.origin,
    baseUrl: parsed.toString().replace(/\/$/, ''),
    resolvedAddressDigests: Object.freeze(addresses.map((entry) => (
      createHash('sha256').update(entry.address).digest('hex')
    )).sort()),
  })
}

export async function runCommand(command, args = [], options = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const childProcess = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      detached: options.detached === true,
      env: options.env || process.env,
      stdio: options.stdio || 'inherit',
    })
    childProcess.once('error', rejectRun)
    try {
      validatedChildProcessPid(childProcess)
      if (typeof options.onSpawn === 'function') options.onSpawn(childProcess)
    } catch (error) {
      childProcess.kill('SIGTERM')
      rejectRun(error)
      return
    }
    childProcess.once('exit', (code, signal) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${command} failed with code=${code} signal=${signal || 'none'}`)))
  })
}

export function validatedChildProcessPid(childProcess) {
  if (!Number.isSafeInteger(childProcess?.pid) || childProcess.pid <= 1) {
    throw new Error('child_process_pid_unavailable')
  }
  return childProcess.pid
}

export function freezeChildProcessForOwnershipCapture(childProcess) {
  validatedChildProcessPid(childProcess)
  if (childProcess.exitCode !== null || childProcess.signalCode !== null
    || childProcess.kill('SIGSTOP') !== true) {
    throw new Error('child_process_freeze_failed')
  }
}

export function sqliteJson(databasePath, sql) {
  const raw = execFileSync(trustedSqlite3Path(), ['-readonly', '-json', databasePath, sql], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).trim()
  return raw ? JSON.parse(raw) : []
}

export function fingerprintDatabaseFamily(databasePath) {
  return ['main', 'wal', 'shm', 'journal'].map((kind) => {
    const filePath = kind === 'main' ? databasePath : `${databasePath}-${kind}`
    if (!existsSync(filePath)) return { kind, bytes: 0, sha256: null }
    const stats = statSync(filePath)
    return {
      kind,
      bytes: stats.size,
      mtimeMs: stats.mtimeMs,
      sha256: sha256File(filePath),
    }
  })
}

export function copyFrozenDatabaseFamily(sourcePath, targetPath) {
  const kindsToCopy = ['main', 'wal', 'journal']
  const targetPaths = ['main', 'wal', 'shm', 'journal'].map(
    (kind) => (kind === 'main' ? targetPath : `${targetPath}-${kind}`),
  )
  if (targetPaths.some((path) => existsSync(path))) {
    throw new Error('database_snapshot_target_not_fresh')
  }
  const cleanup = () => {
    for (const path of targetPaths) rmSync(path, { force: true })
  }
  try {
    const sourceBefore = fingerprintDatabaseFamily(sourcePath)
    if (!sourceBefore.find((entry) => entry.kind === 'main')?.sha256) {
      throw new Error('source_database_missing')
    }
    for (const kind of kindsToCopy) {
      const expected = sourceBefore.find((entry) => entry.kind === kind)
      if (!expected?.sha256) continue
      copyFileSync(
        kind === 'main' ? sourcePath : `${sourcePath}-${kind}`,
        kind === 'main' ? targetPath : `${targetPath}-${kind}`,
      )
    }
    const sourceAfter = fingerprintDatabaseFamily(sourcePath)
    if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
      throw new Error('source_database_changed_during_snapshot')
    }
    const snapshot = fingerprintDatabaseFamily(targetPath)
    for (const kind of kindsToCopy) {
      const expected = sourceBefore.find((entry) => entry.kind === kind)
      const actual = snapshot.find((entry) => entry.kind === kind)
      if (actual?.bytes !== expected?.bytes || actual?.sha256 !== expected?.sha256) {
        throw new Error('database_snapshot_identity_mismatch')
      }
    }
    if (snapshot.find((entry) => entry.kind === 'shm')?.sha256) {
      throw new Error('database_snapshot_shm_not_fresh')
    }
    return Object.freeze({ source: sourceBefore, snapshot })
  } catch (error) {
    cleanup()
    throw error
  }
}

export async function waitForStableDatabaseSnapshot(sourcePath, targetPath, options = {}) {
  if (existsSync(targetPath)) throw new Error(`database snapshot target already exists: ${targetPath}`)
  execFileSync(trustedSqlite3Path(), [sourcePath, `VACUUM INTO ${sqlQuote(targetPath)};`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
  let previous = null
  return waitForCondition(() => {
    if (!existsSync(targetPath) || statSync(targetPath).size === 0) return false
    const current = fingerprintDatabaseFamily(targetPath)
    const stable = previous !== null && JSON.stringify(current) === JSON.stringify(previous)
    previous = current
    return stable ? current : false
  }, {
    timeoutMs: options.timeoutMs || 30_000,
    pollMs: options.pollMs || 100,
    message: 'database snapshot did not become stable',
  })
}

export function seedProviderSettings(input) {
  const sourceDatabaseUri = `${pathToFileURL(input.sourceDatabasePath).href}?mode=ro`
  const sql = `
    PRAGMA journal_mode = DELETE;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    ATTACH DATABASE ${sqlQuote(sourceDatabaseUri)} AS source_db;
    INSERT INTO settings (key, value, updated_at)
      SELECT key, value, updated_at FROM source_db.settings
       WHERE key IN ('ai_provider_workspace', 'ai_model_config', 'ai_saved_configs');
    DETACH DATABASE source_db;
  `
  execFileSync(trustedSqlite3Path(), [input.databasePath, sql], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
  const count = Number(execFileSync(
    trustedSqlite3Path(),
    [input.databasePath, 'SELECT COUNT(*) FROM settings;'],
    { encoding: 'utf8' },
  ).trim())
  if (count < 1 || count > 3) throw new Error(`isolated provider seed count invalid: ${count}`)
  return count
}

export function normalizeHandshake(value) {
  return {
    ok: value?.success === true,
    proofNonce: value?.proofNonce,
    execPath: value?.execPath,
    execSha256: value?.execSha256,
    asarPath: value?.asarPath,
    asarSha256: value?.asarSha256,
    sourceManifestDigest: value?.sourceManifestDigest,
    appPath: value?.appPath,
    runtimeOutputManifestDigest: value?.runtimeOutputManifestDigest,
    userDataPath: value?.userDataPath,
    databasePath: value?.databasePath,
    appVersion: value?.appVersion,
  }
}

export function assertHandshake(value, expected) {
  if (!value?.success || value.proofNonce !== expected.proofNonce) {
    throw new Error('runtime handshake failed')
  }
  if (value.sourceManifestDigest !== expected.sourceManifestDigest) {
    throw new Error('embedded source manifest mismatch')
  }
  if (expected.appPath && (value.appPath !== expected.appPath
    || value.runtimeOutputManifestDigest !== expected.runtimeOutputManifestDigest)) {
    throw new Error('runtime output manifest mismatch')
  }
  if (value.execPath !== expected.executablePath
    || value.execSha256 !== expected.executableSha256
    || sha256File(expected.executablePath) !== expected.executableSha256) {
    throw new Error('runtime executable identity mismatch')
  }
  if (expected.packaged) {
    if (!value.asarPath || value.asarSha256 !== sha256File(value.asarPath)) {
      throw new Error('runtime asar identity mismatch')
    }
  } else if (value.asarPath || value.asarSha256) {
    throw new Error('development runtime unexpectedly reported a packaged asar')
  }
  if (value.userDataPath !== expected.userDataPath || value.databasePath !== expected.databasePath) {
    throw new Error('runtime isolation path mismatch')
  }
}

export async function enableAgentPanelHarness(cdp, remotePort, options = {}) {
  await waitForCondition(async () => {
    try {
      return await evaluateCdp(
        cdp,
        `document.readyState === 'complete' && Boolean(window.electronAPI)`,
        2_000,
      )
    } catch {
      return false
    }
  }, {
    timeoutMs: options.bootstrapTimeoutMs || 30_000,
    pollMs: 250,
    message: 'renderer bootstrap did not become ready',
  })
  const storageKey = options.storageKey || 'ready.agentPanelTest'
  await evaluateCdp(
    cdp,
    `(() => { localStorage.setItem(${JSON.stringify(storageKey)}, '1'); return true })()`,
  )
  await runCdpCommand(cdp, 'Page.reload', { ignoreCache: false })
  const requiredExpression = options.requiredExpression
    || `Boolean(window.__READY_AGENT_TEST__?.submit && window.electronAPI?.agent)`
  let active = cdp
  const deadline = Date.now() + (options.timeoutMs || 30_000)
  while (Date.now() < deadline) {
    try {
      if (await evaluateCdp(active, requiredExpression, 2_000)) return active
    } catch {
      active.close()
      active = await openCdp(remotePort, { timeoutMs: 10_000 })
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error('agent panel harness unavailable')
}

export async function openCdp(remotePort, options = {}) {
  const target = await waitForRendererTarget(remotePort, options.timeoutMs || 90_000)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    if (message.error) item.reject(new Error(message.error.message))
    else item.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const item of pending.values()) item.reject(new Error('CDP target closed'))
    pending.clear()
  })
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', rejectOpen, { once: true })
  })
  return {
    send(method, params = {}) {
      return new Promise((resolveSend, rejectSend) => {
        const id = ++nextId
        pending.set(id, { resolve: resolveSend, reject: rejectSend })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { socket.close() },
  }
}

export async function runCdpCommand(cdp, method, params = {}, timeoutMs = 30_000) {
  let timer
  try {
    return await Promise.race([
      cdp.send(method, params),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function evaluateCdp(cdp, expression, timeoutMs = 60_000) {
  const response = await runCdpCommand(cdp, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  }, timeoutMs)
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  }
  return response.result?.value
}

export function captureProcessCensus(options = {}) {
  const format = 'pid=,ppid=,pgid=,lstart=,command='
  const output = execFileSync('/bin/ps', options.includeEnvironment === true
    ? ['axeww', '-o', format]
    : ['axo', format], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const rows = parseMacProcessRows(output)
  const hasRootPid = Object.prototype.hasOwnProperty.call(options, 'rootPid')
  if (!hasRootPid) return rows
  if (!Number.isSafeInteger(options.rootPid) || options.rootPid <= 1) {
    throw new Error('process census rootPid must be a safe process id')
  }
  const included = new Set([options.rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!included.has(row.pid) && included.has(row.parentPid)) {
        included.add(row.pid)
        changed = true
      }
    }
  }
  return rows.filter((row) => included.has(row.pid)
    && (options.includeRoot !== false || row.pid !== options.rootPid))
}

export function captureDetachedDescendantProcessGroups(rootProcessRecord, census) {
  const currentRoot = census.find((row) => row.pid === rootProcessRecord.pid)
  if (!currentRoot) return { groupIds: [], records: [] }
  if (currentRoot.processStartIdentity !== rootProcessRecord.processStartIdentity
    || currentRoot.command !== rootProcessRecord.command
    || currentRoot.processGroupId !== rootProcessRecord.processGroupId) {
    throw new Error('root_process_identity_changed')
  }
  const descendantPids = new Set([rootProcessRecord.pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of census) {
      if (!descendantPids.has(row.pid) && descendantPids.has(row.parentPid)) {
        descendantPids.add(row.pid)
        changed = true
      }
    }
  }
  const groupIds = new Set(census.filter((row) => (
    row.pid !== rootProcessRecord.pid
      && descendantPids.has(row.pid)
      && Number.isSafeInteger(row.processGroupId)
      && row.processGroupId > 1
      && row.processGroupId !== rootProcessRecord.processGroupId
  )).map((row) => row.processGroupId))
  return {
    groupIds: [...groupIds],
    records: census.filter((row) => groupIds.has(row.processGroupId)),
  }
}

export async function assertRecordedProcessesExited(records, options = {}) {
  if (!Array.isArray(records)) throw new Error('recorded process census must be an array')
  let remaining = records
  try {
    await waitForCondition(() => {
      const currentByPid = new Map(captureProcessCensus().map((row) => [row.pid, row]))
      remaining = records.filter((record) => {
        const current = currentByPid.get(record.pid)
        return current?.processStartIdentity === record.processStartIdentity
          && current.command === record.command
      })
      return remaining.length === 0
    }, {
      timeoutMs: options.timeoutMs || 30_000,
      pollMs: options.pollMs || 250,
      message: 'recorded processes did not exit',
    })
  } catch {
    const identities = remaining.map((row) => row.processStartIdentity).join(', ')
    throw new Error(`recorded processes did not exit: ${identities}`)
  }
}

export async function waitForCondition(predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 30_000)
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.pollMs || 250))
  }
  const message = options.message || 'condition did not become true'
  throw new Error(lastError instanceof Error ? `${message}: ${lastError.message}` : message)
}

export function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

export function readJsonLines(filePath) {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

export function sanitizedRuntimeEnvironment(source) {
  const allowed = new Set([
    'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'NO_COLOR', 'PATH',
    'SHELL', 'TEMP', 'TERM', 'TMP', 'TMPDIR', 'TZ', 'USER', 'XDG_CONFIG_HOME',
  ])
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key, value]) => (
    allowed.has(key) && typeof value === 'string'
    ))),
    PATH: TRUSTED_RUNTIME_PATH,
  }
}

export function assertNoAmbientExecutionInjection(source) {
  const blocked = Object.keys(source).filter((key) => (
    key === 'NODE_OPTIONS' || key === 'NODE_PATH' || key === 'NODE_EXTRA_CA_CERTS'
      || key === 'ELECTRON_RUN_AS_NODE' || key === 'BASH_ENV' || key === 'ENV'
      || key === 'ZDOTDIR' || key.startsWith('DYLD_') || key.startsWith('LD_')
      || key.startsWith('SSL_CERT')
      || ['npm_config_node_options', 'npm_config_node_path', 'npm_config_script_shell']
        .includes(key.toLowerCase())
  ))
  if (blocked.length > 0) throw new Error('ambient_execution_injection_forbidden')
}

export async function closeChildProcess(childProcess, options = {}) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return { forced: false, exitCode: childProcess.exitCode, signalCode: childProcess.signalCode }
  }
  if (options.gracefulSignal) childProcess.kill(options.gracefulSignal)
  let timer
  const timedOut = await Promise.race([
    new Promise((resolveExit) => childProcess.once('exit', () => resolveExit(false))),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(true), options.timeoutMs || 30_000)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (!timedOut) {
    return { forced: false, exitCode: childProcess.exitCode, signalCode: childProcess.signalCode }
  }
  const exited = new Promise((resolveExit) => childProcess.once('exit', resolveExit))
  childProcess.kill(options.killSignal || 'SIGKILL')
  await exited
  return { forced: true, exitCode: childProcess.exitCode, signalCode: childProcess.signalCode }
}

async function waitForRendererTarget(remotePort, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${remotePort}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      })
      const targets = response.ok ? await response.json() : []
      const target = targets.find((item) => item.type === 'page'
        && item.webSocketDebuggerUrl
        && /\/index\.html(?:[?#].*)?$/.test(String(item.url || ''))
        && !/overlay/.test(String(item.url || '')))
      if (target) return target
    } catch {
      // The renderer target is not ready yet; continue bounded polling.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error('Ready renderer target unavailable')
}

function parseMacProcessRows(output) {
  return String(output).split('\n').flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/,
    )
    if (!match) return []
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const processGroupId = Number(match[3])
    if (![pid, parentPid, processGroupId].every(Number.isSafeInteger)) return []
    const startedAt = match.slice(4, 9).join(' ')
    return [{
      pid,
      parentPid,
      processGroupId,
      startedAt,
      processStartIdentity: `${pid}:${startedAt}`,
      command: match[9],
    }]
  })
}
