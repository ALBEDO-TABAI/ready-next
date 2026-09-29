'use strict'

const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const { sha256File, computeTreeIdentity } = require('../../codex-runtime/live-proof-file-identity.cjs')

// Test-process-only substitution. No product entrypoint calls this helper.
const __breaksInvariants = ['e6.fixed-production-identities', 'e6.global-lease-namespace', 'e6.external-cli-probe']

function installFixture(profilePath) {
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
  const modulePath = require.resolve(profile.modulePath)
  require(modulePath)
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
    return value
  }
  require.cache[modulePath].exports = freeze(profile.identities)
  // CLI lookup/read is an external-account boundary, not recovery logic.
  // Tests supply its identity and forbid every actual account read.
  const authorityPath = require.resolve(join(dirname(modulePath), 'e6-user-scenario-authority.cjs'))
  const authority = require(authorityPath)
  require.cache[authorityPath].exports = {
    ...authority,
    readCurrentLarkCliAuthority: () => freeze({
      architecture: 'arm64', authorityDigest: 'a'.repeat(64), payloadSha256: 'b'.repeat(64),
      autoInstallForbidden: true, wrapperExecutionForbidden: true, launcherCount: 1,
      version: authority.SUPPORTED_VERSION,
    }),
    runCurrentLarkCliRead: () => { throw new Error('e6_fixture_external_cli_forbidden') },
  }
}

