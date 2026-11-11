import { removeStorage } from '../utils/storage'

// W1-T1 one-time cleanup: the skin and accent caches are retired. Main migrated the setting
// itself (window-material/theme-appearance.ts); the renderer only drops the stale copies.
const RETIRED_THEME_STORAGE_KEYS = ['ready-theme-skin', 'ready-theme-accent'] as const

export function removeRetiredThemeStorage(): void {
  for (const key of RETIRED_THEME_STORAGE_KEYS) removeStorage(key)
}
