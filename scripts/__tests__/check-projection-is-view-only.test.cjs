'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-projection-is-view-only.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l3-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeProjectionFile(rootDir, rel, body) {
  const p = path.join(rootDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

function writeAllProjectionStubs(rootDir, body) {
  for (const rel of [
    'src/main/modules/agent-control/task-projection/run-projection.ts',
    'src/main/modules/agent-control/task-projection/task-projection-sync.ts',
    'src/main/modules/repositories/task-projection-repository.ts',
    'src/main/modules/agent-control/skills/skill-running-projection.ts',
  ]) {
    writeProjectionFile(rootDir, rel, body)
  }
  writeProjectionFile(rootDir, 'src/main/modules/repositories/skill-task-run-repository.ts', '// ledger\n')
}

test('L3 gate passes when all projection files are clean', (t) => {
  const root = makeHarnessRoot(t)
  writeAllProjectionStubs(root, '// no imports\n')
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L3 gate passes when projection imports type-only from skill-task-run-repository', (t) => {
  const root = makeHarnessRoot(t)
  writeAllProjectionStubs(root, `
import type { SkillTaskRunRecord } from '../repositories/skill-task-run-repository'
export const noop = () => null
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L3 gate fails when projection value-imports skill-task-run-repository', (t) => {
  const root = makeHarnessRoot(t)
  writeAllProjectionStubs(root, '// clean\n')
  writeProjectionFile(root, 'src/main/modules/agent-control/task-projection/run-projection.ts', `
import { SkillTaskRunRepository } from '../repositories/skill-task-run-repository'
export function bad(repo: SkillTaskRunRepository) { return repo }
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /projection_imports_ledger_value/)
})

test('L3 gate fails when projection calls ledger writer .updateChildRun', (t) => {
  const root = makeHarnessRoot(t)
  writeAllProjectionStubs(root, '// clean\n')
  writeProjectionFile(root, 'src/main/modules/agent-control/task-projection/task-projection-sync.ts', `
export function bad(repo: any) {
  repo.updateChildRun('id', { status: 'done' })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /projection_calls_ledger_writer/)
})

test('L3 gate fails when ledger imports a task-projection module', (t) => {
  const root = makeHarnessRoot(t)
  writeAllProjectionStubs(root, '// clean\n')
  writeProjectionFile(root, 'src/main/modules/repositories/skill-task-run-repository.ts', `
import { syncTaskProjection } from '../agent-control/task-projection/task-projection-sync'
export const dummy = () => syncTaskProjection
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /ledger_imports_projection/)
})

test('L3 gate ignores type-only ledger imports of task-projection', (t) => {
  const root = makeHarnessRoot(t)
  writeAllProjectionStubs(root, '// clean\n')
  writeProjectionFile(root, 'src/main/modules/repositories/skill-task-run-repository.ts', `
import type { TaskProjectionRecord } from '../agent-control/task-projection/task-projection-sync'
export type Foo = TaskProjectionRecord
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
