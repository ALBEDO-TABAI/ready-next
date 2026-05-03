const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const {
  checkTerminalReasonPropagation,
} = require('../check-terminal-reason-propagation.cjs')

const SCRIPT_PATH = resolve(__dirname, '../check-terminal-reason-propagation.cjs')

function withSourceFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-terminal-reason-'))
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

test('accepts bare working status', () => {
  withSourceFixture(
    {
      'src/main/modules/claude-bridge/direct-chat.ts': [
        'export function run(emitStatus: (status: string, terminalReason?: string) => void) {',
        "  emitStatus('working')",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkTerminalReasonPropagation({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('rejects terminal status without terminalReason', () => {
  withSourceFixture(
    {
      'src/main/modules/claude-bridge/direct-chat.ts': [
        'export function run(emitStatus: (status: string, terminalReason?: string) => void) {',
        "  emitStatus('checkpoint')",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkTerminalReasonPropagation({ root })
      assert.equal(result.violations.length, 1)
      assert.equal(result.violations[0].file, 'src/main/modules/claude-bridge/direct-chat.ts')
      assert.equal(result.violations[0].line, 2)
      assert.match(result.violations[0].message, /terminal emitStatus/)
    },
  )
})

test('accepts terminal status with explicit terminalReason', () => {
  withSourceFixture(
    {
      'src/main/modules/claude-bridge/direct-chat.ts': [
        'export function run(emitStatus: (status: string, terminalReason?: string) => void) {',
        "  emitStatus('checkpoint', 'checkpoint_budget')",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkTerminalReasonPropagation({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('accepts terminal status object with explicit terminalReason', () => {
  withSourceFixture(
    {
      'src/main/modules/agent-control/turn-transcript.ts': [
        'export function run(emitStatus: (event: { status: string, terminalReason?: string }) => void) {',
        "  emitStatus({ status: 'checkpoint', terminalReason: 'checkpoint_budget' })",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkTerminalReasonPropagation({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('rejects terminal status object without terminalReason', () => {
  withSourceFixture(
    {
      'src/main/modules/agent-control/turn-transcript.ts': [
        'export function run(emitStatus: (event: { status: string, terminalReason?: string }) => void) {',
        "  emitStatus({ status: 'done' })",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkTerminalReasonPropagation({ root })
      assert.equal(result.violations.length, 1)
      assert.equal(result.violations[0].line, 2)
      assert.match(result.violations[0].message, /terminal emitStatus/)
    },
  )
})

test('ignores dynamic status forwarding through TurnTranscript', () => {
  withSourceFixture(
    {
      'src/main/modules/agent-control/turn-engine.ts': [
        'export function run(transcript: { emitStatus: (status: string, terminalReason?: string | null) => void }, status: string, terminalReason?: string | null) {',
        '  transcript.emitStatus(status, terminalReason)',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkTerminalReasonPropagation({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('supports CLI --root', () => {
  withSourceFixture(
    {
      'src/main/modules/claude-bridge/direct-chat.ts': [
        'export function run(emitStatus: (status: string, terminalReason?: string) => void) {',
        "  emitStatus('working')",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], {
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /terminal reason propagation: ok/)
    },
  )
})
