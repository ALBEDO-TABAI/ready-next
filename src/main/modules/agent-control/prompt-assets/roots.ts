import { join } from 'path'
import { app } from 'electron'

/**
 * Electron-coupled prompt-assets root resolution (EP1-X3). Kept separate from
 * the loader so the loader stays unit-testable without the app. Mirrors the
 * embedded-skills dev/prod candidate order.
 */
export function promptAssetRoots(): string[] {
  return [
    join(process.resourcesPath, 'prompts'),
    join(app.getAppPath(), 'assets', 'prompts'),
    join(process.cwd(), 'assets', 'prompts'),
  ]
}
