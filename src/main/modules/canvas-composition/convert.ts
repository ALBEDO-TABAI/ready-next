import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { graphicSvg, type CanvasNode } from '../../../shared/ready-canvas'
import { parseReadyUri, toReadyUri } from '../../../shared/ready-ref'
import type { DraftCreate } from '../../../shared/document-drafts'
import { rewriteMarkdownMediaRefs } from '../../../shared/markdown-asset-refs'
import { clusters } from '../../../renderer/modules/canvas/interaction/geometry'
import { checkedPath, filename, hashBytes } from '../document-drafts/files'
import type { ObjectRegistry } from '../object-service/registry'

/** Reuse C's pure geometry so the composition clusters match the visible canvas. */
export function compositionOrder(nodes: readonly CanvasNode[]): CanvasNode[] {
  const order = new Map(nodes.map((node, i) => [node.id, i]))
  const compare = (a: CanvasNode, b: CanvasNode) => a.y - b.y || a.x - b.x || order.get(a.id)! - order.get(b.id)!
  return clusters(nodes.filter(n => n.type !== 'group')).map(group => group.sort(compare))
    .sort((a, b) => compare(a[0], b[0])).flat()
}
export interface CompositionFile { path: string; content: string; hash: string }
export function convertSelection(root: string, objectId: string, operationId: string, nodes: CanvasNode[], registry: ObjectRegistry) {
  const attachments: NonNullable<DraftCreate['attachments']> = [], files: CompositionFile[] = []
  const material = new Map<string, string>()
  const folder = join(root, '.ready', 'canvas-composition', hashBytes(operationId))
  const attach = (path: string, bytes = readFileSync(checkedPath(root, join(root, path))), expectedHash?: string): string => {
    const hash = hashBytes(bytes), key = `${path}:${hash}`
    if (expectedHash && expectedHash !== hash) throw new Error('画板附件已改变，请重新确认素材')
    const prior = material.get(key)
    if (prior) return prior
    const name = `${attachments.length + 1}-${filename(basename(path))}`, sourcePath = join(folder, name)
    // A durable, exact placeholder; finalization owns its single rewrite.
    const markdownPath = `.ready/canvas-composition/${hashBytes(operationId)}/${name}`
    attachments.push({ sourcePath, name, contentHash: hash, markdownPath })
    files.push({ path: sourcePath, content: bytes.toString('base64'), hash })
    material.set(key, markdownPath)
    return markdownPath
  }
  const label = (text: string) => text.replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ')
  const ordered = compositionOrder(nodes)
  const chunks = ordered.map(node => {
    const original = node.ready.sources?.find(item => {
      const parsed = parseReadyUri(item.uri)
      return /^https?:\/\//i.test(item.uri) || (parsed.ok && ['book-location', 'web'].includes(parsed.ref.kind))
    })
    const source = original?.uri ?? node.ready.sources?.[0]?.uri ?? toReadyUri({ kind: 'canvas', id: objectId, node: node.id })
    const reference = node.ready.ref ?? (() => {
      const parsed = parseReadyUri(source)
      return parsed.ok && (parsed.ref.kind === 'book-location' || (node.ready.kind === 'note' && ['page', 'file'].includes(parsed.ref.kind))) ? parsed.ref : undefined
    })()
    if (reference && (node.ready.kind === 'document' || node.ready.kind === 'subcanvas' || node.ready.kind === 'note' || reference.kind === 'book-location')) return `![[${toReadyUri(reference)}]]`
    if (node.type === 'text') {
      if (node.ready.kind === 'draft') throw new Error('请选择草稿中的正文，不能将草稿卡再次成文')
      const content = rewriteMarkdownMediaRefs(node.text, ref => ref.localCandidate ? encodeURI(attach(ref.localCandidate)) : null)
      return `${content}\n\n[出处](<${source}>)`
    }
    if (node.type === 'link') return `[${label(node.ready.preview?.title || node.url)}](<${node.url}>)`
    if (node.type !== 'file') return ''
    if (node.ready.kind === 'image' || node.ready.kind === 'graphic') {
      const bytes = node.ready.graphic ? Buffer.from(graphicSvg(node.ready.graphic, node.width, node.height)) : undefined
      return `![${label(node.ready.preview?.title || node.id)}](<${encodeURI(attach(node.file, bytes, node.ready.graphic ? undefined : node.ready.media?.sha256))}>)`
    }
    const object = registry.register(checkedPath(root, join(root, node.file)))
    if (object.identity_state === 'conflict') throw new Error('引用文件身份冲突')
    if (node.ready.media && object.content_hash !== node.ready.media.sha256) throw new Error('画板附件已改变，请重新确认素材')
    const uri = toReadyUri({ kind: object.kind === 'markdown' ? 'page' : object.kind === 'canvas' ? 'canvas' : 'file', id: object.id })
    if (node.ready.kind === 'document' || node.ready.kind === 'subcanvas') return `![[${uri}]]`
    return `[${label(node.ready.preview?.title || basename(node.file))}](${uri})${node.ready.media?.transcript ? `\n\n${node.ready.media.transcript}` : ''}`
  })
  return { content: chunks.join('\n\n'), attachments, files, orderedNodeIds: ordered.map(node => node.id) }
}
