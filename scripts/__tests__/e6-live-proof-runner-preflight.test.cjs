'use strict'

const assert = require('node:assert/strict')
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const sourceRoot = resolve(__dirname, '../..')
const { createE6TestRuntime } = require('./helpers/e6-isolated-runtime.cjs')
const testRuntime = createE6TestRuntime(sourceRoot)
const root = testRuntime.root
process.chdir(root)
test.after(() => {
  process.chdir(sourceRoot)
  rmSync(testRuntime.directory, { recursive: true, force: true })
})
const runner = resolve(sourceRoot, 'scripts/run-codex-runtime-e6-live-proof.mjs')
const userScenarioRunner = resolve(sourceRoot, 'scripts/run-codex-runtime-e6-user-scenario.mjs')
const outputRoot = resolve(root, 'outputs/codex-runtime-e6')
const e6EnvKeys = Object.keys(process.env).filter((key) => key.startsWith('READY_CODEX_E6_'))
const {
  E6_AUTHORITY_ROOT,
  acquireE6GlobalLease,
  releaseE6GlobalLease,
} = require('../codex-runtime/e6-global-lease.cjs')
const { digestJson } = require('../codex-runtime/contract-lib.cjs')

function authorityPath(name) {
  mkdirSync(E6_AUTHORITY_ROOT, { recursive: true, mode: 0o700 })
  const stats = lstatSync(E6_AUTHORITY_ROOT)
  assert.equal(stats.isDirectory() && !stats.isSymbolicLink(), true)
  assert.equal(stats.uid, process.getuid())
  assert.equal(stats.mode & 0o777, 0o700)
  return join(E6_AUTHORITY_ROOT, name)
}

function outputEntries() {
  return existsSync(outputRoot) ? readdirSync(outputRoot).sort() : []
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fingerprint(path) {
  const stats = statSync(path)
  return { bytes: stats.size, mtimeMs: stats.mtimeMs, sha256: sha256File(path) }
}

function sidecarRuntimeIdentity() {
  const { sha256Canonical } = require('../codex-runtime/e6-live-proof-evidence.cjs')
  const runtimeManifest = JSON.parse(readFileSync(
    join(root, 'assets/codex-runtime/runtime-manifest.json'),
    'utf8',
  ))
  const executablePath = join(
    root,
    'build/codex',
    runtimeManifest.targetTriple,
    'codex',
  )
  const stats = lstatSync(executablePath)
  return {
    runtimeManifest,
    executablePath,
    marker: {
      runtimeManifestDigest: sha256Canonical(runtimeManifest),
      binarySha256: runtimeManifest.binarySha256,
      executablePath,
      fileIdentity: {
        device: String(stats.dev),
        inode: String(stats.ino),
        mode: stats.mode,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
      },
    },
  }
}

function baseEnv(databasePath, target) {
  const env = { ...process.env }
  for (const key of e6EnvKeys) delete env[key]
  return {
    ...env,
    OPENAI_API_KEY: 'provider-secret-canary',
    FEISHU_APP_SECRET: 'feishu-secret-canary',
    LARK_ACCESS_TOKEN: 'lark-secret-canary',
    READY_CODEX_E6_TARGET: target,
    READY_CODEX_REAL_DB_PATH: databasePath,
    READY_CODEX_E6_CHANNEL_ID: 'channel-opaque-canary',
    READY_CODEX_E6_DOC_TOKEN: 'feishu-document-opaque-canary',
    READY_CODEX_E6_DOC_TYPE: 'docx',
    READY_CODEX_E6_DOC_REF: 'LarkDocumentRef_1234',
    READY_CODEX_E6_FEISHU_LOGICAL_RESOURCE_ID: 'feishu:opaque-resource',
    READY_CODEX_E6_FEISHU_RESOURCE_VERSION: 'feishu-version-opaque',
    READY_CODEX_E6_FEISHU_RESOURCE_DIGEST: 'a'.repeat(64),
    READY_CODEX_E6_FEISHU_EXPECTED_ANSWER: 'FEISHU_OPAQUE_ANSWER_1234567890',
    READY_CODEX_E6_LARK_LOGICAL_RESOURCE_ID: 'lark:opaque-resource',
    READY_CODEX_E6_LARK_RESOURCE_VERSION: 'lark-version-opaque',
    READY_CODEX_E6_LARK_RESOURCE_DIGEST: 'b'.repeat(64),
    READY_CODEX_E6_LARK_EXPECTED_ANSWER: 'LARK_OPAQUE_ANSWER_1234567890',
    READY_CODEX_E6_POLICY_EPOCH: '1',
    READY_CODEX_E6_ITERATIONS: '3',
  }
}

function run(env) {
  return spawnSync(process.execPath, [...testRuntime.nodeArgs, runner], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
}

function runAsync(env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [...testRuntime.nodeArgs, runner], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', rejectRun)
    child.once('exit', (status, signal) => resolveRun({ status, signal, stdout, stderr }))
  })
}

function runUserScenarioAsync(databasePath) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('READY_CODEX_E6_')
      || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key]
  }
  Object.assign(env, {
    READY_CODEX_REAL_DB_PATH: databasePath,
    READY_CODEX_E6_SHEET_URL: 'https://ji3jaf9ul0l.feishu.cn/sheets/GfPlsXKO2hI3Sqtoh82c1i45nhf?from=from_copylink',
    READY_CODEX_E6_DOCX_URL: 'https://ji3jaf9ul0l.feishu.cn/docx/GedDd3EATovEz9xILmbcCTk5n4e?from=from_copylink',
  })
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [...testRuntime.nodeArgs, userScenarioRunner], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', rejectRun)
    child.once('exit', (status, signal) => resolveRun({ status, signal, stdout, stderr }))
  })
}

function assertNoCanaries(value) {
  for (const canary of [
    'provider-secret-canary',
    'feishu-secret-canary',
    'lark-secret-canary',
    'channel-opaque-canary',
    'feishu-document-opaque-canary',
    'LarkDocumentRef_1234',
    'FEISHU_OPAQUE_ANSWER_1234567890',
    'LARK_OPAQUE_ANSWER_1234567890',
  ]) assert.equal(value.includes(canary), false)
}

test('runner rejects before any effect when the contract is absent', () => {
  const env = { ...process.env }
  for (const key of e6EnvKeys) delete env[key]
  const before = outputEntries()
  const result = run(env)
  assert.equal(result.status, 2)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.code, 'missing_target')
  assert.deepEqual(report.effects, {
    providerRequests: 0,
    feishuReads: 0,
    larkReads: 0,
    sourceDatabaseOpens: 0,
    sourceDatabaseWrites: 0,
    processSpawns: 0,
  })
  assert.deepEqual(outputEntries(), before)
})

