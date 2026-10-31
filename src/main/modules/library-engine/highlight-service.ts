import { migrateHighlightCache } from './highlight-cache-migration'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { LibraryHighlight, LibraryHighlightState } from '../../../shared/library'
import { applyDocumentOperation, documentVersion } from '../document-engine/document-write-service'
import { publishFileAtomically } from '../document-engine/atomic-file-publish'
import type { LibraryEngine } from './library-engine'
import type { HighlightCodec } from './highlight-markdown'
import { exists, insideVault, isMissing } from './source-note'
import { anchorFileSchema, colorSchema, compact, offsetSchema, quoteAt, relocate, sliceText, type AnchorFile, type HighlightAnchor } from './highlight-anchors'
import { parseHighlights, rewriteHighlights } from './highlight-markdown'

const contextSchema = z.object({ bookId: z.string().regex(/^[\w-]+$/), chapters: z.array(z.object({ title: z.string(), text: z.string() }).strict()).min(1) })
const versionSchema = z.string().min(1)
const createSchema = contextSchema.extend({ expectedVersion: versionSchema, chapter: offsetSchema, from: offsetSchema, to: offsetSchema, color: colorSchema, note: z.string().optional() }).strict()
const removeSchema = contextSchema.extend({ expectedVersion: versionSchema, id: z.string().regex(/^hl-[\w-]+$/) }).strict()
const updateSchema = removeSchema.extend({ patch: z.object({ color: colorSchema.optional(), note: z.string().optional() }).strict().refine(p => Object.keys(p).length > 0) }).strict()
type Context = z.infer<typeof contextSchema>
const message = (e: unknown) => e instanceof Error ? e.message : String(e)

