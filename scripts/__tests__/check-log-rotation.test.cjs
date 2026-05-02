const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const test = require('node:test')

const { checkLogRotation } = require('../check-log-rotation.cjs')

test('passes when required ready logs use createRotatingLogger and ndjson stays allowlisted', () => {
  withFixture(validFiles(), (root) => {
    const result = checkLogRotation({ root })
    assert.equal(result.ok, true, result.errors.join('\n'))
  })
})

test('fails when sync direct ready log writer bypasses rotation', () => {
  const files = validFiles()
  files['src/main/modules/tools/direct.ts'] = [
    "const LOG = getLogPath('ready-tools.log')",
    "appendFileSync(LOG, 'x')",
  ].join('\n')
  withFixture(files, (root) => {
    const result = checkLogRotation({ root })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /getLogPath/)
  })
})

test('fails when async direct ready log writer bypasses rotation', () => {
  const files = validFiles()
  files['src/main/modules/browser/direct.ts'] = "appendFile('ready-browser.log', 'x')\n"
  withFixture(files, (root) => {
    const result = checkLogRotation({ root })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /ready-browser\.log/)
  })
})

function validFiles() {
  return {
    'src/main/utils/rotating-logger.ts': [
      "getLogPath('ready-agent-metrics.log')",
      'appendFileSync(path, text)',
      'appendFile(path, text)',
    ].join('\n'),
    'src/main/modules/logs.ts': [
      "createRotatingLogger('ready-agent-metrics.log')",
      "createRotatingLogger('ready-database.log')",
      "createRotatingLogger('ready-tools.log')",
      "createRotatingLogger('ready-system-tools.log')",
      "createRotatingLogger('ready-memory-tools.log')",
      "createRotatingLogger('ready-directchat.log')",
      "createRotatingLogger('ready-search.log')",
      "createRotatingLogger('ready-settings.log')",
      "createRotatingLogger('ready-browser.log')",
      "appendFileSync(getLogPath('ready-design-run-captures.ndjson'), line)",
    ].join('\n'),
  }
}

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-log-rotation-'))
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
