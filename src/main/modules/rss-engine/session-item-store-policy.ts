/**
 * Which items of a login platform are written after a refresh.
 *
 * An item is written when it is first seen and then left as it was. The same note or video comes back on every
 * refresh with a newly signed cover address, a new access token in its link, or — read from the page instead of
 * from its responses — a slightly different title; each such difference would count as changed content, drop the
 * saved body and send the item to be judged again. One exception: a reading that knows the publish date replaces
 * one that did not.
 */
export interface StorableSessionItem {
  id: string
  published_at: number | null
}

export function selectFirstSeenSessionItems<T extends StorableSessionItem>(
  items: T[],
  stored: ReadonlyArray<StorableSessionItem>,
): T[] {
  const storedById = new Map(stored.map((row) => [row.id, row]))
  return items.filter((item) => {
    const existing = storedById.get(item.id)
    return !existing || (existing.published_at == null && item.published_at != null)
  })
}