function createE6TestRuntime(sourceRoot) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ready-e6-isolated-')))
  const root = join(directory, 'workspace')
  const modulePath = join(sourceRoot, 'scripts/codex-runtime/live-proof-identities.cjs')
  const production = require(modulePath)
  const write = (path, text, mode) => {
    fs.mkdirSync(dirname(path), { recursive: true })
    fs.writeFileSync(path, text, mode ? { mode } : undefined)
    return path
  }
  const pin = (path) => ({ path, sha256: sha256File(path) })
  const copy = (from, to) => {
    fs.mkdirSync(dirname(to), { recursive: true })
    fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE)
    return to
  }
  try {
    fs.mkdirSync(root)
    fs.symlinkSync(join(sourceRoot, 'scripts'), join(root, 'scripts'), 'dir')
    const manifestPath = 'assets/codex-runtime/runtime-manifest.json'
    copy(join(sourceRoot, manifestPath), join(root, manifestPath))
    const manifest = JSON.parse(fs.readFileSync(join(root, manifestPath), 'utf8'))
    const binary = `build/codex/${manifest.targetTriple}/codex`
    copy(join(sourceRoot, binary), join(root, binary))
    const scripts = { build: 'node fixture-build.cjs' }
    write(join(root, 'package.json'), JSON.stringify({ scripts }))
    write(join(root, 'package-lock.json'), '{"fixture":true}\n')
    write(join(root, 'node_modules/fixture-package/index.js'), 'module.exports = "fixture"\n')
    const electronRelativePath = 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    write(join(root, electronRelativePath), 'fixture Electron identity\n')
    write(join(root, 'fixture-build.cjs'), [
      "const fs = require('node:fs')",
      "fs.mkdirSync('out')",
      "fs.writeFileSync('out/launcher.json', JSON.stringify({ offline: process.env.NPM_CONFIG_OFFLINE, userConfig: process.env.NPM_CONFIG_USERCONFIG, globalConfig: process.env.NPM_CONFIG_GLOBALCONFIG, home: process.env.HOME, sentinel: process.env.E6_FIXTURE_SECRET ?? null }))",
    ].join(';'))
    const npmPath = write(join(directory, 'npm-cli.js'), '// fixture npm identity\n')
    const pythonRoot = join(directory, 'python-runtime')
    const pythonPath = write(join(pythonRoot, 'bin/python3.11'), [
      '#!/bin/sh',
      'case "$*" in',
      '  --version) echo "Python 3.11.15" ;;',
      '  *OPENSSL_VERSION*) echo "OpenSSL fixture" ;;',
      '  *) echo "sidecar-imports-ok" ;;',
      'esac',
      '',
    ].join('\n'), 0o700)
    write(join(pythonRoot, 'lib/runtime.txt'), 'fixture standard library\n')
    const venv = join(directory, 'sidecar-python')
    fs.mkdirSync(join(venv, 'bin'), { recursive: true })
    for (const name of ['python', 'python3', 'python3.11']) fs.symlinkSync(pythonPath, join(venv, 'bin', name))
    write(join(venv, 'lib/site-packages/fixture.txt'), 'fixture sidecar dependency\n')
    const requirementsPath = 'src/python/ready_sidecar/requirements.txt'
    write(join(root, requirementsPath), 'fixture-sidecar==1\n')
    const headers = join(directory, 'electron-gyp')
    write(join(headers, 'include/node/node.h'), '// fixture headers\n')
    const pythonTree = computeTreeIdentity(pythonRoot)
    const venvTree = computeTreeIdentity(venv)
    const dependencies = computeTreeIdentity(join(root, 'node_modules'))
    write(join(root, '.gitignore'), '/scripts\n/build\n/node_modules\n/out\n/outputs\n')
    const git = (args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root, stdio: 'pipe', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
    git(['init', '--initial-branch=fixture'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'isolated fixture'])
    const identities = {
      ...production,
      TRUSTED_RUNTIME_PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      E6_AUTHORITY_ROOT: join(directory, 'authority'),
      TRUSTED_GIT: pin('/usr/bin/git'),
      TRUSTED_NODE: pin(fs.realpathSync(process.execPath)),
      TRUSTED_NPM_CLI: pin(npmPath),
      TRUSTED_SQLITE3: pin(copy('/usr/bin/sqlite3', join(directory, 'sqlite3'))),
      TRUSTED_BUILD_SHELL: pin('/bin/sh'),
      TRUSTED_PACKAGE_LOCK: { path: 'package-lock.json', sha256: sha256File(join(root, 'package-lock.json')) },
      TRUSTED_NODE_MODULES: { path: 'node_modules', digest: dependencies.digest, entryCount: dependencies.entryCount, fileBytes: dependencies.fileBytes },
      TRUSTED_ELECTRON: { relativePath: electronRelativePath, sha256: sha256File(join(root, electronRelativePath)) },
      TRUSTED_BUILD_SCRIPTS: scripts,
      TRUSTED_BUILD_COMMAND: 'node fixture-build.cjs',
      TRUSTED_SIDECAR_PYTHON: {
        ...pin(pythonPath), runtimeRoot: pythonRoot, runtimeDigest: pythonTree.digest,
        runtimeEntryCount: pythonTree.entryCount, runtimeFileBytes: pythonTree.fileBytes,
        version: 'Python 3.11.15', sslVersion: 'OpenSSL fixture',
      },
      TRUSTED_SIDECAR_ENVIRONMENT: {
        path: venv, digest: venvTree.digest, entryCount: venvTree.entryCount, fileBytes: venvTree.fileBytes,
        requirementsPath, requirementsSha256: sha256File(join(root, requirementsPath)), requirementsInstallDigest: 'fixture-install',
      },
      TRUSTED_ELECTRON_GYP: { path: headers, ...computeTreeIdentity(headers) },
    }
    const profilePath = write(join(directory, 'identities.json'), JSON.stringify({ modulePath, identities }))
    const bootstrap = write(join(directory, 'bootstrap.cjs'), `require(${JSON.stringify(__filename)}).installFixture(${JSON.stringify(profilePath)})\n`)
    installFixture(profilePath)
    return { root, directory, identities, production, modulePath, bootstrap, nodeArgs: ['--require', bootstrap] }
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

module.exports = { __breaksInvariants, createE6TestRuntime, installFixture }
