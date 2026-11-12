import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { toReadyUri } from '../../../shared/ready-ref'
import { z } from 'zod'
import { LIBRARY_DATABASE_PAGE, LIBRARY_FOLDER, LIBRARY_FIELDS as F, LIBRARY_KIND_BOOK, type LibraryBook, type LibraryState, type LibraryImportResult } from '../../../shared/library'
import type { VaultState } from '../../../shared/vault'
import { topicFor } from '../../../shared/library-topics'
import { readDocumentSource } from '../../../shared/document-operations'
import { applyDocumentOperation, documentVersion } from '../document-engine/document-write-service'
import { publishFileAtomically } from '../document-engine/atomic-file-publish'
import { decodeBookText, epubMetadata, nameMetadata, type BookMetadata } from './book-metadata'
import { exists, insideVault, isMissing, readBook, sourceNoteContent } from './source-note'
import { bookIdSchema, formats, importSchema, updateSchema } from './validation'
import type { ObjectRegistry } from '../object-service/registry'

import { readingDatabasePage as databasePage, readingSourceText, upgradeReadingDatabase } from './database-upgrade'

const reason = (error: unknown) => error instanceof Error ? error.message : String(error)

// Frontmatter dates stay human-readable: local wall-clock time with its UTC offset.
function localDateTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export class LibraryEngine {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly dependencies: {
    vault(): VaultState
    write?: typeof applyDocumentOperation
    publish?: typeof publishFileAtomically
    registry?: ObjectRegistry
  }) {}

  /** One owner serializes scans/imports/updates so readers never see an incomplete import. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  vaultRoot(): string | null {
    const vault = this.dependencies.vault()
    return vault.status === 'ready' ? vault.root : null
  }

  private requireRoot(): string {
    const root = this.vaultRoot()
    if (!root) throw Object.assign(new Error('请先配置可用的资料库'), { code: 'no_vault' })
    return root
  }

  get(): Promise<LibraryState> { return this.serial(() => this.scan()) }

  readOnly(): Promise<LibraryState> { return this.serial(() => this.scan(false)) }

  private async scan(upgrade = true): Promise<LibraryState> {
    const root = this.vaultRoot()
    if (!root) return { status: 'no_vault' }
    if (upgrade) await upgradeReadingDatabase(root, { write: this.dependencies.write })
    const state: Extract<LibraryState, { status: 'ready' }> = { status: 'ready', vaultRoot: root, books: [], issues: [] }
    const scanDirectory = async (path: string): Promise<void> => {
      try {
        await insideVault(root, path)
        if ((await lstat(path)).isSymbolicLink()) throw new Error('阅读目录不能是符号链接')
        const entries = await readdir(path, { withFileTypes: true })
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith('.') || entry.name.endsWith('.assets')) continue
          const child = join(path, entry.name)
          if (entry.isDirectory()) { await scanDirectory(child); continue }
          if (!entry.name.toLowerCase().endsWith('.md')) continue
          try {
            const book = await readBook(root, child)
            if (book) state.books.push(book)
          } catch (error) { state.issues.push({ notePath: child, reason: reason(error) }) }
        }
      } catch (error) {
        if (path === join(root, LIBRARY_FOLDER) && isMissing(error)) return
        state.issues.push({ notePath: path, reason: reason(error) })
      }
    }
    await scanDirectory(join(root, LIBRARY_FOLDER))
    const counts = new Map<string, number>()
    for (const book of state.books) counts.set(book.id, (counts.get(book.id) ?? 0) + 1)
    state.books = state.books.filter(book => {
      if (counts.get(book.id) === 1) return true
      state.issues.push({ notePath: book.notePath, reason: `重复的 ready_id：${book.id}` })
      return false
    })
    return state
  }

  private async locate(id: unknown): Promise<LibraryBook> {
    const validId = bookIdSchema.parse(id)
    const state = await this.scan()
    if (state.status === 'no_vault') throw Object.assign(new Error('请先配置可用的资料库'), { code: 'no_vault' })
    const book = state.books.find(item => item.id === validId)
    if (!book) throw new Error('当前资料库中找不到这本书，或来源页有问题')
    return book
  }

  findBook(id: string): Promise<LibraryBook> { return this.serial(() => this.locate(id)) }

  private confirmBook(book: LibraryBook): LibraryBook {
    const object = this.dependencies.registry?.register(book.notePath)
    if (object && (object.id !== book.id || object.identity_state === 'conflict')) throw new Error('书籍对象身份冲突')
    return book
  }

  importFiles(input: unknown): Promise<LibraryImportResult> {
    return this.serial(async () => {
      const paths = importSchema.parse(input)
      const root = this.requireRoot()
      const folder = join(root, LIBRARY_FOLDER)
      if (!await exists(folder)) await mkdir(folder)
      await insideVault(root, folder)
      if ((await lstat(folder)).isSymbolicLink()) throw new Error('阅读目录不能是符号链接')
      const result: LibraryImportResult = { imported: [], failed: [] }
      for (const path of paths) {
        try { result.imported.push(await this.importOne(root, folder, path)) }
        catch (error) { result.failed.push({ path, reason: reason(error) }) }
      }
      return result
    })
  }

  importDownload(path: string, id: string, source: LibraryBook['source'], expectedRoot: string): Promise<LibraryBook> {
    return this.serial(async () => {
      const root = this.requireRoot()
      if (root !== expectedRoot) throw new Error('下载期间资料库已切换')
      const state = await this.scan()
      const existing = state.status === 'ready' ? state.books.find(book => book.id === id) : undefined
      if (existing) return this.confirmBook(existing)
      const folder = join(root, LIBRARY_FOLDER)
      await mkdir(folder, { recursive: true })
      await insideVault(root, folder)
      if ((await lstat(folder)).isSymbolicLink()) throw new Error('阅读目录不能是符号链接')
      return this.importOne(root, folder, path, { id: bookIdSchema.parse(id), source })
    })
  }

  /** L5 runs under the existing import queue, including hash-based duplicate detection. */
  importArchive(input: { path: string; title: string; ref: string; bytes: Uint8Array; root: string; fields: Record<string, unknown>; cover?: BookMetadata['cover'] }): Promise<{ book: LibraryBook; skipped: boolean }> {
    return this.serial(async () => {
      if (this.requireRoot() !== input.root) throw new Error('导入期间资料库已切换')
      const fileHash = createHash('sha256').update(input.bytes).digest('hex')
      const state = await this.scan()
      if (state.status !== 'ready') throw new Error('资料库不可用')
      let book = state.books.find(b => b.source.kind === 'import' && b.source.ref === input.ref)
      if (book) {
        const { frontmatter } = readDocumentSource(await readFile(book.notePath, 'utf8'))
        if (frontmatter['藏书阁导入完成'] === true) return { book: this.confirmBook(book), skipped: true }
        if (createHash('sha256').update(await readFile(book.filePath)).digest('hex') !== fileHash) throw new Error('未完成导入的原书内容已改变，请先核对文件')
      } else {
        for (const existing of state.books) {
          const hash = createHash('sha256').update(await readFile(existing.filePath)).digest('hex')
          if (hash === fileHash) return { book: this.confirmBook(existing), skipped: true }
        }
        const folder = join(input.root, LIBRARY_FOLDER)
        await mkdir(folder, { recursive: true }); await insideVault(input.root, folder)
        if ((await lstat(folder)).isSymbolicLink()) throw new Error('阅读目录不能是符号链接')
        book = await this.importOne(input.root, folder, input.path, {
          id: `archive-${createHash('sha256').update(input.ref).digest('hex')}`,
          source: { kind: 'import', ref: input.ref }, title: input.title, cover: input.cover, bytes: input.bytes,
        })
      }
      await this.writeArchiveFields(book, input.root, { ...input.fields, '藏书阁文件哈希': fileHash, '藏书阁导入完成': false })
      return { book: this.confirmBook(await this.locate(book.id)), skipped: false }
    })
  }

  completeArchive(id: string, root: string): Promise<void> {
    return this.serial(async () => this.writeArchiveFields(await this.locate(id), root, { '藏书阁导入完成': true }))
  }

  private async writeArchiveFields(book: LibraryBook, root: string, set: Record<string, unknown>): Promise<void> {
    if (this.requireRoot() !== root) throw new Error('导入期间资料库已切换')
    const content = await readFile(book.notePath, 'utf8')
    if (this.requireRoot() !== root) throw new Error('导入期间资料库已切换')
    const receipt = await (this.dependencies.write ?? applyDocumentOperation)({ path: book.notePath,
      expectedVersion: documentVersion(content), operation: { type: 'setFrontmatterFields', set }, origin: 'library-archive' })
    if ('code' in receipt) throw Object.assign(new Error(receipt.message), { code: receipt.code })
    if (receipt.tab === 'merged_dirty') throw new Error('来源页有未保存修改，请保存后重新导入')
    if (documentVersion(await readFile(book.notePath, 'utf8')) !== receipt.afterVersion) throw new Error('来源页在写入后发生变化，请重新导入')
  }

  private async importOne(root: string, folder: string, path: string, download?: { id: string; source: LibraryBook['source']; title?: string; cover?: BookMetadata['cover']; bytes?: Uint8Array }): Promise<LibraryBook> {
    if (!isAbsolute(path)) throw new Error('导入文件必须是绝对路径')
    const format = z.enum(formats).parse(extname(path).slice(1).toLowerCase())
    const bytes = download?.bytes ?? await readFile(path)
    const named = nameMetadata(basename(path))
    const metadata: BookMetadata = format === 'epub' ? await epubMetadata(bytes) : { ...named, subjects: [] }
    if (download?.cover) metadata.cover = download.cover
    const title = download?.title || metadata.title || named.title || '未命名'
    const stem = title.replace(/[<>:"/\\|?*]|\p{Cc}/gu, '_').replace(/[. ]+$/g, '').slice(0, 80) || '未命名'
    let name = stem
    for (let n = 2; await exists(join(folder, `${name}.md`)) || await exists(join(folder, `${name}.assets`)); n++) name = `${stem} (${n})`
    const notePath = join(folder, `${name}.md`)
    const assetsName = `${name}.assets`
    const assetsPath = join(folder, assetsName)
    const publish = this.dependencies.publish ?? publishFileAtomically
    // Exclusive mkdir reserves this name; only files owned by this attempt are rolled back.
    await mkdir(assetsPath)
    let ownsNote = false
    let ownsDatabasePage = false
    const page = join(root, LIBRARY_DATABASE_PAGE)
    try {
      await publish(join(assetsPath, basename(path)), bytes)
      const coverName = metadata.cover ? `cover.${metadata.cover.extension}` : undefined
      if (metadata.cover && coverName) await publish(join(assetsPath, coverName), metadata.cover.bytes)
      const words = format === 'txt' || format === 'md' ? [...decodeBookText(bytes).replace(/\s/g, '')].length : undefined
      const fields = {
        [F.id]: download?.id ?? randomUUID(), [F.kind]: LIBRARY_KIND_BOOK,
        ...(name !== title ? { title } : {}),
        [F.author]: metadata.author || named.author, [F.year]: metadata.year, [F.publisher]: metadata.publisher,
        [F.language]: metadata.language, [F.topic]: topicFor({ cats: metadata.subjects, title }), [F.tags]: metadata.subjects,
        [F.status]: '想读', [F.file]: `${assetsName}/${basename(path)}`, [F.cover]: coverName ? `${assetsName}/${coverName}` : undefined,
        [F.words]: words, [F.addedAt]: localDateTime(Date.now()), [F.source]: download?.source ?? { kind: 'local' },
        来源说明: readingSourceText(download?.source ?? { kind: 'local' }),
      }
      if (this.requireRoot() !== root) throw new Error('导入期间资料库已切换，请重新导入')
      if (!await exists(page)) { ownsDatabasePage = true; await publish(page, databasePage) }
      else await upgradeReadingDatabase(root, { write: this.dependencies.write })
      if (await exists(notePath)) throw new Error('来源页已被其他程序创建')
      ownsNote = true
      await publish(notePath, sourceNoteContent({ ...fields, 来源引用: toReadyUri({ kind: 'book-location', book: fields[F.id], loc: 'c0:0+1' }), 链接: fields[F.source].url ?? '' }))
      const book = await readBook(root, notePath)
      if (!book) throw new Error('来源页写入后无法读取')
      return this.confirmBook(book)
    } catch (error) {
      if (ownsNote) await rm(notePath, { force: true })
      if (ownsDatabasePage) await rm(page, { force: true })
      await rm(assetsPath, { recursive: true, force: true })
      throw error
    }
  }

  updateBook(input: unknown): Promise<LibraryBook> {
    return this.serial(async () => {
      const { id, patch } = updateSchema.parse(input)
      if (patch.title !== undefined) throw new Error('暂不支持改书名：需要同时重命名来源页和附件文件夹')
      const book = await this.locate(id)
      const set: Record<string, unknown> = {}
      if (patch.author !== undefined) set[F.author] = patch.author
      if (patch.topic !== undefined) set[F.topic] = patch.topic
      if (patch.tags !== undefined) set[F.tags] = patch.tags
      if (patch.status !== undefined) set[F.status] = patch.status
      if (patch.status === '读完' && book.status !== '读完') set[F.finishedAt] = localDateTime(Date.now())
      const receipt = await (this.dependencies.write ?? applyDocumentOperation)({ path: book.notePath, operation: { type: 'setFrontmatterFields', set }, origin: 'library' })
      if ('code' in receipt) throw Object.assign(new Error(receipt.message), { code: receipt.code })
      if (receipt.tab === 'merged_dirty') throw Object.assign(new Error('修改已合并到未保存的文档，请保存来源页后刷新书房'), { code: 'unsaved_document' })
      return this.locate(id)
    })
  }
}