/** One queue per book. The md write receipt precedes sidecar publication, including every retry. */
export class LibraryHighlightService {
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(private readonly engine: Pick<LibraryEngine, 'vaultRoot'> & { findBook(id: string): Promise<{ id: string; notePath: string }> }, private readonly dependencies: {
    write?: typeof applyDocumentOperation
    publish?: typeof publishFileAtomically
    codec?: HighlightCodec
  } = {}) {}

  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(id) ?? Promise.resolve()).then(work)
    const settled = result.then(() => {}, () => {}) // operation caller owns errors; a failed edit does not poison the queue
    this.tails.set(id, settled)
    void settled.then(() => { if (this.tails.get(id) === settled) this.tails.delete(id) })
    return result
  }

  private async read(input: Context) {
    const root = this.engine.vaultRoot()
    if (!root) throw new Error('请先配置可用的资料库')
    const book = await this.engine.findBook(input.bookId)
    if (this.engine.vaultRoot() !== root) throw new Error('资料库已切换，请重新打开书籍')
    await insideVault(root, book.notePath)
    const md = await readFile(book.notePath, 'utf8')
    const path = join(root, '.ready', 'anchors', `${book.id}.highlights.json`)
    const previousPath = join(root, '.ready', 'anchors', `${book.id}.json`)
    // Do not follow a sidecar or its directory outside this vault, even on rebuild.
    for (const p of [join(root, '.ready'), join(root, '.ready', 'anchors'), path, previousPath]) if (await exists(p)) await insideVault(root, p)
    migrateHighlightCache(root, book.id)
    let cache: AnchorFile = { version: 1, highlights: {} }, cacheText: string | null = null
    try {
      cacheText = await readFile(path, 'utf8')
      const parsed = anchorFileSchema.safeParse(JSON.parse(cacheText))
      if (parsed.success) cache = parsed.data
      // Invalid cache is rebuildable; the md blocks below remain authoritative.
    } catch (error) { if (!isMissing(error) && !(error instanceof SyntaxError)) throw error }
    return { root, book, md, path, cache, cacheText }
  }

  private project(md: string, input: Context, cache: AnchorFile) {
    const anchors: AnchorFile = { version: 1, highlights: {} }
    const highlights = parseHighlights(md, input.bookId, this.dependencies.codec).map(({ highlight: h }) => {
      const old = cache.highlights[h.id]
      if (h.location.status === 'malformed') { if (old) anchors.highlights[h.id] = old; return h }
      const same = old && compact(old.quote.exact) === compact(h.text)
      const now = Date.now()
      const anchor: HighlightAnchor = {
        chapter: same ? old.chapter : h.chapter, from: same ? old.from : h.from, to: same ? old.to : h.to,
        quote: { exact: h.text, prefix: same ? old.quote.prefix : '', suffix: same ? old.quote.suffix : '' },
        color: h.color, createdAt: old?.createdAt ?? now, updatedAt: old?.updatedAt ?? now,
      }
      const location = relocate(anchor, input.chapters)
      if (location.status === 'located') {
        anchor.chapter = location.chapter; anchor.from = location.from; anchor.to = location.to
        anchor.quote = { ...quoteAt(input.chapters[location.chapter].text, location.from, location.to), exact: h.text }
      }
      if (old && (old.color !== anchor.color || old.chapter !== anchor.chapter || old.from !== anchor.from || old.to !== anchor.to || !same)) anchor.updatedAt = now
      anchors.highlights[h.id] = anchor
      return { ...h, chapterTitle: location.status === 'located' ? input.chapters[location.chapter].title : h.chapterTitle, location }
    })
    return { highlights, anchors }
  }

  private async snapshot(input: Context, current: Awaited<ReturnType<LibraryHighlightService['read']>>, md: string, persistence: LibraryHighlightState['persistence'] = 'saved'): Promise<LibraryHighlightState> {
    const { highlights, anchors } = this.project(md, input, current.cache)
    const state: LibraryHighlightState = { version: documentVersion(md), sourcePath: current.book.notePath, highlights, persistence, anchors: 'repair_needed' }
    if (persistence === 'pending_save') return { ...state, warning: '划线已合并到来源页的未保存内容，请保存来源页后刷新标注。' }
    try {
      if (this.engine.vaultRoot() !== current.root) throw new Error('资料库已切换')
      for (const directory of [join(current.root, '.ready'), join(current.root, '.ready', 'anchors')]) {
        if (!await exists(directory)) await mkdir(directory)
        await insideVault(current.root, directory)
      }
      if (await exists(current.path)) await insideVault(current.root, current.path)
      const text = JSON.stringify(anchors, null, 2) + '\n'
      // Listing an unchanged book must not rewrite the sidecar.
      if (text !== current.cacheText) await (this.dependencies.publish ?? publishFileAtomically)(current.path, text)
      state.anchors = 'synced'
    } catch (error) { state.warning = `划线保留在来源页，定位文件待重建：${message(error)}` }
    return state
  }

  list(raw: unknown): Promise<LibraryHighlightState> {
    const input = contextSchema.strict().parse(raw)
    return this.serial(input.bookId, async () => { const current = await this.read(input); return this.snapshot(input, current, current.md) })
  }

  private async change(input: Context & { expectedVersion: string }, edit: (list: LibraryHighlight[]) => { next: LibraryHighlight[]; removed: Set<string> }, importedAt?: Map<string, number>): Promise<LibraryHighlightState> {
    const current = await this.read(input)
    if (documentVersion(current.md) !== input.expectedVersion) throw new Error('Document version has changed，请刷新标注后重试')
    const { next, removed } = edit(this.project(current.md, input, current.cache).highlights)
    const normalized = next.map(h => h.location.status === 'located' ? { ...h, chapter: h.location.chapter, from: h.location.from, to: h.location.to, chapterTitle: input.chapters[h.location.chapter].title } : h)
    const before = parseHighlights(current.md, input.bookId, this.dependencies.codec)
    for (const h of normalized) {
      const old = before.find(b => b.highlight.id === h.id)?.highlight
      if ((h.location.status === 'located' && (!old || old.text !== h.text || old.color !== h.color || old.note !== h.note)) || importedAt?.has(h.id)) {
        const now = Date.now()
        current.cache.highlights[h.id] = { chapter: h.chapter, from: h.from, to: h.to,
          quote: h.location.status === 'located' ? { ...quoteAt(input.chapters[h.chapter].text, h.from, h.to), exact: h.text } : { exact: h.text, prefix: '', suffix: '' }, color: h.color,
          createdAt: current.cache.highlights[h.id]?.createdAt ?? importedAt?.get(h.id) ?? now, updatedAt: importedAt?.get(h.id) ?? now }
      }
    }
    const md = rewriteHighlights(current.md, input.bookId, normalized, removed, this.dependencies.codec)
    if (this.engine.vaultRoot() !== current.root) throw new Error('资料库已切换')
    // Bind the fixed offset to the whole preceding text: dirty edits before an
    // insertion must conflict, never shift the quote into unrelated content.
    let end = current.md.length, nextEnd = md.length
    while (end > 0 && nextEnd > 0 && current.md[end - 1] === md[nextEnd - 1]) { end--; nextEnd-- }
    const receipt = await (this.dependencies.write ?? applyDocumentOperation)({
      path: current.book.notePath, expectedVersion: input.expectedVersion, origin: 'library-highlights',
      operation: { type: 'replaceRange', start: 0, end, expectedText: current.md.slice(0, end), replacement: md.slice(0, nextEnd) },
    })
    if ('code' in receipt) throw Object.assign(new Error(receipt.message), { code: receipt.code })
    if (receipt.tab === 'merged_dirty') return { ...await this.snapshot(input, current, md, 'pending_save'), version: receipt.afterVersion }
    const saved = await readFile(current.book.notePath, 'utf8')
    if (documentVersion(saved) !== receipt.afterVersion) throw new Error('来源页在保存后又被修改，请刷新标注')
    return this.snapshot(input, current, saved)
  }

  /** Archive ids are deterministic; retry adds only blocks still absent from the source. */
  importMissing(input: Context & { expectedVersion: string }, imported: (LibraryHighlight & { createdAt: number })[]): Promise<LibraryHighlightState> {
    return this.serial(input.bookId, async () => {
      const current = await this.read(input)
      const ids = new Set(parseHighlights(current.md, input.bookId, this.dependencies.codec).map(b => b.highlight.id))
      const missing = imported.filter(h => !ids.has(h.id))
      if (!missing.length) return this.snapshot(input, current, current.md)
      return this.change(input, list => ({ next: [...list, ...missing], removed: new Set() }), new Map(missing.map(h => [h.id, h.createdAt])))
    })
  }

  create(raw: unknown): Promise<LibraryHighlightState> {
    const input = createSchema.parse(raw)
    return this.serial(input.bookId, () => this.change(input, list => {
      const chapter = input.chapters[input.chapter]
      if (!chapter || input.from >= input.to || input.to > compact(chapter.text).length) throw new Error('划线超出章节范围')
      let from = input.from, to = input.to
      const overlaps = new Set<LibraryHighlight>()
      // Transitive closure also handles source blocks manually edited into overlapping intervals.
      let changed = true
      while (changed) {
        changed = false
        for (const h of list) {
          const at = h.location
          if (!overlaps.has(h) && at.status === 'located' && at.chapter === input.chapter && at.from < to && at.to > from) {
            overlaps.add(h); from = Math.min(from, at.from); to = Math.max(to, at.to); changed = true
          }
        }
      }
      const notes = [...overlaps].sort((a, b) => a.from - b.from).map(h => h.note).concat(input.note ?? '').filter(Boolean)
      const h: LibraryHighlight = {
        id: [...overlaps][0]?.id ?? `hl-${randomUUID()}`, chapter: input.chapter, chapterTitle: chapter.title, from, to, text: sliceText(chapter.text, from, to).replace(/\s+/g, ' ').trim(),
        note: notes.join('\n\n'), color: input.color, sourceLine: 0, location: { status: 'located', chapter: input.chapter, from, to },
      }
      return { next: [...list.filter(old => !overlaps.has(old)), h], removed: new Set([...overlaps].map(old => old.id)) }
    }))
  }

  update(raw: unknown): Promise<LibraryHighlightState> {
    const input = updateSchema.parse(raw)
    return this.serial(input.bookId, () => this.change(input, list => {
      const targets = list.filter(h => h.id === input.id)
      if (targets.length !== 1 || targets[0].location.status === 'malformed') throw new Error('标注不存在或格式已修改，请在来源页检查')
      return { next: list.map(h => h.id === input.id ? { ...h, ...input.patch } : h), removed: new Set() }
    }))
  }

  remove(raw: unknown): Promise<LibraryHighlightState> {
    const input = removeSchema.parse(raw)
    return this.serial(input.bookId, () => this.change(input, list => {
      if (!list.some(h => h.id === input.id)) throw new Error('标注不存在，请刷新后重试')
      return { next: list.filter(h => h.id !== input.id), removed: new Set([input.id]) }
    }))
  }
}
