import { PromptAssetLoader } from '../prompt-assets/loader'
import { promptAssetRoots } from '../prompt-assets/roots'

/**
 * EP1-B2 — render the versioned browser discipline asset via the X3 loader.
 * Electron-coupled (promptAssetRoots), so it stays outside the adapter and is
 * added only after the final browser tool surface is known. Cached after first
 * load; clipped to the 2500-char turn-instruction budget.
 */

const MAX_DISCIPLINE_CHARS = 2500
let cached: string | null = null

export function loadBrowserDisciplineText(): string {
  if (cached !== null) return cached
  try {
    const loader = new PromptAssetLoader({ roots: promptAssetRoots() })
    const text = loader.render('browser/discipline')
    cached = text.length > MAX_DISCIPLINE_CHARS ? text.slice(0, MAX_DISCIPLINE_CHARS) : text
  } catch {
    // silent-catch: bundled-asset load failure degrades to empty turn guidance; tool execution must not block on it
    cached = ''
  }
  return cached
}
