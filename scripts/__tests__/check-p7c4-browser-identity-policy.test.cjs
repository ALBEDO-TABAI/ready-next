'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-p7c4-browser-identity-policy.cjs')

function makeRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7c4-identity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(root, rel, body) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function seed(root, overrides = {}) {
  const inventory = {
    policy: 'shared-persist-browser',
    surfaces: [
      {
        id: 'normal-and-agent-tabs',
        file: 'src/main/modules/browser-engine/tab-lifecycle-service.ts',
        partition: 'persist:browser',
        evidence: "this.host.createHost('persist:browser')",
      },
      {
        id: 'rss-article-fetch',
        file: 'src/main/modules/rss-engine/content-runtime.ts',
        partition: 'persist:browser',
        evidence: "session.fromPartition('persist:browser')",
      },
      {
        id: 'auth-popup',
        file: 'src/main/modules/browser-engine/auth-popup-manager.ts',
        partition: 'persist:browser',
        evidence: "partition: 'persist:browser'",
      },
      {
        id: 'background-probe',
        file: 'src/main/modules/browser-engine/ipc-handler.ts',
        partition: 'persist:browser',
        evidence: "partition: 'persist:browser'",
      },
      {
        id: 'download-session',
        file: 'src/main/modules/browser-engine/ipc-handler.ts',
        partition: 'persist:browser',
        evidence: "session.fromPartition('persist:browser')",
      },
      {
        id: 'permission-and-adblock-policy',
        file: 'src/main/modules/browser-engine/session-policy-service.ts',
        partition: 'persist:browser',
        evidence: "applyForPartition('persist:browser')",
      },
    ],
  }
  const files = {
    'scripts/p7c4-browser-identity-inventory.json': `${JSON.stringify(inventory, null, 2)}\n`,
    'src/main/modules/browser-engine/tab-lifecycle-service.ts': "const view = this.host.createHost('persist:browser')\n",
    'src/main/modules/browser-engine/ipc-handler.ts': [
      'async ensureAgentTab() {',
      "const created = await this.createTab(READY_BROWSER_BLANK_URL, { background: true })",
      "this.updateTabRuntimeState(created.tabId, { owner: 'agent', activity: 'running' })",
      "partition: 'persist:browser'",
      "session.fromPartition('persist:browser')",
      '}',
    ].join('\n'),
    'src/main/modules/rss-engine/content-runtime.ts': "session.fromPartition('persist:browser')\n",
    'src/main/modules/browser-engine/auth-popup-manager.ts': "partition: 'persist:browser'\n",
    'src/main/modules/browser-engine/session-policy-service.ts': "applyForPartition('persist:browser')\n",
    'src/main/modules/browser-engine/browser-surface-binding.ts': [
      'user-view-assisted',
      'agent-view-background',
      'read-only-observe',
    ].join('\n'),
    'docs/superpowers/plans/2026-06-20-p7c4-browser-identity-policy-spike-implementation.md': [
      'Current State: Shared Browser Identity',
      'current agent browser work is not browser identity isolation',
      'Ready keeps the current shared browser identity for now',
      'native lock overlay and supervision panel signal control ownership only',
      'Gate proves normal tabs, agent tabs, RSS article fetch, auth popup, background probe, downloads, and session policy all still use `persist:browser`.',
      'No production partition/profile change in this batch',
    ].join('\n'),
    'outputs/agent-audit/fix-plan/164-CONSENSUS-BROWSER-ISOLATION-SPECIALIST-PRODUCT-ROUTE.md': 'negative contract: same partition + hidden tab + overlay must fail any claim of "isolation".\n',
    'outputs/agent-audit/fix-plan/00-ROADMAP.md': 'P7c4 browser identity/session policy decision spike; not implemented isolation.\n',
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) writeFile(root, rel, body)
}

function run(root) {
  return spawnSync('node', [SCRIPT], { cwd: root, encoding: 'utf8' })
}

test('p7c4 identity gate passes the honest shared-browser policy', (t) => {
  const root = makeRoot(t)
  seed(root)
  const result = run(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-p7c4-browser-identity-policy.*OK/)
})

test('p7c4 identity gate fails when shared partition evidence disappears', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'src/main/modules/browser-engine/tab-lifecycle-service.ts': "const view = this.host.createHost('persist:agent')\n",
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /persist:browser/)
})

test('p7c4 identity gate fails when inventory stops admitting the shared partition', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'scripts/p7c4-browser-identity-inventory.json': `${JSON.stringify({
      policy: 'shared-persist-browser',
      surfaces: [
        {
          id: 'normal-and-agent-tabs',
          file: 'src/main/modules/browser-engine/tab-lifecycle-service.ts',
          partition: 'persist:agent',
          evidence: "this.host.createHost('persist:browser')",
        },
      ],
    })}\n`,
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /must list the current shared browser surfaces|must remain honest/)
})

test('p7c4 identity gate fails when docs omit shared identity state', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'docs/superpowers/plans/2026-06-20-p7c4-browser-identity-policy-spike-implementation.md': 'No production partition/profile change in this batch\n',
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Current State: Shared Browser Identity/)
})

test('p7c4 identity gate fails on same-session isolation overclaim', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'outputs/agent-audit/fix-plan/00-ROADMAP.md': [
      'P7c4 browser identity/session policy decision spike',
      'P7c4 browser isolation complete',
    ].join('\n'),
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /overclaims browser identity isolation/)
})

test('p7c4 identity gate allows explicit exclusion wording', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'outputs/agent-audit/fix-plan/00-ROADMAP.md': [
      'P7c4 browser identity/session policy decision spike',
      'P3c 不包含浏览器身份隔离。',
      'P7c4 已完成锁层，但没有实现独立 BrowserView/profile/session/partition 隔离。',
      'P7c3 native lock overlay 只证明锁层可见，不证明隔离。',
    ].join('\n'),
  })
  const result = run(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
