// Library (书房) contract between the Main library engine and the Document-mode
// Library surface. Books live in the vault as source notes:
//   阅读/<书名>.md            frontmatter = the fields below, body = 标注 + 我的笔记
//   阅读/<书名>.assets/       the book file and its cover
// 阅读.md is the library database page (ready_database fields and views).

export const LIBRARY_FOLDER = '阅读'
export const LIBRARY_DATABASE_PAGE = '阅读.md'

/** Frontmatter keys of a source note. Keys are user-facing, so they are Chinese. */
export const LIBRARY_FIELDS = {
  id: 'ready_id',
  kind: '类型',
  author: '作者',
  year: '年份',
  publisher: '出版社',
  language: '语言',
  topic: '分类',
  tags: 'tags',
  status: '状态',
  file: '文件',
  cover: '封面',
  words: '字数',
  addedAt: '加入',
  finishedAt: '读完',
  source: '来源',
} as const

export const LIBRARY_KIND_BOOK = '书'

export type LibraryBookStatus = '想读' | '在读' | '读完'
export type LibraryBookFormat = 'epub' | 'txt' | 'md' | 'pdf' | 'mobi' | 'azw3' | 'fb2' | 'cbz' | 'djvu'

export interface LibraryBookSource {
  kind: 'local' | 'zlib' | 'treasure'
  ref?: string
  url?: string
}

export interface LibraryBook {
  /** ready_id of the source note; stable across renames and moves. */
  id: string
  /** Source note file name without .md, unless frontmatter sets a title. */
  title: string
  author: string
  year?: number
  publisher?: string
  language?: string
  /** A library topic key; 'unsorted' when unknown. */
  topic: string
  tags: string[]
  status: LibraryBookStatus
  format: LibraryBookFormat
  /** Absolute paths, resolved by Main inside the vault. */
  notePath: string
  filePath: string
  coverPath?: string
  words?: number
  /** Epoch milliseconds. */
  addedAt: number
  finishedAt?: number
  source: LibraryBookSource
}

/** Reading position anchored by chapter + non-whitespace offset, independent of layout. */
export interface LibraryReadingPosition {
  bookId: string
  chapter: number
  offset: number
  pct: number
  updatedAt: number
}

export interface LibraryBookmark {
  id: string
  chapter: number
  offset: number
  label: string
  createdAt: number
}

/** A note under 阅读/ that could not be read as a book; shown, never silently dropped. */
export interface LibraryIssue {
  notePath: string
  reason: string
}

export type LibraryState =
  | { status: 'no_vault' }
  | { status: 'ready'; vaultRoot: string; books: LibraryBook[]; issues: LibraryIssue[] }

export interface LibraryImportResult {
  imported: LibraryBook[]
  failed: { path: string; reason: string }[]
}

export type LibraryBookPatch = Partial<Pick<LibraryBook, 'title' | 'author' | 'topic' | 'tags' | 'status'>>

export type LibraryResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }

/*
 * IPC. Main handles, Renderer invokes. Keep channel names literal at both call
 * sites so the IPC contract gate can pair them.
 *   'library:get'           ()                                    -> LibraryState
 *   'library:importFiles'   (absolutePaths: string[])             -> LibraryImportResult
 *   'library:pickAndImport' ()                                    -> LibraryImportResult (file dialog in Main)
 *   'library:updateBook'    ({ id: string, patch: LibraryBookPatch }) -> LibraryBook (frontmatter via the write service)
 *   'library:getPosition'   (bookId: string)                      -> LibraryReadingPosition | null
 *   'library:setPosition'   (position: LibraryReadingPosition)    -> LibraryReadingPosition
 *   'library:listBookmarks' (bookId: string)                      -> LibraryBookmark[]
 *   'library:setBookmarks'  ({ bookId: string, bookmarks: LibraryBookmark[] }) -> LibraryBookmark[]
 * Push 'library:changed' (LibraryState) after imports, updates and vault changes.
 */
