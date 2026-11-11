import { create } from 'zustand'
import { unwrapRSS } from './unwrap'

/**
 * Pages the person keeps out of 在做的事 (W5 §3): their titles are never sent with a judgment request. Main owns
 * the list; this mirrors it for the page menu's 不让筛子看到 switch.
 */
interface SieveExclusions {
  ids: ReadonlySet<string> | null
  load(): Promise<void>
  setHidden(objectId: string, hidden: boolean): Promise<void>
}

export const useSieveExclusions = create<SieveExclusions>((set) => ({
  ids: null,
  load: async () => { set({ ids: new Set(await unwrapRSS(window.electronAPI.rss.sieveExcludedPages())) }) },
  setHidden: async (objectId, hidden) => {
    set({ ids: new Set(await unwrapRSS(window.electronAPI.rss.sieveExcludePage({ objectId, excluded: hidden }))) })
  },
}))
