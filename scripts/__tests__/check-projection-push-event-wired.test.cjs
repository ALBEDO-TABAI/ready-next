'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-projection-push-event-wired.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-o-push-wired-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(rootDir, rel, body) {
  const p = path.join(rootDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

function writeAllFour(rootDir, opts = {}) {
  writeFile(rootDir, 'src/main/modules/repositories/task-projection-repository.ts',
    opts.repo === false
      ? 'export class TaskProjectionRepository {}\n'
      : `class T { e = { emit: (e: string) => {} }; touch() { this.e.emit('change') } }\n`,
  )
  writeFile(rootDir, 'src/main/modules/claude-bridge/ipc-handler.ts',
    opts.ipc === false
      ? 'export function setupAgentIPC() {}\n'
      : `function f(w: any) { w.webContents.send('agent:taskProjectionsChanged', {}) }\n`,
  )
  writeFile(rootDir, 'src/preload/index.ts',
    opts.preload === false
      ? 'export const api = {}\n'
      : `ipcRenderer.on('agent:taskProjectionsChanged', () => {})\n`,
  )
  writeFile(rootDir, 'src/renderer/components/agent/ChatPanel.tsx',
    opts.renderer === false
      ? 'export const X = 1\n'
      : `function s(api) { api.onTaskProjectionsChanged(() => {}) }\n`,
  )
}

test('all four sites wired — pass', (t) => {
  const root = makeHarness(t)
  writeAllFour(root)
  const res = runIn(root)
  assert.equal(res.status, 0, res.stderr)
})

test('repository missing emit — fail', (t) => {
  const root = makeHarness(t)
  writeAllFour(root, { repo: false })
  const res = runIn(root)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /TaskProjectionRepository must emit/)
})

test('ipc-handler missing send — fail', (t) => {
  const root = makeHarness(t)
  writeAllFour(root, { ipc: false })
  const res = runIn(root)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /ipc-handler must forward/)
})

test('preload missing channel — fail', (t) => {
  const root = makeHarness(t)
  writeAllFour(root, { preload: false })
  const res = runIn(root)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /preload must reference/)
})

test('ChatPanel missing subscription — fail', (t) => {
  const root = makeHarness(t)
  writeAllFour(root, { renderer: false })
  const res = runIn(root)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /ChatPanel must subscribe/)
})
