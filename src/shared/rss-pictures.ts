import { z } from 'zod'

// Pictures for RSS items (2026-11-18, plan: docs/superpowers/plans/2026-11-18-ready-next-rss-pictures-implementation.md).
// An item's picture is, in order: the cover its feed gave it; else the picture its own page declares
// (og:image / twitter:image), looked up once and kept beside the item. A looked-up picture is never written
// into the item itself, so the article's revision, its saved body and the model's work on it stay as they were.

/** The most items one lookup request may name. */
export const RSS_PICTURE_LOOKUP_MAX_ITEMS = 24

export const RSSPictureLookupSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(RSS_PICTURE_LOOKUP_MAX_ITEMS),
}).strict()
export type RSSPictureLookupInput = z.infer<typeof RSSPictureLookupSchema>

/**
 * feed: the feed's own cover. page: the picture the item's page declares. none: the page declares none.
 * failed: the page could not be read this time (it is tried once more, later). skipped: this item is not
 * looked up (no public page address, or a source read through the person's own session). unknown: no such item.
 */
export type RSSPictureState = 'feed' | 'page' | 'none' | 'failed' | 'skipped' | 'unknown'
export interface RSSPictureResult { itemId: string; coverImage: string | null; state: RSSPictureState }
export interface RSSPictureLookupResult { pictures: RSSPictureResult[] }
