import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { stringify } from 'yaml'
import { z } from 'zod'
import { LIBRARY_DATABASE_PAGE, LIBRARY_FOLDER, LIBRARY_FIELDS as F, LIBRARY_KIND_BOOK, type LibraryBook, type LibraryState, type LibraryImportResult } from '../../../shared/library'
import type { VaultState } from '../../../shared/vault'
import { topicFor } from '../../../shared/library-topics'
import { applyDocumentOperation } from '../document-engine/document-write-service'
import { publishFileAtomically } from '../document-engine/atomic-file-publish'
import { decodeBookText, epubMetadata, nameMetadata, type BookMetadata } from './book-metadata'
import { exists, insideVault, isMissing, readBook } from './source-note'
import { bookIdSchema, formats, importSchema, updateSchema } from './validation'

const databasePage = `---\n${stringify({ ready_database: {
  source: LIBRARY_FOLDER,
  fields: {
    类型: { type: 'select', options: ['书'] }, 作者: { type: 'text' }, 分类: { type: 'select' },
    状态: { type: 'select', options: ['想读', '在读', '读完'] }, 读完: { type: 'date' },
    加入: { type: 'date' }, 字数: { type: 'number' }, 来源: { type: 'text' },
  },
  views: [{ name: '书架', type: 'bookshelf' }, { name: '表格', type: 'table' }, { name: '日历', type: 'calendar', dateField: '读完' }],
} })}---\n`
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

  private async scan(): Promise<LibraryState> {
    const root = this.vaultRoot()
    if (!root) return { status: 'no_vault' }
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
      if (existing) return existing
      const folder = join(root, LIBRARY_FOLDER)
      await mkdir(folder, { recursive: true })
      await insideVault(root, folder)
      if ((await lstat(folder)).isSymbolicLink()) throw new Error('阅读目录不能是符号链接')
      return this.importOne(root, folder, path, { id: bookIdSchema.parse(id), source })
    })
  }

  private async importOne(root: string, folder: string, path: string, download?: { id: string; source: LibraryBook['source'] }): Promise<LibraryBook> {
    if (!isAbsolute(path)) throw new Error('导入文件必须是绝对路径')
    const format = z.enum(formats).parse(extname(path).slice(1).toLowerCase())
    const bytes = await readFile(path)
    const named = nameMetadata(basename(path))
    const metadata: BookMetadata = format === 'epub' ? await epubMetadata(bytes) : { ...named, subjects: [] }
    const title = metadata.title || named.title || '未命名'
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
      }
      if (this.requireRoot() !== root) throw new Error('导入期间资料库已切换，请重新导入')
      if (!await exists(page)) { ownsDatabasePage = true; await publish(page, databasePage) }
      if (await exists(notePath)) throw new Error('来源页已被其他程序创建')
      ownsNote = true
      await publish(notePath, `---\n${stringify(fields)}---\n\n## 标注\n\n## 我的笔记\n`)
      const book = await readBook(root, notePath)
      if (!book) throw new Error('来源页写入后无法读取')
      return book
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
