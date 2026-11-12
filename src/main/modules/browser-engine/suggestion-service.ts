import { browserSuggestSchema, type BrowserSuggestions, type BrowserSuggestion } from '../../../shared/browser-shell'
import { readBrowserSearchSettings, resolveSearchEngine, searchTemplateUrl } from '../../../shared/search-engines'

interface SuggestionSource {
  getSetting(key: string): string | undefined
  getBookmarks(): BrowserSuggestion[]
  getHistory(): { url: string; title: string; favicon?: string | null; visited_at: number; visit_count: number }[]
}
export function normalizeSuggestionUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    url.hostname = url.hostname.replace(/^www\./, '')
    return url.toString().replace(/\/$/, '')
  } catch {
    // silent-catch: local bookmark/history values that are not URLs still deduplicate literally.
    return value
  }
}

export class BrowserSuggestionService {
  private request: AbortController | null = null
  constructor(private readonly deps: {
    data: SuggestionSource
    tabs(): BrowserSuggestions['tabs']
    fetch: typeof fetch
    now?: () => number
  }) {}

  async suggest(input: unknown): Promise<BrowserSuggestions> {
    this.request?.abort()
    const controller = new AbortController()
    this.request = controller
    const { query: raw, limit = 6 } = browserSuggestSchema.parse(input)
    const query = raw.trim().toLowerCase()
    const result: BrowserSuggestions = { tabs: [], bookmarks: [], history: [], search: [] }
    const seen = new Set<string>()
    const matches = (row: BrowserSuggestion) => row.url.toLowerCase().includes(query) || row.title.toLowerCase().includes(query)
    const prefix = (row: BrowserSuggestion) => {
      try { return new URL(row.url).hostname.replace(/^www\./, '').toLowerCase().startsWith(query) ? 10 : 0 }
      catch { return 0 /* silent-catch: invalid local URLs have no domain-prefix bonus. */ }
    }
    const unique = <T extends BrowserSuggestion>(rows: T[]) => rows.filter(row => {
      const key = normalizeSuggestionUrl(row.url)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, limit)
    if (query) {
      result.tabs = unique(this.deps.tabs().filter(matches).sort((a, b) => prefix(b) - prefix(a)))
      result.bookmarks = unique(this.deps.data.getBookmarks().filter(matches).sort((a, b) => prefix(b) - prefix(a)))
    }
    const history = new Map<string, BrowserSuggestions['history'][number]>()
    for (const row of this.deps.data.getHistory()) {
      const key = normalizeSuggestionUrl(row.url), prior = history.get(key)
      const newer = !prior || row.visited_at > prior.lastVisitedAt
      history.set(key, { url: newer ? row.url : prior.url, title: newer ? row.title : prior.title || row.title,
        favicon: (newer ? row.favicon : prior.favicon) ?? null, visitCount: Math.max(prior?.visitCount ?? 0, row.visit_count),
        lastVisitedAt: Math.max(row.visited_at, prior?.lastVisitedAt ?? 0) })
    }
    const now = (this.deps.now?.() ?? Date.now()) / 1000
    const score = (row: BrowserSuggestions['history'][number]) => prefix(row) + Math.log2(row.visitCount + 1) + 4 / (1 + Math.max(0, now - row.lastVisitedAt) / 86400)
    result.history = unique([...history.values()].filter(matches).sort((a, b) => query ? score(b) - score(a) : b.lastVisitedAt - a.lastVisitedAt))
    const settings = readBrowserSearchSettings(key => this.deps.data.getSetting(key))
    const template = resolveSearchEngine(settings.searchEngine).suggest
    if (!query || !settings.searchSuggestions || !template) return result
    let timer: ReturnType<typeof setTimeout> | undefined
    const aborted = new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }))
    try {
      timer = setTimeout(() => controller.abort(), 800)
      const response: unknown = await Promise.race([this.deps.fetch(searchTemplateUrl(template, raw.trim()), {
        signal: controller.signal, credentials: 'omit', redirect: 'error',
      }).then(async response => response.ok ? response.json() : null), aborted])
      if (!controller.signal.aborted && Array.isArray(response) && Array.isArray(response[1])) {
        result.search = [...new Set(response[1].filter((value): value is string => typeof value === 'string'))].slice(0, limit)
      }
    } catch {
      // silent-catch: remote suggestions are optional; timeout, cancellation and provider errors return no search suggestions.
      result.search = []
    } finally {
      clearTimeout(timer)
    }
    return result
  }
}
