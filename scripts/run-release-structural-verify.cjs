#!/usr/bin/env node
'use strict'

const { execFileSync, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const os = require('node:os')
const { buildSourceManifest, runGit, sourcePaths } = require('./browser-live-proof-manifest.cjs')
const {
  buildReleaseSourceManifest,
  captureRegularFile,
  sameFileIdentity,
} = require('./release-package-identity.cjs')
const {
  verifyAndWriteReceipt,
  verifyExistingStructuralReceipt,
} = require('./verify-release-structural-package.cjs')

const npmCli = fs.realpathSync(path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm'))
const npmCommand = (label, args) => ({ label, cmd: process.execPath, args: [npmCli, ...args] })
const RELEASE_STRUCTURAL_TESTS = [
  'scripts/__tests__/release-package-identity.test.cjs',
  'scripts/__tests__/verify-release-structural-package.test.cjs',
  'scripts/__tests__/run-release-structural-verify.test.cjs',
  'scripts/__tests__/run-release-candidate-verify.test.cjs',
  'scripts/__tests__/check-release-live-evidence.test.cjs',
  'scripts/__tests__/check-release-stage-z-readiness.test.cjs',
]

const RELEASE_STRUCTURAL_COMMANDS = [
  npmCommand('npm:ci', ['ci', '--offline']),
  { label: 'prepare:pinned-electron', cmd: process.execPath, args: ['node_modules/electron/install.js'] },
  { label: 'verify:trusted-build-input', cmd: process.execPath, args: ['scripts/codex-runtime/check-trusted-build-provenance.mjs'] },
  npmCommand('verify:codex-runtime-source', ['run', 'verify:codex-runtime-source']),
  npmCommand('verify:version', ['run', 'verify:version']),
  npmCommand('typecheck', ['run', 'typecheck']),
  npmCommand('lint:check', ['run', 'lint:check']),
  npmCommand('verify:lint-budget', ['run', 'verify:lint-budget']),
  { label: 'check-eslint-baseline', cmd: process.execPath, args: ['scripts/check-eslint-baseline.cjs'] },
  npmCommand('verify:ipc-contract', ['run', 'verify:ipc-contract']),
  npmCommand('verify:meta-paths', ['run', 'verify:meta-paths']),
  npmCommand('verify:stability', ['run', 'verify:stability']),
  npmCommand('verify:streaming', ['run', 'verify:streaming']),
  npmCommand('verify:native', ['run', 'verify:native']),
  npmCommand('verify:codex-turn-delivery', ['run', 'verify:codex-turn-delivery']),
  npmCommand('verify:codex-runtime-e2', ['run', 'verify:codex-runtime-e2']),
  {
    label: 'test:release-structural',
    cmd: process.execPath,
    args: ['--test', '--test-concurrency=1', ...RELEASE_STRUCTURAL_TESTS],
  },
  { label: 'seed-safety', cmd: process.execPath, args: ['scripts/check-ai-seed-release-safety.cjs'] },
  { label: 'build', cmd: process.execPath, args: ['scripts/build-with-source-identity.cjs'] },
  {
    label: 'package:dist',
    cmd: process.execPath,
    args: ['node_modules/electron-builder/out/cli/cli.js', '--config', 'electron-builder.yml'],
  },
]

const ALLOWED_ENV_KEYS = new Set([
  'CC',
  'CXX',
  'DEVELOPER_DIR',
  'LANG',
  'LC_ALL',
  'SDKROOT',
])
const PINNED_ELECTRON_ARCHIVE = Object.freeze({
  cacheDirectory: 'bc80a13ebe4734629db853b3fc870b18ba9e388b795710fdbbd075694e548d03',
  fileName: 'electron-v42.3.0-darwin-arm64.zip',
  path: path.join(os.homedir(), 'Library', 'Caches', 'electron', 'electron-v42.3.0-darwin-arm64.zip'),
  bytes: 117895187,
  sha256: '19f4b0a4fcc3574e79befb53495cca8de02a126210d04363cf76f67099d128ef',
})
const PINNED_DMGBUILD_ARCHIVE = Object.freeze({
  path: path.join(
    os.homedir(),
    'Library',
    'Caches',
    'electron-builder',
    'downloads',
    '9e65e0ee1d9ea8008477cf2763b0e368d0c12c6e28d0de6f291ffb517316e406',
    'dmgbuild-bundle-arm64-75c8a6c.tar.gz',
  ),
  bytes: 20675673,
  sha256: 'a785f2a385c8c31996a089ef8e26361904b40c772d5ea65a36001212f1fc25e0',
  version: 'dmgbuild version/commit hash: 75c8a6c',
  toolEntryCount: 651,
  toolDigest: 'aa4697daa244a29322b445c5bb4372ce2b98d89953c8def7083be8a85d09a27d',
  protectedToolDigest: '36499ad0066bfba4c6179d4403b06e6ba9e59300773fab103755339d037fadaf',
})

function pinnedDmgbuildPath(homeDirectory) {
  return path.join(homeDirectory, 'release-tools', 'dmgbuild-1.2.0', 'dmgbuild')
}

function pinnedDmgbuildWrapperPath(homeDirectory) {
  return path.join(homeDirectory, 'release-tools', 'run-pinned-dmgbuild.cjs')
}

function releaseToolsRoot(homeDirectory) {
  return path.join(homeDirectory, 'release-tools')
}

function protectReleaseToolPath(target) {
  execFileSync('/bin/chmod', ['-R', 'a-w', target], { stdio: 'pipe' })
  execFileSync('/usr/bin/chflags', ['-R', 'uchg', target], { stdio: 'pipe' })
}

function unprotectReleaseTools(homeDirectory) {
  if (!fs.existsSync(homeDirectory)) return
  execFileSync('/usr/bin/chflags', ['-R', 'nouchg', homeDirectory], { stdio: 'pipe' })
  execFileSync('/bin/chmod', ['-R', 'u+w', homeDirectory], { stdio: 'pipe' })
}

function removeReleaseHome(homeDirectory) {
  try {
    unprotectReleaseTools(homeDirectory)
  } finally {
    fs.rmSync(homeDirectory, { recursive: true, force: true })
  }
}

function packagingSandboxProfile(homeDirectory, sharedCacheRoots = [
  path.join(os.homedir(), '.npm'),
  path.join(os.homedir(), 'Library', 'Caches', 'electron'),
  path.join(os.homedir(), 'Library', 'Caches', 'electron-builder'),
]) {
  const physicalPath = (value) => {
    let existing = path.resolve(value)
    const suffix = []
    while (!fs.existsSync(existing)) {
      suffix.unshift(path.basename(existing))
      existing = path.dirname(existing)
    }
    return path.join(fs.realpathSync(existing), ...suffix)
  }
  const escapePath = (value) => physicalPath(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const escaped = escapePath(homeDirectory)
  const profilePath = path.join(homeDirectory, 'package.sb')
  const cacheRules = sharedCacheRoots
    .map((cacheRoot) => `(deny file-write* (subpath "${escapePath(cacheRoot)}"))`)
    .join('\n')
  fs.writeFileSync(profilePath, `(version 1)\n(allow default)\n(deny network*)\n(deny file-write* (subpath "${escaped}"))\n${cacheRules}\n`, {
    flag: 'wx',
    mode: 0o400,
  })
  return profilePath
}

function buildDirectoryIdentity(root) {
  const entries = []
  const visit = (directory, relativeDirectory = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name
      const absolutePath = path.join(directory, name)
      const stat = fs.lstatSync(absolutePath)
      const mode = (stat.mode & 0o7777).toString(8)
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory', mode })
        visit(absolutePath, relativePath)
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: relativePath, type: 'symlink', mode, target: fs.readlinkSync(absolutePath) })
      } else if (stat.isFile()) {
        const identity = captureRegularFile(absolutePath, root)
        entries.push({
          path: relativePath,
          type: 'file',
          mode,
          bytes: identity.bytes,
          sha256: identity.sha256,
        })
      } else {
        throw new Error(`unsupported staged release tool entry: ${relativePath}`)
      }
    }
  }
  visit(root)
  return {
    entryCount: entries.length,
    digest: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  }
}

