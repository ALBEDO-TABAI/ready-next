'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-p7c3b-surface-claims.cjs')

function makeRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7c3b-claims-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(root, rel, body) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function seed(root, overrides = {}) {
  const files = {
    'docs/superpowers/plans/2026-06-20-p7c3b-default-surface-tightening-implementation.md': [
      'No browser profile, partition, cookie, login, permission, history, download, or site-learning isolation.',
      'No claim that P7c3b closes P7c4.',
      'Deferred To P7c4',
    ].join('\n'),
    'outputs/agent-audit/fix-plan/00-ROADMAP.md': 'P7c3b  default surface tightening（新增；visible co-driving 显式化，不声称隔离）\n',
    'src/renderer/modules/browser/browserOwnershipStatus.ts': [
      'Agent 协作当前页',
      '当前可见页写锁',
      'Agent 后台页',
      '后台 Agent 页写锁',
    ].join('\n'),
    'src/renderer/components/browser/AgentBrowserSupervisionPanel.tsx': [
      '当前可见页协作',
      '后台 Agent 页',
      'Agent 正在协作当前页',
      'Agent 正在后台页工作',
    ].join('\n'),
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) writeFile(root, rel, body)
}

function run(root) {
  return spawnSync('node', [SCRIPT], { cwd: root, encoding: 'utf8' })
}

test('p7c3b claim gate passes the honest non-isolation contract', (t) => {
  const root = makeRoot(t)
  seed(root)
  const result = run(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-p7c3b-surface-claims.*OK/)
})

test('p7c3b claim gate fails when the plan omits non-isolation scope', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'docs/superpowers/plans/2026-06-20-p7c3b-default-surface-tightening-implementation.md': 'Deferred To P7c4\n',
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /No browser profile/)
})

test('p7c3b claim gate fails on overclaim wording', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'outputs/agent-audit/fix-plan/00-ROADMAP.md': [
      'P7c3b  default surface tightening（新增；visible co-driving 显式化，不声称隔离）',
      'P7c3b browser isolation complete',
    ].join('\n'),
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /overclaims P7c3b/)
})

test('p7c3b claim gate fails when UI copy stops distinguishing surfaces', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'src/renderer/modules/browser/browserOwnershipStatus.ts': 'Agent 浏览器\n',
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Agent 协作当前页/)
})
