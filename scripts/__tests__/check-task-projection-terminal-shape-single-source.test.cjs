'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SCRIPT = path.resolve(__dirname, '../check-task-projection-terminal-shape-single-source.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-shape-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function writeShape(root) {
  writeFile(root, 'src/main/modules/agent-control/task-projection/task-projection-terminal-shape.ts', `
export function resolveTerminalProjectionStatus() { return null }
export function resolveTerminalProjectionInteractionState() { return null }
export function resolveTerminalProjectionWaitingFor() { return null }
`)
}

test('terminal shape gate passes on the real codebase', () => {
  const result = runIn(REPO_ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-task-projection-terminal-shape-single-source: ok/)
})

test('terminal shape gate catches local terminal shape resolvers in projection sync', (t) => {
  const root = makeHarnessRoot(t)
  writeShape(root)
  writeFile(root, 'src/main/modules/agent-control/task-projection/task-projection-sync.ts', `
import { resolveTerminalProjectionStatus } from './task-projection-terminal-shape'
function resolveTerminalStatus(reason) {
  if (reason === 'done') return 'completed'
  return 'blocked'
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_terminal_shape_resolver/)
})

test('terminal shape gate catches a missing shared source export', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/task-projection/task-projection-terminal-shape.ts', `
export function resolveTerminalProjectionStatus() { return null }
`)
  writeFile(root, 'src/main/modules/agent-control/task-projection/task-projection-sync.ts', `
import { resolveTerminalProjectionStatus } from './task-projection-terminal-shape'
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /shape_export_missing/)
})
