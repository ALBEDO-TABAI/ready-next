import type { LibraryBook } from './library'
import type { DatabaseDefinition, DatabaseView, projectView } from './document-database'

export interface BookPreview {
  kind: 'book'
  book: Pick<LibraryBook, 'id' | 'title' | 'author' | 'coverPath' | 'format'>
  passage: { text: string; prefix: string; suffix: string; chapterTitle: string; note?: string; located: boolean } | null
}
export interface WebPreview { kind: 'web'; title: string; url: string; excerpts: { id: string; text: string; note: string }[] }
export interface CanvasPreview { kind: 'canvas'; title: string; nodes: { id: string; x: number; y: number; width: number; height: number; title: string }[] }
export type StoredObjectPreview = BookPreview | WebPreview | CanvasPreview
export interface DatabasePreview {
  kind: 'database'
  definition: DatabaseDefinition
  view: DatabaseView
  rows: ReturnType<typeof projectView>['rows']
  total: number
}
