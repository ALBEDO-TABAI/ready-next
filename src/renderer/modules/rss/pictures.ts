import { useEffect } from 'react'
import { create } from 'zustand'
import { RSS_PICTURE_LOOKUP_MAX_ITEMS } from '../../../shared/rss-pictures'

// Pictures for items whose feed gave none (plan 2026-11-18 资讯配图, P3 and P7). An item that comes on screen without
// a cover asks once in a session; what is asked within a moment goes to Main as one request, and the answers are
// kept here by item id. Main decides whether a page is read at all and how often; nothing is fetched from here.

export const useRSSPictures = create<{ found: Record<string, string | null> }>(() => ({ found: {} }))
const asked = new Set<string>()
let waiting: string[] = [], timer: ReturnType<typeof setTimeout> | null = null

async function send(): Promise<void> {
  timer = null
  const batch = waiting.splice(0, RSS_PICTURE_LOOKUP_MAX_ITEMS)
  if (waiting.length) timer = setTimeout(() => void send(), 0)
  if (!batch.length) return
  // The app's preload always has the method; a test double of the bridge may not, and then nothing is asked.
  const lookup = globalThis.window?.electronAPI?.rss?.lookupPictures
  if (!lookup) return
  try {
    const result = await lookup({ itemIds: batch })
    if (!result.success || !result.data) throw new Error(result.error || '配图没有读到')
    const found = Object.fromEntries(result.data.pictures.map(picture => [picture.itemId, picture.coverImage]))
    useRSSPictures.setState(state => ({ found: { ...state.found, ...found } }))
  } catch (cause) {
    // silent-catch: a picture that could not be read leaves the item as words; there is nothing for the reader to do about it.
    console.warn('[rss] picture lookup did not finish', cause)
  }
}

/** Ask for the picture of an item that has none from its feed. Asking again for the same item does nothing. */
export function requestRSSPicture(itemId: string): void {
  if (asked.has(itemId)) return
  asked.add(itemId); waiting.push(itemId)
  timer ??= setTimeout(() => void send(), 120)
}

/** The item's picture: its feed cover, else what the lookup found. Null while unknown and when there is none. */
export function useRSSPicture(itemId: string, coverImage: string | null | undefined): string | null {
  const found = useRSSPictures(state => state.found[itemId])
  useEffect(() => { if (!coverImage) requestRSSPicture(itemId) }, [itemId, coverImage])
  return coverImage || found || null
}

/** Tests start from nothing asked and nothing found. */
export function resetRSSPicturesForTests(): void {
  if (timer) clearTimeout(timer)
  timer = null; waiting = []; asked.clear(); useRSSPictures.setState({ found: {} })
}
