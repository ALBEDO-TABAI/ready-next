#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function fail(message) {
  console.error(`[check-p7c4-browser-identity-policy] FAIL: ${message}`)
  process.exit(1)
}

function read(relPath) {
  const full = path.join(ROOT, relPath)
  if (!fs.existsSync(full)) fail(`missing required file: ${relPath}`)
  return fs.readFileSync(full, 'utf8')
}

function assertIncludes(relPath, needles) {
  const source = read(relPath)
  for (const needle of needles) {
    if (!source.includes(needle)) fail(`${relPath} missing required text: ${needle}`)
  }
  return source
}

function assertInventory() {
  const inventory = JSON.parse(read('scripts/p7c4-browser-identity-inventory.json'))
  if (inventory.policy !== 'shared-default-with-explicit-profiles') {
    fail(`inventory policy must be shared-default-with-explicit-profiles, got ${inventory.policy}`)
  }
  if (!Array.isArray(inventory.surfaces) || inventory.surfaces.length < 6) {
    fail('inventory must list the current shared browser surfaces')
  }
  for (const surface of inventory.surfaces) {
    if (!surface || typeof surface !== 'object') fail('inventory surface entries must be objects')
    const id = String(surface.id || '').trim()
    const file = String(surface.file || '').trim()
    const partition = String(surface.partition || '').trim()
    const evidence = String(surface.evidence || '').trim()
    if (!id || !file || !partition || !evidence) {
      fail(`inventory entry is incomplete: ${JSON.stringify(surface)}`)
    }
    assertIncludes(file, [evidence])
  }
}

function assertNoSharedSessionIsolationClaim(relPath, source) {
  const lines = source.split(/\r?\n/)
  const overclaim = lines.find((line) => {
    if (!/P7c4|agent browser|Agent browser|后台|background|native lock|锁层|overlay/i.test(line)) return false
    if (!/(isolation|isolated|independent browser|独立浏览器|独立.*身份|隔离)/i.test(line)) return false
    if (/(not|no |cannot|must not|does not include|deferred|future|decision\/spike|fail|fails|failing|不是|不等于|不包含|不含|不证明|不得|未实现|未来|后续)/i.test(line)) return false
    return /(complete|done|closed|achieved|implemented|实现|完成|关闭|已完成|已实现|已经隔离)/i.test(line)
      || /(?:is|equals|=|等于|就是).*(?:isolation|isolated|隔离|独立浏览器)/i.test(line)
  })
  if (overclaim) fail(`${relPath} overclaims browser identity isolation: ${overclaim}`)
}

assertInventory()

const tabLifecycle = assertIncludes('src/main/modules/browser-engine/tab-lifecycle-service.ts', [
  "profile ? `persist:browser-profile-${profile}` : 'persist:browser'",
])

const ipcHandler = assertIncludes('src/main/modules/browser-engine/ipc-handler.ts', [
  'async ensureAgentTab()',
  "const created = await this.createTab(READY_BROWSER_BLANK_URL, { background: true })",
  "this.updateTabRuntimeState(created.tabId, { owner: 'agent', activity: 'running' })",
  "partition: 'persist:browser'",
  "session.fromPartition('persist:browser')",
])

assertIncludes('src/main/modules/browser-engine/preview-service.ts', [
  "this.deps.createHost('persist:browser')",
])

assertIncludes('src/main/modules/browser-engine/auth-popup-manager.ts', [
  "profile ? `persist:browser-profile-${profile}` : 'persist:browser'",
])

assertIncludes('src/main/modules/browser-engine/session-policy-service.ts', [
  "this.applyForPartition('persist:browser')",
])

assertIncludes('src/main/modules/browser-engine/browser-surface-binding.ts', [
  'user-view-assisted',
  'agent-view-background',
  'read-only-observe',
])

const plan = assertIncludes('docs/superpowers/plans/2026-06-20-p7c4-browser-identity-policy-spike-implementation.md', [
  'Current State: Shared Default With Explicit Profiles',
  'current agent browser work is not browser identity isolation',
  'Ready keeps the default browser identity shared',
  'native lock overlay and supervision panel signal control ownership only',
  'named profiles isolate cookies and origin storage, while history and application-level learning remain shared by policy.',
  'Profile selection is explicit; Ready never silently moves an existing tab into another identity.',
])

const consensus = assertIncludes('outputs/agent-audit/fix-plan/164-CONSENSUS-BROWSER-ISOLATION-SPECIALIST-PRODUCT-ROUTE.md', [
  'same partition + hidden tab + overlay must fail any claim of "isolation"',
])

const roadmap = assertIncludes('outputs/agent-audit/fix-plan/00-ROADMAP.md', [
  'P7c4',
  'identity/session policy',
])

for (const [relPath, source] of [
  ['docs/superpowers/plans/2026-06-20-p7c4-browser-identity-policy-spike-implementation.md', plan],
  ['outputs/agent-audit/fix-plan/164-CONSENSUS-BROWSER-ISOLATION-SPECIALIST-PRODUCT-ROUTE.md', consensus],
  ['outputs/agent-audit/fix-plan/00-ROADMAP.md', roadmap],
  ['src/main/modules/browser-engine/tab-lifecycle-service.ts', tabLifecycle],
  ['src/main/modules/browser-engine/ipc-handler.ts', ipcHandler],
]) {
  assertNoSharedSessionIsolationClaim(relPath, source)
}

console.log('[check-p7c4-browser-identity-policy] OK')
