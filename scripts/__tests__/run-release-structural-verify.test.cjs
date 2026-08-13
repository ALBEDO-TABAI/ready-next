'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const test = require('node:test')
const {
  RELEASE_STRUCTURAL_COMMANDS,
  createIsolatedReleaseWorktree,
  packagePinnedReleaseCommand,
  promoteVerifiedPackage,
  releaseChildEnvironment,
  removeReleaseHome,
  removeIsolatedReleaseWorktree,
  runStructuralSequence,
  stagePinnedDmgbuildArchive,
  stagePinnedElectronArchive,
} = require('../run-release-structural-verify.cjs')

test('isolated release source copies the dirty tree without mutating shared git metadata', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-release-clone-fixture-'))
  const git = '/Library/Developer/CommandLineTools/usr/bin/git'
  const gitEnv = {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: '/var/empty',
    LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin',
  }
  const run = (args) => execFileSync(git, args, { cwd: fixtureRoot, env: gitEnv, encoding: 'utf8' })
  let isolated = null
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'assets/codex-runtime'), { recursive: true })
    fs.mkdirSync(path.join(fixtureRoot, 'build/codex/aarch64-apple-darwin'), { recursive: true })
    fs.writeFileSync(path.join(fixtureRoot, '.gitignore'), 'build/codex/\nbuild/runtime-seeds/\n')
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), '{"version":"1.0.0"}\n')
    fs.writeFileSync(path.join(fixtureRoot, 'tracked.txt'), 'committed\n')
    fs.writeFileSync(path.join(fixtureRoot, 'deleted.txt'), 'delete me\n')
    const runtime = Buffer.from('pinned runtime')
    fs.writeFileSync(path.join(fixtureRoot, 'build/codex/aarch64-apple-darwin/codex'), runtime, { mode: 0o755 })
    fs.writeFileSync(path.join(fixtureRoot, 'assets/codex-runtime/runtime-manifest.json'), JSON.stringify({
      binarySha256: crypto.createHash('sha256').update(runtime).digest('hex'),
      binarySizeBytes: runtime.length,
    }))
    run(['init', '-b', 'fixture'])
    run(['add', '.'])
    run(['-c', 'user.name=Ready Release', '-c', 'user.email=release@ready.invalid', 'commit', '-m', 'fixture'])
    const head = run(['rev-parse', 'HEAD']).trim()
    fs.writeFileSync(path.join(fixtureRoot, 'tracked.txt'), 'dirty\n')
    fs.rmSync(path.join(fixtureRoot, 'deleted.txt'))
    fs.writeFileSync(path.join(fixtureRoot, 'untracked.sh'), '#!/bin/sh\n', { mode: 0o755 })

    isolated = createIsolatedReleaseWorktree(fixtureRoot)
    assert.equal(fs.readFileSync(path.join(isolated.worktree, 'tracked.txt'), 'utf8'), 'dirty\n')
    assert.equal(fs.existsSync(path.join(isolated.worktree, 'deleted.txt')), false)
    assert.equal(fs.readFileSync(path.join(isolated.worktree, 'untracked.sh'), 'utf8'), '#!/bin/sh\n')
    assert.notEqual(fs.statSync(path.join(isolated.worktree, 'untracked.sh')).mode & 0o111, 0)
    assert.equal(execFileSync(git, ['-C', isolated.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head)
    assert.equal(execFileSync(git, ['-C', isolated.worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'fixture')
    assert.equal(fs.readFileSync(path.join(isolated.worktree, 'build/runtime-seeds/ai-settings.seed.json'), 'utf8'), '{}\n')
  } finally {
    if (isolated?.worktree && fs.existsSync(isolated.worktree)) {
      removeIsolatedReleaseWorktree(fixtureRoot, isolated.worktree)
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('structural release checks runtime source before tests and packaging', () => {
  const labels = RELEASE_STRUCTURAL_COMMANDS.map((command) => command.label)
  assert.equal(labels[0], 'npm:ci')
  assert.equal(labels[1], 'prepare:pinned-electron')
  assert.equal(labels[2], 'verify:trusted-build-input')
  assert.equal(labels[3], 'verify:codex-runtime-source')
  assert(labels.indexOf('npm:ci') < labels.indexOf('verify:codex-runtime-source'))
  assert(labels.indexOf('verify:codex-runtime-source') < labels.indexOf('test:release-structural'))
  assert(labels.indexOf('verify:codex-runtime-source') < labels.indexOf('build'))
  assert(labels.indexOf('build') < labels.indexOf('package:dist'))
  for (const required of [
    'verify:version',
    'npm:ci',
    'prepare:pinned-electron',
    'verify:trusted-build-input',
    'typecheck',
    'lint:check',
    'verify:lint-budget',
    'check-eslint-baseline',
    'verify:ipc-contract',
    'verify:meta-paths',
    'verify:stability',
    'verify:streaming',
    'verify:native',
    'verify:codex-runtime-e2',
    'test:release-structural',
    'seed-safety',
    'build',
    'package:dist',
  ]) assert(labels.includes(required), `missing ${required}`)
})

test('release home stages the exact pinned Electron archive for offline install', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-electron-archive-'))
  try {
    const archivePath = path.join(fixtureRoot, 'fixture.zip')
    const releaseHome = path.join(fixtureRoot, 'home')
    const content = Buffer.from('pinned-electron-archive')
    fs.writeFileSync(archivePath, content)
    const identity = stagePinnedElectronArchive(releaseHome, {
      path: archivePath,
      cacheDirectory: 'official-cache',
      fileName: 'electron-v42.3.0-darwin-arm64.zip',
      bytes: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    })
    const environment = releaseChildEnvironment(releaseHome)
    assert.equal(identity.bytes, content.length)
    assert.equal(
      identity.path,
      path.join(environment.electron_config_cache, 'official-cache', 'electron-v42.3.0-darwin-arm64.zip'),
    )
    assert.equal(
      fs.readFileSync(path.join(environment.electron_config_cache, 'official-cache', 'electron-v42.3.0-darwin-arm64.zip'), 'utf8'),
      content.toString('utf8'),
    )
    fs.writeFileSync(identity.path, 'changed-electron-archive')
    assert.throws(() => identity.verify(), /changed before packaging/)
    assert.throws(() => stagePinnedElectronArchive(path.join(fixtureRoot, 'other-home'), {
      path: archivePath,
      cacheDirectory: 'official-cache',
      fileName: 'electron-v42.3.0-darwin-arm64.zip',
      bytes: content.length,
      sha256: '0'.repeat(64),
    }), /identity mismatch/)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('packaging reads the protected pinned Electron archive instead of downloading it', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-electron-dist-'))
  try {
    const archivePath = path.join(fixtureRoot, 'fixture.zip')
    const releaseHome = path.join(fixtureRoot, 'home')
    const content = Buffer.from('pinned-electron-archive')
    fs.writeFileSync(archivePath, content)
    const electron = stagePinnedElectronArchive(releaseHome, {
      path: archivePath,
      cacheDirectory: 'official-cache',
      fileName: 'electron-v42.3.0-darwin-arm64.zip',
      bytes: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    })
    const command = {
      cmd: process.execPath,
      args: ['node_modules/electron-builder/out/cli/cli.js', '--config', 'electron-builder.yml'],
    }
    const effective = packagePinnedReleaseCommand(command, {
      electron,
      sandboxProfile: path.join(releaseHome, 'package.sb'),
    })
    assert.equal(effective.cmd, '/usr/bin/sandbox-exec')
    assert(effective.args.includes(`--config.electronDist=${electron.path}`))
    assert.equal(effective.args.some((arg) => arg.includes('https://')), false)
    const { configureBuildCommand, createYargs, normalizeOptions } = require('electron-builder/out/builder')
    const builderArgs = effective.args.slice(effective.args.indexOf(command.cmd) + 2)
    const parsed = configureBuildCommand(createYargs()).parse(builderArgs)
    assert.equal(normalizeOptions(parsed).config.electronDist, electron.path)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('release home stages the exact pinned dmgbuild archive for offline packaging', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-dmgbuild-archive-'))
  try {
    const payloadRoot = path.join(fixtureRoot, 'payload')
    const archivePath = path.join(fixtureRoot, 'fixture.tar.gz')
    const releaseHome = path.join(fixtureRoot, 'home')
    fs.mkdirSync(payloadRoot, { recursive: true })
    fs.writeFileSync(path.join(payloadRoot, 'dmgbuild'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    fs.writeFileSync(path.join(payloadRoot, 'VERSION.txt'), 'fixture-version\n')
    const toolIdentity = require('../run-release-structural-verify.cjs').buildDirectoryIdentity(payloadRoot)
    require('node:child_process').execFileSync('/usr/bin/tar', ['-czf', archivePath, '-C', payloadRoot, '.'])
    const content = fs.readFileSync(archivePath)
    const identity = stagePinnedDmgbuildArchive(releaseHome, {
      path: archivePath,
      bytes: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      version: 'fixture-version',
      toolEntryCount: toolIdentity.entryCount,
      toolDigest: toolIdentity.digest,
      protectedToolDigest: (() => {
        require('node:child_process').execFileSync('/bin/chmod', ['-R', 'a-w', payloadRoot])
        const protectedIdentity = require('../run-release-structural-verify.cjs').buildDirectoryIdentity(payloadRoot)
        require('node:child_process').execFileSync('/bin/chmod', ['-R', 'u+w', payloadRoot])
        return protectedIdentity.digest
      })(),
    })
    const environment = releaseChildEnvironment(releaseHome)
    assert.equal(identity.archive.bytes, content.length)
    assert.match(fs.readFileSync(environment.CUSTOM_DMGBUILD_PATH, 'utf8'), /pinned dmgbuild identity mismatch/)
    assert.equal(
      fs.readFileSync(path.join(releaseHome, 'release-tools', 'dmgbuild-1.2.0', 'dmgbuild'), 'utf8'),
      '#!/bin/sh\nexit 0\n',
    )
    assert.notEqual(fs.statSync(environment.CUSTOM_DMGBUILD_PATH).mode & 0o111, 0)
    assert.throws(() => fs.writeFileSync(environment.CUSTOM_DMGBUILD_PATH, '#!/bin/sh\nexit 9\n'), /EPERM|operation not permitted/i)
    assert.throws(
      () => fs.writeFileSync(path.join(releaseHome, 'release-tools', 'dmgbuild-1.2.0', 'dmgbuild'), '#!/bin/sh\nexit 9\n'),
      /EPERM|operation not permitted/i,
    )
    identity.verify()
    assert.throws(() => stagePinnedDmgbuildArchive(path.join(fixtureRoot, 'other-home'), {
      path: archivePath,
      bytes: content.length,
      sha256: '0'.repeat(64),
      version: 'fixture-version',
      toolEntryCount: toolIdentity.entryCount,
      toolDigest: toolIdentity.digest,
      protectedToolDigest: toolIdentity.digest,
    }), /identity mismatch/)
  } finally {
    try { removeReleaseHome(path.join(fixtureRoot, 'home')) } catch {}
    try { removeReleaseHome(path.join(fixtureRoot, 'other-home')) } catch {}
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('the invoked dmgbuild wrapper rechecks the pinned tool at the execution boundary', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-dmgbuild-boundary-'))
  try {
    const payloadRoot = path.join(fixtureRoot, 'payload')
    const archivePath = path.join(fixtureRoot, 'fixture.tar.gz')
    const releaseHome = path.join(fixtureRoot, 'home')
    fs.mkdirSync(payloadRoot, { recursive: true })
    fs.writeFileSync(path.join(payloadRoot, 'dmgbuild'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    fs.writeFileSync(path.join(payloadRoot, 'VERSION.txt'), 'fixture-version\n')
    const toolIdentity = require('../run-release-structural-verify.cjs').buildDirectoryIdentity(payloadRoot)
    require('node:child_process').execFileSync('/bin/chmod', ['-R', 'a-w', payloadRoot])
    const protectedToolIdentity = require('../run-release-structural-verify.cjs').buildDirectoryIdentity(payloadRoot)
    require('node:child_process').execFileSync('/bin/chmod', ['-R', 'u+w', payloadRoot])
    require('node:child_process').execFileSync('/usr/bin/tar', ['-czf', archivePath, '-C', payloadRoot, '.'])
    const content = fs.readFileSync(archivePath)
    stagePinnedDmgbuildArchive(releaseHome, {
      path: archivePath,
      bytes: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      version: 'fixture-version',
      toolEntryCount: toolIdentity.entryCount,
      toolDigest: toolIdentity.digest,
      protectedToolDigest: protectedToolIdentity.digest,
    })
    const environment = releaseChildEnvironment(releaseHome)
    assert.equal(require('node:child_process').spawnSync(environment.CUSTOM_DMGBUILD_PATH, [], { encoding: 'utf8' }).status, 0)
    assert.throws(
      () => fs.writeFileSync(path.join(releaseHome, 'release-tools', 'dmgbuild-1.2.0', 'dmgbuild'), '#!/bin/sh\nexit 0\n# changed\n'),
      /EPERM|operation not permitted/i,
    )
    assert.equal(require('node:child_process').spawnSync(environment.CUSTOM_DMGBUILD_PATH, [], { encoding: 'utf8' }).status, 0)
  } finally {
    try { removeReleaseHome(path.join(fixtureRoot, 'home')) } catch {}
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('the package subprocess cannot use the network or write protected caches and release tools', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-package-sandbox-'))
  try {
    const releaseHome = path.join(fixtureRoot, 'home')
    const toolRoot = path.join(releaseHome, 'release-tools')
    const sharedCache = path.join(fixtureRoot, 'shared-cache')
    fs.mkdirSync(toolRoot, { recursive: true })
    fs.mkdirSync(sharedCache, { recursive: true })
    fs.writeFileSync(path.join(toolRoot, 'guard'), 'pinned')
    fs.writeFileSync(path.join(sharedCache, 'guard'), 'pinned')
    const profile = require('../run-release-structural-verify.cjs').packagingSandboxProfile(releaseHome, [sharedCache])
    const writeAttempt = require('node:child_process').spawnSync('/usr/bin/sandbox-exec', [
      '-f',
      profile,
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(toolRoot, 'guard'))}, 'changed')`,
    ], { encoding: 'utf8' })
    assert.notEqual(writeAttempt.status, 0)
    assert.equal(fs.readFileSync(path.join(toolRoot, 'guard'), 'utf8'), 'pinned')
    const renameAttempt = require('node:child_process').spawnSync('/usr/bin/sandbox-exec', [
      '-f',
      profile,
      process.execPath,
      '-e',
      `require('node:fs').renameSync(${JSON.stringify(toolRoot)}, ${JSON.stringify(`${toolRoot}.moved`)})`,
    ], { encoding: 'utf8' })
    assert.notEqual(renameAttempt.status, 0)
    assert.equal(fs.existsSync(toolRoot), true)
    const cacheAttempt = require('node:child_process').spawnSync('/usr/bin/sandbox-exec', [
      '-f',
      profile,
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(sharedCache, 'guard'))}, 'changed')`,
    ], { encoding: 'utf8' })
    assert.notEqual(cacheAttempt.status, 0)
    assert.equal(fs.readFileSync(path.join(sharedCache, 'guard'), 'utf8'), 'pinned')
    const networkAttempt = require('node:child_process').spawnSync('/usr/bin/sandbox-exec', [
      '-f',
      profile,
      process.execPath,
      '-e',
      "require('node:net').connect(80, '127.0.0.1').on('connect', () => process.exit(0)).on('error', (error) => { console.error(error.code); process.exit(7) })",
    ], { encoding: 'utf8', timeout: 5000 })
    assert.notEqual(networkAttempt.status, 0)
    assert.match(networkAttempt.stderr, /EPERM|Operation not permitted/)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('the package subprocess cannot replace the release home with a path alias', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-package-alias-'))
  try {
    const releaseHome = path.join(fixtureRoot, 'home')
    const evilHome = path.join(fixtureRoot, 'evil-home')
    const toolRoot = path.join(releaseHome, 'release-tools')
    const evilToolRoot = path.join(evilHome, 'release-tools')
    fs.mkdirSync(toolRoot, { recursive: true })
    fs.mkdirSync(evilToolRoot, { recursive: true })
    fs.writeFileSync(path.join(toolRoot, 'run-pinned-dmgbuild.cjs'), 'pinned')
    fs.writeFileSync(path.join(evilToolRoot, 'run-pinned-dmgbuild.cjs'), '#!/bin/sh\necho SYMLINK_PATH_BYPASS\n', { mode: 0o755 })
    const profile = require('../run-release-structural-verify.cjs').packagingSandboxProfile(releaseHome)
    const aliasAttempt = require('node:child_process').spawnSync('/usr/bin/sandbox-exec', [
      '-f',
      profile,
      process.execPath,
      '-e',
      [
        `const fs=require('node:fs')`,
        `fs.renameSync(${JSON.stringify(releaseHome)}, ${JSON.stringify(`${releaseHome}.moved`)})`,
        `fs.symlinkSync(${JSON.stringify(evilHome)}, ${JSON.stringify(releaseHome)})`,
      ].join(';'),
    ], { encoding: 'utf8' })
    assert.notEqual(aliasAttempt.status, 0)
    assert.equal(fs.lstatSync(releaseHome).isDirectory(), true)
    assert.equal(fs.readFileSync(path.join(toolRoot, 'run-pinned-dmgbuild.cjs'), 'utf8'), 'pinned')
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('release home cleanup removes recursively protected cache and tool files', () => {
  const releaseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-release-cleanup-'))
  const nested = path.join(releaseHome, 'Library', 'Caches', 'electron', 'archive.zip')
  fs.mkdirSync(path.dirname(nested), { recursive: true })
  fs.writeFileSync(nested, 'pinned')
  require('node:child_process').execFileSync('/bin/chmod', ['-R', 'a-w', releaseHome])
  require('node:child_process').execFileSync('/usr/bin/chflags', ['-R', 'uchg', releaseHome])
  removeReleaseHome(releaseHome)
  assert.equal(fs.existsSync(releaseHome), false)
})

function promotionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-promote-live-'))
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-promote-isolated-'))
  const artifactRel = 'exports/Ready-1.0.0-arm64.dmg'
  const artifact = Buffer.from('verified-dmg')
  const sha256 = crypto.createHash('sha256').update(artifact).digest('hex')
  const receiptRel = `exports/release-structural-receipts/${sha256}.json`
  const receipt = {
    receiptId: '12345678-1234-1234-1234-123456789abc',
    source: { digest: 'source' },
    runtimeManifestSha256: 'runtime',
    artifact: { path: artifactRel, bytes: artifact.length, sha256 },
  }
  fs.mkdirSync(path.join(isolatedRoot, 'exports/release-structural-receipts'), { recursive: true })
  fs.writeFileSync(path.join(isolatedRoot, artifactRel), artifact)
  fs.writeFileSync(path.join(isolatedRoot, receiptRel), JSON.stringify(receipt))
  return { root, isolatedRoot, artifactRel, receiptRel, receipt }
}

test('promotion creates fresh receipt directory and reads back the exact verified package', () => {
  const fixture = promotionFixture()
  const result = promoteVerifiedPackage({
    root: fixture.root,
    isolatedRoot: fixture.isolatedRoot,
    contract: { artifactRel: fixture.artifactRel },
    candidateReceipt: fixture.receipt,
    loadIdentity: () => ({ ok: true, receipt: fixture.receipt }),
  })
  assert.equal(result.receiptId, fixture.receipt.receiptId)
  assert.equal(fs.readFileSync(path.join(fixture.root, fixture.artifactRel), 'utf8'), 'verified-dmg')
  assert.equal(fs.existsSync(path.join(fixture.root, fixture.receiptRel)), true)
})

test('promotion rejects an exports symlink before writing outside the root', () => {
  const fixture = promotionFixture()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-promote-outside-'))
  fs.symlinkSync(outside, path.join(fixture.root, 'exports'))
  assert.throws(() => promoteVerifiedPackage({
    root: fixture.root,
    isolatedRoot: fixture.isolatedRoot,
    contract: { artifactRel: fixture.artifactRel },
    candidateReceipt: fixture.receipt,
  }), /trusted output directory|symlink|physical/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('promotion rejects a corrupted copy and leaves the prior package untouched', () => {
  const fixture = promotionFixture()
  const destination = path.join(fixture.root, fixture.artifactRel)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, 'prior-dmg')
  const copyFile = (source, target, flags) => {
    fs.copyFileSync(source, target, flags)
    if (String(source).endsWith('.dmg') && String(target).endsWith('.dmg')) fs.writeFileSync(target, 'corrupted')
  }
  assert.throws(() => promoteVerifiedPackage({
    root: fixture.root,
    isolatedRoot: fixture.isolatedRoot,
    contract: { artifactRel: fixture.artifactRel },
    candidateReceipt: fixture.receipt,
    copyFile,
  }), /promoted DMG does not match/)
  assert.equal(fs.readFileSync(destination, 'utf8'), 'prior-dmg')
})

test('promotion rejects selective receipt corruption and restores the prior package', () => {
  const fixture = promotionFixture()
  const destination = path.join(fixture.root, fixture.artifactRel)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, 'prior-dmg')
  const copyFile = (source, target, flags) => {
    fs.copyFileSync(source, target, flags)
    if (String(source).endsWith('.json') && String(target).endsWith('.json')) {
      const value = JSON.parse(fs.readFileSync(target, 'utf8'))
      value.verification = { appExecutableSha256: 'forged-but-nonempty' }
      fs.writeFileSync(target, JSON.stringify(value))
    }
  }
  assert.throws(() => promoteVerifiedPackage({
    root: fixture.root,
    isolatedRoot: fixture.isolatedRoot,
    contract: { artifactRel: fixture.artifactRel },
    candidateReceipt: fixture.receipt,
    copyFile,
  }), /promoted receipt does not match/)
  assert.equal(fs.readFileSync(destination, 'utf8'), 'prior-dmg')
  assert.equal(fs.existsSync(path.join(fixture.root, fixture.receiptRel)), false)
})

test('promotion rejects a forged existing receipt for the same artifact', () => {
  const fixture = promotionFixture()
  const receiptPath = path.join(fixture.root, fixture.receiptRel)
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(receiptPath, JSON.stringify({
    ...fixture.receipt,
    verification: { appExecutableSha256: 'forged' },
  }))
  assert.throws(() => promoteVerifiedPackage({
    root: fixture.root,
    isolatedRoot: fixture.isolatedRoot,
    contract: { artifactRel: fixture.artifactRel },
    candidateReceipt: fixture.receipt,
  }), /existing content-addressed receipt conflicts/)
})

test('promotion rejects a preplanted receipt identity without its verified DMG', () => {
  const fixture = promotionFixture()
  const receiptPath = path.join(fixture.root, fixture.receiptRel)
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(receiptPath, JSON.stringify({
    ...fixture.receipt,
    receiptId: '22222222-2222-2222-2222-222222222222',
  }))
  assert.throws(() => promoteVerifiedPackage({
    root: fixture.root,
    isolatedRoot: fixture.isolatedRoot,
    contract: { artifactRel: fixture.artifactRel },
    candidateReceipt: fixture.receipt,
    loadIdentity: () => ({ ok: false, receipt: null }),
  }), /not backed by the current verified DMG/)
})

test('structural release fails before packaging when runtime source is stale', () => {
  const calls = []
  let receiptCalls = 0
  const exit = runStructuralSequence([
    { label: 'verify:codex-runtime-source', cmd: 'source', args: [] },
    { label: 'package:dist', cmd: 'build', args: [] },
  ], {
    runner: (cmd) => {
      calls.push(cmd)
      return { status: cmd === 'source' ? 4 : 0, error: null }
    },
    sourceManifest: () => ({ digest: 'source-a' }),
    writeReceipt: () => { receiptCalls += 1 },
  })
  assert.equal(exit, 4)
  assert.deepEqual(calls, ['source'])
  assert.equal(receiptCalls, 0)
})

test('structural release rejects source drift after build and writes no receipt', () => {
  let sourceReads = 0
  let receiptCalls = 0
  const exit = runStructuralSequence([
    { label: 'package:dist', cmd: 'build', args: [] },
  ], {
    runner: () => ({ status: 0, error: null }),
    sourceManifest: () => ({ digest: sourceReads++ === 0 ? 'source-a' : 'source-b' }),
    writeReceipt: () => { receiptCalls += 1 },
  })
  assert.equal(exit, 1)
  assert.equal(receiptCalls, 0)
})

test('structural release writes one receipt only after every command passes', () => {
  const calls = []
  const receipts = []
  let isolatedTemporaryDirectory = null
  const exit = runStructuralSequence([
    { label: 'one', cmd: 'one', args: [] },
    { label: 'package:dist', cmd: 'build', args: [] },
  ], {
    runner: (cmd, _args, options) => {
      calls.push(cmd)
      isolatedTemporaryDirectory = options.env.TMPDIR
      assert(fs.statSync(isolatedTemporaryDirectory).isDirectory())
      assert.notEqual(isolatedTemporaryDirectory, process.env.TMPDIR || os.tmpdir())
      if (cmd === 'build') {
        assert.equal(options.env.npm_config_cache, path.join(isolatedTemporaryDirectory, 'npm-cache'))
      }
      return { status: 0, error: null }
    },
    sourceManifest: () => ({ digest: 'source-a' }),
    writeReceipt: (input) => receipts.push(input),
  })
  assert.equal(exit, 0)
  assert.deepEqual(calls, ['one', 'build'])
  assert.deepEqual(receipts, [{ expectedSourceDigest: 'source-a' }])
  assert.equal(fs.existsSync(isolatedTemporaryDirectory), false)
})

test('structural release removes its private directories after every exceptional exit', async (t) => {
  for (const failure of ['second temporary directory', 'runner', 'source readback', 'receipt']) {
    await t.test(failure, () => {
      const directories = []
      let temporaryDirectoryCalls = 0
      let sourceReads = 0
      const makeTemporaryDirectory = (prefix) => {
        temporaryDirectoryCalls += 1
        if (failure === 'second temporary directory' && temporaryDirectoryCalls === 2) {
          throw new Error('temporary directory unavailable')
        }
        const directory = fs.mkdtempSync(prefix)
        directories.push(directory)
        return directory
      }
      assert.throws(() => runStructuralSequence([
        { label: 'one', cmd: 'one', args: [] },
      ], {
        runner: () => {
          if (failure === 'runner') throw new Error('runner failed')
          return { status: 0, error: null }
        },
        sourceManifest: () => {
          sourceReads += 1
          if (failure === 'source readback' && sourceReads === 2) throw new Error('source readback failed')
          return { digest: 'source-a' }
        },
        writeReceipt: () => {
          if (failure === 'receipt') throw new Error('receipt failed')
        },
        makeTemporaryDirectory,
      }))
      for (const directory of directories) assert.equal(fs.existsSync(directory), false)
    })
  }
})

test('structural release rechecks the complete staged packaging tool immediately before packaging', () => {
  const calls = []
  let toolChanged = false
  let receiptCalls = 0
  const exit = runStructuralSequence([
    { label: 'one', cmd: 'one', args: [] },
    { label: 'package:dist', cmd: 'build', args: [] },
  ], {
    prepareReleaseHome: () => ({
      preparePackaging: () => {},
      packageCommand: (command) => command,
      verify: () => {
        if (toolChanged) throw new Error('staged dmgbuild tool changed before packaging')
      },
    }),
    runner: (cmd) => {
      calls.push(cmd)
      toolChanged = true
      return { status: 0, error: null }
    },
    sourceManifest: () => ({ digest: 'source-a' }),
    writeReceipt: () => { receiptCalls += 1 },
  })
  assert.equal(exit, 1)
  assert.deepEqual(calls, ['one'])
  assert.equal(receiptCalls, 0)
})
