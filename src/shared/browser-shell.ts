import { z } from 'zod'
import type { RSSArticleExcerpt } from './rss-workspace'

export const browserTabRequestSchema = z.object({ tabId: z.string().min(1) }).strict()
export const browserSuggestSchema = z.object({ query: z.string().max(2000), limit: z.number().int().min(1).max(20).optional() }).strict()
export const browserFindSchema = browserTabRequestSchema.extend({ text: z.string().min(1).max(2000), forward: z.boolean().optional(), findNext: z.boolean().optional(), matchCase: z.boolean().optional() })
export const browserStopFindSchema = browserTabRequestSchema.extend({ action: z.enum(['clearSelection', 'keepSelection', 'activateSelection']) })
export type BrowserFindRequest = z.infer<typeof browserFindSchema>
export type BrowserStopFindRequest = z.infer<typeof browserStopFindSchema>
export interface BrowserFoundInPage { tabId: string; requestId: number; matches: number; activeMatchOrdinal: number; finalUpdate: boolean }
export interface BrowserSuggestion { url: string; title: string; favicon: string | null }
export interface BrowserSuggestions {
  tabs: (BrowserSuggestion & { tabId: string; browserTaskId?: string })[]
  bookmarks: BrowserSuggestion[]
  history: (BrowserSuggestion & { visitCount: number; lastVisitedAt: number })[]
  search: string[]
}
export const browserPageCapabilitiesSchema = z.object({ url: z.string(), readable: z.boolean(), feeds: z.array(z.object({ url: z.string().url(), title: z.string(), type: z.string() }).strict()) }).strict()
export type BrowserPageCapabilities = z.infer<typeof browserPageCapabilitiesSchema>
export interface BrowserPageCapabilitiesChanged extends BrowserPageCapabilities { tabId: string }
/** Same complete excerpt consumed by the RSS reader; browser ids are ephemeral, never RSS record ids. */
export interface BrowserReadArticle extends RSSArticleExcerpt {
  url: string; title: string; byline: string | null; siteName: string; publishedAt: number | null; lang: string | null
}
export type BrowserReadResult = { success: true; data: BrowserReadArticle } | { success: false; error: 'tab_missing' | 'unsupported_protocol' | 'not_readable' | 'too_large' | 'page_changed' | 'extraction_failed' }
