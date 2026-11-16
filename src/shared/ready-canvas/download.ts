import { activeCanvasContent } from './operations'
import type { CanvasNode, ReadyCanvas } from './schema'

// 下载为 ZIP (M4 §11, 2026-11-14): the files themselves of a selection, a sub-board or a whole board — not a
// composed document (that is 导出为 Markdown). This is the pure plan: which archive paths hold which attachment or
// text. Main reads the attachments and writes the archive.

export const DOWNLOAD_LIMITS = { files: 2000, bytes: 512 * 1024 * 1024, depth: 16 }
export interface DownloadBoard { path: string; canvas: ReadyCanvas }
export type DownloadEntry =
  | { kind: 'asset'; path: string; file: string; nodeId: string }
  | { kind: 'text'; path: string; text: string }
/** Why a card is not in the archive: it points at something outside the board's own attachments (a document card, a
 *  file kept elsewhere), or its sub-board cannot be read (in the bin, missing, nested too deep or in a loop). */
export interface DownloadSkip { nodeId: string; reason: 'reference' | 'unavailable' }
export interface DownloadPlan { entries: DownloadEntry[]; folders: string[]; skipped: DownloadSkip[] }
export interface CanvasDownloadRequest { objectId: string; nodeIds?: string[]; suggestedName?: string }
export type CanvasDownloadResult =
  | { success: true; path: string; fileCount: number; skipped: number; missing: number }
  | { success: false; canceled: true }
  | { success: false; error: string }

// eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]+/g
const safeName = (name: string, fallback: string) => name.replace(UNSAFE, '_').replace(/\s+/g, ' ').replace(/^\.+|[. ]+$/g, '').trim().slice(0, 100).trim() || fallback
const KIND_NAME: Record<string, string> = { image: '图片', audio: '录音', video: '视频', text: '文字卡', note: '便签', draft: '草稿' }
/** A text card is named after its first line, without the Markdown marks in front of it. */
const firstLine = (text: string) => (text.split('\n').find(line => line.trim()) ?? '').replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').replace(/[*_`~[\]()]/g, '').trim().slice(0, 40)

/** `ids`: the chosen cards (a group brings its members, a sub-board card its whole board as a folder); absent: every
 *  card of the board. `child` reads a sub-board card's board, or returns undefined when it cannot be read. */
export function planBoardDownload(board: DownloadBoard, ids: ReadonlySet<string> | undefined, child: (node: CanvasNode) => DownloadBoard | undefined): DownloadPlan {
  const plan: DownloadPlan = { entries: [], folders: [], skipped: [] }, used = new Set<string>()
  const claim = (dir: string, name: string, folder = false): string => {
    const dot = folder ? -1 : name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : ''
    let path = dir + name
    for (let count = 2; used.has(path.toLowerCase()); count++) path = `${dir}${stem} (${count})${extension}`
    used.add(path.toLowerCase())
    return path
  }
  const walk = (current: DownloadBoard, chosen: ReadonlySet<string> | undefined, dir: string, trail: readonly string[]) => {
    const active = activeCanvasContent(current.canvas).nodes, picked = chosen ? new Set(chosen) : undefined
    // A chosen group stands for its members.
    if (picked) for (let grew = true; grew;) { grew = false; for (const node of active) if (node.ready.groupId && picked.has(node.ready.groupId) && !picked.has(node.id)) { picked.add(node.id); grew = true } }
    const nodes = active.filter(node => !picked || picked.has(node.id)).sort((a, b) => Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x)
    const links = nodes.flatMap(node => node.type === 'link' ? [node] : [])
    // Reserved before any card's own file can take the name.
    const linksPath = links.length ? claim(dir, 'links.md') : undefined
    const own = `${current.path.replace(/\.canvas$/i, '')}.assets/`
    for (const node of nodes) {
      const kind = node.ready.kind, title = node.ready.preview?.title?.trim()
      if (node.type === 'text') {
        const text = node.text.replace(/\r\n?/g, '\n').trim()
        if (text) plan.entries.push({ kind: 'text', path: claim(dir, `${safeName(firstLine(text), KIND_NAME[kind] ?? '文字卡')}.md`), text: `${text}\n` })
      } else if (node.type === 'file' && (kind === 'image' || kind === 'audio' || kind === 'video')) {
        if (!node.file.startsWith(own)) { plan.skipped.push({ nodeId: node.id, reason: 'reference' }); continue }
        const stored = node.file.split('/').pop()!, dot = stored.lastIndexOf('.'), extension = dot > 0 ? stored.slice(dot) : ''
        const stem = safeName((node.ready.media?.originalName ?? title ?? '').replace(/\.[^.]*$/, ''), title ? safeName(title, KIND_NAME[kind]) : KIND_NAME[kind])
        plan.entries.push({ kind: 'asset', path: claim(dir, `${stem}${extension}`), file: node.file, nodeId: node.id })
        const transcript = node.ready.media?.transcript?.trim()
        if (transcript) plan.entries.push({ kind: 'text', path: claim(dir, `${stem}.md`), text: `# ${title || stem}\n\n${transcript}\n` })
      } else if (node.type === 'file' && kind === 'subcanvas') {
        const next = trail.length < DOWNLOAD_LIMITS.depth ? child(node) : undefined
        if (!next || trail.includes(next.path)) { plan.skipped.push({ nodeId: node.id, reason: 'unavailable' }); continue }
        const folder = `${claim(dir, safeName(next.canvas.ready.title || next.path.split('/').pop()!.replace(/\.canvas$/i, ''), '子画板'), true)}/`
        plan.folders.push(folder)
        walk(next, undefined, folder, [...trail, next.path])
      } else if (node.type === 'file' && kind !== 'graphic') plan.skipped.push({ nodeId: node.id, reason: 'reference' })
    }
    if (linksPath) plan.entries.push({ kind: 'text', path: linksPath, text: `# 链接\n\n${links.map(node => `- [${(node.ready.preview?.title?.trim() || node.url).replace(/[[\]]/g, ' ')}](${node.url})`).join('\n')}\n` })
  }
  walk(board, ids, '', [board.path])
  return plan
}