function stableDirectoryIdentity(root) {
  const first = buildDirectoryIdentity(root)
  const second = buildDirectoryIdentity(root)
  if (first.entryCount !== second.entryCount || first.digest !== second.digest) {
    throw new Error('staged release tool changed while its identity was captured')
  }
  return first
}

function dmgbuildWrapperSource({ toolRoot, expectedEntryCount, expectedDigest }) {
  return `#!${process.execPath}
'use strict'
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const toolRoot = ${JSON.stringify(toolRoot)}
const expectedEntryCount = ${JSON.stringify(expectedEntryCount)}
const expectedDigest = ${JSON.stringify(expectedDigest)}
function fileIdentity(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(file, flags)
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile()) throw new Error('not a regular file')
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < before.size) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position)
      if (bytesRead <= 0) throw new Error('short read')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = fs.fstatSync(fd)
    for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) {
      if (before[key] !== after[key]) throw new Error('file changed while reading')
    }
    return { bytes: before.size, mode: (before.mode & 0o7777).toString(8), sha256: hash.digest('hex') }
  } finally {
    fs.closeSync(fd)
  }
}
function inventory() {
  const entries = []
  const visit = (directory, relativeDirectory = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relativePath = relativeDirectory ? relativeDirectory + '/' + name : name
      const absolutePath = path.join(directory, name)
      const stat = fs.lstatSync(absolutePath)
      const mode = (stat.mode & 0o7777).toString(8)
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory', mode })
        visit(absolutePath, relativePath)
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: relativePath, type: 'symlink', mode, target: fs.readlinkSync(absolutePath) })
      } else if (stat.isFile()) {
        const value = fileIdentity(absolutePath)
        entries.push({ path: relativePath, type: 'file', mode: value.mode, bytes: value.bytes, sha256: value.sha256 })
      } else {
        throw new Error('unsupported tool entry')
      }
    }
  }
  visit(toolRoot)
  return { entryCount: entries.length, digest: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex') }
}
try {
  const first = inventory()
  const second = inventory()
  if (first.entryCount !== expectedEntryCount || first.digest !== expectedDigest
    || second.entryCount !== expectedEntryCount || second.digest !== expectedDigest) {
    throw new Error('pinned dmgbuild identity mismatch')
  }
  const result = spawnSync(path.join(toolRoot, 'dmgbuild'), process.argv.slice(2), { stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.signal) process.kill(process.pid, result.signal)
  process.exit(typeof result.status === 'number' ? result.status : 1)
} catch (error) {
  console.error('[pinned-dmgbuild] refused:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
`
}

