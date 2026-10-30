import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { ReadyCanvasSchema, serializeCanvas, validateCanvasCollection } from '../../../shared/ready-canvas'
import { rewriteMarkdownMediaRefs } from '../../../shared/markdown-asset-refs'
import { extractObjectLinks } from '../search-engine/object-link-extract'
import { hashBytes } from '../document-drafts/files'
import type { ObjectMoveGroup } from '../object-service/mutations'
import type { CanvasService } from './canvas-service'

/** Page operations retain their own durable move intent; canvas bytes are changed only by the writer. */
export async function repairCanvasPageMoves(service: CanvasService, group: ObjectMoveGroup, title?: { objectId: string; value: string }): Promise<void> {
  if (group.status !== 'present') return
  const fingerprint = hashBytes(JSON.stringify(group))
  const replay = await service.resumeOperation(`${group.id}:canvas-paths`, fingerprint)
  if (replay) { if (replay.state !== 'completed') throw new Error(JSON.stringify(replay)); return }
  const changes = canvasChanges(service, group, title)
  if (!changes.length) return
  const [main, ...others] = changes
  const result = await service.publishBundle({ ...main, root: group.root, operationId: `${group.id}:canvas-paths`, files: others.map(item => ({ path: item.path, content: Buffer.from(item.content).toString('base64'), sha256: hashBytes(item.content), original: item.original })) }, fingerprint)
  if (result.state !== 'completed') throw new Error(JSON.stringify(result))
}

export function canvasPageMoveIds(service: CanvasService, group: ObjectMoveGroup): string[] {
  const changes = group.status === 'present' ? canvasChanges(service, group) : []
  if (group.status === 'present' && group.objects.every(o => o.status === 'present')) {
    const objects = service.registry.list().filter(o => o.status === 'present' && o.current_path?.startsWith(group.root + '/'))
    const paths = new Map(objects.map(o => [o.id, movedPath(relative(group.root, o.current_path!), group)]))
    const entries = objects.filter(o => o.kind === 'canvas').map(o => ({ path: paths.get(o.id)!, canvas: ReadyCanvasSchema.parse(JSON.parse(changes.find(c => c.objectId === o.id)?.content ?? readFileSync(o.current_path!, 'utf8'))) }))
    validateCanvasCollection(entries, paths)
  }
  return [...new Set([...group.objects.filter(o => o.kind === 'canvas').map(o => o.id), ...changes.map(c => c.objectId)])]
}
function canvasChanges(service: CanvasService, group: ObjectMoveGroup, title?: { objectId: string; value: string }) {
  const rewrite = (path: string) => movedPath(path, group)
  return service.registry.list().filter(o => o.kind === 'canvas' && o.status === 'present' && o.current_path?.startsWith(group.root + '/')).flatMap(object => {
    const original = readFileSync(object.current_path!, 'utf8'), canvas = ReadyCanvasSchema.parse(JSON.parse(original))
    const before = serializeCanvas(canvas)
    if (title?.objectId === object.id) canvas.ready.title = title.value
    for (const node of canvas.nodes) {
      if (node.type === 'file') node.file = rewrite(node.file)
      if (node.type === 'group' && node.background) node.background = rewrite(node.background)
      if (node.type === 'text') node.text = rewriteMarkdownMediaRefs(rewriteCanvasText(node.text, rewrite), ref => ref.localCandidate ? rewrite(ref.rawDest) : null)
      if (node.ready.preview?.image) node.ready.preview.image = rewrite(node.ready.preview.image)
      if (node.ready.media?.poster) node.ready.media.poster = rewrite(node.ready.media.poster)
    }
    const content = serializeCanvas(canvas)
    return content === before ? [] : [{ objectId: object.id, path: relative(group.root, object.current_path!), original, content, affectedNodeIds: canvas.nodes.map(n => n.id) }]
  })
}

function movedPath(path: string, group: ObjectMoveGroup): string {
  const moves = group.moves.map(move => ({ source: relative(group.root, move.source), target: relative(group.root, move.target) })).sort((a, b) => b.source.length - a.source.length)
  const move = moves.find(m => path === m.source || path.startsWith(m.source + '/'))
  return move ? move.target + path.slice(move.source.length) : path
}

function rewriteCanvasText(text: string, rewrite: (path: string) => string): string {
  const edits = extractObjectLinks(text).flatMap(link => {
    if (link.sourceOffset === null || /^[a-z][a-z0-9+.-]*:/i.test(link.targetText)) return []
    let path: string
    try { path = decodeURIComponent(link.targetText) } catch { return [] }
    const wiki = text.slice(link.sourceOffset).startsWith('[[') || text.slice(link.sourceOffset).startsWith('![[')
    let next = rewrite(path)
    if (wiki && next === path && !path.endsWith('.md')) next = rewrite(path + '.md').replace(/\.md$/i, '')
    if (next === path) return []
    const start = text.indexOf(link.rawTarget, link.sourceOffset)
    if (start < 0) throw new Error('Canvas text reference position changed')
    return [{ start, end: start + link.rawTarget.length, value: (wiki ? next : encodeURI(next)) + (link.fragment === null ? '' : '#' + link.fragment) }]
  })
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end)
  return text
}
