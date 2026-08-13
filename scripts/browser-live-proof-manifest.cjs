const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, lstatSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { resolve } = require('node:path')

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

const EXCLUDED_PREFIXES = [
  'build/browser-live-proof/',
  'exports/',
  'node_modules/',
  'out/',
  'outputs/',
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sourcePaths(root, { includeMissing = false, includeDatabases = false } = {}) {
  const raw = runGit(root, ['ls-files', '-co', '--exclude-standard', '-z'], 'buffer')
  return raw.toString('utf8').split('\0').filter(Boolean).filter((path) => (
    !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))
    && (includeDatabases || (
      !path.endsWith('.db')
      && !path.endsWith('.db-shm')
      && !path.endsWith('.db-wal')
    ))
  )).filter((path) => {
    if (includeMissing) return true
    try {
      lstatSync(resolve(root, path))
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }).sort()
}

function buildSourceManifest(root = process.cwd()) {
  const absoluteRoot = resolve(root)
  const files = sourcePaths(absoluteRoot).map((path) => {
    const content = readFileSync(resolve(absoluteRoot, path))
    return { path, bytes: content.length, sha256: sha256(content) }
  })
  const digest = sha256(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(''))
  const pkg = JSON.parse(readFileSync(resolve(absoluteRoot, 'package.json'), 'utf8'))
  return {
    version: 1,
    head: runGit(absoluteRoot, ['rev-parse', 'HEAD']).trim(),
    branch: runGit(absoluteRoot, ['branch', '--show-current']).trim(),
    appVersion: String(pkg.version || ''),
    digest,
    files,
  }
}

function runGit(root, args, encoding = 'utf8') {
  assertTrustedGit()
  return execFileSync(TRUSTED_GIT.path, args, {
    cwd: root,
    encoding,
    env: TRUSTED_GIT_ENV,
    maxBuffer: 64 * 1024 * 1024,
  })
}

function assertTrustedGit() {
  if (!existsSync(TRUSTED_GIT.path) || sha256File(TRUSTED_GIT.path) !== TRUSTED_GIT.sha256) {
    throw new Error('browser live proof git identity mismatch')
  }
}

function sha256File(path) {
  statSync(path)
  return sha256(readFileSync(path))
}

function buildOutputManifest(root = process.cwd()) {
  const absoluteRoot = resolve(root)
  const outputRoot = resolve(absoluteRoot, 'out')
  const visit = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name)
    if (entry.isSymbolicLink() || lstatSync(absolutePath).isSymbolicLink()) {
      throw new Error('browser live proof output symlink rejected')
    }
    if (entry.isDirectory()) return visit(absolutePath)
    if (!entry.isFile()) return []
    const relativePath = absolutePath.slice(absoluteRoot.length + 1)
    const content = readFileSync(absolutePath)
    return [{ path: relativePath, bytes: content.length, sha256: sha256(content) }]
  })
  const files = visit(outputRoot).sort((left, right) => left.path.localeCompare(right.path))
  if (!files.some((file) => file.path === 'out/main/index.js')
    || !files.some((file) => file.path === 'out/preload/index.mjs')
    || !files.some((file) => file.path === 'out/renderer/index.html')) {
    throw new Error('browser live proof output entrypoints missing')
  }
  return {
    version: 1,
    digest: sha256(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join('')),
    files,
  }
}

module.exports = { buildOutputManifest, buildSourceManifest, runGit, sha256File, sourcePaths }
