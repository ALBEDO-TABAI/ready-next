import { create } from 'zustand'
import { readJsonStorage, writeJsonStorage } from '../utils/storage'

// How a 资讯 surface lays its items out (2026-11-18). 列表 reads like an edition: what the sieve picked gets a large
// picture, everything else a small one at the end of its line. 图册 is a board of covers. Each surface remembers its
// own choice on this machine; a surface that has never been switched starts as 列表.
export type RSSLayout = 'list' | 'gallery'
export type RSSLayoutSurface = 'feed' | 'sieve' | 'digest'

const KEY = 'ready-rss-layouts'
const SURFACES: readonly RSSLayoutSurface[] = ['feed', 'sieve', 'digest']
function saved(): Record<RSSLayoutSurface, RSSLayout> {
  const stored = readJsonStorage<Partial<Record<RSSLayoutSurface, unknown>>>(KEY, {})
  return Object.fromEntries(SURFACES.map(surface => [surface, stored?.[surface] === 'gallery' ? 'gallery' : 'list'])) as Record<RSSLayoutSurface, RSSLayout>
}

export const useRSSLayout = create<{ layouts: Record<RSSLayoutSurface, RSSLayout>; setLayout(surface: RSSLayoutSurface, layout: RSSLayout): void }>((set, get) => ({
  layouts: saved(),
  setLayout: (surface, layout) => {
    const layouts = { ...get().layouts, [surface]: layout }
    set({ layouts })
    writeJsonStorage(KEY, layouts)
  },
}))
