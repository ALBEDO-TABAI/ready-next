import { PromptAssetLoader } from '../prompt-assets/loader'
import { promptAssetRoots } from '../prompt-assets/roots'

/**
 * EP1-B2 — render the versioned browser discipline asset via the X3 loader.
 * Electron-coupled (promptAssetRoots), so it lives outside the adapter, which
 * stays electron-free and receives the rendered text. Cached after first load;
 * clipped to the 2500-char fragment budget.
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
    // silent-catch: bundled-asset load failure degrades to an empty discipline fragment; prompt assembly must not block on it
    cached = ''
  }
  return cached
}
