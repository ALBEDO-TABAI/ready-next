import { recentNavigation, type NavigationState } from '../../../../shared/navigation-history'
import { toReadyUri } from '../../../../shared/ready-ref'
import { searchPresentation } from '../../../../shared/search-presentation'
import type { SearchResultItem } from './query'

/** The palette consumes this projection; it does not maintain its own list of visits or open tabs. */
export function recentOpenedResults(state: NavigationState): SearchResultItem[] {
  return recentNavigation(state).map(entry => {
    const kind = entry.ref.kind, path = toReadyUri(entry.ref)
    const sourceType = kind.startsWith('rss-') ? 'rss' : kind === 'event' || kind === 'day' ? 'calendar' : kind === 'web' ? 'bookmark' : kind === 'book-location' ? 'book' : kind === 'conversation' ? 'agent' : kind === 'canvas' ? 'canvas' : kind === 'fastcard' ? 'fastcard' : 'page'
    return { ...searchPresentation({ name: entry.title, path, sourceType }), name: entry.title, path, sourceType, nameMatch: false, snippet: '', tagsHit: [], linksHit: [] }
  })
}
