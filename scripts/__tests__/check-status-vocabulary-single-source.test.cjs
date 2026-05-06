'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-status-vocabulary-single-source.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeVocabulary(rootDir) {
  const p = path.join(rootDir, 'src/renderer/modules/agent/task-status-vocabulary.ts')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, `
export const __GATE_CANONICAL_LABELS = Object.freeze([
  '已完成', '失败', '进行中',
])
`)
}

test('L5 gate passes when no agent-surface file inlines a canonical label', (t) => {
  const root = makeHarnessRoot(t)
  writeVocabulary(root)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L5 gate fails when agent-surface file inlines a canonical label', (t) => {
  const root = makeHarnessRoot(t)
  writeVocabulary(root)
  const offender = path.join(root, 'src/renderer/components/agent/SomePanel.tsx')
  fs.mkdirSync(path.dirname(offender), { recursive: true })
  fs.writeFileSync(offender, `
import type { TaskCardRun } from '../../foo'
export function Bad(run: TaskCardRun) {
  return <span>{run.status === 'done' ? '已完成' : '进行中'}</span>
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /inline_canonical_label/)
})

test('L5 gate ignores files that do not import any trigger type', (t) => {
  const root = makeHarnessRoot(t)
  writeVocabulary(root)
  const offFile = path.join(root, 'src/renderer/components/rss/RssLabel.tsx')
  fs.mkdirSync(path.dirname(offFile), { recursive: true })
  fs.writeFileSync(offFile, `
export function RssLabel() {
  return <span>已完成</span>
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L5 gate ignores test files', (t) => {
  const root = makeHarnessRoot(t)
  writeVocabulary(root)
  const t1 = path.join(root, 'src/renderer/__tests__/foo.test.tsx')
  fs.mkdirSync(path.dirname(t1), { recursive: true })
  fs.writeFileSync(t1, `
import type { TaskCardRun } from '../foo'
export function bad(run: TaskCardRun) { return '已完成' }
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L5 gate fails when canonical labels constant is missing', (t) => {
  const root = makeHarnessRoot(t)
  const p = path.join(root, 'src/renderer/modules/agent/task-status-vocabulary.ts')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, `// vocabulary without canonical labels\n`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /__GATE_CANONICAL_LABELS array literal not found/)
})