function releaseChildEnvironment(homeDirectory, temporaryDirectory = process.env.TMPDIR || os.tmpdir()) {
  const electronCacheRoot = path.join(homeDirectory, 'Library', 'Caches', 'electron')
  const env = {
    electron_config_cache: electronCacheRoot,
    CUSTOM_DMGBUILD_PATH: pinnedDmgbuildWrapperPath(homeDirectory),
    HOME: homeDirectory,
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: temporaryDirectory,
    npm_config_cache: path.join(os.homedir(), '.npm'),
  }
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

function stagePinnedElectronArchive(releaseHome, archive = PINNED_ELECTRON_ARCHIVE) {
  const source = captureRegularFile(archive.path, path.dirname(archive.path))
  if (source.bytes !== archive.bytes || source.sha256 !== archive.sha256) {
    throw new Error('pinned Electron archive identity mismatch')
  }
  const cacheRoot = path.join(releaseHome, 'Library', 'Caches', 'electron')
  const destinationDirectory = path.join(cacheRoot, archive.cacheDirectory)
  const destination = path.join(destinationDirectory, archive.fileName)
  fs.mkdirSync(destinationDirectory, { recursive: true })
  fs.copyFileSync(archive.path, destination, fs.constants.COPYFILE_EXCL)
  const copied = captureRegularFile(destination, destinationDirectory)
  if (copied.bytes !== source.bytes || copied.sha256 !== source.sha256) {
    throw new Error('staged Electron archive identity mismatch')
  }
  return {
    ...copied,
    path: destination,
    verify() {
      const current = captureRegularFile(destination, destinationDirectory)
      if (current.bytes !== copied.bytes || current.sha256 !== copied.sha256) {
        throw new Error('staged Electron archive changed before packaging')
      }
    },
  }
}

function stagePinnedDmgbuildArchive(releaseHome, archive = PINNED_DMGBUILD_ARCHIVE) {
  const source = captureRegularFile(archive.path, path.dirname(archive.path))
  if (source.bytes !== archive.bytes || source.sha256 !== archive.sha256) {
    throw new Error('pinned dmgbuild archive identity mismatch')
  }
  const toolRoot = path.dirname(pinnedDmgbuildPath(releaseHome))
  const archiveDirectory = path.join(releaseHome, 'release-tools', 'archives')
  const stagedArchive = path.join(archiveDirectory, 'dmgbuild-bundle-arm64-75c8a6c.tar.gz')
  fs.mkdirSync(archiveDirectory, { recursive: true })
  fs.mkdirSync(toolRoot, { recursive: true })
  fs.copyFileSync(archive.path, stagedArchive, fs.constants.COPYFILE_EXCL)
  const copied = captureRegularFile(stagedArchive, archiveDirectory)
  if (copied.bytes !== source.bytes || copied.sha256 !== source.sha256) {
    throw new Error('staged dmgbuild archive identity mismatch')
  }
  execFileSync('/usr/bin/tar', ['-xzf', stagedArchive, '-C', toolRoot], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    stdio: 'pipe',
  })
  const executable = captureRegularFile(pinnedDmgbuildPath(releaseHome), toolRoot)
  if ((fs.statSync(pinnedDmgbuildPath(releaseHome)).mode & 0o111) === 0) {
    throw new Error('staged dmgbuild is not executable')
  }
  const version = fs.readFileSync(path.join(toolRoot, 'VERSION.txt'), 'utf8')
  if (!version.includes(archive.version)) throw new Error('staged dmgbuild version mismatch')
  const extractedToolIdentity = stableDirectoryIdentity(toolRoot)
  if (extractedToolIdentity.entryCount !== archive.toolEntryCount || extractedToolIdentity.digest !== archive.toolDigest) {
    throw new Error('staged dmgbuild tool does not match the pinned inventory')
  }
  protectReleaseToolPath(toolRoot)
  const toolIdentity = stableDirectoryIdentity(toolRoot)
  if (toolIdentity.entryCount !== archive.toolEntryCount || toolIdentity.digest !== archive.protectedToolDigest) {
    throw new Error('protected dmgbuild tool does not match the pinned inventory')
  }
  const wrapperPath = pinnedDmgbuildWrapperPath(releaseHome)
  const wrapperSource = dmgbuildWrapperSource({
    toolRoot,
    expectedEntryCount: archive.toolEntryCount,
    expectedDigest: archive.protectedToolDigest,
  })
  fs.writeFileSync(wrapperPath, wrapperSource, { flag: 'wx', mode: 0o700 })
  protectReleaseToolPath(wrapperPath)
  const wrapper = captureRegularFile(wrapperPath, path.dirname(wrapperPath))
  return {
    archive: copied,
    executable,
    toolIdentity,
    wrapper,
    verify() {
      const currentArchive = captureRegularFile(stagedArchive, archiveDirectory)
      if (currentArchive.bytes !== copied.bytes || currentArchive.sha256 !== copied.sha256) {
        throw new Error('staged dmgbuild archive changed before packaging')
      }
      const currentToolIdentity = stableDirectoryIdentity(toolRoot)
      if (currentToolIdentity.entryCount !== toolIdentity.entryCount
        || currentToolIdentity.digest !== toolIdentity.digest) {
        throw new Error('staged dmgbuild tool changed before packaging')
      }
      const currentWrapper = captureRegularFile(wrapperPath, path.dirname(wrapperPath))
      if (currentWrapper.bytes !== wrapper.bytes || currentWrapper.sha256 !== wrapper.sha256) {
        throw new Error('staged dmgbuild wrapper changed before packaging')
      }
    },
  }
}

