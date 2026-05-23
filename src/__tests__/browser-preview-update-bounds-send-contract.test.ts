// Stage Y Y1.4 — IPC contract hardening (reduction-only).
//
// Behavior pinned: `browser:previewUpdateBounds` is a send-only channel.
// The renderer (`src/preload/index.ts:368-371`) calls `ipcRenderer.send`;
// the main side (`src/main/modules/browser-engine/ipc-shell.ts`)
// registers ONLY `ipcMain.on('browser:previewUpdateBounds', ...)` — the
// legacy `ipcMain.handle('browser:previewUpdateBounds', ...)` dual
// registration that Y1.4 removed is forbidden going forward.
//
// Y1.4 removed the dead `ipcMain.handle(...)` registration along with the
// matching `invoke_only` row in `scripts/ipc-contract-allowlist.json`. This
// test guards against the dual-registration creeping back (which would
// re-trip the V5 IPC contract gate as handled-only without a renderer
// caller).
//
// Why structural: `setupBrowserShellIPC` consumes the live electron
// `ipcMain` singleton (see `ipc-shell.ts:1`). The electron module is not
// loadable outside the Electron runtime (its npm package exports a binary
// launcher path, not the ipcMain API), so the behavioral
// "ipcMain receives a `send` and triggers `controller.previewUpdateBounds`"
// loop is not observable from a `node:test` host. The V5 IPC contract gate
// (`npm run verify:ipc-contract`) IS the behavioral check — it scans the
// real source, asserts the renderer-side `ipcRenderer.send` ↔ main-side
// `ipcMain.on` correspondence, and fails if the dual `handle` registration
// returns. This test complements the gate by pinning the file-level
// invariant in a place reviewers see during ordinary code review.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(relativePath: string): string {
  // allow-source-grep: IPC handler registration shape — electron module is not loadable outside Electron runtime (its npm package exports a binary launcher path, not the ipcMain API), so the ipcMain.handle / ipcMain.on registration shape is verified at the source level. Paired with `npm run verify:ipc-contract` (V5 gate) which is the behavioral check.
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

test('browser:previewUpdateBounds is registered via ipcMain.on (send path) in ipc-shell.ts', () => {
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')

  // The live send-path registration must exist. Match
  // `ipcMain.on(\n    'browser:previewUpdateBounds',` and any whitespace
  // / multi-line body in between.
  assert.match(
    ipcShell,
    /ipcMain\.on\(\s*'browser:previewUpdateBounds'\s*,/,
    'ipcMain.on(\'browser:previewUpdateBounds\') must remain registered — this is the live path the preload uses via ipcRenderer.send',
  )
})

test('Y1.4 removed the legacy ipcMain.handle(browser:previewUpdateBounds) dual registration', () => {
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')

  // The dual `handle()` registration was dead code (no renderer caller
  // used `ipcRenderer.invoke` for this channel; preload routes through
  // `ipcRenderer.send`). Y1.4 removed it along with the matching
  // `invoke_only` allowlist row. Reintroducing it would re-trip the V5
  // gate as handled-only without a counterpart.
  assert.doesNotMatch(
    ipcShell,
    /ipcMain\.handle\(\s*'browser:previewUpdateBounds'\s*,/,
    'ipcMain.handle(\'browser:previewUpdateBounds\') must NOT be re-registered (removed by Y1.4 reduction-only IPC hardening)',
  )
})

test('preload routes previewUpdateBounds through ipcRenderer.send (not invoke)', () => {
  const preload = readWorkspaceFile('src/preload/index.ts')

  // Pin the preload-side contract: `previewUpdateBounds` is `send`-shaped,
  // matching the kept `ipcMain.on(...)` on the main side. If the preload
  // ever switches back to `invoke`, the kept `on()` would silently miss
  // every call and the dual `handle()` would need to come back — exactly
  // the regression Y1.4 hardens against.
  assert.match(
    preload,
    /previewUpdateBounds:\s*\([^)]*\)\s*=>\s*\{[\s\S]*?ipcRenderer\.send\(\s*'browser:previewUpdateBounds'/,
    'preload previewUpdateBounds must use ipcRenderer.send, not invoke',
  )
  assert.doesNotMatch(
    preload,
    /previewUpdateBounds:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*'browser:previewUpdateBounds'/,
    'preload must NOT switch previewUpdateBounds back to ipcRenderer.invoke (would orphan the main-side ipcMain.on registration)',
  )
})

test('removed allowlist row is no longer present in scripts/ipc-contract-allowlist.json', () => {
  const allowlistRaw = readWorkspaceFile('scripts/ipc-contract-allowlist.json')
  const allowlist = JSON.parse(allowlistRaw) as {
    invoke_only?: Array<{ channel: string }>
  }
  const invokeOnly = allowlist.invoke_only ?? []
  const previewUpdateBoundsRow = invokeOnly.find(
    (entry) => entry.channel === 'browser:previewUpdateBounds',
  )
  assert.equal(
    previewUpdateBoundsRow,
    undefined,
    'invoke_only entry for browser:previewUpdateBounds was removed by Y1.4 and must stay removed',
  )
})
