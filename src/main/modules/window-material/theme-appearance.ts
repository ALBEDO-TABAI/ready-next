// Appearance settings owned by Main (W1 DS2, DL12): the light/dark option and the
// "reduce transparency" switch. Skins and accent colours are retired; the one-time
// migration below is the only place that still knows the old skin setting.

export const THEME_SETTING_KEY = 'ui_theme_option'
export const REDUCE_TRANSPARENCY_SETTING_KEY = 'ui_reduce_transparency'
const LEGACY_SKIN_SETTING_KEY = 'ui_theme_skin'
// Skins that painted a Ready-owned opaque backdrop instead of the desktop glass.
const LEGACY_OPAQUE_SKINS = new Set(['ready-glass', 'solid-green-glass', 'solid-blue-glass'])

export type ThemeOption = 'light' | 'dark' | 'system'
export type Transparency = 'normal' | 'reduced'

export interface AppearanceSettingsStore {
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
  deleteSetting(key: string): void
}

/**
 * One-time migration of the retired skin setting. Users who had chosen an opaque skin get
 * "reduce transparency" on, unless they already set the switch themselves. Running it again
 * changes nothing.
 */
export function migrateLegacyAppearanceSettings(store: AppearanceSettingsStore): { migrated: boolean; reduceTransparency: boolean | null } {
  const legacy = store.getSetting(LEGACY_SKIN_SETTING_KEY)
  if (legacy === undefined) return { migrated: false, reduceTransparency: null }
  const skin = String(legacy).trim().toLowerCase()
  const explicit = store.getSetting(REDUCE_TRANSPARENCY_SETTING_KEY)
  let reduceTransparency: boolean | null = null
  if (explicit === undefined && LEGACY_OPAQUE_SKINS.has(skin)) {
    store.setSetting(REDUCE_TRANSPARENCY_SETTING_KEY, 'true')
    reduceTransparency = true
  }
  store.deleteSetting(LEGACY_SKIN_SETTING_KEY)
  return { migrated: true, reduceTransparency }
}

export function readThemeOption(store: Pick<AppearanceSettingsStore, 'getSetting'>): ThemeOption {
  const raw = String(store.getSetting(THEME_SETTING_KEY) || '').trim().toLowerCase()
  return raw === 'dark' || raw === 'system' ? raw : 'light'
}

export function readReduceTransparency(store: Pick<AppearanceSettingsStore, 'getSetting'>): boolean {
  return String(store.getSetting(REDUCE_TRANSPARENCY_SETTING_KEY) || '').trim().toLowerCase() === 'true'
}

/** The switch follows the system: either one asking for less transparency is enough. */
export function resolveTransparency(input: { userReduce: boolean; systemReduce: boolean }): Transparency {
  return input.userReduce || input.systemReduce ? 'reduced' : 'normal'
}
