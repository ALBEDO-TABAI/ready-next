import type { LibraryHighlightState } from './library'
import type { PdfSelection } from './pdf-source-anchor'
import type { RSSReadExcerptInput } from './rss-excerpt'
import type { RSSReadingRange } from './rss-reading'

export type SourceReply<T = LibraryHighlightState> = { success: true; data: T } | { success: false; error: string }
export interface SourceHighlightRemove { sourceId: string; id: string; expectedVersion: string }
export type SourceHighlightRemoval = Pick<LibraryHighlightState, 'sourcePath' | 'version' | 'persistence'>
export interface SourceAnnotationsAPI {
  pdf(input: PdfSelection): Promise<SourceReply>
  rss(input: RSSReadExcerptInput): Promise<SourceReply>
  web(input: { tabId: string }): Promise<SourceReply>
  /** A selection in the browser's reading view: the article as the reader showed it (its revision) and the range. */
  webReading(input: { tabId: string; revision: string; range: RSSReadingRange }): Promise<SourceReply>
  removeHighlight(input: SourceHighlightRemove): Promise<SourceReply<SourceHighlightRemoval>>
}
