const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, statSync } = require('node:fs')
const { resolve } = require('node:path')

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

function sourcePaths(root) {
  const raw = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  return raw.toString('utf8').split('\0').filter(Boolean).filter((path) => (
    !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))
    && !path.endsWith('.db')
    && !path.endsWith('.db-shm')
    && !path.endsWith('.db-wal')
  )).filter((path) => existsSync(resolve(root, path))).sort()
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
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: absoluteRoot, encoding: 'utf8' }).trim(),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: absoluteRoot, encoding: 'utf8' }).trim(),
    appVersion: String(pkg.version || ''),
    digest,
    files,
  }
}

function sha256File(path) {
  statSync(path)
  return sha256(readFileSync(path))
}

module.exports = { buildSourceManifest, sha256File }
