'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-renderer-no-status-text-guess.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-o-text-guess-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(rootDir, rel, body) {
  const p = path.join(rootDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

const TRIGGER_IMPORT = `import type { TaskProjectionRecordData } from '../../types/electron'\n`

test('clean file (no canonical phrases, no reverse parse) passes', (t) => {
  const root = makeHarness(t)
  writeFile(root, 'src/renderer/components/agent/X.tsx', TRIGGER_IMPORT + `
function render(p: TaskProjectionRecordData) {
  return p.taskTitle ?? ''
}
`)
  const res = runIn(root)
  assert.equal(res.status, 0, res.stderr)
})

test('canonical phrase literal in scoped renderer file fails', (t) => {
  const root = makeHarness(t)
  writeFile(root, 'src/renderer/components/agent/X.tsx', TRIGGER_IMPORT + `
function render(p: TaskProjectionRecordData) {
  return '后台任务已完成'
}
`)
  const res = runIn(root)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /forbidden_phrase/)
})

test('reverse `.includes()` in `if (...)` decision context fails', (t) => {
  const root = makeHarness(t)
  writeFile(root, 'src/renderer/components/agent/X.tsx', TRIGGER_IMPORT + `
function decide(summary: string) {
  if (summary.includes('完成')) { return 'done' }
  return 'running'
}
`)
  const res = runIn(root)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /reverse_text_decision/)
})

test('non-task-card file (no trigger import) is exempt — `提交失败` passes', (t) => {
  const root = makeHarness(t)
  writeFile(root, 'src/renderer/components/skill/Q.tsx', `
import * as React from 'react'
export function err() { return '提交失败' }
`)
  const res = runIn(root)
  assert.equal(res.status, 0, res.stderr)
})

test('button label `取消后台任务` (not in 5-phrase set) passes', (t) => {
  const root = makeHarness(t)
  writeFile(root, 'src/renderer/components/agent/X.tsx', TRIGGER_IMPORT + `
function btn(_p: TaskProjectionRecordData) {
  return '取消后台任务'
}
`)
  const res = runIn(root)
  assert.equal(res.status, 0, res.stderr)
})

test('reverse includes outside decision context passes', (t) => {
  const root = makeHarness(t)
  writeFile(root, 'src/renderer/components/agent/X.tsx', TRIGGER_IMPORT + `
function probe(p: TaskProjectionRecordData) {
  const flag = (p.taskSummary || '').includes('完成')
  console.log(flag)
}
`)
  const res = runIn(root)
  assert.equal(res.status, 0, res.stderr)
})
