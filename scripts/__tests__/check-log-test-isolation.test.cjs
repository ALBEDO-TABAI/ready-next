const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const test = require('node:test')

const { checkLogTestIsolation } = require('../check-log-test-isolation.cjs')

test('passes when test log isolation uses the default logger path', () => {
  withFixture(validFiles(), (root) => {
    const result = checkLogTestIsolation({ root })
    assert.equal(result.ok, true, result.errors.join('\n'))
  })
})

test('fails when the platform path does not check every test environment signal', () => {
  const files = validFiles()
  files['src/main/utils/platform.ts'] = files['src/main/utils/platform.ts'].replace(
    "process.env.READY_TEST_LOG_ISOLATION === '1'",
    'false',
  )
  withFixture(files, (root) => {
    const result = checkLogTestIsolation({ root })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /READY_TEST_LOG_ISOLATION/)
  })
})

test('fails when the isolation test bypasses the default logger path', () => {
  const files = validFiles()
  files['src/__tests__/rotating-logger-test-isolation.test.ts'] = [
    "createRotatingLogger('ready-tools.log', { resolvePath: () => '/tmp/ready-test-logs/ready-tools.log' })",
  ].join('\n')
  withFixture(files, (root) => {
    const result = checkLogTestIsolation({ root })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /without mocks/)
  })
})

function validFiles() {
  return {
    'src/main/utils/platform.ts': [
      "process.env.VITEST === 'true'",
      "process.env.NODE_ENV === 'test'",
      "process.env.READY_TEST_LOG_ISOLATION === '1'",
      "process.env.NODE_TEST_CONTEXT === 'child-v8'",
      "join(tmpdir(), 'ready-test-logs', filename)",
    ].join('\n'),
    'src/main/utils/rotating-logger.ts': [
      'const resolvePath = options.resolvePath ?? getLogPath',
    ].join('\n'),
    'src/__tests__/rotating-logger-test-isolation.test.ts': [
      "createRotatingLogger('ready-tools.log')",
    ].join('\n'),
  }
}

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-log-test-isolation-'))
  try {
    for (const [file, text] of Object.entries(files)) write(root, file, text)
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function write(root, file, text) {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
