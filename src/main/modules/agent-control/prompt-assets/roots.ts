import { join } from 'path'
import { createRequire } from 'node:module'

// CommonJS `require('electron')` rather than ESM `import { app }` — Electron's
// Node entry exports a string path via `module.exports =`, so the named import
// crashes with "does not provide an export named 'app'" in non-Electron Node
// contexts (tsx tests reach this module through the orchestrator import
// chain). Same pattern as database.ts.
const electronApp = (() => {
  try {
    const electron = createRequire(import.meta.url)('electron') as typeof import('electron') | string
    return typeof electron === 'string' ? null : electron.app ?? null
  } catch {
    return null
  }
})()

/**
 * Electron-coupled prompt-assets root resolution (EP1-X3). Kept separate from
 * the loader so the loader stays unit-testable without the app. Mirrors the
 * embedded-skills dev/prod candidate order; outside Electron only the cwd
 * candidate applies.
 */
export function promptAssetRoots(): string[] {
  const roots: string[] = []
  if (process.resourcesPath) roots.push(join(process.resourcesPath, 'prompts'))
  if (electronApp) roots.push(join(electronApp.getAppPath(), 'assets', 'prompts'))
  roots.push(join(process.cwd(), 'assets', 'prompts'))
  return roots
}
