#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const PLATFORM_FILE = 'src/main/utils/platform.ts'
const LOGGER_FILE = 'src/main/utils/rotating-logger.ts'
const TEST_FILE = 'src/__tests__/rotating-logger-test-isolation.test.ts'

function checkLogTestIsolation(options = {}) {
  const root = resolve(options.root || resolve(__dirname, '..'))
  const errors = []
  const platform = read(root, PLATFORM_FILE, errors)
  const logger = read(root, LOGGER_FILE, errors)
  const testFile = read(root, TEST_FILE, errors)

  if (!platform.includes('ready-test-logs')) {
    errors.push(`${PLATFORM_FILE}: missing ready-test-logs routing`)
  }
  for (const marker of [
    "process.env.VITEST === 'true'",
    "process.env.NODE_ENV === 'test'",
    "process.env.READY_TEST_LOG_ISOLATION === '1'",
    "process.env.NODE_TEST_CONTEXT === 'child-v8'",
  ]) {
    if (!platform.includes(marker)) errors.push(`${PLATFORM_FILE}: missing ${marker}`)
  }
  if (!/options\.resolvePath\s*\?\?\s*getLogPath/.test(logger)) {
    errors.push(`${LOGGER_FILE}: default logger path must flow through getLogPath`)
  }
  if (/\b(resolvePath|mock|jest\.|vi\.)\b/.test(testFile)) {
    errors.push(`${TEST_FILE}: test must exercise the real default logger path without mocks`)
  }

  return { ok: errors.length === 0, errors }
}

function read(root, rel, errors) {
  const path = resolve(root, rel)
  if (!existsSync(path)) {
    errors.push(`${rel}: missing`)
    return ''
  }
  return readFileSync(path, 'utf8')
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
  const result = checkLogTestIsolation({ root: parseRoot(process.argv.slice(2)) })
  if (!result.ok) {
    console.error('log test isolation check failed:')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log('log test isolation: ok')
}

if (require.main === module) main()

module.exports = { checkLogTestIsolation }
