/**
 * Stage U PR U1.2 — legacy AgentManager IPC channels removed.
 *
 * Asserts the IPC handler source no longer registers
 * `agent:orchestrate` / `agent:getStatus` / `agent:getAll` /
 * `agent:getDiagnostics`, and the preload + renderer-type surfaces
 * no longer expose their wrappers / type declarations.
 *
 * This is a source-grep structural test (CLAUDE.md §6.4 "structural gate"
 * category). Paired with the runtime CI gate
 * `scripts/check-no-legacy-agent-ipc.cjs` for active reintroduction
 * prevention, this test pins the deletion as a one-shot historical
 * baseline. If either fails after a green build, suspect a regression.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readWorkspaceFile(rel: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- Stage U §0.7: source-grep is permitted as a structural gate when paired with a runtime gate. This test pairs with check-no-legacy-agent-ipc.cjs (U1.2).
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

const LEGACY_CHANNELS = [
  'agent:orchestrate',
  'agent:getStatus',
  'agent:getAll',
  'agent:getDiagnostics',
]

test('U1.2 main: claude-bridge/ipc-handler.ts no longer registers any legacy AgentManager IPC channel', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  for (const channel of LEGACY_CHANNELS) {
    assert.doesNotMatch(
      source,
      new RegExp(`ipcMain\\.handle\\(\\s*['"]${channel}['"]`),
      `${channel} handler must be removed in U1.2`,
    )
  }
})

test('U1.2 preload: index.ts no longer wraps any legacy AgentManager channel', () => {
  const source = readWorkspaceFile('src/preload/index.ts')
  for (const channel of LEGACY_CHANNELS) {
    assert.doesNotMatch(
      source,
      new RegExp(`ipcRenderer\\.invoke\\(\\s*['"]${channel}['"]`),
      `${channel} preload wrapper must be removed in U1.2`,
    )
  }
  // Wrapper method names are also retired.
  for (const method of ['orchestrate:', 'getDiagnostics:']) {
    // These names exist on OTHER namespaces (browser:getDiagnostics, settings:getAll, etc.)
    // so we cannot blanket-grep them — instead assert the specific agent-namespace
    // wrappers are gone by checking they don't sit next to `agent:` invokes.
    assert.doesNotMatch(
      source,
      new RegExp(`${method}.*ipcRenderer\\.invoke\\(\\s*['"]agent:`),
      `agent-namespace ${method} wrapper must be removed in U1.2`,
    )
  }
})

test('U1.2 renderer types: electron.d.ts no longer declares legacy agent type signatures', () => {
  const source = readWorkspaceFile('src/renderer/types/electron.d.ts')
  // The legacy declarations were:
  //   orchestrate: (task, agents) => Promise<...>
  //   getStatus: (agent) => Promise<unknown>
  //   getAll: () => Promise<unknown>
  //   getDiagnostics: () => Promise<{ success; data: unknown }>
  // After U1.2, only the U1.2 deletion comment should mention them.
  // We pin the strictest signal: the historical `getAll: () => Promise<unknown>`
  // (return type literally `unknown`) signature.
  assert.doesNotMatch(
    source,
    /\bgetAll:\s*\(\)\s*=>\s*Promise<unknown>/,
    'legacy getAll type signature must be removed in U1.2',
  )
  // Same for `getDiagnostics: () => Promise<{ success: boolean; data: unknown }>`
  assert.doesNotMatch(
    source,
    /\bgetDiagnostics:\s*\(\)\s*=>\s*Promise<\{\s*success:\s*boolean;\s*data:\s*unknown\s*\}>/,
    'legacy getDiagnostics type signature must be removed in U1.2',
  )
})

test('U1.2 retirement is announced in a code comment so future readers know why', () => {
  // The deletion is not a no-op; we leave a comment block pointing to the
  // SDK runtime replacement so future PRs do not "helpfully" re-add the
  // channels by reading git blame on the empty spot.
  const ipc = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  assert.match(
    ipc,
    /U1\.2.*legacy agent IPC channels removed/i,
    'main IPC source must contain a U1.2 retirement note (acts as the deletion sentinel)',
  )
  const preload = readWorkspaceFile('src/preload/index.ts')
  assert.match(
    preload,
    /U1\.2.*removed.*orchestrate.*getStatus.*getAll.*getDiagnostics/,
    'preload must contain a U1.2 retirement note enumerating the removed wrappers',
  )
})
