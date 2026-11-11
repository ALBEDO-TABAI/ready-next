'use strict'

// Fixed production inputs. Only test-process bootstraps substitute this module.
// Never resolve an identity or a lease namespace from environment/CLI input.
const { resolve } = require('node:path')
const E6_AUTHORITY_ROOT = resolve('/tmp', `ready-codex-e6-global-lease-${process.getuid()}`)

const TRUSTED_RUNTIME_PATH = '/opt/homebrew/Cellar/node/26.0.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const TRUSTED_NODE = Object.freeze({
  path: '/opt/homebrew/Cellar/node/26.0.0/bin/node',
  sha256: '08dad0581f00a0cabf4d49ec92ca1f25fdfd01c2c18fa8e92b35f04d4c24c164',
})
const TRUSTED_NPM_CLI = Object.freeze({
  path: '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  sha256: '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7',
})
// macOS 27.2 system sqlite3 3.54.0 (com.apple.sqlite3, macOS Software Signing), re-pinned 2026-10-07.
const TRUSTED_SQLITE3 = Object.freeze({
  path: '/usr/bin/sqlite3',
  sha256: '5b4d771825e408a60db3549ada33e5abeb7a31464b5d65a87d8514208f8b61cf',
})
const TRUSTED_BUILD_SHELL = Object.freeze({
  path: '/bin/sh',
  sha256: 'ff0b291f8142f71b46ba01ace6c9713fc8049a5518e8bd21869ccf2ef1fed05a',
})
const TRUSTED_PACKAGE_LOCK = Object.freeze({
  path: 'package-lock.json',
  sha256: 'dfc84f52dbd561063aa6d6a2d444498a401bb8a277adc6c5f53a8d3067fc0b49',
})
const TRUSTED_NODE_MODULES = Object.freeze({
  path: 'node_modules',
  digest: '3ef28c876de8ca2ba099df2034534e0f264a08e949d8dbef6c794df826828388',
  entryCount: 143809,
  fileBytes: 1824325243,
})
const NON_DEPENDENCY_NODE_MODULE_PATHS = Object.freeze([
  '.cache',
  '.vite',
  'better-sqlite3/build',
  'bufferutil/build',
  'utf-8-validate/build',
])
const TRUSTED_ELECTRON = Object.freeze({
  relativePath: 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  sha256: '2d29df6b75f4ee3584479f0001dd41f5e088d390900a1537fa89b0d97e112d39',
})
const TRUSTED_BUILD_SCRIPTS = Object.freeze({
  build: 'npm run rebuild:native && npm run native:check && npm run typecheck && electron-vite build',
  'native:check': 'node scripts/check-better-sqlite3-electron-abi.cjs',
  'rebuild:native': 'node scripts/patch-better-sqlite3-v8.cjs && electron-builder install-app-deps',
  typecheck: 'node scripts/run-typecheck.cjs',
  'typecheck:node': 'tsc --noEmit -p tsconfig.node.json --composite false --incremental --tsBuildInfoFile node_modules/.cache/tsc/node.tsbuildinfo',
  'typecheck:web': 'tsc --noEmit -p tsconfig.web.json --composite false --incremental --tsBuildInfoFile node_modules/.cache/tsc/web.tsbuildinfo',
})
const TRUSTED_BUILD_COMMAND = [
  'node scripts/patch-better-sqlite3-v8.cjs',
  'electron-builder install-app-deps',
  'node scripts/check-better-sqlite3-electron-abi.cjs',
  'tsc --noEmit -p tsconfig.node.json --composite false --incremental --tsBuildInfoFile "$READY_CODEX_E6_TSC_CACHE/node.tsbuildinfo"',
  'tsc --noEmit -p tsconfig.web.json --composite false --incremental --tsBuildInfoFile "$READY_CODEX_E6_TSC_CACHE/web.tsbuildinfo"',
  'electron-vite build',
].join(' && ')
const TRUSTED_SIDECAR_PYTHON = Object.freeze({
  path: '/Users/user/.local/share/uv/python/cpython-3.11.15-macos-aarch64-none/bin/python3.11',
  sha256: '68100c5188b837802c7ae52398389d121b1c063ed244dec11649775b539c3a30',
  runtimeRoot: '/Users/user/.local/share/uv/python/cpython-3.11.15-macos-aarch64-none',
  runtimeDigest: 'ff14b6050beb41801c1874b7beade909cb675f2d7b0b1de6463f4507cb4e39fe',
  runtimeEntryCount: 2335,
  runtimeFileBytes: 68810209,
  version: 'Python 3.11.15',
  sslVersion: 'OpenSSL 3.5.6 7 Apr 2026',
})
const TRUSTED_SIDECAR_ENVIRONMENT = Object.freeze({
  path: '/Users/user/Library/Application Support/ready/agent-sidecar-runtime/python',
  digest: 'ebd1c054c4955ea24292fdeaf3d53353271f54fb9b6b27ce18dcae6d8a2029fe',
  entryCount: 14592,
  fileBytes: 66481773,
  requirementsPath: 'src/python/ready_sidecar/requirements.txt',
  requirementsSha256: 'c81e6ca3c9a422f21198e4e91331fd3e5eb7c5fa7daf8030773451ad94afd71c',
  requirementsInstallDigest: '1237553332',
})
const TRUSTED_ELECTRON_GYP = Object.freeze({
  path: '/Users/user/.electron-gyp/45.3.0',
  digest: 'adbc714d9a8949b15dba1c6b8681b3c2e71968986f8ff1f46c2ce8a9e0815891',
  entryCount: 131,
  fileBytes: 1575483,
})

const TRUSTED_GIT = Object.freeze({
  path: '/Library/Developer/CommandLineTools/usr/bin/git',
  sha256: '5cc7d22ef4228b5c5369f80bd16083ca4be50423bdb4c863ad559f7cc1268daf',
})
const TRUSTED_GIT_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: '/var/empty',
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
})

module.exports = Object.freeze({
  TRUSTED_GIT,
  TRUSTED_GIT_ENV,
  E6_AUTHORITY_ROOT,
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
})
