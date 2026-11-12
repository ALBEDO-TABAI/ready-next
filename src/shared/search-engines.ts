export const SEARCH_ENGINES = {
  google: { name: 'Google', search: 'https://www.google.com/search?q=%s', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s' },
  bing: { name: 'Bing', search: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s' },
  duckduckgo: { name: 'DuckDuckGo', search: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?type=list&q=%s' },
  baidu: { name: '百度', search: 'https://www.baidu.com/s?wd=%s', suggest: 'https://suggestion.baidu.com/su?ie=utf-8&action=opensearch&wd=%s' },
} as const

export const SEARCH_ENGINE_KEY = 'browser.searchEngine'
export const SEARCH_SUGGESTIONS_KEY = 'browser.searchSuggestions'
export interface BrowserSearchSettings { readonly searchEngine: string; readonly searchSuggestions: boolean }
export const DEFAULT_SEARCH_SETTINGS: BrowserSearchSettings = { searchEngine: 'google', searchSuggestions: false }

/** The stored string is either a built-in id or a custom http(s) template. */
export function resolveSearchEngine(value = 'google'): { search: string; suggest?: string } {
  if (Object.hasOwn(SEARCH_ENGINES, value)) return SEARCH_ENGINES[value as keyof typeof SEARCH_ENGINES]
  const url = new URL(value)
  if (!/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(url.protocol) || !value.includes('%s') || url.username || url.password) {
    throw new Error('invalid_search_engine_template')
  }
  return { search: value }
}

export function validateBrowserSearchSetting(key: string, value: string): void {
  if (key === SEARCH_ENGINE_KEY) resolveSearchEngine(value)
  if (key === SEARCH_SUGGESTIONS_KEY && value !== 'true' && value !== 'false') throw new Error('invalid_search_suggestions_setting')
}

export function readBrowserSearchSettings(read: (key: string) => string | undefined): BrowserSearchSettings {
  const searchEngine = read(SEARCH_ENGINE_KEY) ?? DEFAULT_SEARCH_SETTINGS.searchEngine
  resolveSearchEngine(searchEngine)
  return { searchEngine, searchSuggestions: read(SEARCH_SUGGESTIONS_KEY) === 'true' }
}

export function searchTemplateUrl(template: string, query: string): string {
  return template.replaceAll('%s', encodeURIComponent(query))
}
