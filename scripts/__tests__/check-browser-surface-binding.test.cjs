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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-surface-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(root, rel, body) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function seedMinimum(root, overrides = {}) {
  const files = {
    'src/main/modules/browser-engine/agent-browser-errors.ts': "export type AgentBrowserSurface = 'user-view' | 'agent-view'\nexport type AgentBrowserErrorCode = 'browser_surface_undeclared' | 'browser_surface_binding_violation'\n",
    'src/main/modules/browser-engine/browser-surface-binding.ts': "export const x = 'user-view-assisted agent-view-background read-only-observe resolveBrowserToolSurfaceBinding'\n",
    'src/main/modules/tools/tool-executor.ts': "resolveBrowserToolSurfaceBinding({ dispatch: 'tool-executor' })\n",
    'src/main/modules/browser-engine/scoped-browser-facade.ts': "resolveBrowserToolSurfaceBinding({ dispatch: 'scoped-facade' })\n",
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) writeFile(root, rel, body)
}

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

test('browser surface gate fails when the engine surface enum widens', (t) => {
  const root = makeRoot(t)
  seedMinimum(root, {
    'src/main/modules/browser-engine/agent-browser-errors.ts': "export type AgentBrowserSurface = 'user-view' | 'agent-view' | 'read-only-observe'\nexport type AgentBrowserErrorCode = 'browser_surface_undeclared' | 'browser_surface_binding_violation'\n",
  })
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /two engine write-lease surfaces/)
})

test('browser surface gate fails when tool-executor does not declare dispatch', (t) => {
  const root = makeRoot(t)
  seedMinimum(root, {
    'src/main/modules/tools/tool-executor.ts': 'executeBrowserTool(toolName, args)\n',
  })
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /tool-executor/)
})

test('browser surface gate fails on a new production executeBrowserTool bypass', (t) => {
  const root = makeRoot(t)
  seedMinimum(root)
  writeFile(root, 'src/main/modules/rogue-browser-entry.ts', `
import { executeBrowserTool } from './tools/browser-tools'
export async function rogue(toolName, args, controller) {
  return executeBrowserTool(toolName, args, controller)
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /rogue-browser-entry/)
})

test('browser surface gate fails on a new executeBrowserTool bypass outside modules', (t) => {
  const root = makeRoot(t)
  seedMinimum(root)
  writeFile(root, 'src/main/rogue-main-entry.ts', `
import { executeBrowserTool } from './modules/tools'
export async function rogue(toolName, args, controller) {
  return executeBrowserTool(toolName, args, controller)
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /rogue-main-entry/)
})

test('browser surface gate ignores executeBrowserTool mentions in comments', (t) => {
  const root = makeRoot(t)
  seedMinimum(root)
  writeFile(root, 'src/main/modules/comment-only-browser-entry.ts', `
// executeBrowserTool should not count from a line comment.
/*
 * executeBrowserTool should not count from a block comment either.
 */
export const commentOnly = true
`)
  const result = runIn(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-browser-surface-binding.*OK/)
})

test('browser surface gate allows only a tools barrel re-export', (t) => {
  const root = makeRoot(t)
  seedMinimum(root)
  writeFile(root, 'src/main/modules/tools/index.ts', `
import { executeBrowserTool } from './browser-tools'
export { executeBrowserTool }
`)
  const result = runIn(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-browser-surface-binding.*OK/)
})

test('browser surface gate rejects a tools barrel call', (t) => {
  const root = makeRoot(t)
  seedMinimum(root)
  writeFile(root, 'src/main/modules/tools/index.ts', `
import { executeBrowserTool } from './browser-tools'
export { executeBrowserTool }
export async function runBrowserTool(toolName, args, controller) {
  return executeBrowserTool(toolName, args, controller)
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /re-export/)
})

test('browser surface gate rejects an extra direct ipc-handler executeBrowserTool call', (t) => {
  const root = makeRoot(t)
  seedMinimum(root)
  writeFile(root, 'src/main/modules/browser-engine/ipc-handler.ts', `
export function makeFacade() {
  return new ScopedBrowserFacade({
    execute: async (toolName, args, gateSurface, gateLeaseId) => {
      const { executeBrowserTool } = await import('../tools/browser-tools')
      return executeBrowserTool(toolName, args, {}, undefined, undefined, { surface: gateSurface, leaseId: gateLeaseId })
    },
  })
}
export async function bypass(toolName, args, controller) {
  const { executeBrowserTool } = await import('../tools/browser-tools')
  return executeBrowserTool(toolName, args, controller)
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /exactly one/)
})

test('browser surface gate passes on the real codebase', () => {
  const result = runIn(REPO_ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-browser-surface-binding.*OK/)
})