test('a concurrent E6 owner rejects the second runner before source or external effects', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-global-lease-'))
  const databasePath = join(fixtureRoot, 'ready.db')
  execFileSync('sqlite3', [databasePath, `
    CREATE TABLE agent_channels (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
      last_error TEXT, last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `])
  const lease = await acquireE6GlobalLease()
  try {
    assert.equal(lease.acquired, true)
    const beforeDatabase = fingerprint(databasePath)
    const beforeOutput = outputEntries()
    const result = run(baseEnv(databasePath, 'all'))
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
    const report = JSON.parse(result.stdout)
    assert.equal(report.code, 'e6_global_lease_busy')
    assert.equal(report.effects.providerRequests, 0)
    assert.equal(report.effects.feishuReads, 0)
    assert.equal(report.effects.larkReads, 0)
    assert.equal(report.effects.sourceDatabaseOpens, 0)
    assert.equal(report.effects.sourceDatabaseWrites, 0)
    assert.equal(report.effects.processSpawns, null)
    assert.deepEqual(fingerprint(databasePath), beforeDatabase)
    assert.deepEqual(outputEntries(), beforeOutput)
  } finally {
    await releaseE6GlobalLease(lease)
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('the global E6 lease is recovered only after the exact owner dies', async () => {
  const modulePath = join(root, 'scripts/codex-runtime/e6-global-lease.cjs')
  const ambientRoots = [
    mkdtempSync(join(tmpdir(), 'ready-e6-ambient-a-')),
    mkdtempSync(join(tmpdir(), 'ready-e6-ambient-b-')),
  ]
  const owner = spawn(process.execPath, [...testRuntime.nodeArgs, '-e', [
    `const { acquireE6GlobalLease } = require(${JSON.stringify(modulePath)})`,
    'acquireE6GlobalLease().then((lease) => {',
    "if (!lease.acquired) process.exit(2)",
    "process.stdout.write('READY\\n')",
    'setInterval(() => {}, 1000)',
    '}).catch(() => process.exit(3))',
  ].join(';')], {
    env: { ...process.env, TMPDIR: ambientRoots[0] },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolveReady, rejectReady) => {
      owner.stdout.on('data', (chunk) => {
        if (String(chunk).includes('READY')) resolveReady()
      })
      owner.once('error', rejectReady)
      owner.once('exit', (code) => rejectReady(new Error(`lease owner exited ${code}`)))
    })
    const ambientContender = spawnSync(process.execPath, [...testRuntime.nodeArgs, '-e', [
      `const { acquireE6GlobalLease, releaseE6GlobalLease } = require(${JSON.stringify(modulePath)})`,
      'acquireE6GlobalLease().then(async (lease) => {',
      "process.stdout.write(JSON.stringify({ acquired: lease.acquired, code: lease.code || null }))",
      'await releaseE6GlobalLease(lease)',
      '}).catch(() => process.exit(3))',
    ].join(';')], {
      env: { ...process.env, TMPDIR: ambientRoots[1] },
      encoding: 'utf8',
    })
    assert.equal(ambientContender.status, 0, ambientContender.stderr)
    assert.deepEqual(JSON.parse(ambientContender.stdout), {
      acquired: false,
      code: 'e6_global_lease_busy',
    })
    owner.kill('SIGKILL')
    await new Promise((resolveExit) => {
      if (owner.exitCode !== null || owner.signalCode !== null) resolveExit()
      else owner.once('exit', resolveExit)
    })
    const [recovered, contender] = await Promise.all([
      acquireE6GlobalLease(),
      acquireE6GlobalLease(),
    ])
    try {
      assert.deepEqual(
        [recovered, contender].map((lease) => lease.acquired).sort(),
        [false, true],
      )
    } finally {
      await releaseE6GlobalLease(recovered)
      await releaseE6GlobalLease(contender)
    }
  } finally {
    try { owner.kill('SIGKILL') } catch {
      // The simulated owner is expected to be dead.
    }
    for (const path of ambientRoots) rmSync(path, { recursive: true, force: true })
  }
})

test('the global E6 lease uses an isolated group and reports unexpected helper loss', async () => {
  const lease = await acquireE6GlobalLease()
  try {
    assert.equal(lease.acquired, true)
    const helperGroup = execFileSync('/bin/ps', [
      '-p', String(lease.helper.pid), '-o', 'pgid=',
    ], { encoding: 'utf8' }).trim()
    const ownerGroup = execFileSync('/bin/ps', [
      '-p', String(process.pid), '-o', 'pgid=',
    ], { encoding: 'utf8' }).trim()
    assert.equal(helperGroup, String(lease.helper.pid))
    assert.notEqual(helperGroup, ownerGroup)
    assert.deepEqual(await acquireE6GlobalLease(), {
      acquired: false,
      code: 'e6_global_lease_busy',
    })
    const lost = assert.rejects(lease.lost, /e6_global_lease_lost/)
    lease.helper.kill('SIGKILL')
    await lost
    lease.helper.stdin.destroy()
    const recovered = await acquireE6GlobalLease()
    try {
      assert.equal(recovered.acquired, true)
    } finally {
      await releaseE6GlobalLease(recovered)
    }
  } finally {
    try { lease.helper.stdin.destroy() } catch {}
    try { process.kill(-lease.helper.pid, 'SIGKILL') } catch {}
  }
})

test('trusted build launcher uses an isolated offline fixture', {
  timeout: 300_000,
}, async () => {
  const {
    assertTrustedBuildProvenance,
    prepareTrustedBuildToolchain,
    runTrustedNpmBuild,
    trustedElectronGypProvenance,
  } = await import('../codex-runtime/live-proof-runtime.mjs')
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-build-home-'))
  const homePath = join(fixtureRoot, 'home')
  const headerParent = join(homePath, '.electron-gyp')
  const toolchainBinPath = join(homePath, 'trusted-bin')
  const lease = await acquireE6GlobalLease()
  try {
    assert.equal(lease.acquired, true)
    mkdirSync(headerParent, { recursive: true })
    const headers = trustedElectronGypProvenance()
    cpSync(headers.root, join(headerParent, '42.3.0'), {
      recursive: true,
      verbatimSymlinks: true,
    })
    prepareTrustedBuildToolchain(toolchainBinPath)
    const before = assertTrustedBuildProvenance(root)
    await runTrustedNpmBuild({
      cwd: root,
      homePath,
      toolchainBinPath,
      processIdentityArgument: `ready-codex-e6-build-${'a'.repeat(40)}`,
      env: { E6_FIXTURE_SECRET: 'must-not-reach-build' },
    })
    assert.deepEqual(assertTrustedBuildProvenance(root), before)
    const launched = JSON.parse(readFileSync(join(root, 'out/launcher.json'), 'utf8'))
    assert.equal(launched.offline, 'true')
    assert.equal(launched.home, homePath)
    assert.equal(launched.userConfig, join(homePath, '.npmrc'))
    assert.equal(launched.globalConfig, join(homePath, '.npm-globalrc'))
    assert.equal(launched.sentinel, null)
  } finally {
    await releaseE6GlobalLease(lease)
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('frozen database copy reads live WAL data without changing the source shm', async () => {
  const {
    copyFrozenDatabaseFamily,
    fingerprintDatabaseFamily,
    sqliteJson,
  } = await import('../codex-runtime/live-proof-runtime.mjs')
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-live-wal-'))
  const databasePath = join(fixtureRoot, 'ready.db')
  const snapshotPath = join(fixtureRoot, 'snapshot.db')
  const writer = spawn('/usr/bin/sqlite3', [databasePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    const ready = new Promise((resolveReady, rejectReady) => {
      let stdout = ''
      writer.stdout.on('data', (chunk) => {
        stdout += String(chunk)
        if (stdout.includes('READY\n')) resolveReady()
      })
      writer.once('error', rejectReady)
      writer.once('exit', (code) => {
        if (!stdout.includes('READY\n')) rejectReady(new Error(`sqlite writer exited ${code}`))
      })
    })
    writer.stdin.write([
      'PRAGMA journal_mode=WAL;',
      'PRAGMA wal_autocheckpoint=0;',
      'CREATE TABLE proof (answer TEXT NOT NULL);',
      "INSERT INTO proof VALUES ('wal-answer');",
      '.print READY',
      '',
    ].join('\n'))
    await ready
    const sourceBefore = fingerprintDatabaseFamily(databasePath)
    const copied = copyFrozenDatabaseFamily(databasePath, snapshotPath)
    assert.deepEqual(copied.source, sourceBefore)
    assert.deepEqual(sqliteJson(snapshotPath, 'SELECT answer FROM proof;'), [{ answer: 'wal-answer' }])
    assert.deepEqual(fingerprintDatabaseFamily(databasePath), sourceBefore)
  } finally {
    writer.stdin.end()
    await new Promise((resolveExit) => {
      if (writer.exitCode !== null || writer.signalCode !== null) resolveExit()
      else writer.once('exit', resolveExit)
    })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('freezing Main preserves a pre-CAS detached child group for exact cleanup capture', async () => {
  const {
    captureDetachedDescendantProcessGroups,
    captureProcessCensus,
    freezeChildProcessForOwnershipCapture,
    waitForCondition,
  } = await import('../codex-runtime/live-proof-runtime.mjs')
  const parent = spawn(process.execPath, [...testRuntime.nodeArgs, '-e', [
    "const { spawn } = require('node:child_process')",
    "const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })",
    'process.stdout.write(`${child.pid}\\n`)',
    'setInterval(() => {}, 1000)',
  ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'] })
  let detachedPid = null
  try {
    detachedPid = await new Promise((resolvePid, rejectPid) => {
      let stdout = ''
      parent.stdout.on('data', (chunk) => {
        stdout += String(chunk)
        const line = stdout.split(/\r?\n/)[0]
        if (/^[1-9]\d*$/.test(line)) resolvePid(Number(line))
      })
      parent.once('error', rejectPid)
      parent.once('exit', (code) => rejectPid(new Error(`parent exited ${code}`)))
    })
    const rootRecord = await waitForCondition(() => (
      captureProcessCensus().find((row) => row.pid === parent.pid) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    await waitForCondition(() => (
      captureProcessCensus().some((row) => row.pid === detachedPid) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    freezeChildProcessForOwnershipCapture(parent)
    const captured = captureDetachedDescendantProcessGroups(rootRecord, captureProcessCensus())
    assert.equal(captured.groupIds.includes(detachedPid), true)
    assert.equal(captured.records.some((row) => row.pid === detachedPid), true)
  } finally {
    try { parent.kill('SIGKILL') } catch {
      // The parent may already have exited.
    }
    if (Number.isSafeInteger(detachedPid) && detachedPid > 1) {
      try { process.kill(-detachedPid, 'SIGKILL') } catch {
        // The exact detached group may already be gone.
      }
    }
    await new Promise((resolveExit) => {
      if (parent.exitCode !== null || parent.signalCode !== null) resolveExit()
      else parent.once('exit', resolveExit)
    })
  }
})

test('a new runner with another TMPDIR recovers live detached groups and sensitive files first', async () => {
  const {
    captureProcessCensus,
    waitForCondition,
  } = await import('../codex-runtime/live-proof-runtime.mjs')
  const { sha256Canonical } = require('../codex-runtime/e6-live-proof-evidence.cjs')
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-recovery-db-'))
  const ambientRoots = [
    mkdtempSync(join(tmpdir(), 'ready-e6-recovery-ambient-a-')),
    mkdtempSync(join(tmpdir(), 'ready-e6-recovery-ambient-b-')),
  ]
  const databasePath = join(fixtureRoot, 'ready.db')
  execFileSync('sqlite3', [databasePath, `
    CREATE TABLE agent_channels (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
      last_error TEXT, last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `])
  const proofId = 'c'.repeat(40)
  const abandonedRoot = authorityPath(`ready-codex-e6-${proofId}`)
  rmSync(abandonedRoot, { recursive: true, force: true })
  mkdirSync(abandonedRoot, { mode: 0o700 })
  mkdirSync(join(abandonedRoot, 'profile'), { mode: 0o700 })
  writeFileSync(join(abandonedRoot, 'profile', 'sensitive-profile.bin'), 'sensitive-profile-canary')
  writeFileSync(join(abandonedRoot, 'e6-raw-evidence.db'), 'sensitive-raw-canary')
  const mainScript = [
    "const { spawn } = require('node:child_process')",
    "const sidecar = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })",
    'process.stdout.write(`SIDECAR ${sidecar.pid}\\n`)',
    'setInterval(() => {}, 1000)',
  ].join(';')
  const oldRunner = spawn(process.execPath, [...testRuntime.nodeArgs, '-e', [
    "const { spawn } = require('node:child_process')",
    `const main = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(mainScript)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })`,
    'process.stdout.write(`MAIN ${main.pid}\\n`)',
    "main.stdout.on('data', (chunk) => process.stdout.write(chunk))",
    'setInterval(() => {}, 1000)',
  ].join(';')], {
    env: { ...process.env, TMPDIR: ambientRoots[0] },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let mainPid = null
  let sidecarPid = null
  try {
    await new Promise((resolvePids, rejectPids) => {
      let stdout = ''
      oldRunner.stdout.on('data', (chunk) => {
        stdout += String(chunk)
        mainPid = Number(stdout.match(/(?:^|\n)MAIN ([1-9]\d*)/)?.[1] || 0) || null
        sidecarPid = Number(stdout.match(/(?:^|\n)SIDECAR ([1-9]\d*)/)?.[1] || 0) || null
        if (mainPid && sidecarPid) resolvePids()
      })
      oldRunner.once('error', rejectPids)
      oldRunner.once('exit', (code) => rejectPids(new Error(`old runner exited ${code}`)))
    })
    const oldRunnerRecord = await waitForCondition(() => (
      captureProcessCensus().find((row) => row.pid === oldRunner.pid) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    const mainRecord = await waitForCondition(() => (
      captureProcessCensus().find((row) => row.pid === mainPid) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    oldRunner.kill('SIGKILL')
    await new Promise((resolveExit) => {
      if (oldRunner.exitCode !== null || oldRunner.signalCode !== null) resolveExit()
      else oldRunner.once('exit', resolveExit)
    })
    const runtimeManifest = JSON.parse(readFileSync(
      join(root, 'assets/codex-runtime/runtime-manifest.json'),
      'utf8',
    ))
    const executablePath = join(
      root,
      'build/codex',
      runtimeManifest.targetTriple,
      'codex',
    )
    const stats = lstatSync(executablePath)
    writeFileSync(join(abandonedRoot, 'e6-owner.json'), `${JSON.stringify({
      schemaVersion: 2,
      proofId,
      ownerUid: process.getuid(),
      ownerPid: oldRunnerRecord.pid,
      ownerProcessStartIdentity: oldRunnerRecord.processStartIdentity,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      spawnIntents: [],
      processRoots: [{
        kind: 'main',
        pid: mainRecord.pid,
        processGroupId: mainRecord.processGroupId,
        processStartIdentity: mainRecord.processStartIdentity,
        command: mainRecord.command,
      }],
      sidecarRuntime: {
        runtimeManifestDigest: sha256Canonical(runtimeManifest),
        binarySha256: runtimeManifest.binarySha256,
        executablePath,
        fileIdentity: {
          device: String(stats.dev),
          inode: String(stats.ino),
          mode: stats.mode,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
        },
      },
    })}\n`, { mode: 0o600 })
    const result = run({
      ...baseEnv(databasePath, 'all'),
      TMPDIR: ambientRoots[1],
    })
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
    assert.equal(JSON.parse(result.stdout).code, 'e6_feishu_channel_unavailable')
    assert.equal(existsSync(abandonedRoot), false)
    await waitForCondition(() => {
      const livePids = new Set(captureProcessCensus().map((row) => row.pid))
      return !livePids.has(mainPid) && !livePids.has(sidecarPid)
    }, { timeoutMs: 5_000, pollMs: 25 })
  } finally {
    if (Number.isSafeInteger(mainPid) && mainPid > 1) {
      try { process.kill(-mainPid, 'SIGKILL') } catch {
        // Recovery may already have terminated Main.
      }
    }
    if (Number.isSafeInteger(sidecarPid) && sidecarPid > 1) {
      try { process.kill(-sidecarPid, 'SIGKILL') } catch {
        // Recovery may already have terminated the exact sidecar group.
      }
    }
    try { oldRunner.kill('SIGKILL') } catch {
      // The simulated old runner is expected to be dead.
    }
    rmSync(abandonedRoot, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
    for (const path of ambientRoots) rmSync(path, { recursive: true, force: true })
  }
})

test('spawn intents recover build and Main groups before parent marker persistence', async (t) => {
  const { captureProcessCensus, waitForCondition } = await import(
    '../codex-runtime/live-proof-runtime.mjs'
  )
  for (const [kind, proofCharacter] of [['build', 'd'], ['main', 'e']]) {
    await t.test(kind, async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), `ready-e6-${kind}-intent-`))
      const databasePath = join(fixtureRoot, 'ready.db')
      execFileSync('sqlite3', [databasePath, `
        CREATE TABLE agent_channels (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
          enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
          last_error TEXT, last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `])
      const proofId = proofCharacter.repeat(40)
      const abandonedRoot = authorityPath(`ready-codex-e6-${proofId}`)
      rmSync(abandonedRoot, { recursive: true, force: true })
      mkdirSync(abandonedRoot, { mode: 0o700 })
      const oldRunner = spawn(process.execPath, [...testRuntime.nodeArgs, '-e', 'setInterval(() => {}, 1000)'])
      let orphan = null
      try {
        const owner = await waitForCondition(() => (
          captureProcessCensus().find((row) => row.pid === oldRunner.pid) || false
        ), { timeoutMs: 5_000, pollMs: 25 })
        const identityArgument = kind === 'build'
          ? `ready-codex-e6-build-${proofId}`
          : `--ready-e6-proof-id=${proofId}`
        orphan = spawn(process.execPath, [...testRuntime.nodeArgs,
          '-e', 'setInterval(() => {}, 1000)', identityArgument,
        ], { detached: true, stdio: 'ignore' })
        await waitForCondition(() => (
          captureProcessCensus().some((row) => row.pid === orphan.pid) || false
        ), { timeoutMs: 5_000, pollMs: 25 })
        oldRunner.kill('SIGKILL')
        await new Promise((resolveExit) => oldRunner.once('exit', resolveExit))
        writeFileSync(join(abandonedRoot, 'e6-owner.json'), `${JSON.stringify({
          schemaVersion: 2,
          proofId,
          ownerUid: process.getuid(),
          ownerPid: owner.pid,
          ownerProcessStartIdentity: owner.processStartIdentity,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          spawnIntents: [{
            kind,
            executablePath: process.execPath,
            identityArgument,
          }],
          processRoots: [],
          sidecarRuntime: kind === 'main' ? sidecarRuntimeIdentity().marker : null,
        })}\n`, { mode: 0o600 })
        const result = await runAsync(baseEnv(databasePath, 'all'))
        assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
        assert.equal(JSON.parse(result.stdout).code, 'e6_feishu_channel_unavailable')
        assert.equal(existsSync(abandonedRoot), false)
        await waitForCondition(() => !captureProcessCensus().some((row) => row.pid === orphan.pid), {
          timeoutMs: 5_000,
          pollMs: 25,
        })
      } finally {
        try { oldRunner.kill('SIGKILL') } catch {
          // The simulated owner is expected to be dead.
        }
        if (orphan?.pid) {
          try { process.kill(-orphan.pid, 'SIGKILL') } catch {
            // Recovery may already have terminated the exact group.
          }
        }
        rmSync(abandonedRoot, { recursive: true, force: true })
        rmSync(fixtureRoot, { recursive: true, force: true })
      }
    })
  }
})

test('the ordinary user-scenario runner recovers a Main spawn before parent capture', async () => {
  const { captureProcessCensus, waitForCondition } = await import(
    '../codex-runtime/live-proof-runtime.mjs'
  )
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-user-runner-recovery-'))
  const databasePath = join(fixtureRoot, 'ready.db')
  execFileSync('/usr/bin/sqlite3', [databasePath, `
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `])
  const proofId = '7'.repeat(40)
  const abandonedRoot = authorityPath(`ready-codex-e6-${proofId}`)
  rmSync(abandonedRoot, { recursive: true, force: true })
  mkdirSync(abandonedRoot, { mode: 0o700 })
  const oldOwner = spawn(process.execPath, [...testRuntime.nodeArgs, '-e', 'setInterval(() => {}, 1000)'])
  let orphan = null
  try {
    const owner = await waitForCondition(() => (
      captureProcessCensus().find((row) => row.pid === oldOwner.pid) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    const identityArgument = `--ready-e6-proof-id=${proofId}`
    orphan = spawn(process.execPath, [...testRuntime.nodeArgs,
      '-e', 'setInterval(() => {}, 1000)', identityArgument,
    ], { detached: true, stdio: 'ignore' })
    await waitForCondition(() => (
      captureProcessCensus().some((row) => row.pid === orphan.pid) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    writeFileSync(join(abandonedRoot, 'e6-owner.json'), `${JSON.stringify({
      schemaVersion: 2,
      proofId,
      ownerUid: process.getuid(),
      ownerPid: owner.pid,
      ownerProcessStartIdentity: owner.processStartIdentity,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      spawnIntents: [{
        kind: 'main',
        executablePath: process.execPath,
        identityArgument,
      }],
      processRoots: [],
      sidecarRuntime: sidecarRuntimeIdentity().marker,
    })}\n`, { mode: 0o600 })
    oldOwner.kill('SIGKILL')
    await new Promise((resolveExit) => oldOwner.once('exit', resolveExit))
    const result = await runUserScenarioAsync(databasePath)
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /e6_provider_identity_untrusted/)
    assert.equal(existsSync(abandonedRoot), false)
    await waitForCondition(() => !captureProcessCensus().some((row) => row.pid === orphan.pid), {
      timeoutMs: 5_000,
      pollMs: 25,
    })
  } finally {
    try { oldOwner.kill('SIGKILL') } catch {
      // The simulated owner is expected to be dead.
    }
    if (orphan?.pid) {
      try { process.kill(-orphan.pid, 'SIGKILL') } catch {
        // Recovery may already have terminated the exact group.
      }
    }
    rmSync(abandonedRoot, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('the ordinary user-scenario runner reconciles every abandoned confirmation release intent', async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-user-effect-recovery-'))
  const databasePath = join(fixtureRoot, 'ready.db')
  execFileSync('/usr/bin/sqlite3', [databasePath, `
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `])
  for (const [index, stage] of ['sheet_insert', 'sheet_write', 'docx_write'].entries()) {
    await t.test(stage, async () => {
      const proofId = String(index + 1).repeat(40)
      const abandonedRoot = authorityPath(`ready-codex-e6-${proofId}`)
      rmSync(abandonedRoot, { recursive: true, force: true })
      mkdirSync(abandonedRoot, { mode: 0o700 })
      writeFileSync(join(abandonedRoot, 'e6-owner.json'), `${JSON.stringify({
        schemaVersion: 2,
        proofId,
        ownerUid: process.getuid(),
        ownerPid: process.pid,
        ownerProcessStartIdentity: `${process.pid}:fixture-owner-is-dead`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        spawnIntents: [],
        processRoots: [],
        sidecarRuntime: null,
        userScenario: {
          schemaVersion: 1,
          proofMode: 'ordinary-agent-lark-cli-two-resource-write-readback',
          proofId,
          sheetReferenceDigest: digestJson('https://ji3jaf9ul0l.feishu.cn/sheets/GfPlsXKO2hI3Sqtoh82c1i45nhf?from=from_copylink'),
          docxReferenceDigest: digestJson('https://ji3jaf9ul0l.feishu.cn/docx/GedDd3EATovEz9xILmbcCTk5n4e?from=from_copylink'),
          cliIdentity: {
            architecture: 'arm64',
            authorityDigest: digestJson('cli-authority'),
            autoInstallForbidden: true,
            launcherCount: 1,
            payloadSha256: digestJson('cli-payload'),
            version: 'lark-cli version 1.0.76',
            wrapperExecutionForbidden: true,
          },
          releaseIntents: [{
            stage,
            frozenCallId: `frozen-${stage}`,
            readyRunId: `run-${stage}`,
            scopeId: 'scope-user-effect-recovery',
            paramsCanonicalSha256: digestJson({ stage }),
            targetReferenceDigest: digestJson(stage === 'docx_write'
              ? 'https://ji3jaf9ul0l.feishu.cn/docx/GedDd3EATovEz9xILmbcCTk5n4e?from=from_copylink'
              : 'https://ji3jaf9ul0l.feishu.cn/sheets/GfPlsXKO2hI3Sqtoh82c1i45nhf?from=from_copylink'),
            authIdentity: {
              principalDigest: digestJson('principal'),
              scopeDigest: digestJson('scope'),
              statusDigest: digestJson('status'),
            },
            ...(stage === 'sheet_insert' ? {
              sheetSelector: { key: 'sheet_id', value: 'ed9d44' },
              sheetSelectorDigest: digestJson({ key: 'sheet_id', value: 'ed9d44' }),
              position: 'V',
              columnCountBefore: 21,
              revisionBefore: 46,
              preInsertStructureContentDigest: digestJson('pre-insert-structure'),
              preInsertTemplateContentDigest: digestJson('pre-insert-template'),
              templateStyleDigest: digestJson('template-style'),
            } : {}),
            ...(stage === 'sheet_write' ? {
              sheetSelector: { key: 'sheet_id', value: 'ed9d44' },
              sheetSelectorDigest: digestJson({ key: 'sheet_id', value: 'ed9d44' }),
              range: 'V1',
              sentinelDigest: digestJson(`E6-READY-${proofId.slice(0, 16)}`),
              columnCountBefore: 21,
              revisionBefore: 46,
              columnCountAfterInsert: 22,
              revisionAfterInsert: 47,
              preInsertStructureContentDigest: digestJson('pre-insert-structure'),
              preInsertTemplateContentDigest: digestJson('pre-insert-template'),
              postInsertTemplateContentDigest: digestJson('post-insert-template'),
              templateStyleDigest: digestJson('template-style'),
            } : {}),
            ...(stage === 'docx_write' ? {
              revisionBefore: 7,
              patternDigest: digestJson('pattern'),
              patternLength: 20,
              visibleContentDigest: digestJson('visible'),
              visibleContentLength: 20,
              beforeContentDigest: digestJson('before'),
              expectedAfterContentDigest: digestJson('after'),
              documentTokenDigest: digestJson('doc-token'),
            } : {}),
            createdAt: new Date().toISOString(),
          }],
        },
      })}\n`, { mode: 0o600 })
      try {
        const result = await runUserScenarioAsync(databasePath)
        assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
        assert.match(result.stderr, /e6_user_scenario_abandoned_effect_reconciliation_required/)
        assert.equal(existsSync(abandonedRoot), false)
        const reconciliationPath = join(
          outputRoot, proofId, 'e6-effect-reconciliation.json',
        )
        assert.equal(existsSync(reconciliationPath), true)
        assert.equal(JSON.parse(readFileSync(reconciliationPath, 'utf8')).status, 'effect_unknown')
      } finally {
        rmSync(abandonedRoot, { recursive: true, force: true })
        rmSync(join(outputRoot, proofId), { recursive: true, force: true })
      }
    })
  }
  await t.test('extra sensitive recovery fields are rejected before retention', async () => {
    const proofId = '9'.repeat(40)
    const abandonedRoot = authorityPath(`ready-codex-e6-${proofId}`)
    rmSync(abandonedRoot, { recursive: true, force: true })
    mkdirSync(abandonedRoot, { mode: 0o700 })
    writeFileSync(join(abandonedRoot, 'e6-owner.json'), `${JSON.stringify({
      schemaVersion: 2,
      proofId,
      ownerUid: process.getuid(),
      ownerPid: process.pid,
      ownerProcessStartIdentity: `${process.pid}:fixture-owner-is-dead`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      spawnIntents: [],
      processRoots: [],
      sidecarRuntime: null,
      userScenario: {
        schemaVersion: 1,
        proofMode: 'ordinary-agent-lark-cli-two-resource-write-readback',
        proofId,
        sheetReferenceDigest: digestJson('https://ji3jaf9ul0l.feishu.cn/sheets/GfPlsXKO2hI3Sqtoh82c1i45nhf?from=from_copylink'),
        docxReferenceDigest: digestJson('https://ji3jaf9ul0l.feishu.cn/docx/GedDd3EATovEz9xILmbcCTk5n4e?from=from_copylink'),
        cliIdentity: {
          architecture: 'arm64',
          authorityDigest: digestJson('cli-authority'),
          autoInstallForbidden: true,
          launcherCount: 1,
          payloadSha256: digestJson('cli-payload'),
          version: 'lark-cli version 1.0.76',
          wrapperExecutionForbidden: true,
        },
        releaseIntents: [{
          stage: 'sheet_insert',
          frozenCallId: 'frozen-secret',
          readyRunId: 'run-secret',
          scopeId: 'scope-secret',
          paramsCanonicalSha256: digestJson('params'),
          targetReferenceDigest: digestJson('https://ji3jaf9ul0l.feishu.cn/sheets/GfPlsXKO2hI3Sqtoh82c1i45nhf?from=from_copylink'),
          authIdentity: {
            principalDigest: digestJson('principal'),
            scopeDigest: digestJson('scope'),
            statusDigest: digestJson('status'),
          },
          sheetSelector: { key: 'sheet_id', value: 'ed9d44' },
          sheetSelectorDigest: digestJson({ key: 'sheet_id', value: 'ed9d44' }),
          position: 'V',
          columnCountBefore: 21,
          revisionBefore: 46,
          accessToken: 'Bearer should-never-be-retained',
          createdAt: new Date().toISOString(),
        }],
      },
    })}\n`, { mode: 0o600 })
    try {
      const result = await runUserScenarioAsync(databasePath)
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, /e6_user_scenario_recovery_marker_invalid/)
      assert.equal(existsSync(join(
        outputRoot, proofId, 'e6-effect-reconciliation.json',
      )), false)
    } finally {
      rmSync(abandonedRoot, { recursive: true, force: true })
      rmSync(join(outputRoot, proofId), { recursive: true, force: true })
    }
  })
  rmSync(fixtureRoot, { recursive: true, force: true })
})

test('a SIGKILL-abandoned markerless staging root cannot block later runners', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-markerless-staging-'))
  const databasePath = join(fixtureRoot, 'ready.db')
  execFileSync('sqlite3', [databasePath, `
    CREATE TABLE agent_channels (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
      last_error TEXT, last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `])
  const proofId = '8'.repeat(40)
  const abandonedOwner = spawn(process.execPath, [...testRuntime.nodeArgs, '-e', [
    "const { mkdirSync } = require('node:fs')",
    `const { E6_AUTHORITY_ROOT } = require(${JSON.stringify(join(root, 'scripts/codex-runtime/e6-global-lease.cjs'))})`,
    "const { join } = require('node:path')",
    `mkdirSync(join(E6_AUTHORITY_ROOT, 'ready-codex-e6-staging-${proofId}-' + process.pid), { mode: 0o700 })`,
    "process.stdout.write('READY\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'] })
  const stagingPath = join(
    E6_AUTHORITY_ROOT,
    `ready-codex-e6-staging-${proofId}-${abandonedOwner.pid}`,
  )
  try {
    await new Promise((resolveReady, rejectReady) => {
      abandonedOwner.stdout.on('data', (chunk) => {
        if (String(chunk).includes('READY')) resolveReady()
      })
      abandonedOwner.once('error', rejectReady)
      abandonedOwner.once('exit', (code) => rejectReady(new Error(`owner exited ${code}`)))
    })
    assert.equal(existsSync(stagingPath), true)
    abandonedOwner.kill('SIGKILL')
    await new Promise((resolveExit) => abandonedOwner.once('exit', resolveExit))
    const result = await runAsync(baseEnv(databasePath, 'all'))
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
    assert.equal(JSON.parse(result.stdout).code, 'e6_feishu_channel_unavailable')
    assert.equal(existsSync(stagingPath), false)
  } finally {
    try { abandonedOwner.kill('SIGKILL') } catch {
      // The simulated owner is expected to be dead.
    }
    rmSync(stagingPath, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('pre-CAS recovery owns exact same-group descendants but rejects crossed groups', async () => {
  const { selectMarkedPreCasCandidate } = await import(
    '../run-codex-runtime-e6-live-proof.mjs'
  )
  const runtime = { executablePath: '/tmp/codex' }
  const leader = { pid: 101, processGroupId: 101, command: '/tmp/codex app-server' }
  const child = { pid: 102, processGroupId: 101, command: '/usr/bin/git ls-remote' }
  assert.deepEqual(selectMarkedPreCasCandidate([leader, child], runtime), [leader])
  assert.throws(
    () => selectMarkedPreCasCandidate([
      leader,
      { ...child, pid: 103, processGroupId: 103 },
    ], runtime),
    /e6_pre_cas_sidecar_identity_mismatch/,
  )
})

test('a Main spawn intent recovers both pre-CAS and post-CAS sidecars after Main exits', async () => {
  const {
    captureProcessCensus,
    waitForCondition,
  } = await import(
    '../codex-runtime/live-proof-runtime.mjs'
  )
  const {
    initializeSensitiveRunRoot,
    updateSensitiveRootMarker,
  } = await import('../run-codex-runtime-e6-live-proof.mjs')
  const runtime = sidecarRuntimeIdentity()
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-pre-cas-sidecar-'))
  const databasePath = join(fixtureRoot, 'ready.db')
  const proofId = 'f'.repeat(40)
  const abandonedRoot = authorityPath(`ready-codex-e6-${proofId}`)
  const profilePath = join(abandonedRoot, 'profile')
  const stateDir = join(profilePath, 'codex-state')
  const processLeaseId = 'lease-pre-cas-e6'
  const sidecarSpawnInstanceId = 'spawn-pre-cas-e6'
  const connectionEpoch = 'epoch-pre-cas-e6'
  const postCasProcessLeaseId = 'lease-post-cas-e6'
  const postCasSpawnInstanceId = 'spawn-post-cas-e6'
  const postCasConnectionEpoch = 'epoch-post-cas-e6'
  const exitedProcessLeaseId = 'lease-post-cas-exited-e6'
  const exitedSpawnInstanceId = 'spawn-post-cas-exited-e6'
  const exitedConnectionEpoch = 'epoch-post-cas-exited-e6'
  rmSync(abandonedRoot, { recursive: true, force: true })
  initializeSensitiveRunRoot(abandonedRoot, proofId)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  execFileSync('sqlite3', [databasePath, `
    CREATE TABLE agent_channels (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
      last_error TEXT, last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `])
  const isolatedDatabasePath = join(profilePath, 'ready.db')
  execFileSync('sqlite3', [isolatedDatabasePath, `
    CREATE TABLE codex_sidecar_process_leases (
      process_lease_id TEXT PRIMARY KEY, sidecar_spawn_instance_id TEXT NOT NULL,
      connection_epoch TEXT NOT NULL, isolated_state_dir TEXT NOT NULL,
      owner_main_pid INTEGER NOT NULL, owner_main_process_start_identity TEXT NOT NULL,
      runtime_manifest_digest TEXT NOT NULL, binary_sha256 TEXT NOT NULL,
      executable_path TEXT NOT NULL, spawn_visibility_deadline_at TEXT NOT NULL,
      pid INTEGER, process_group_id INTEGER, process_start_identity TEXT,
      ownership_confirmed_at TEXT, closed_at TEXT, tree_zero_at TEXT,
      tree_zero_matcher_mode TEXT, stable_zero_sample_transcript_digest TEXT,
      tree_zero_evidence_digest TEXT, revision INTEGER NOT NULL, spawn_intent_at TEXT NOT NULL
    );
  `])
  const mainIdentityArgument = `--ready-e6-proof-id=${proofId}`
  const main = spawn(process.execPath, [...testRuntime.nodeArgs,
    '-e', 'setInterval(() => {}, 1000)', mainIdentityArgument,
  ], {
    detached: true,
    stdio: 'ignore',
  })
  let sidecar = null
  let postCasSidecar = null
  let exitedPostCasSidecar = null
  try {
    const mainRecord = await waitForCondition(() => (
      captureProcessCensus().find((row) => row.pid === main.pid) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    execFileSync('sqlite3', [isolatedDatabasePath, `
      INSERT INTO codex_sidecar_process_leases (
        process_lease_id, sidecar_spawn_instance_id, connection_epoch, isolated_state_dir,
        owner_main_pid, owner_main_process_start_identity, runtime_manifest_digest,
        binary_sha256, executable_path, spawn_visibility_deadline_at, revision, spawn_intent_at
      ) VALUES (
        '${processLeaseId}', '${sidecarSpawnInstanceId}', '${connectionEpoch}', '${stateDir}',
        ${mainRecord.pid}, '${mainRecord.processStartIdentity}',
        '${runtime.marker.runtimeManifestDigest}', '${runtime.marker.binarySha256}',
        '${runtime.executablePath}', '${new Date(Date.now() - 1_000).toISOString()}',
        1,
        '${new Date(Date.now() - 2_000).toISOString()}'
      );
    `])
    sidecar = spawn(runtime.executablePath, [
      'app-server', '--stdio', '--strict-config', '--disable', 'plugins', '--disable', 'remote_plugin',
    ], {
      cwd: stateDir,
      detached: true,
      env: {
        ...process.env,
        READY_CODEX_PROCESS_LEASE_ID: processLeaseId,
        READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID: sidecarSpawnInstanceId,
        READY_CODEX_CONNECTION_EPOCH: connectionEpoch,
        READY_CODEX_STATE_DIR: stateDir,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    await waitForCondition(() => captureProcessCensus({ includeEnvironment: true }).some(
      (row) => row.pid === sidecar.pid && row.command.includes(`READY_CODEX_PROCESS_LEASE_ID=${processLeaseId}`),
    ), { timeoutMs: 5_000, pollMs: 25 })
    postCasSidecar = spawn(runtime.executablePath, [
      'app-server', '--stdio', '--strict-config', '--disable', 'plugins', '--disable', 'remote_plugin',
    ], {
      cwd: stateDir,
      detached: true,
      env: {
        ...process.env,
        READY_CODEX_PROCESS_LEASE_ID: postCasProcessLeaseId,
        READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID: postCasSpawnInstanceId,
        READY_CODEX_CONNECTION_EPOCH: postCasConnectionEpoch,
        READY_CODEX_STATE_DIR: stateDir,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    const postCasRecord = await waitForCondition(() => (
      captureProcessCensus({ includeEnvironment: true }).find((row) => (
        row.pid === postCasSidecar.pid
          && row.command.includes(`READY_CODEX_PROCESS_LEASE_ID=${postCasProcessLeaseId}`)
      )) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    execFileSync('sqlite3', [isolatedDatabasePath, `
      INSERT INTO codex_sidecar_process_leases (
        process_lease_id, sidecar_spawn_instance_id, connection_epoch, isolated_state_dir,
        owner_main_pid, owner_main_process_start_identity, runtime_manifest_digest,
        binary_sha256, executable_path, spawn_visibility_deadline_at,
        pid, process_group_id, process_start_identity, ownership_confirmed_at,
        revision, spawn_intent_at
      ) VALUES (
        '${postCasProcessLeaseId}', '${postCasSpawnInstanceId}', '${postCasConnectionEpoch}',
        '${stateDir}', ${mainRecord.pid}, '${mainRecord.processStartIdentity}',
        '${runtime.marker.runtimeManifestDigest}', '${runtime.marker.binarySha256}',
        '${runtime.executablePath}', '${new Date(Date.now() - 1_000).toISOString()}',
        ${postCasRecord.pid}, ${postCasRecord.processGroupId},
        '${postCasRecord.processStartIdentity}', '${new Date().toISOString()}',
        1, '${new Date(Date.now() - 2_000).toISOString()}'
      );
    `])
    exitedPostCasSidecar = spawn(
      runtime.executablePath,
      [
        'app-server', '--stdio', '--strict-config', '--disable', 'plugins', '--disable', 'remote_plugin',
      ],
      {
        cwd: stateDir,
        detached: true,
        env: {
          ...process.env,
          READY_CODEX_PROCESS_LEASE_ID: exitedProcessLeaseId,
          READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID: exitedSpawnInstanceId,
          READY_CODEX_CONNECTION_EPOCH: exitedConnectionEpoch,
          READY_CODEX_STATE_DIR: stateDir,
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    )
    const exitedRecord = await waitForCondition(() => (
      captureProcessCensus({ includeEnvironment: true }).find((row) => (
        row.pid === exitedPostCasSidecar.pid
          && row.command.includes(`READY_CODEX_PROCESS_LEASE_ID=${exitedProcessLeaseId}`)
      )) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    execFileSync('sqlite3', [isolatedDatabasePath, `
      INSERT INTO codex_sidecar_process_leases (
        process_lease_id, sidecar_spawn_instance_id, connection_epoch, isolated_state_dir,
        owner_main_pid, owner_main_process_start_identity, runtime_manifest_digest,
        binary_sha256, executable_path, spawn_visibility_deadline_at,
        pid, process_group_id, process_start_identity, ownership_confirmed_at,
        revision, spawn_intent_at
      ) VALUES (
        '${exitedProcessLeaseId}', '${exitedSpawnInstanceId}', '${exitedConnectionEpoch}',
        '${stateDir}', ${mainRecord.pid}, '${mainRecord.processStartIdentity}',
        '${runtime.marker.runtimeManifestDigest}', '${runtime.marker.binarySha256}',
        '${runtime.executablePath}', '${new Date(Date.now() - 1_000).toISOString()}',
        ${exitedRecord.pid}, ${exitedRecord.processGroupId},
        '${exitedRecord.processStartIdentity}', '${new Date().toISOString()}',
        1, '${new Date(Date.now() - 2_000).toISOString()}'
      );
    `])
    exitedPostCasSidecar.kill('SIGKILL')
    await new Promise((resolveExit) => {
      if (exitedPostCasSidecar.exitCode !== null
        || exitedPostCasSidecar.signalCode !== null) resolveExit()
      else exitedPostCasSidecar.once('exit', resolveExit)
    })
    main.kill('SIGKILL')
    await new Promise((resolveExit) => {
      if (main.exitCode !== null || main.signalCode !== null) resolveExit()
      else main.once('exit', resolveExit)
    })
    updateSensitiveRootMarker(abandonedRoot, proofId, {
      ownerPid: process.pid,
      ownerProcessStartIdentity: `${process.pid}:fixture-owner-is-dead`,
      spawnIntents: [{
        kind: 'main',
        executablePath: process.execPath,
        identityArgument: mainIdentityArgument,
      }],
      processRoots: [],
      sidecarRuntime: runtime.marker,
    })
    const result = await runAsync(baseEnv(databasePath, 'all'))
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
    assert.equal(JSON.parse(result.stdout).code, 'e6_feishu_channel_unavailable')
    assert.equal(existsSync(abandonedRoot), false)
    await waitForCondition(() => !captureProcessCensus().some((row) => (
      row.pid === sidecar.pid || row.pid === postCasSidecar.pid
    )), {
      timeoutMs: 5_000,
      pollMs: 25,
    })
  } finally {
    try { main.kill('SIGKILL') } catch {
      // The simulated Main is expected to be dead.
    }
    if (sidecar?.pid) {
      try { process.kill(-sidecar.pid, 'SIGKILL') } catch {
        // Recovery may already have terminated the exact group.
      }
    }
    if (postCasSidecar?.pid) {
      try { process.kill(-postCasSidecar.pid, 'SIGKILL') } catch {
        // Recovery may already have terminated the exact group.
      }
    }
    if (exitedPostCasSidecar?.pid) {
      try { process.kill(-exitedPostCasSidecar.pid, 'SIGKILL') } catch {
        // The fixture intentionally exits before recovery begins.
      }
    }
    rmSync(abandonedRoot, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('post-CAS recovery rejects a live sidecar with crossed lease markers without killing it', async () => {
  const { captureProcessCensus, waitForCondition } = await import(
    '../codex-runtime/live-proof-runtime.mjs'
  )
  const runtime = sidecarRuntimeIdentity()
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-post-cas-marker-'))
  const databasePath = join(fixtureRoot, 'ready.db')
  const proofId = '7'.repeat(40)
  const abandonedRoot = authorityPath(`ready-codex-e6-${proofId}`)
  const profilePath = join(abandonedRoot, 'profile')
  const stateDir = join(profilePath, 'codex-state')
  const isolatedDatabasePath = join(profilePath, 'ready.db')
  const mainIdentityArgument = `--ready-e6-proof-id=${proofId}`
  rmSync(abandonedRoot, { recursive: true, force: true })
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  execFileSync('sqlite3', [databasePath, `
    CREATE TABLE agent_channels (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
      last_error TEXT, last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `])
  execFileSync('sqlite3', [isolatedDatabasePath, `
    CREATE TABLE codex_sidecar_process_leases (
      process_lease_id TEXT PRIMARY KEY, sidecar_spawn_instance_id TEXT NOT NULL,
      connection_epoch TEXT NOT NULL, isolated_state_dir TEXT NOT NULL,
      owner_main_pid INTEGER NOT NULL, owner_main_process_start_identity TEXT NOT NULL,
      runtime_manifest_digest TEXT NOT NULL, binary_sha256 TEXT NOT NULL,
      executable_path TEXT NOT NULL, spawn_visibility_deadline_at TEXT NOT NULL,
      pid INTEGER, process_group_id INTEGER, process_start_identity TEXT,
      ownership_confirmed_at TEXT, closed_at TEXT, tree_zero_at TEXT,
      tree_zero_matcher_mode TEXT, stable_zero_sample_transcript_digest TEXT,
      tree_zero_evidence_digest TEXT, revision INTEGER NOT NULL, spawn_intent_at TEXT NOT NULL
    );
  `])
  const main = spawn(process.execPath, [...testRuntime.nodeArgs,
    '-e', 'setInterval(() => {}, 1000)', mainIdentityArgument,
  ], { detached: true, stdio: 'ignore' })
  let sidecar = null
  try {
    const mainRecord = await waitForCondition(() => (
      captureProcessCensus().find((row) => row.pid === main.pid) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    sidecar = spawn(runtime.executablePath, ['app-server', '--stdio', '--strict-config'], {
      cwd: stateDir,
      detached: true,
      env: {
        ...process.env,
        READY_CODEX_PROCESS_LEASE_ID: 'marker-cross-lease',
        READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID: 'marker-cross-actual-spawn',
        READY_CODEX_CONNECTION_EPOCH: 'marker-cross-epoch',
        READY_CODEX_STATE_DIR: stateDir,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    const sidecarRecord = await waitForCondition(() => (
      captureProcessCensus({ includeEnvironment: true }).find((row) => (
        row.pid === sidecar.pid
          && row.command.includes('READY_CODEX_PROCESS_LEASE_ID=marker-cross-lease')
      )) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    execFileSync('sqlite3', [isolatedDatabasePath, `
      INSERT INTO codex_sidecar_process_leases (
        process_lease_id, sidecar_spawn_instance_id, connection_epoch, isolated_state_dir,
        owner_main_pid, owner_main_process_start_identity, runtime_manifest_digest,
        binary_sha256, executable_path, spawn_visibility_deadline_at,
        pid, process_group_id, process_start_identity, ownership_confirmed_at,
        revision, spawn_intent_at
      ) VALUES (
        'marker-cross-lease', 'marker-cross-claimed-spawn', 'marker-cross-epoch',
        '${stateDir}', ${mainRecord.pid}, '${mainRecord.processStartIdentity}',
        '${runtime.marker.runtimeManifestDigest}', '${runtime.marker.binarySha256}',
        '${runtime.executablePath}', '${new Date(Date.now() - 1_000).toISOString()}',
        ${sidecarRecord.pid}, ${sidecarRecord.processGroupId},
        '${sidecarRecord.processStartIdentity}', '${new Date().toISOString()}',
        1, '${new Date(Date.now() - 2_000).toISOString()}'
      );
    `])
    main.kill('SIGKILL')
    await new Promise((resolveExit) => main.once('exit', resolveExit))
    writeFileSync(join(abandonedRoot, 'e6-owner.json'), `${JSON.stringify({
      schemaVersion: 2,
      proofId,
      ownerUid: process.getuid(),
      ownerPid: process.pid,
      ownerProcessStartIdentity: `${process.pid}:fixture-owner-is-dead`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      spawnIntents: [{
        kind: 'main', executablePath: process.execPath, identityArgument: mainIdentityArgument,
      }],
      processRoots: [],
      sidecarRuntime: runtime.marker,
    })}\n`, { mode: 0o600 })
    const result = await runAsync(baseEnv(databasePath, 'all'))
    assert.equal(result.status, 1)
    assert.equal(result.stderr.includes('e6_unhandled_main_failure'), true)
    assert.equal(existsSync(abandonedRoot), true)
    assert.equal(captureProcessCensus().some((row) => row.pid === sidecar.pid), true)
  } finally {
    try { main.kill('SIGKILL') } catch {
      // The simulated Main is expected to be dead.
    }
    if (sidecar?.pid) {
      try { process.kill(-sidecar.pid, 'SIGKILL') } catch {
        // The mismatched process is cleaned only by the fixture owner.
      }
    }
    rmSync(abandonedRoot, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('failed zero proof preserves recovery authority until the next runner can finish cleanup', async () => {
  const { captureProcessCensus, waitForCondition } = await import(
    '../codex-runtime/live-proof-runtime.mjs'
  )
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-retained-recovery-'))
  const databasePath = join(fixtureRoot, 'ready.db')
  execFileSync('sqlite3', [databasePath, `
    CREATE TABLE agent_channels (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
      last_error TEXT, last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `])
  const proofId = '9'.repeat(40)
  const abandonedRoot = authorityPath(`ready-codex-e6-${proofId}`)
  rmSync(abandonedRoot, { recursive: true, force: true })
  mkdirSync(abandonedRoot, { mode: 0o700 })
  const orphan = spawn(process.execPath, [...testRuntime.nodeArgs, '-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  try {
    const orphanRecord = await waitForCondition(() => (
      captureProcessCensus().find((row) => row.pid === orphan.pid) || false
    ), { timeoutMs: 5_000, pollMs: 25 })
    writeFileSync(join(abandonedRoot, 'e6-owner.json'), `${JSON.stringify({
      schemaVersion: 2,
      proofId,
      ownerUid: process.getuid(),
      ownerPid: process.pid,
      ownerProcessStartIdentity: `${process.pid}:fixture-owner-is-dead`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      spawnIntents: [],
      processRoots: [{ ...orphanRecord, kind: 'build' }],
      sidecarRuntime: null,
    })}\n`, { mode: 0o600 })

    // spawnSync intentionally prevents this parent from reaping its child while
    // the first runner proves process-group zero.
    const first = run(baseEnv(databasePath, 'all'))
    assert.equal(first.status, 1)
    assert.equal(existsSync(abandonedRoot), true)
    await new Promise((resolveTick) => setImmediate(resolveTick))
    await waitForCondition(() => !captureProcessCensus().some((row) => row.pid === orphan.pid), {
      timeoutMs: 5_000,
      pollMs: 25,
    })

    const second = await runAsync(baseEnv(databasePath, 'all'))
    assert.equal(second.status, 2, `${second.stdout}\n${second.stderr}`)
    assert.equal(JSON.parse(second.stdout).code, 'e6_feishu_channel_unavailable')
    assert.equal(existsSync(abandonedRoot), false)
  } finally {
    try { process.kill(-orphan.pid, 'SIGKILL') } catch {
      // Cleanup may already have terminated the exact group.
    }
    rmSync(abandonedRoot, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('preflight-only validates both resources without opening SQLite or creating output', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-runner-preflight-'))
  const databasePath = join(fixtureRoot, 'ready.db')
  execFileSync('sqlite3', [databasePath, 'CREATE TABLE marker (id INTEGER);'])
  try {
    const beforeOutput = outputEntries()
    const beforeDatabase = fingerprint(databasePath)
    const result = run(baseEnv(databasePath, 'preflight-only'))
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    const report = JSON.parse(result.stdout)
    assert.equal(report.ok, true)
    assert.equal(report.target, 'preflight-only')
    assert.deepEqual(report.intendedRuns, { feishu: 0, lark: 0 })
    assert.equal(report.effects.sourceDatabaseOpens, 0)
    assertNoCanaries(result.stdout)
    assert.deepEqual(fingerprint(databasePath), beforeDatabase)
    assert.deepEqual(outputEntries(), beforeOutput)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('missing enabled Feishu channel stops before build, provider, or external reads', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-runner-channel-'))
  const databasePath = join(fixtureRoot, 'ready.db')
  execFileSync('sqlite3', [databasePath, `
    CREATE TABLE agent_channels (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
      last_error TEXT, last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `])
  try {
    const beforeOutput = outputEntries()
    const beforeDatabase = fingerprint(databasePath)
    const result = run(baseEnv(databasePath, 'all'))
    assert.equal(result.status, 2)
    assert.equal(result.stderr, '')
    const report = JSON.parse(result.stdout)
    assert.equal(report.code, 'e6_feishu_channel_unavailable')
    assert.equal(report.effects.providerRequests, 0)
    assert.equal(report.effects.feishuReads, 0)
    assert.equal(report.effects.larkReads, 0)
    assert.equal(report.effects.sourceDatabaseOpens, 0)
    assert.equal(report.effects.sourceDatabaseWrites, 0)
    assert.equal(report.effects.processSpawns, null)
    assert.equal(report.details.processSpawnObservationVerified, false)
    assertNoCanaries(result.stdout)
    assert.deepEqual(fingerprint(databasePath), beforeDatabase)
    assert.deepEqual(outputEntries(), beforeOutput)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('runtime child environment drops provider, connector, and host capability credentials', async () => {
  const {
    assertNoAmbientExecutionInjection,
    assertTrustedPublicHttpsEndpoint,
    sanitizedRuntimeEnvironment,
  } = await import('../codex-runtime/live-proof-runtime.mjs')
  assert.deepEqual(sanitizedRuntimeEnvironment({
    PATH: '/safe/bin',
    TMPDIR: '/safe/tmp',
    OPENAI_API_KEY: 'provider-secret',
    FEISHU_APP_SECRET: 'connector-secret',
    LARK_ACCESS_TOKEN: 'user-token',
    SSH_AUTH_SOCK: '/private/socket',
    AWS_ACCESS_KEY_ID: 'access-key',
    READY_CODEX_REAL_DB_PATH: '/private/source.db',
    READY_CODEX_E6_DOC_REF: 'private-document-ref',
    READY_CODEX_E6_FEISHU_EXPECTED_ANSWER: 'private-proof-answer',
    READY_LIVE_SKIP_BUILD: '1',
    NODE_OPTIONS: '--require=/tmp/mock-provider-hook.cjs',
    NODE_PATH: '/tmp/mock-modules',
    NODE_EXTRA_CA_CERTS: '/tmp/mock-ca.pem',
    DYLD_INSERT_LIBRARIES: '/tmp/mock.dylib',
    ELECTRON_RUN_AS_NODE: '1',
    BASH_ENV: '/tmp/mock-shell-env',
    ENABLE_MOCK_SERVICES: 'true',
    READY_SIDECAR_PYTHON: '/tmp/fake-python',
    READY_PACKAGED_SKILL_RUNTIME_ROOT: '/tmp/fake-skills',
    READY_SKILL_RUNTIME_ROOT: '/tmp/fake-skills',
    NODE_ENV: 'test',
    VITEST: 'true',
    NODE_TEST_CONTEXT: 'child-v8',
    SAFE_SETTING: 'kept',
  }), {
    PATH: testRuntime.identities.TRUSTED_RUNTIME_PATH,
    TMPDIR: '/safe/tmp',
  })
  const publicEndpoint = await assertTrustedPublicHttpsEndpoint('https://1.1.1.1/v1', {
    allowedHosts: ['1.1.1.1'],
  })
  assert.equal(publicEndpoint.endpointClass, 'trusted_public_https')
  await assert.rejects(
    assertTrustedPublicHttpsEndpoint('https://127.0.0.1/v1', { allowedHosts: ['127.0.0.1'] }),
    /external_endpoint_not_public/,
  )
  await assert.rejects(
    assertTrustedPublicHttpsEndpoint('https://mock.example.com/v1', {
      allowedHosts: ['mock.example.com'],
    }),
    /external_endpoint_untrusted/,
  )
  await assert.rejects(
    assertTrustedPublicHttpsEndpoint('https://1.1.1.1/mock/v1', {
      allowedHosts: ['1.1.1.1'], allowedPathnames: ['/v1'],
    }),
    /external_endpoint_untrusted/,
  )
  await assert.rejects(
    assertTrustedPublicHttpsEndpoint('https://1.1.1.1/fixture', {
      allowedHosts: ['1.1.1.1'], allowedPathnames: ['/v1'],
    }),
    /external_endpoint_untrusted/,
  )
  assert.doesNotThrow(() => assertNoAmbientExecutionInjection({ PATH: '/safe/bin' }))
  assert.throws(
    () => assertNoAmbientExecutionInjection({ NODE_OPTIONS: '--require=/tmp/mock.js' }),
    /ambient_execution_injection_forbidden/,
  )
})

test('pins the complete fixture dependency tree, Electron payload, and sidecar Python probe', async () => {
  const {
    assertTrustedBuildProvenance,
    assertTrustedBuildToolchain,
    captureProcessCensus,
    prepareTrustedBuildToolchain,
    trustedElectronGypProvenance,
    trustedSidecarEnvironmentProvenance,
    trustedSidecarPythonProvenance,
    validatedChildProcessPid,
  } = await import('../codex-runtime/live-proof-runtime.mjs')
  const build = assertTrustedBuildProvenance(root)
  assert.equal(build.packageLockSha256, sha256File(resolve(root, 'package-lock.json')))
  assert.equal(build.dependencyEntryCount, testRuntime.identities.TRUSTED_NODE_MODULES.entryCount)
  assert.equal(build.electronExecutableSha256, sha256File(build.electronExecutablePath))
  const python = trustedSidecarPythonProvenance()
  assert.equal(python.version, 'Python 3.11.15')
  assert.equal(python.sslVersion, 'OpenSSL fixture')
  assert.equal(python.runtimeEntryCount, testRuntime.identities.TRUSTED_SIDECAR_PYTHON.runtimeEntryCount)
  const sidecar = trustedSidecarEnvironmentProvenance(root)
  assert.equal(sidecar.entryCount, testRuntime.identities.TRUSTED_SIDECAR_ENVIRONMENT.entryCount)
  assert.equal(sidecar.requirementsInstallDigest, 'fixture-install')
  const electronGyp = trustedElectronGypProvenance()
  assert.equal(electronGyp.entryCount, testRuntime.identities.TRUSTED_ELECTRON_GYP.entryCount)
  const toolchainRoot = mkdtempSync(join(tmpdir(), 'ready-e6-toolchain-'))
  try {
    const binPath = join(toolchainRoot, 'bin')
    const prepared = prepareTrustedBuildToolchain(binPath)
    assert.deepEqual(assertTrustedBuildToolchain(binPath), prepared)
  } finally {
    rmSync(toolchainRoot, { recursive: true, force: true })
  }
  assert.throws(() => captureProcessCensus({ rootPid: undefined }), /safe process id/)
  assert.throws(() => validatedChildProcessPid({ pid: undefined }), /child_process_pid_unavailable/)
  assert.equal(validatedChildProcessPid({ pid: process.pid }), process.pid)
})

test('dependency identity ignores only generated caches and detects dependency or Electron branding drift', async () => {
  const { computeTrustedNodeModulesIdentity } = await import(
    '../codex-runtime/live-proof-runtime.mjs'
  )
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-dependency-identity-'))
  try {
    const nodeModulesRoot = join(fixtureRoot, 'node_modules')
    const dependencyPath = join(nodeModulesRoot, 'fixture-package/index.js')
    const electronBrandPath = join(
      nodeModulesRoot,
      'electron/dist/Electron.app/Contents/Info.plist',
    )
    mkdirSync(join(nodeModulesRoot, '.cache'), { recursive: true })
    mkdirSync(join(nodeModulesRoot, '.vite'), { recursive: true })
    mkdirSync(join(nodeModulesRoot, 'better-sqlite3/build'), { recursive: true })
    mkdirSync(join(nodeModulesRoot, 'bufferutil/build'), { recursive: true })
    mkdirSync(join(nodeModulesRoot, 'utf-8-validate/build'), { recursive: true })
    mkdirSync(resolve(dependencyPath, '..'), { recursive: true })
    mkdirSync(resolve(electronBrandPath, '..'), { recursive: true })
    writeFileSync(dependencyPath, 'module.exports = "trusted"\n')
    writeFileSync(electronBrandPath, '<plist><string>Ready</string></plist>\n')
    const baseline = computeTrustedNodeModulesIdentity(fixtureRoot)

    writeFileSync(join(nodeModulesRoot, '.cache/tsc.tsbuildinfo'), 'generated cache')
    writeFileSync(join(nodeModulesRoot, '.vite/deps.json'), 'generated vite cache')
    writeFileSync(join(nodeModulesRoot, 'better-sqlite3/build/config.gypi'), 'generated native build')
    writeFileSync(join(nodeModulesRoot, 'bufferutil/build/bufferutil.node'), 'generated native build')
    writeFileSync(join(nodeModulesRoot, 'utf-8-validate/build/validation.node'), 'generated native build')
    assert.deepEqual(computeTrustedNodeModulesIdentity(fixtureRoot), baseline)

    writeFileSync(dependencyPath, 'module.exports = "drifted"\n')
    assert.notEqual(computeTrustedNodeModulesIdentity(fixtureRoot).digest, baseline.digest)
    writeFileSync(dependencyPath, 'module.exports = "trusted"\n')

    writeFileSync(electronBrandPath, '<plist><string>Drifted</string></plist>\n')
    assert.notEqual(computeTrustedNodeModulesIdentity(fixtureRoot).digest, baseline.digest)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})


test('production identities ignore fixture environment variables', () => {
  const result = spawnSync(process.execPath, ['-e',
    `process.stdout.write(JSON.stringify(require(${JSON.stringify(testRuntime.modulePath)})))`,
  ], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', READY_CODEX_E6_IDENTITY_PROFILE: testRuntime.bootstrap, READY_CODEX_E6_AUTHORITY_ROOT: testRuntime.directory, NODE_ENV: 'test' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), testRuntime.production)
  assert.notEqual(JSON.parse(result.stdout).E6_AUTHORITY_ROOT, testRuntime.identities.E6_AUTHORITY_ROOT)
})

test('isolated provenance rejects mutated fixture identities', async () => {
  const runtime = await import('../codex-runtime/live-proof-runtime.mjs')
  const cases = [
    [join(root, 'package-lock.json'), () => runtime.assertTrustedBuildProvenance(root), /package_lock_identity_mismatch/],
    [join(root, 'node_modules/fixture-package/index.js'), () => runtime.assertTrustedBuildProvenance(root), /node_modules_identity_mismatch/],
    [join(root, testRuntime.identities.TRUSTED_ELECTRON.relativePath), () => runtime.assertTrustedBuildProvenance(root), /node_modules_identity_mismatch|electron_identity_mismatch/],
    [join(testRuntime.identities.TRUSTED_SIDECAR_ENVIRONMENT.path, 'lib/site-packages/fixture.txt'), () => runtime.trustedSidecarEnvironmentProvenance(root), /sidecar_environment_identity_mismatch/],
    [testRuntime.identities.TRUSTED_SQLITE3.path, () => runtime.trustedSqlite3Path(), /sqlite3_identity_mismatch/],
  ]
  for (const [file, verify, expected] of cases) {
    const original = readFileSync(file)
    try {
      writeFileSync(file, 'tampered fixture identity')
      assert.throws(verify, expected)
    } finally { writeFileSync(file, original) }
    assert.doesNotThrow(verify)
  }
})


test('isolated recovery cannot read a real external CLI account', () => {
  const { runCurrentLarkCliRead } = require('../codex-runtime/e6-user-scenario-authority.cjs')
  assert.throws(() => runCurrentLarkCliRead(['auth', 'status', '--json', '--verify'], root), /e6_fixture_external_cli_forbidden/)
})
