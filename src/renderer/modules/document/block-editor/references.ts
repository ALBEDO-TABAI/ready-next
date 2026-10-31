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
  for (const item of result.data.items) {
    const ready = parseReadyUri(item.path)
    if (ready.ok) { if (!wiki) addReady(item.name, item.sourceType, ready.ref); continue }
    if (item.sourceType !== 'document' || !/\.md$/i.test(item.path)) continue
    if (/[[\]|\r\n]/.test(item.path)) continue
    if (!wiki) {
      const location = await window.electronAPI.objects.resolvePath(item.path)
      addReady(item.name, item.path, { kind: 'page', id: location.objectId })
      continue
    }
    const path = await wikiTarget(filePath, item.path)
    if (/[[\]|\r\n]/.test(path)) continue
    const addWiki = (target: string, label: string) => choices.push({ id: target, label, detail: item.path, text: target, reference: { kind: 'wiki', target } })
    if (anchorQuery === undefined) addWiki(path, item.name)
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
      addWiki(`${path}#${heading}`, `${item.name} › ${heading}`)
    }
  }
  return choices.filter((choice, index) => choices.findIndex(other => other.id === choice.id) === index)
}

export async function openInlineReference(reference: InlineReference, filePath?: string | null) {
  const { openReadyRef } = await import('../../workbench/open-ready-ref')
  if (reference.kind === 'ready') return openReadyRef(reference.ref, 'document')
  if (reference.kind === 'wiki') {
    if (filePath === undefined) throw new Error('尚未提供画板文件路径，无法打开相对页面链接')
    const [path, anchor] = reference.target.split('#', 2)
    const file = /\.md$/i.test(path) ? path : `${path}.md`
    // Canonical targets are relative to this page's folder; a hand-written vault-relative link is the fallback.
    const roots = workspaceRoots()
    const vault = roots.find(root => filePath?.startsWith(`${root.replace(/[/\\]+$/, '')}/`)) ?? roots[0]
    const folder = filePath?.replace(/[/\\][^/\\]+$/, '')
    const candidates = file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) ? [file]
      : [...new Set([folder, vault].filter((base): base is string => Boolean(base)).map(base => `${base}/${file}`))]
    let target: string | undefined
    for (const candidate of candidates) if ((await window.electronAPI.document.stat(candidate)).success) { target = candidate; break }
    if (!target) throw new Error(`找不到页面：${path}`)
    const location = await window.electronAPI.objects.resolvePath(target)
    return openReadyRef({ kind: 'page', id: location.objectId, ...(anchor ? { anchor } : {}) }, 'document')
  }
  if (reference.href.startsWith('ready://')) return openReadyRef(reference.href, 'document')
  if (!/^https?:\/\//i.test(reference.href)) throw new Error('只支持网页或 Ready 内部链接')
  return openReadyRef({ kind: 'web', url: reference.href }, 'document')
}
