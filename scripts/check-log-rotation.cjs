#!/usr/bin/env node

const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative, resolve, sep } = require('node:path')

const REQUIRED_READY_LOGS = [
  'ready-agent-metrics.log',
  'ready-database.log',
  'ready-tools.log',
  'ready-system-tools.log',
  'ready-memory-tools.log',
  'ready-directchat.log',
  'ready-search.log',
  'ready-settings.log',
  'ready-browser.log',
]

const HELPER_FILE = normalizePath('src/main/utils/rotating-logger.ts')
const NDJSON_ALLOWLIST = 'ready-design-run-captures.ndjson'
const DIRECT_READY_LOG_PATH_RE = /getLogPath\(\s*['"](ready-[^'"]+\.log)['"]\s*\)/g
const DIRECT_APPEND_READY_RE = /appendFile(?:Sync)?\([^)]*['"](ready-[^'"]+\.log)['"]/g
const ROTATING_LOGGER_RE = /createRotatingLogger\(\s*['"](ready-[^'"]+\.log)['"]/g

function checkLogRotation(options = {}) {
  const root = resolve(options.root || resolve(__dirname, '..'))
  const errors = []
  const mainRoot = resolve(root, 'src/main')
  const files = existsSync(mainRoot) ? listFiles(mainRoot) : []
  const foundRotatingLogs = new Set()
  let ndjsonSeen = false

  for (const file of files) {
    const rel = normalizePath(relative(root, file))
    const text = readFileSync(file, 'utf8')
    if (text.includes(NDJSON_ALLOWLIST)) ndjsonSeen = true

    collectMatches(ROTATING_LOGGER_RE, text, (filename) => {
      foundRotatingLogs.add(filename)
    })

    if (rel === HELPER_FILE) continue

    collectMatches(DIRECT_READY_LOG_PATH_RE, text, (filename) => {
      errors.push(`${rel}: direct getLogPath("${filename}") bypasses createRotatingLogger`)
    })
    collectMatches(DIRECT_APPEND_READY_RE, text, (filename) => {
      errors.push(`${rel}: direct append to "${filename}" bypasses createRotatingLogger`)
    })
  }

  for (const filename of REQUIRED_READY_LOGS) {
    if (!foundRotatingLogs.has(filename)) {
      errors.push(`ready log "${filename}" is not routed through createRotatingLogger`)
    }
  }
  if (!ndjsonSeen) {
    errors.push(`${NDJSON_ALLOWLIST} whitelist candidate is missing from the source inventory`)
  }

  return { ok: errors.length === 0, errors }
}

function collectMatches(regex, text, callback) {
  regex.lastIndex = 0
  let match = regex.exec(text)
  while (match) {
    callback(match[1])
    match = regex.exec(text)
  }
}

function listFiles(root) {
  const results = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      results.push(...listFiles(path))
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) {
      results.push(path)
    }
  }
  return results
}

function normalizePath(path) {
  return path.split(sep).join('/')
}

function parseRoot(argv) {
  let root = resolve(__dirname, '..')
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--root') throw new Error(`Unknown argument "${arg}".`)
    const value = argv[index + 1]
    if (!value) throw new Error('Missing value for --root.')
    root = resolve(value)
    index += 1
  }
  return root
}

function main() {
  const result = checkLogRotation({ root: parseRoot(process.argv.slice(2)) })
  if (!result.ok) {
    console.error('log rotation check failed:')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log('log rotation: ok')
}

if (require.main === module) main()

module.exports = { checkLogRotation }
