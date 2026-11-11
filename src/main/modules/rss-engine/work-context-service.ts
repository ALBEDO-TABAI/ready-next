import type { RSSSieveStore } from '../database/rss-sieve-store'
import type { RSSWorkContextSnapshot } from '../../../shared/rss-sieve'
import { buildRSSWorkContext, type RSSWorkContextSources } from './work-context'
/** Preview and transmission share title selection; only transmission requires consent. No title history is retained. */
export function previewRSSWorkContext(store: RSSSieveStore, sources: RSSWorkContextSources, now: number): RSSWorkContextSnapshot {
  try {
    const privacy = store.privacy()
    return buildRSSWorkContext(sources, privacy, store.excludedPages(), now)
  } catch (error) {
    console.warn('[rss-work-context] unable to build titles; omitting context', error)
    return { text:'',entries:[] }
  }
}

export function sendableRSSWorkContext(store: RSSSieveStore, sources: RSSWorkContextSources, now: number): RSSWorkContextSnapshot {
  try {
    const privacy = store.privacy()
    if (privacy.answer !== 'enabled' || !privacy.enabled) return { text:'',entries:[] }
    return buildRSSWorkContext(sources, privacy, store.excludedPages(), now)
  } catch (error) {
    console.warn('[rss-work-context] unable to build titles; omitting context', error)
    return { text:'',entries:[] }
  }
}