function packagePinnedReleaseCommand(command, inputs) {
  return {
    cmd: '/usr/bin/sandbox-exec',
    args: [
      '-f',
      inputs.sandboxProfile,
      command.cmd,
      ...command.args,
      `--config.electronDist=${inputs.electron.path}`,
    ],
  }
}

function stagePinnedReleaseInputs(releaseHome) {
  const inputs = {
    electron: stagePinnedElectronArchive(releaseHome),
  }
  return {
    ...inputs,
    preparePackaging() {
      if (inputs.dmgbuild) return inputs.dmgbuild
      inputs.dmgbuild = stagePinnedDmgbuildArchive(releaseHome)
      protectReleaseToolPath(releaseToolsRoot(releaseHome))
      inputs.sandboxProfile = packagingSandboxProfile(releaseHome)
      protectReleaseToolPath(releaseHome)
      return inputs.dmgbuild
    },
    packageCommand(command) {
      return packagePinnedReleaseCommand(command, inputs)
    },
    verify() {
      inputs.electron.verify()
      inputs.dmgbuild?.verify()
    },
  }
}

function runStructuralSequence(commands, {
  runner = spawnSync,
  workspaceRoot = process.cwd(),
  sourceManifest = () => buildReleaseSourceManifest(workspaceRoot),
  writeReceipt = verifyAndWriteReceipt,
  prepareReleaseHome = () => {},
  makeTemporaryDirectory = (prefix) => fs.mkdtempSync(prefix),
  announce = true,
} = {}) {
  const sourceBefore = sourceManifest()
  const browserSourceManifest = buildSourceManifest(workspaceRoot)
  const embeddedManifestPath = path.join(workspaceRoot, 'build', 'browser-live-proof', 'source-manifest.json')
  fs.mkdirSync(path.dirname(embeddedManifestPath), { recursive: true })
  fs.writeFileSync(embeddedManifestPath, `${JSON.stringify(browserSourceManifest, null, 2)}\n`, { mode: 0o644 })
  const releaseHome = makeTemporaryDirectory(path.join(os.tmpdir(), 'ready-release-home-'))
  let releaseTemporaryDirectory = null
  try {
    releaseTemporaryDirectory = makeTemporaryDirectory(path.join(os.tmpdir(), 'ready-release-tmp-'))
    const releaseInputs = prepareReleaseHome(releaseHome)
    for (const command of commands) {
      console.log(`\n[release-structural] ${command.label}`)
      let effectiveCommand = command
      if (command.label === 'package:dist') {
        try {
          releaseInputs?.preparePackaging?.()
          releaseInputs?.verify?.()
          effectiveCommand = releaseInputs?.packageCommand?.(command) || command
        } catch (error) {
          console.error(`[release-structural] pinned release input verification failed: ${error instanceof Error ? error.message : String(error)}`)
          return 1
        }
      }
      const result = runner(effectiveCommand.cmd, effectiveCommand.args, {
        cwd: workspaceRoot,
        stdio: 'inherit',
        encoding: 'utf8',
        env: {
          ...releaseChildEnvironment(releaseHome, releaseTemporaryDirectory),
          ...(command.label === 'package:dist'
            ? { npm_config_cache: path.join(releaseTemporaryDirectory, 'npm-cache') }
            : {}),
          PYTHONDONTWRITEBYTECODE: '1',
        },
      })
      if (result.error) {
        console.error(`[release-structural] ${command.label} failed to start: ${result.error.message}`)
        return 1
      }
      if (result.status !== 0 || result.signal) {
        const exit = typeof result.status === 'number' && result.status !== 0 ? result.status : 1
        console.error(`[release-structural] ${command.label} failed`)
        return exit
      }
    }

    const sourceAfter = sourceManifest()
    if (!sameSourceIdentity(sourceAfter, sourceBefore)) {
      console.error('[release-structural] source tree changed while verification was running')
      return 1
    }
    writeReceipt({ expectedSourceDigest: sourceBefore.digest })
    if (announce) {
      console.log('\n[release-structural] STRUCTURAL_PACKAGE_PASS')
      console.log('[release-structural] LIVE_ACCEPTANCE_DEFERRED')
    }
    return 0
  } finally {
    removeReleaseHome(releaseHome)
    if (releaseTemporaryDirectory) {
      fs.rmSync(releaseTemporaryDirectory, { recursive: true, force: true })
    }
  }
}

