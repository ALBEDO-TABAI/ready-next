import type { RSSItem, RSSSource } from '../../components/rss/RSSFeed'

export interface RSSWarmCacheSnapshot {
  items: RSSItem[]
  sources: RSSSource[]
  isMock: boolean
  fetchedAt: number
}

let rssWarmCache: RSSWarmCacheSnapshot | null = null
let rssWarmCachePromise: Promise<RSSWarmCacheSnapshot> | null = null

export function getRSSWarmCache(): RSSWarmCacheSnapshot | null {
  return rssWarmCache
}

export function setRSSWarmCache(snapshot: RSSWarmCacheSnapshot): RSSWarmCacheSnapshot {
  rssWarmCache = snapshot
  return snapshot
}

export function primeRSSWarmCache(loader: () => Promise<RSSWarmCacheSnapshot>): Promise<RSSWarmCacheSnapshot> {
  if (rssWarmCache) return Promise.resolve(rssWarmCache)
  if (rssWarmCachePromise) return rssWarmCachePromise

  rssWarmCachePromise = loader()
    .then((snapshot) => {
      rssWarmCache = snapshot
      return snapshot
    })
    .finally(() => {
      rssWarmCachePromise = null
    })

  return rssWarmCachePromise
}
