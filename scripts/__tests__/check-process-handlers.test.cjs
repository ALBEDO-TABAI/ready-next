const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const test = require('node:test')

const { checkProcessHandlers } = require('../check-process-handlers.cjs')

test('passes with four handlers, bounded cleanup, and local process metrics', () => {
  withFixture(validFiles(), (root) => {
    const result = checkProcessHandlers({ root })
    assert.equal(result.ok, true, result.errors.join('\n'))
  })
})

test('fails when any required global handler is missing', () => {
  const files = validFiles()
  files['src/main/process-handlers.ts'] = files['src/main/process-handlers.ts'].replace(
    "deps.app.on('child-process-gone', () => {})",
    '',
  )
  withFixture(files, (root) => {
    const result = checkProcessHandlers({ root })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /child-process-gone/)
  })
})

test('fails when process metrics are added to TOOL_ERROR_METRICS', () => {
  const files = validFiles()
  files['src/main/modules/agent-control/tool-error-metrics.ts'] = "export const TOOL_ERROR_METRICS = { process: 'process_unhandled_rejection' }\n"
  withFixture(files, (root) => {
    const result = checkProcessHandlers({ root })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /TOOL_ERROR_METRICS/)
  })
})

function validFiles() {
  return {
    'src/main/index.ts': "import { registerMainProcessHandlers } from './process-handlers'\nregisterMainProcessHandlers({ app, cleanup: runFatalProcessCleanup })\napp.whenReady().then(() => {})\n",
    'src/main/process-handlers.ts': [
      "const DEFAULT_FATAL_CLEANUP_TIMEOUT_MS = 5_000",
      "processTarget.on('unhandledRejection', () => {})",
      "processTarget.on('uncaughtException', () => {})",
      "deps.app.on('render-process-gone', () => {})",
      "deps.app.on('child-process-gone', () => {})",
      'app.exit(1)',
    ].join('\n'),
    'src/main/utils/process-metrics.ts': [
      "'process_unhandled_rejection'",
      "'process_uncaught_exception'",
      "'render_process_gone'",
      "'child_process_gone'",
      "'log_rotation_failed'",
    ].join('\n'),
    'src/main/modules/agent-control/tool-error-metrics.ts': "export const TOOL_ERROR_METRICS = { surfaced: 'tool_error_surfaced' }\n",
  }
}

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-process-handlers-'))
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
