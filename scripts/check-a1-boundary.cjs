#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const { resolve } = require('node:path')

const PROTECTED_DIR = 'src/main/modules/agent-control'

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = checkA1Boundary(options)
    if (result.ok) {
      console.log('a1 boundary: ok')
      return
    }
    console.error(formatErrors(result))
    process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function checkA1Boundary({ root = resolve(__dirname, '..'), base }) {
  if (!base) throw new Error(usage('Missing required --base <sha>.'))

  const committed = filterProtected(
    runGit(root, ['diff', '--name-only', `${base}..HEAD`]).split(/\n/),
  )
  const uncommitted = filterProtected(parseStatusPaths(runGit(root, ['status', '--porcelain'])))

  return {
    ok: committed.length === 0 && uncommitted.length === 0,
    committed,
    uncommitted,
  }
}

function parseArgs(argv) {
  const options = {
    root: resolve(__dirname, '..'),
    base: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error(usage('Missing value for --root.'))
      options.root = resolve(value)
      i += 1
    } else if (arg === '--base') {
      const value = argv[i + 1]
      if (!value) throw new Error(usage('Missing value for --base.'))
      options.base = value
      i += 1
    } else {
      throw new Error(usage(`Unknown argument "${arg}".`))
    }
  }
  if (!options.base) throw new Error(usage('Missing required --base <sha>.'))
  return options
}

function usage(message) {
  return [
    message,
    'Usage: node scripts/check-a1-boundary.cjs --base <sha> [--root <path>]',
  ].join('\n')
}

function runGit(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function parseStatusPaths(statusOutput) {
  const paths = []
  for (const line of statusOutput.split(/\n/)) {
    if (!line.trim()) continue
    const rawPath = line.slice(3)
    if (rawPath.includes(' -> ')) {
      const [from, to] = rawPath.split(' -> ')
      paths.push(stripGitQuotes(from), stripGitQuotes(to))
    } else {
      paths.push(stripGitQuotes(rawPath))
    }
  }
  return paths
}

function stripGitQuotes(filePath) {
  const value = filePath.trim()
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}

function filterProtected(files) {
  return [...new Set(files.map(normalizePath).filter(isProtectedPath))].sort()
}

function isProtectedPath(filePath) {
  if (!filePath.startsWith(`${PROTECTED_DIR}/`)) return false
  if (filePath === `${PROTECTED_DIR}/turn-engine.ts`) return true
  if (filePath === `${PROTECTED_DIR}/skill-child-error-mapping.ts`) return true
  return /^skill-child-.*\.ts$/.test(filePath.slice(PROTECTED_DIR.length + 1))
}

function normalizePath(filePath) {
  return String(filePath || '').replaceAll('\\', '/')
}

function formatErrors(result) {
  const lines = []
  if (result.committed.length > 0) {
    lines.push('committed A1 boundary changes:')
    lines.push(...result.committed.map((file) => `- ${file}`))
  }
  if (result.uncommitted.length > 0) {
    lines.push('uncommitted A1 boundary changes:')
    lines.push(...result.uncommitted.map((file) => `- ${file}`))
  }
  return lines.join('\n')
}

module.exports = {
  checkA1Boundary,
  isProtectedPath,
  parseStatusPaths,
}
