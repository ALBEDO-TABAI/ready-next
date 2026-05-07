'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-no-active-child-run-polling.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-o-poll-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeRenderer(rootDir, body) {
  const p = path.join(rootDir, 'src/renderer/components/agent/ChatPanel.tsx')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

test('no setInterval — pass', (t) => {
  const root = makeHarness(t)
  writeRenderer(root, `
function f(api) {
  api.listActiveChildRuns()
}
`)
  const res = runIn(root)
  assert.equal(res.status, 0, res.stderr)
})

test('setInterval polling listActiveChildRuns without marker — fail', (t) => {
  const root = makeHarness(t)
  writeRenderer(root, `
function f(api) {
  setInterval(() => { api.listActiveChildRuns() }, 2000)
}
`)
  const res = runIn(root)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /polling_listActiveChildRuns/)
})

test('setInterval with gate-allow marker — pass', (t) => {
  const root = makeHarness(t)
  writeRenderer(root, `
function f(api) {
  // gate-allow:active-child-run-debug
  setInterval(() => { api.listActiveChildRuns() }, 2000)
}
`)
  const res = runIn(root)
  assert.equal(res.status, 0, res.stderr)
})

test('setInterval doing other work — pass', (t) => {
  const root = makeHarness(t)
  writeRenderer(root, `
function f() {
  setInterval(() => { console.log('tick') }, 1000)
}
`)
  const res = runIn(root)
  assert.equal(res.status, 0, res.stderr)
})
