import type { LibraryBook } from '../../../shared/library'
import { readFile } from 'node:fs/promises'
import { toReadyUri } from '../../../shared/ready-ref'
import { readBook } from '../library-engine/source-note'
import { parseHighlights } from '../library-engine/highlight-markdown'
import { FastCardRepository } from '../repositories/fastcard-repository'
import { AbortError, syncShared, type AdapterContext, type IndexSourceAdapter } from './adapters'

async function books(ctx: AdapterContext) {
  const candidates = ctx.repository.getConnection().prepare(`SELECT o.current_path AS path FROM objects o
    JOIN documents d ON d.object_id=o.id AND d.source_type='document'
    WHERE o.workspace_id=? AND o.status='present' AND o.identity_state<>'conflict'
      AND json_extract(d.frontmatter_json, '$.类型')='书'`).all<{ path: string }>(ctx.workspaceId)
  const result: LibraryBook[] = []
  for (const candidate of candidates) {
    if (ctx.signal?.aborted) throw new AbortError()
    const book = await readBook(ctx.workspaceRoot, candidate.path)
    if (book) result.push(book)
  }
  return result
}

export class BookAdapter implements IndexSourceAdapter {
  readonly sourceType = 'book'
  readonly workspaceScope = 'per-root'
  async reindex(ctx: AdapterContext) {
    return syncShared(this, ctx, (await books(ctx)).map(book => ({
      path: toReadyUri({ kind: 'book-location', book: book.id, loc: 'c0:0+1' }), sourceId: book.id,
      name: book.title, body: [book.title, book.author, book.publisher, ...book.tags].filter(Boolean).join(' '),
      meta: { bookId: book.id, format: book.format, author: book.author }, mtime: book.addedAt,
    })))
  }
}

export class HighlightAdapter implements IndexSourceAdapter {
  readonly sourceType = 'highlight'
  readonly workspaceScope = 'per-root'
  async reindex(ctx: AdapterContext) {
    const rows: Parameters<typeof syncShared>[2] = []
    for (const book of await books(ctx)) {
      const content = await readFile(book.notePath, 'utf8')
      for (const { highlight: h } of parseHighlights(content, book.id)) {
        rows.push({ path: toReadyUri({ kind: 'page', id: book.id, anchor: `^${h.id}` }), sourceId: `${book.id}/${h.id}`,
          name: `${book.title} · ${h.chapterTitle}`, body: [h.text, h.note, book.title, book.author].join('\n'),
          meta: { bookId: book.id, highlightId: h.id }, mtime: book.addedAt })
      }
    }
    return syncShared(this, ctx, rows)
  }
}

export class FastCardAdapter implements IndexSourceAdapter {
  readonly sourceType = 'fastcard'
  readonly workspaceScope = 'shared'
  async reindex(ctx: AdapterContext) {
    return syncShared(this, ctx, new FastCardRepository(ctx.repository.getConnection()).list().map(card => ({
      path: toReadyUri({ kind: 'fastcard', id: card.id }), sourceId: card.id,
      name: card.title || card.text?.slice(0, 60) || card.caption || card.video?.title || '收集',
      body: [card.text, card.originalText, card.translatedText, card.description, card.caption, card.alt,
        card.transcription?.status === 'ready' ? card.transcription.text : '', card.source?.pageTitle, card.source?.pageUrl, ...(card.tags ?? [])].filter(Boolean).join('\n'),
      meta: { kind: card.kind }, mtime: card.createdAt,
    })))
  }
}
