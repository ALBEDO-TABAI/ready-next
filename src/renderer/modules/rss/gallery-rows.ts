import type { RSSItem } from '../../components/rss/RSSFeed'
import { dayHeading, dayKey, itemTimestamp } from './feed-item'

// How 图册 lays a feed out (plan 2026-11-18 资讯配图, P10): covers in rows, as many across as the panel has room for.

/** How many covers go across, by the width of the panel. */
export function galleryColumns(width: number): number {
  return width < 560 ? 1 : width < 880 ? 2 : width < 1280 ? 3 : 4
}

export interface GalleryRow { key: string; heading: { main: string; detail: string } | null; items: RSSItem[] }

/** The items in rows of `columns`; the first row of each day carries the date. */
export function galleryRows(items: readonly RSSItem[], columns: number): GalleryRow[] {
  const rows: GalleryRow[] = []
  let day: string | null = null
  for (const item of items) {
    const key = dayKey(itemTimestamp(item)), last = rows.at(-1)
    if (key !== day || !last || last.items.length >= columns) rows.push({ key: `row:${item.id}`, heading: key !== day ? dayHeading(itemTimestamp(item)) : null, items: [item] })
    else last.items.push(item)
    day = key
  }
  return rows
}