function sameSourceIdentity(left, right) {
  return sameSourceContentIdentity(left, right)
    && left?.branch === right?.branch
}

function sameSourceContentIdentity(left, right) {
  return left?.version === right?.version
    && left?.head === right?.head
    && left?.appVersion === right?.appVersion
    && left?.digest === right?.digest
    && left?.files?.length === right?.files?.length
}

function assertToolchain(root) {
  const expectedNode = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim()
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const expectedNpm = String(pkg.packageManager || '').replace(/^npm@/, '')
  const actualNpm = String(execFileSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' })).trim()
  if (process.version !== `v${expectedNode}` || actualNpm !== expectedNpm) {
    throw new Error(`release toolchain mismatch: node=${process.version}, npm=${actualNpm}`)
  }
  return { node: process.version, npm: actualNpm, platform: process.platform, architecture: process.arch }
}

function copyCurrentSourceToWorktree(root, worktree) {
  const current = new Set(sourcePaths(root, { includeDatabases: true }))
  for (const relativePath of sourcePaths(worktree, { includeDatabases: true })) {
    if (current.has(relativePath)) continue
    fs.rmSync(path.join(worktree, relativePath), { recursive: true, force: true })
  }
  for (const relativePath of current) {
    const source = path.join(root, relativePath)
    const target = path.join(worktree, relativePath)
    const stat = fs.lstatSync(source)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`release source entry must be a regular file: ${relativePath}`)
    }
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    fs.chmodSync(target, stat.mode & 0o777)
  }
}

