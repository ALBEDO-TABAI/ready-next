import { sourceDocumentId } from '../library-engine/source-documents'
import { parseBookLocation } from '../../../shared/book-location'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { ReadyRefSchema, toReadyUri } from '../../../shared/ready-ref'
import { readDocumentSource } from '../../../shared/document-operations'
import { readCanvas } from '../../../shared/ready-canvas'
import type { StoredObjectPreview, BookPreview } from '../../../shared/object-preview'
import { insideVault, readBook } from '../library-engine/source-note'
import { parseHighlights } from '../library-engine/highlight-markdown'
import { compact, relocate, sliceText } from '../library-engine/highlight-anchors'
import { sourceHighlightCodec } from '../library-engine/source-adapters'
import type { ObjectRegistry } from './registry'

/** Local reads only. No scan, cache repair, source upgrade or network fetch on hover. */
export async function readStoredObjectPreview(registry: ObjectRegistry, input: unknown): Promise<StoredObjectPreview | null> {
  const ref = ReadyRefSchema.parse(input)
  const read = async (id: string) => {
    const object = registry.get(id)
    if (!object?.current_path || object.status !== 'present' || object.identity_state === 'conflict') return null
    const workspace = registry.db.prepare('SELECT root FROM workspaces WHERE id=?').get<{ root: string }>(object.workspace_id)
    if (!workspace) return null
    const path = await insideVault(workspace.root, object.current_path)
    return { root: workspace.root, path, content: await readFile(path, 'utf8') }
  }
  if (ref.kind === 'web') {
    const url = ref.url.split(':~:text=')[0].replace(/#$/, '')
    const uri = toReadyUri({ kind: 'web', url })
    const source = await read(sourceDocumentId(uri))
    const fallback = { kind: 'web' as const, title: new URL(url).hostname, url, excerpts: [] }
    if (!source) {
      const bookmark = registry.db.prepare('SELECT title FROM browser_bookmarks WHERE url=?').get<{ title: string }>(url)
      return { ...fallback, title: bookmark?.title || fallback.title }
    }
    const { frontmatter } = readDocumentSource(source.content)
    if (frontmatter.来源引用 !== uri) throw new Error('网页来源身份不一致')
    const excerpts = parseHighlights(source.content, '', sourceHighlightCodec({
      source: { kind: 'web', ref: { kind: 'web', url }, title: fallback.title, author: '', url, snapshot: '' },
      text: '', from: 0, to: 0, reference: () => { throw new Error('Preview is read-only') },
    })).filter(block => block.highlight.location.status !== 'malformed')
      .map(({ highlight }) => ({ id: highlight.id, text: highlight.text, note: highlight.note }))
    return { ...fallback, title: typeof frontmatter.title === 'string' ? frontmatter.title : fallback.title, excerpts }
  }
  if (ref.kind !== 'book-location' && ref.kind !== 'canvas' && ref.kind !== 'page') throw new Error('此类型不使用本地对象速览')
  const source = await read(ref.kind === 'book-location' ? ref.book : ref.id)
  if (!source) return null
  if (ref.kind === 'canvas') {
    const result = readCanvas(JSON.parse(source.content))
    if (result.mode !== 'editable') throw new Error('此画板版本暂不支持速览')
    if (result.canvas.ready.id !== ref.id) throw new Error('画板身份已变化')
    return { kind: 'canvas', title: result.canvas.ready.title || basename(source.path, extname(source.path)),
      nodes: result.canvas.nodes.filter(node => !node.ready.trash).map(node => ({
        id: node.id, x: node.x, y: node.y, width: node.width, height: node.height,
        title: node.ready.preview?.title || (node.type === 'text' ? node.text.split('\n')[0] : node.type === 'group' ? node.label || '' : node.type === 'link' ? node.url : basename(node.file)),
      })) }
  }
  const book = await readBook(source.root, source.path)
  if (!book) return null
  if (book.id !== (ref.kind === 'book-location' ? ref.book : ref.id)) throw new Error('书籍身份已变化')
  const preview: BookPreview = { kind: 'book', book: { id: book.id, title: book.title, author: book.author, coverPath: book.coverPath, format: book.format }, passage: null }
  const highlight = ref.kind === 'page' && ref.anchor?.startsWith('^hl-')
    ? parseHighlights(source.content, book.id).find(block => `^${block.highlight.id}` === ref.anchor)?.highlight : undefined
  if (ref.kind === 'page' && !highlight) return null
  if (!['epub', 'txt', 'md'].includes(book.format)) return preview
  const { archiveChapters } = await import('../library-engine/archive-chapters')
  const chapters = await archiveChapters(await readFile(book.filePath), book.format, book.title)
  let chapter = 0, from = 0, to = 1
  if (highlight) {
    const location = relocate({ chapter: highlight.chapter, from: highlight.from, to: highlight.to,
      quote: { exact: highlight.text, prefix: '', suffix: '' }, color: highlight.color, createdAt: 0, updatedAt: 0 }, chapters)
    if (location.status !== 'located') return { ...preview, passage: { text: highlight.text, prefix: '', suffix: '', chapterTitle: highlight.chapterTitle, note: highlight.note, located: false } }
    ;({ chapter, from, to } = location)
  } else if (ref.kind === 'book-location') {
    ;({ chapter, from, to } = parseBookLocation(ref.loc))
  }
  const text = chapters[chapter]?.text
  if (!text || to > compact(text).length) throw new Error('书内位置已失效')
  return { ...preview, passage: { text: highlight?.text ?? sliceText(text, from, to), prefix: sliceText(text, Math.max(0, from - 100), from),
    suffix: sliceText(text, to, to + 100), chapterTitle: chapters[chapter].title, note: highlight?.note, located: true } }
}
