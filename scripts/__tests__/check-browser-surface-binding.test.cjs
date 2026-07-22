'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-browser-surface-binding.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function makeRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-claim-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(root, rel, body) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function seed(root) {
  write(root, 'src/main/modules/browser-engine/browser-target-claims.ts', 'BrowserTargetClaimRepository BrowserTargetClaimService checkWrite( recordUserSignal(')
  write(root, 'src/main/modules/browser-engine/agent-browser-lease-gate.ts', 'BrowserTargetClaimService checkWrite(')
  write(root, 'src/main/modules/tools/browser-tools.ts', 'export function executeBrowserTool() {}')
}

function run(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

test('target-claim gate rejects a retired ownership file', (t) => {
  const root = makeRoot(t)
  seed(root)
  write(root, 'src/main/modules/browser-engine/browser-write-lease.ts', 'legacy')
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /legacy ownership path/)
})

test('target-claim gate rejects a new executeBrowserTool bypass', (t) => {
  const root = makeRoot(t)
  seed(root)
  write(root, 'src/main/modules/rogue.ts', 'executeBrowserTool()')
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /bypasses the target-claim tool funnel/)
})

test('target-claim gate passes on the real codebase', () => {
  const result = run(REPO_ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-browser-surface-binding.*OK/)
})
