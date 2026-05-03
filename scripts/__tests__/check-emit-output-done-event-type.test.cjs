const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const {
  checkEmitOutputDoneEventType,
} = require('../check-emit-output-done-event-type.cjs')

const SCRIPT_PATH = resolve(__dirname, '../check-emit-output-done-event-type.cjs')

function withSourceFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-done-event-type-'))
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const fullPath = join(root, relativePath)
      mkdirSync(resolve(fullPath, '..'), { recursive: true })
      writeFileSync(fullPath, source)
    }
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('accepts status-derived final output type', () => {
  withSourceFixture(
    {
      'src/main/modules/agent-control/turn-engine.ts': [
        "const status = params.status || 'error'",
        "transcript.emitOutput('', status === 'error' ? 'error' : 'done')",
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkEmitOutputDoneEventType({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('rejects retired doneEventType compatibility parameter', () => {
  withSourceFixture(
    {
      'src/main/modules/agent-control/turn-engine.ts': [
        "function finish(params: { doneEventType?: 'done' | 'error' }) {",
        "  transcript.emitOutput('', params.doneEventType || 'done')",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkEmitOutputDoneEventType({ root })
      assert.equal(result.violations.length, 2)
      assert.match(result.violations[0].message, /doneEventType is retired/)
    },
  )
})

test('supports CLI --root', () => {
  withSourceFixture(
    {
      'src/main/modules/agent-control/turn-engine.ts': [
        "transcript.emitOutput('', status === 'error' ? 'error' : 'done')",
        '',
      ].join('\n'),
    },
    (root) => {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /emit output doneEventType: ok/)
    },
  )
})
