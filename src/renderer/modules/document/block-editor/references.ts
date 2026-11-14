import { parseDocumentBlocks, parseInlineBlock, type InlineReference } from '../../../../shared/document-blocks'
import { parseReadyUri, ReadyRefSchema, type ReadyRef } from '../../../../shared/ready-ref'
import { useWorkspace } from '../../../stores/useWorkspace'
import { useDocTabs } from '../../../stores/useDocTabs'
import { plainText } from './dom-inline'

/** Host-owned paths; a file parent is expanded to its same-name folder by the page service. */
export interface EditorLinkBase { filePath: string | null; parentPath: string | null }

export interface ReferenceChoice { id: string; label: string; detail: string; text: string; reference: InlineReference }
export function workspaceRoots(): string[] {
  const { workspaceRoot, pinnedFolders } = useWorkspace.getState()
  return [...new Set([workspaceRoot, ...pinnedFolders].filter((root): root is string => Boolean(root)))]
}
/** Relative path between two canonical files, as the object link repair writes it (Node's relative(dirname(from), to)). */
export function linkPath(fromFile: string, toFile: string): string {
  const from = fromFile.replace(/\\/g, '/').split('/').slice(0, -1), to = toFile.replace(/\\/g, '/').split('/')
  if (from[0] !== to[0]) return to.join('/')
  let common = 0
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/')
}
/**
 * Wiki targets use the canonical form the link repair keeps: relative to the page's folder, computed from registry
 * paths. Inserting any other form would make Main rewrite the link after saving, adding a step to the undo history.
 */
export async function wikiTarget(filePath: string | null | undefined, file: string): Promise<string> {
  if (!filePath) return file.replace(/\.md$/i, '')
  const [from, to] = await Promise.all([window.electronAPI.objects.resolvePath(filePath), window.electronAPI.objects.resolvePath(file)])
  return linkPath(from.path, to.path).replace(/\.md$/i, '')
}
export async function findReferences(query: string, wiki: boolean, filePath?: string | null): Promise<ReferenceChoice[]> {
  const choices: ReferenceChoice[] = []
  const addReady = (label: string, detail: string, ref: ReadyRef) => choices.push({ id: JSON.stringify(ref), label, detail, text: label, reference: { kind: 'ready', ref } })
  if (!wiki) {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const date = ReadyRefSchema.safeParse({ kind: 'day', date: /^\d/.test(query) ? query : today })
    if (date.success && (!query || /^(今天|today)$/i.test(query) || /^\d/.test(query))) addReady(date.data.kind === 'day' ? date.data.date : today, '日期', date.data)
  }
  const roots = workspaceRoots(), [pageQuery, anchorQuery] = query.split('#', 2)
  if (!pageQuery.trim() || !roots.length) return choices
  const result = await window.electronAPI.document.searchIndex({ query: pageQuery, workspaceRoots: roots, limit: 12, ...(wiki ? { sources: ['document'] } : {}) })
  if (!result.success || !result.data) throw new Error(result.error ?? '搜索失败')
  // A result's detail is its place in the library, not the absolute path on this machine.
  const place = (path: string) => {
    const normalized = path.replace(/\\/g, '/')
    const base = roots.map(root => root.replace(/\\/g, '/').replace(/\/+$/, '')).find(root => normalized.startsWith(`${root}/`))
    return base ? normalized.slice(base.length + 1) : path
  }
  for (const item of result.data.items) {
    const ready = parseReadyUri(item.path)
    if (ready.ok) { if (!wiki) addReady(item.name, item.sourceType, ready.ref); continue }
    if (item.sourceType !== 'document' || /[[\]|\r\n]/.test(item.path)) continue
    if (!/\.md$/i.test(item.path)) {
      // Any other file in the library (a PDF, an image, a board) links by its object identity; one outside it has none.
      try {
        const location = await window.electronAPI.objects.resolvePath(item.path)
        addReady(item.name, place(item.path), { kind: /\.canvas$/i.test(item.path) ? 'canvas' : 'file', id: location.objectId })
      } catch (error) { console.warn('[references] skip a file without an object identity:', error instanceof Error ? error.message : String(error)) }
      continue
    }
    if (!wiki) {
      const location = await window.electronAPI.objects.resolvePath(item.path)
      addReady(item.name.replace(/\.md$/i, ''), place(item.path), { kind: 'page', id: location.objectId })
      continue
    }
    const path = await wikiTarget(filePath, item.path)
    if (/[[\]|\r\n]/.test(path)) continue
    const name = item.name.replace(/\.md$/i, '')
    const addWiki = (target: string, label: string) => choices.push({ id: target, label, detail: place(item.path), text: target, reference: { kind: 'wiki', target } })
    if (anchorQuery === undefined) addWiki(path, name)
    const open = useDocTabs.getState().tabs.find(tab => tab.path === item.path)
    let content = open?.content
    if (content === undefined) {
      const read = await window.electronAPI.document.readFile(item.path)
      if (!read.success || !read.data || !('content' in read.data)) throw new Error(read.error ?? '无法读取页面标题')
      content = read.data.content
    }
    for (const block of parseDocumentBlocks(content).blocks.filter(block => block.type === 'heading')) {
      const model = parseInlineBlock(block.raw)
      if (model.capability !== 'rich') continue
      const heading = plainText(model.spans)
      if (/[[\]|\r\n]/.test(heading) || (anchorQuery !== undefined && !heading.toLowerCase().includes(anchorQuery.toLowerCase()))) continue
      addWiki(`${path}#${heading}`, `${name} › ${heading}`)
    }
  }
  return choices.filter((choice, index) => choices.findIndex(other => other.id === choice.id) === index)
}

