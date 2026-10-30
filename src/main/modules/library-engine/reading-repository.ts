import type { LibraryBookmark, LibraryReadingPosition } from '../../../shared/library'
import type { DatabaseConnection } from '../database/connection'
import { bookIdSchema, bookmarksSchema, positionSchema } from './validation'

export class LibraryReadingRepository {
  constructor(private readonly db: DatabaseConnection) {}

  /** A single SQLite transaction preserves newer Ready reading and adds only absent bookmarks. */
  importMissing(bookId: string, position: LibraryReadingPosition | undefined, bookmarks: LibraryBookmark[]): void {
    this.db.exec('SAVEPOINT library_archive')
    try {
      if (position && !this.getPosition(bookId)) this.setPosition(position)
      const existing = this.listBookmarks(bookId)
      const missing = bookmarks.filter(b => !existing.some(old => old.id === b.id ||
        (old.chapter === b.chapter && old.offset === b.offset && old.label === b.label && old.createdAt === b.createdAt)))
      if (missing.length) this.setBookmarks(bookId, [...existing, ...missing])
      this.db.exec('RELEASE library_archive')
    } catch (error) {
      this.db.exec('ROLLBACK TO library_archive'); this.db.exec('RELEASE library_archive')
      throw error
    }
  }

  getPosition(bookId: string): LibraryReadingPosition | null {
    const row = this.db.prepare('SELECT position_json FROM library_reading WHERE book_id = ?').get<{ position_json: string | null }>(bookIdSchema.parse(bookId))
    return row?.position_json ? positionSchema.parse(JSON.parse(row.position_json)) : null
  }

  setPosition(input: LibraryReadingPosition): LibraryReadingPosition {
    const position = positionSchema.parse(input)
    this.db.prepare(`INSERT INTO library_reading (book_id, position_json) VALUES (?, ?)
      ON CONFLICT(book_id) DO UPDATE SET position_json = excluded.position_json`).run(position.bookId, JSON.stringify(position))
    return position
  }

  listBookmarks(bookId: string): LibraryBookmark[] {
    const row = this.db.prepare('SELECT bookmarks_json FROM library_reading WHERE book_id = ?').get<{ bookmarks_json: string }>(bookIdSchema.parse(bookId))
    return row ? bookmarksSchema.parse(JSON.parse(row.bookmarks_json)) : []
  }

  setBookmarks(bookId: string, input: LibraryBookmark[]): LibraryBookmark[] {
    const id = bookIdSchema.parse(bookId)
    const bookmarks = bookmarksSchema.parse(input)
    this.db.prepare(`INSERT INTO library_reading (book_id, bookmarks_json) VALUES (?, ?)
      ON CONFLICT(book_id) DO UPDATE SET bookmarks_json = excluded.bookmarks_json`).run(id, JSON.stringify(bookmarks))
    return bookmarks
  }
}
