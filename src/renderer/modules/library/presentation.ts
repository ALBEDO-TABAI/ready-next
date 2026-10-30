import type { LibraryBook } from '../../../shared/library'
import { toLocalFileUrl } from '../../utils/dragDrop'
import { isTopic, type ShelfBook } from './topics'

export function shelfBook(book: LibraryBook): ShelfBook {
  return { id: book.id, title: book.title, author: book.author, year: book.year,
    topic: isTopic(book.topic) ? book.topic : 'unsorted', chars: book.words ?? 0,
    added: book.addedAt, pct: book.status === '读完' ? 1 : book.status === '在读' ? .01 : 0,
    favorite: false, wish: false, ext: book.format,
    cover: book.coverPath ? toLocalFileUrl(book.coverPath) : undefined }
}
