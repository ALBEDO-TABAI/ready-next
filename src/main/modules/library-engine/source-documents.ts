import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toReadyUri } from '../../../shared/ready-ref'
import { readDocumentSource } from '../../../shared/document-operations'
import { applyDocumentOperation, saveUserDocument, type DocumentWriteDependencies } from '../document-engine/document-write-service'
import { filename } from '../document-drafts/files'
import { ObjectRegistry, isInside } from '../object-service/registry'
import { LibraryHighlightService } from './highlight-service'
import type { LibraryEngine } from './library-engine'
import { exists, insideVault, sourceNoteContent } from './source-note'
import { sourceHighlightCodec, type SourceDocument, type SourceSelection } from './source-adapters'

export class SourceDocumentService {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(readonly root: string, private readonly registry: ObjectRegistry, private readonly writer: DocumentWriteDependencies) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
  ensure(source: SourceDocument): Promise<{ id: string; notePath: string }> { return this.serial(() => this.ensureSource(source)) }
  private async ensureSource(source: SourceDocument) {
    const uri = toReadyUri(source.ref)
    if (source.kind === 'book') {
      if (source.ref.kind !== 'book-location') throw new Error('书籍来源身份无效')
      this.registry.scan(this.root)
      const book = this.registry.get(source.ref.book)
      if (!book?.current_path || book.status !== 'present' || book.identity_state === 'conflict') throw new Error('书籍来源页不存在或身份冲突')
      await insideVault(this.root, book.current_path)
      await this.writer.index(book.current_path, await readFile(book.current_path, 'utf8'))
      return { id: book.id, notePath: book.current_path }
    }
    const id = 'source-' + createHash('sha256').update(uri).digest('hex').slice(0, 32)
    let row = this.registry.get(id)
    if (!row) { this.registry.scan(this.root); row = this.registry.get(id) }
    if (row) {
      if (row.status !== 'present' || row.identity_state === 'conflict' || !row.current_path || !isInside(this.root, row.current_path)) throw new Error('来源页已回收、失联或身份冲突，请先恢复来源页')
      await insideVault(this.root, row.current_path)
      const content = await readFile(row.current_path, 'utf8')
      if (readDocumentSource(content).frontmatter.来源引用 !== uri) throw new Error('来源页身份与原文不一致')
      await this.writer.index(row.current_path, content)
      return { id, notePath: row.current_path }
    }
    const folder = join(this.root, source.kind === 'web' ? '网页' : '文章')
    if (!await exists(folder)) await mkdir(folder)
    await insideVault(this.root, folder)
    const name = filename(source.title.replace(/[\\/]/g, '_').replace(/\.\./g, '_').slice(0, 50))
    const notePath = join(folder, `${name}-${id.slice(-8)}.md`)
    const content = sourceNoteContent({ ready_id: id, 类型: { book: '书', rss: '文章', pdf: 'PDF', web: '网页' }[source.kind],
      title: source.title, 作者: source.author, 链接: source.url, 加入: new Date().toISOString(), 来源引用: uri, 来源版本: source.snapshot })
      + '\n已保存的摘录可脱机阅读。原文不可用或位置已变化时，无法回跳，请以这里的摘录为准。\n'
    // Exclusive creation never overwrites a user page. Reconciliation recovers a published file after interruption.
    await saveUserDocument({ path: notePath, content, expectedVersion: 'missing' }, this.writer)
    this.registry.register(notePath)
    return { id, notePath }
  }
  annotate(selection: SourceSelection) {
    return this.serial(async () => {
      const page = await this.ensureSource(selection.source)
      const highlights = new LibraryHighlightService({ vaultRoot: () => this.root, findBook: async () => page }, {
        write: input => applyDocumentOperation(input, this.writer), codec: sourceHighlightCodec(selection),
      })
      const context = { bookId: page.id, chapters: [{ title: selection.source.title, text: selection.text }] }
      const before = await highlights.list(context)
      return highlights.create({ ...context, expectedVersion: before.version, chapter: 0, from: selection.from, to: selection.to, color: 'yellow' })
    })
  }
  /** Book adapter retains the original book identity, files and annotation behavior. */
  static books(engine: LibraryEngine, dependencies: ConstructorParameters<typeof LibraryHighlightService>[1] = {}) {
    return new LibraryHighlightService(engine, dependencies)
  }
}