function createIsolatedReleaseWorktree(root) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-release-source-'))
  fs.rmSync(worktree, { recursive: true, force: true })
  try {
    const head = runGit(root, ['rev-parse', 'HEAD']).trim()
    const branch = runGit(root, ['branch', '--show-current']).trim()
    runGit(root, ['clone', '--no-checkout', '--no-local', root, worktree])
    runGit(worktree, branch
      ? ['checkout', '-B', branch, head]
      : ['checkout', '--detach', head])
    copyCurrentSourceToWorktree(root, worktree)
    const runtimeSource = path.join(root, 'build', 'codex', 'aarch64-apple-darwin', 'codex')
    const runtimeTarget = path.join(worktree, 'build', 'codex', 'aarch64-apple-darwin', 'codex')
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'codex-runtime', 'runtime-manifest.json'), 'utf8'))
    const runtimeIdentity = require('./release-package-identity.cjs').captureRegularFile(runtimeSource, root)
    if (runtimeIdentity.sha256 !== manifest.binarySha256 || runtimeIdentity.bytes !== manifest.binarySizeBytes) {
      throw new Error('external pinned Codex runtime input does not match runtime-manifest.json')
    }
    fs.mkdirSync(path.dirname(runtimeTarget), { recursive: true })
    fs.copyFileSync(runtimeSource, runtimeTarget)
    fs.chmodSync(runtimeTarget, 0o755)
    const seed = path.join(worktree, 'build', 'runtime-seeds', 'ai-settings.seed.json')
    fs.mkdirSync(path.dirname(seed), { recursive: true })
    fs.writeFileSync(seed, '{}\n', { mode: 0o600 })
    return { worktree, runtimeIdentity }
  } catch (error) {
    fs.rmSync(worktree, { recursive: true, force: true })
    throw error
  }
}

function removeIsolatedReleaseWorktree(_root, worktree) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const resolved = path.resolve(worktree)
  const physical = fs.realpathSync(resolved)
  if (path.dirname(physical) !== temporaryRoot
    || !path.basename(physical).startsWith('ready-release-source-')) {
    throw new Error(`refusing to remove non-release worktree: ${worktree}`)
  }
  const stat = fs.lstatSync(physical)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
    throw new Error(`release worktree identity is invalid: ${worktree}`)
  }
  fs.rmSync(physical, { recursive: true, force: false })
}

