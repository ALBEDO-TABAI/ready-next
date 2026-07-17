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
    policy: 'shared-default-with-explicit-profiles',
    surfaces: [
      {
        id: 'normal-and-agent-tabs',
        file: 'src/main/modules/browser-engine/tab-lifecycle-service.ts',
        partition: 'persist:browser or persist:browser-profile-*',
        evidence: "profile ? `persist:browser-profile-${profile}` : 'persist:browser'",
      },
      {
        id: 'preview-view',
        file: 'src/main/modules/browser-engine/preview-service.ts',
        partition: 'persist:browser (default)',
        evidence: "this.deps.createHost('persist:browser')",
      },
      {
        id: 'auth-popup',
        file: 'src/main/modules/browser-engine/auth-popup-manager.ts',
        partition: 'source profile or persist:browser',
        evidence: "profile ? `persist:browser-profile-${profile}` : 'persist:browser'",
      },
      {
        id: 'background-probe',
        file: 'src/main/modules/browser-engine/ipc-handler.ts',
        partition: 'persist:browser (background probe)',
        evidence: "partition: 'persist:browser'",
      },
      {
        id: 'download-session',
        file: 'src/main/modules/browser-engine/ipc-handler.ts',
        partition: 'source tab session or persist:browser fallback',
        evidence: 'targetSession = this.resolveTabView(payload.tabId).view.webContents.session',
      },
      {
        id: 'permission-and-adblock-policy',
        file: 'src/main/modules/browser-engine/ipc-handler.ts',
        partition: 'every created browser partition',
        evidence: 'this.sessionPolicyService.applyForPartition(partition)',
      },
    ],
  }
  const files = {
    'scripts/p7c4-browser-identity-inventory.json': `${JSON.stringify(inventory, null, 2)}\n`,
    'src/main/modules/browser-engine/tab-lifecycle-service.ts': "const view = this.host.createHost(profile ? `persist:browser-profile-${profile}` : 'persist:browser')\n",
    'src/main/modules/browser-engine/ipc-handler.ts': [
      'async ensureAgentTab() {',
      "const created = await this.createTab(READY_BROWSER_BLANK_URL, { background: true })",
      "this.updateTabRuntimeState(created.tabId, { owner: 'agent', activity: 'running' })",
      "partition: 'persist:browser'",
      "session.fromPartition('persist:browser')",
      'targetSession = this.resolveTabView(payload.tabId).view.webContents.session',
      'this.sessionPolicyService.applyForPartition(partition)',
      '}',
    ].join('\n'),
    'src/main/modules/browser-engine/preview-service.ts': "this.deps.createHost('persist:browser')\n",
    'src/main/modules/browser-engine/auth-popup-manager.ts': "profile ? `persist:browser-profile-${profile}` : 'persist:browser'\n",
    'src/main/modules/browser-engine/session-policy-service.ts': "this.applyForPartition('persist:browser')\n",
    'src/main/modules/browser-engine/browser-surface-binding.ts': [
      'user-view-assisted',
      'agent-view-background',
      'read-only-observe',
    ].join('\n'),
    'docs/superpowers/plans/2026-06-20-p7c4-browser-identity-policy-spike-implementation.md': [
      'Current State: Shared Default With Explicit Profiles',
      'current agent browser work is not browser identity isolation',
      'Ready keeps the default browser identity shared',
      'native lock overlay and supervision panel signal control ownership only',
      'named profiles isolate cookies and origin storage, while history and application-level learning remain shared by policy.',
      'Profile selection is explicit; Ready never silently moves an existing tab into another identity.',
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

test('p7c4 identity gate passes the honest shared-default and explicit-profile policy', (t) => {
  const root = makeRoot(t)
  seed(root)
  const result = run(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-p7c4-browser-identity-policy.*OK/)
})

test('p7c4 identity gate fails when explicit profile evidence disappears', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'src/main/modules/browser-engine/tab-lifecycle-service.ts': "const view = this.host.createHost('persist:browser')\n",
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /browser-profile/)
})

test('p7c4 identity gate fails when inventory stops admitting the shared partition', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'scripts/p7c4-browser-identity-inventory.json': `${JSON.stringify({
      policy: 'shared-default-with-explicit-profiles',
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
  assert.match(result.stderr, /Current State: Shared Default With Explicit Profiles/)
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
      'P7c3 native lock overlay 只证明锁层可见，不证明隔离。',
    ].join('\n'),
  })
  const result = run(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