/** Where a link in the text points: a [[wiki]] target resolves against the page's folder first, then the vault. */
export async function resolveInlineReference(reference: InlineReference, filePath?: string | null): Promise<ReadyRef> {
  if (reference.kind === 'ready') return reference.ref
  if (reference.kind === 'wiki') {
    if (filePath === undefined) throw new Error('尚未提供画板文件路径，无法打开相对页面链接')
    const [path, anchor] = reference.target.split('#', 2)
    // [[x]] names a page; a board's target keeps its .canvas extension.
    const board = /\.canvas$/i.test(path)
    const file = board || /\.md$/i.test(path) ? path : `${path}.md`
    // Canonical targets are relative to this page's folder; a hand-written vault-relative link is the fallback.
    const roots = workspaceRoots()
    const vault = roots.find(root => filePath?.startsWith(`${root.replace(/[/\\]+$/, '')}/`)) ?? roots[0]
    const folder = filePath?.replace(/[/\\][^/\\]+$/, '')
    const candidates = file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) ? [file]
      : [...new Set([folder, vault].filter((base): base is string => Boolean(base)).map(base => `${base}/${file}`))]
    let target: string | undefined
    for (const candidate of candidates) if ((await window.electronAPI.document.stat(candidate)).success) { target = candidate; break }
    if (!target) throw new Error(`找不到${board ? '画板' : '页面'}：${path}`)
    const location = await window.electronAPI.objects.resolvePath(target)
    return board ? { kind: 'canvas', id: location.objectId } : { kind: 'page', id: location.objectId, ...(anchor ? { anchor } : {}) }
  }
  if (reference.href.startsWith('ready://')) {
    const parsed = parseReadyUri(reference.href)
    if (!parsed.ok) throw new Error('引用地址无效')
    return parsed.ref
  }
  if (!/^https?:\/\//i.test(reference.href)) throw new Error('只支持网页或 Ready 内部链接')
  return { kind: 'web', url: reference.href }
}

export async function openInlineReference(reference: InlineReference, filePath?: string | null, options?: { newTab?: boolean }) {
  const { openReadyRef } = await import('../../workbench/open-ready-ref')
  return openReadyRef(await resolveInlineReference(reference, filePath), 'document', options)
}

// A capsule in the text (W6 §2.1) is the drawn link itself. Its reference comes from the link: a Ready address is
// read directly, a [[wiki]] target is resolved once per drawn link (a drag needs it at once, so hovering resolves it).
const resolving = new WeakMap<Element, Promise<ReadyRef>>()
const settled = new WeakMap<Element, ReadyRef>()
export function capsuleSource(anchor: HTMLAnchorElement, filePath?: string | null): ReadyRef | (() => Promise<ReadyRef>) {
  const wiki = anchor.dataset.readyWiki
  const parsed = wiki ? null : parseReadyUri(anchor.getAttribute('href') ?? '')
  if (parsed?.ok) return parsed.ref
  return () => {
    let pending = resolving.get(anchor)
    if (!pending) {
      pending = resolveInlineReference(wiki ? { kind: 'wiki', target: wiki } : { kind: 'link', href: anchor.getAttribute('href') ?? '' }, filePath)
      resolving.set(anchor, pending)
      pending.then(ref => settled.set(anchor, ref), () => resolving.delete(anchor))
    }
    return pending
  }
}
export function settledCapsuleReference(anchor: HTMLAnchorElement): ReadyRef | null {
  const parsed = anchor.dataset.readyWiki ? null : parseReadyUri(anchor.getAttribute('href') ?? '')
  return parsed?.ok ? parsed.ref : settled.get(anchor) ?? null
}