function promoteVerifiedPackage({
  root,
  isolatedRoot,
  contract,
  candidateReceipt,
  identityModule = require('./release-package-identity.cjs'),
  loadIdentity = (releaseRoot) => {
    try {
      return { ok: true, receipt: verifyExistingStructuralReceipt({ root: releaseRoot }) }
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)], receipt: null }
    }
  },
  copyFile = fs.copyFileSync,
  transactionRunner = (request) => {
    const output = execFileSync('/usr/bin/python3', [
      path.join(__dirname, 'release-output-transaction.py'),
    ], {
      input: JSON.stringify(request),
      encoding: 'utf8',
      env: {
        HOME: '/var/empty',
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        TMPDIR: os.tmpdir(),
      },
    }).trim()
    return output ? JSON.parse(output) : {}
  },
}) {
  const sameReceipt = (left, right) => JSON.stringify(left) === JSON.stringify(right)
  const isolatedArtifact = path.join(isolatedRoot, contract.artifactRel)
  const destination = path.join(root, contract.artifactRel)
  const receiptRel = identityModule.receiptRelForArtifactSha(candidateReceipt.artifact.sha256)
  const isolatedReceipt = path.join(isolatedRoot, receiptRel)
  const receiptDestination = path.join(root, receiptRel)
  const isolatedReceiptValue = JSON.parse(identityModule.readStableRegularFile(
    isolatedReceipt,
    isolatedRoot,
    { includeContent: true },
  ).content.toString('utf8'))
  if (!sameReceipt(isolatedReceiptValue, candidateReceipt)) {
    throw new Error('isolated structural receipt does not match the verified package')
  }

  let effectiveReceipt = candidateReceipt
  let receiptAlreadyExists = false
  try {
    effectiveReceipt = JSON.parse(identityModule.readStableRegularFile(
      receiptDestination,
      root,
      { includeContent: true },
    ).content.toString('utf8'))
    receiptAlreadyExists = true
    const immutable = (receipt) => {
      const fields = { ...receipt }
      delete fields.receiptId
      delete fields.createdAt
      return JSON.stringify(fields)
    }
    if (immutable(effectiveReceipt) !== immutable(candidateReceipt)) {
      throw new Error('existing content-addressed receipt conflicts with the verified package')
    }
    let existingPackage
    try { existingPackage = loadIdentity(root) } catch { existingPackage = null }
    if (!existingPackage?.ok
      || existingPackage.receipt?.receiptId !== effectiveReceipt.receiptId
      || existingPackage.receipt?.artifact?.sha256 !== effectiveReceipt.artifact.sha256) {
      throw new Error('existing receipt identity is not backed by the current verified DMG')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    effectiveReceipt = candidateReceipt
  }

  const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-release-promotion-'))
  const stagedDmg = path.join(stagingDirectory, path.basename(destination))
  const stagedReceipt = path.join(stagingDirectory, path.basename(receiptDestination))
  try {
    copyFile(isolatedArtifact, stagedDmg, fs.constants.COPYFILE_EXCL)
    const stagedDmgIdentity = captureRegularFile(stagedDmg, stagingDirectory)
    if (!sameFileIdentity(stagedDmgIdentity, effectiveReceipt.artifact)) {
      throw new Error('promoted DMG does not match the verified isolated artifact')
    }
    let stagedReceiptIdentity
    if (!receiptAlreadyExists) {
      copyFile(isolatedReceipt, stagedReceipt, fs.constants.COPYFILE_EXCL)
      const copiedReceipt = JSON.parse(identityModule.readStableRegularFile(
        stagedReceipt,
        stagingDirectory,
        { includeContent: true },
      ).content.toString('utf8'))
      if (!sameReceipt(copiedReceipt, effectiveReceipt)) {
        throw new Error('promoted receipt does not match the verified isolated receipt')
      }
      stagedReceiptIdentity = captureRegularFile(stagedReceipt, stagingDirectory)
    } else {
      stagedReceiptIdentity = captureRegularFile(receiptDestination, root)
    }
    const transactionRequest = {
      root: fs.realpathSync(root),
      artifactSource: stagedDmg,
      artifactDirectory: path.posix.dirname(contract.artifactRel),
      artifactLeaf: path.posix.basename(contract.artifactRel),
      artifactIdentity: { bytes: stagedDmgIdentity.bytes, sha256: stagedDmgIdentity.sha256 },
      receiptSource: receiptAlreadyExists ? null : stagedReceipt,
      receiptDirectory: path.posix.dirname(receiptRel),
      receiptLeaf: path.posix.basename(receiptRel),
      receiptIdentity: { bytes: stagedReceiptIdentity.bytes, sha256: stagedReceiptIdentity.sha256 },
      receiptAlreadyExists,
      suffix: effectiveReceipt.receiptId,
    }
    const transaction = transactionRunner(transactionRequest)
    try {
      const promotedIdentity = loadIdentity(root)
      if (!promotedIdentity.ok
        || !sameReceipt(promotedIdentity.receipt, effectiveReceipt)) {
        throw new Error('promoted package readback does not match the verified isolated package')
      }
      transactionRunner({ ...transactionRequest, action: 'finalize' })
    } catch (error) {
      transactionRunner({
        ...transactionRequest,
        action: 'rollback',
        artifactBackedUp: Boolean(transaction?.artifactBackedUp),
        receiptCreated: Boolean(transaction?.receiptCreated),
      })
      throw error
    }
    return effectiveReceipt
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true })
  }
}

