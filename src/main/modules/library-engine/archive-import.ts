import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { LIBRARY_FIELDS as F, type LibraryArchiveProgress, type LibraryArchiveReport, type LibraryBookStatus, type LibraryHighlight } from '../../../shared/library'
import { archiveSchema, type ArchiveBook } from './archive-format'
import { archiveChapters } from './archive-chapters'
import { compact, quoteAt, relocate } from './highlight-anchors'
import { exists, insideVault } from './source-note'
import type { LibraryEngine } from './library-engine'
import type { LibraryHighlightService } from './highlight-service'
import type { LibraryReadingRepository } from './reading-repository'

const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
// BookRec status describes file availability, not reading completion. Favorite is
// independent: preserve 收藏; it never turns an unread book into a finished book.
const STATUS: Record<ArchiveBook['status'], LibraryBookStatus> = { ready: '想读', wish: '想读', error: '想读' }
export function archiveStatus(book: Pick<ArchiveBook, 'status' | 'finishedAt' | 'openedAt' | 'favorite'> & { progress?: { pct: number } }): LibraryBookStatus {
  if (book.finishedAt !== undefined || book.progress?.pct === 1) return '读完'
  if (book.openedAt !== undefined || (book.progress?.pct ?? 0) > 0) return '在读'
  return STATUS[book.status]
}

/** One invocation at a time; on-disk source identity/completion survives process restart. */
export class LibraryArchiveImporter {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly engine: LibraryEngine, private readonly reading: LibraryReadingRepository, private readonly highlights: LibraryHighlightService) {}

  run(directory: string, progress: (value: LibraryArchiveProgress) => void = () => {}): Promise<LibraryArchiveReport> {
    const root = this.engine.vaultRoot()
    const result = this.tail.then(() => this.import(directory, root, progress))
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private async import(directory: string, root: string | null, progress: (value: LibraryArchiveProgress) => void): Promise<LibraryArchiveReport> {
    if (!root || this.engine.vaultRoot() !== root) throw new Error('请先配置可用的资料库')
    if (!isAbsolute(directory)) throw new Error('请选择藏书阁数据目录')
    const source = await realpath(directory), destination = await realpath(root)
    const overlaps = (a: string, b: string) => {
      const rel = relative(a, b)
      return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    }
    if (overlaps(source, destination) || overlaps(destination, source)) throw new Error('资料库与藏书阁数据目录不能互相包含')
    const file = await insideVault(source, join(source, 'library.json'))
    let archive: ReturnType<typeof archiveSchema.parse>
    try { archive = archiveSchema.parse(JSON.parse(await readFile(file, 'utf8'))) }
    catch (error) { throw new Error(`library.json 结构不正确：${message(error)}`) }
    const report: LibraryArchiveReport = { success: [], skipped: [], failed: [], unlocated: 0 }
    progress({ completed: 0, total: archive.books.length, title: '' })
    for (const [index, old] of archive.books.entries()) {
      try {
        if (this.engine.vaultRoot() !== root) throw new Error('导入期间资料库已切换')
        if (!old.file) throw new Error('原记录没有书文件，无法上架；请先在藏书阁下载书籍')
        const path = join(source, 'files', `${old.id}.${old.file.ext}`)
        const canonicalPath = await insideVault(source, path)
        if (!(await stat(canonicalPath)).isFile()) throw new Error('书籍路径不是文件')
        let cover: { bytes: Uint8Array; extension: string } | undefined
        if (old.cover) {
          for (const extension of ['jpg', 'png', 'webp', 'gif']) {
            const candidate = join(source, 'covers', `${old.id}.${extension}`)
            if (!await exists(candidate)) continue
            cover = { bytes: await readFile(await insideVault(source, candidate)), extension }; break
          }
          if (!cover) throw new Error('记录声明的封面文件缺失')
        }
        const bytes = await readFile(canonicalPath)
        const fields = Object.fromEntries(Object.entries({
          title: old.title, [F.author]: old.author, [F.year]: old.year, [F.publisher]: old.publisher,
          [F.language]: old.language, [F.topic]: old.topic ?? 'unsorted', [F.tags]: old.tags, [F.status]: archiveStatus(old),
          [F.addedAt]: new Date(old.addedAt).toISOString(), [F.finishedAt]: old.finishedAt === undefined ? undefined : new Date(old.finishedAt).toISOString(),
          [F.words]: old.words, '收藏': old.favorite, '简介': old.description,
          '藏书阁原来源': { kind: old.source, ref: old.sourceRef, url: old.sourceUrl }, '藏书阁原状态': old.status,
        }).filter(([, value]) => value !== undefined))
        const imported = await this.engine.importArchive({ path, title: old.title, ref: `藏书阁:${old.id}`, bytes, root, fields, cover })
        if (imported.skipped) {
          report.skipped.push({ id: old.id, title: old.title, reason: '原 id 或书文件已导入' })
        } else {
          const { book } = imported
          const chapters = await archiveChapters(await readFile(book.filePath), book.format, book.title)
          const context = { bookId: book.id, chapters }
          const current = await this.highlights.list(context)
          const additions: (LibraryHighlight & { createdAt: number })[] = (old.highlights ?? []).map(h => {
            const original = chapters[h.chapter]?.text
            const quote = original !== undefined && compact(original).slice(h.from, h.to) === compact(h.text)
              ? quoteAt(original, h.from, h.to) : { exact: h.text, prefix: '', suffix: '' }
            const location = relocate({ chapter: h.chapter, from: h.from, to: h.to, quote, color: h.color, createdAt: h.at, updatedAt: h.at }, chapters)
            const at = location.status === 'located' ? location : h
            return { id: `hl-${hash(`${old.id}:${h.id}`)}`, chapter: at.chapter, from: at.from, to: at.to,
              createdAt: h.at, text: h.text, note: h.note ?? '', color: h.color, location, sourceLine: 0,
              chapterTitle: location.status === 'located' ? chapters[location.chapter].title : '未定位' }
          })
          const saved = await this.highlights.importMissing({ ...context, expectedVersion: current.version }, additions)
          if (saved.persistence !== 'saved' || saved.anchors !== 'synced') throw new Error(saved.warning ?? '标注尚未保存')
          if (this.engine.vaultRoot() !== root) throw new Error('导入期间资料库已切换')
          this.reading.importMissing(book.id, old.progress ? { bookId: book.id, chapter: old.progress.chapter, offset: old.progress.offset, pct: old.progress.pct, updatedAt: old.progress.at } : undefined,
            (old.bookmarks ?? []).map(b => ({ id: `archive-${hash(JSON.stringify([old.id, b]))}`, chapter: b.chapter, offset: b.offset, label: b.label, createdAt: b.at })))
          await this.engine.completeArchive(book.id, root)
          report.unlocated += saved.highlights.filter(h => h.location.status !== 'located').length
          report.success.push({ id: old.id, title: old.title, bookId: book.id })
        }
      } catch (error) { report.failed.push({ id: old.id, title: old.title, reason: message(error) }) }
      progress({ completed: index + 1, total: archive.books.length, title: old.title })
    }
    return report
  }
}
