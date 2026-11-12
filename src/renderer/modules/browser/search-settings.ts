import { DEFAULT_SEARCH_SETTINGS, readBrowserSearchSettings, SEARCH_ENGINE_KEY, SEARCH_SUGGESTIONS_KEY, type BrowserSearchSettings } from '../../../shared/search-engines'

type SearchSettingsAPI = { settings: Pick<Window['electronAPI']['settings'], 'getAll'>; browser: Pick<Window['electronAPI']['browser'], 'onSearchSettingsChanged'> }
let current: BrowserSearchSettings = { ...DEFAULT_SEARCH_SETTINGS }
export function getBrowserSearchSettings(): BrowserSearchSettings { return current }

/** Subscribe before the initial read so an old read cannot overwrite a newer save. */
export async function initializeBrowserSearchSettings(api: SearchSettingsAPI): Promise<() => void> {
  const values: Record<string, string> = {}
  const changed = new Set<string>()
  const unsubscribe = api.browser.onSearchSettingsChanged(({ key, value }) => {
    changed.add(key)
    values[key] = value
    current = readBrowserSearchSettings(key => values[key])
  })
  try {
    const result = await api.settings.getAll()
    if (!result.success) throw new Error(result.error || 'search_settings_read_failed')
    for (const key of [SEARCH_ENGINE_KEY, SEARCH_SUGGESTIONS_KEY]) {
      if (!changed.has(key) && result.data?.[key] !== undefined) values[key] = result.data[key]
    }
    current = readBrowserSearchSettings(key => values[key])
    return unsubscribe
  } catch (error) {
    unsubscribe()
    throw error
  }
}

if (typeof window !== 'undefined' && window.electronAPI) {
  void initializeBrowserSearchSettings(window.electronAPI).catch(error => console.error('[browser] search settings unavailable', error))
}