function main() {
  const root = process.cwd()
  let isolated = null
  try {
    const toolchain = assertToolchain(root)
    const sourceBefore = buildReleaseSourceManifest(root)
    isolated = createIsolatedReleaseWorktree(root)
    const isolatedSource = buildReleaseSourceManifest(isolated.worktree)
    if (!sameSourceContentIdentity(isolatedSource, sourceBefore)) {
      throw new Error('isolated release source does not match the live frozen source')
    }
    const bootstrapExit = runStructuralSequence([RELEASE_STRUCTURAL_COMMANDS[0]], {
      workspaceRoot: isolated.worktree,
      writeReceipt: () => {},
      prepareReleaseHome: stagePinnedReleaseInputs,
      announce: false,
    })
    if (bootstrapExit !== 0) return bootstrapExit
    const identityModule = require('./release-package-identity.cjs')
    const isolatedRequire = createRequire(path.join(isolated.worktree, 'package.json'))
    const contract = identityModule.packagingContract(isolated.worktree, {
      parseYaml: (text) => isolatedRequire('yaml').parse(text),
    })
    const isolatedArtifact = path.join(isolated.worktree, contract.artifactRel)
    if (fs.existsSync(isolatedArtifact)) throw new Error('isolated release output is not empty before build')
    const exit = runStructuralSequence(RELEASE_STRUCTURAL_COMMANDS.slice(1), {
      workspaceRoot: isolated.worktree,
      writeReceipt: () => {},
      prepareReleaseHome: stagePinnedReleaseInputs,
      announce: false,
    })
    if (exit !== 0) return exit
    if (!sameSourceIdentity(buildReleaseSourceManifest(root), sourceBefore)) {
      throw new Error('live source tree changed while isolated release verification was running')
    }
    const candidateReceipt = verifyAndWriteReceipt({
      root: isolated.worktree,
      expectedSourceDigest: sourceBefore.digest,
      contractFactory: () => contract,
      sourceManifest: (workspaceRoot) => {
        const snapshot = buildReleaseSourceManifest(workspaceRoot)
        return { ...snapshot, head: sourceBefore.head, branch: sourceBefore.branch }
      },
      toolchain,
    })
    if (!sameSourceIdentity(buildReleaseSourceManifest(root), sourceBefore)) {
      throw new Error('live source tree changed before verified package promotion')
    }
    promoteVerifiedPackage({
      root,
      isolatedRoot: isolated.worktree,
      contract,
      candidateReceipt,
      identityModule,
    })
    identityModule.forwardReleasePackageReceipt(isolatedArtifact, path.join(root, contract.artifactRel))
    console.log('\n[release-structural] STRUCTURAL_PACKAGE_PASS')
    console.log('[release-structural] LIVE_ACCEPTANCE_DEFERRED')
    return 0
  } catch (error) {
    console.error(`[release-structural] FAIL: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    if (isolated?.worktree) removeIsolatedReleaseWorktree(root, isolated.worktree)
  }
}

if (require.main === module) process.exit(main())

module.exports = {
  RELEASE_STRUCTURAL_COMMANDS,
  assertToolchain,
  buildDirectoryIdentity,
  dmgbuildWrapperSource,
  copyCurrentSourceToWorktree,
  createIsolatedReleaseWorktree,
  releaseChildEnvironment,
  removeIsolatedReleaseWorktree,
  removeReleaseHome,
  promoteVerifiedPackage,
  packagingSandboxProfile,
  packagePinnedReleaseCommand,
  runStructuralSequence,
  stagePinnedDmgbuildArchive,
  stagePinnedElectronArchive,
  stagePinnedReleaseInputs,
  sameSourceContentIdentity,
  sameSourceIdentity,
}
