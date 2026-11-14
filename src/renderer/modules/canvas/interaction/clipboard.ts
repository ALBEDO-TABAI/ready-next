import { CanvasEdgeSchema, CanvasNodeSchema, type CanvasEdge, type CanvasNode } from '../../../../shared/ready-canvas/schema'
import type { CanvasOperation } from '../../../../shared/ready-canvas/operations'
import { bounds, type Point } from './geometry'

// Copy, cut, paste and duplicate for cards (M4 §10.2). The cards travel as JSON under their own clipboard type, next
// to a plain-text reading of them for other apps; a paste without that type is ordinary text or a web address.

export const CARDS_MIME = 'application/vnd.ready.canvas-cards+json'
export interface CardsPayload { kind: 'ready-canvas-cards'; version: 1; nodes: CanvasNode[]; edges: CanvasEdge[] }

/** A sub-board has one owner and a draft card one draft: neither can exist twice, so they are left out of a copy. */
const copyable = (node: CanvasNode): boolean => node.ready.kind !== 'subcanvas' && node.ready.kind !== 'draft' && !node.ready.trash
export function cardsPayload(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): CardsPayload | null {
  const kept = nodes.filter(copyable), ids = new Set(kept.map(n => n.id))
  if (!kept.length) return null
  return { kind: 'ready-canvas-cards', version: 1, nodes: structuredClone(kept), edges: structuredClone(edges.filter(e => ids.has(e.fromNode) && ids.has(e.toNode) && !e.ready?.trash)) }
}
export function cardsText(payload: CardsPayload): string {
  const lines = payload.nodes.map(n => n.type === 'text' ? n.text : n.type === 'link' ? n.url : n.type === 'group' ? n.label ?? '' : n.ready.preview?.title || n.file.split('/').pop() || '')
  return lines.filter(line => line.trim()).join('\n\n')
}
export function parseCards(raw: string): CardsPayload | null {
  try {
    const value = JSON.parse(raw) as Partial<CardsPayload>
    if (value?.kind !== 'ready-canvas-cards' || value.version !== 1 || !Array.isArray(value.nodes)) return null
    const nodes = value.nodes.map(node => CanvasNodeSchema.parse(node)).filter(copyable)
    return nodes.length ? { kind: 'ready-canvas-cards', version: 1, nodes, edges: (value.edges ?? []).map(edge => CanvasEdgeSchema.parse(edge)) } : null
  } catch { /* silent-catch: a clipboard that is not our cards is pasted as plain text instead */ return null }
}
/** New cards from a payload: fresh ids, memberships remapped inside the set, moved by `offset` or centred on `centre`. */
export function pasteOperations(payload: CardsPayload, place: { offset: Point } | { centre: Point }, newId: () => string = () => crypto.randomUUID()): { operations: CanvasOperation[]; ids: string[] } {
  const ids = new Map(payload.nodes.map(n => [n.id, newId()])), box = bounds(payload.nodes)
  const offset = 'offset' in place ? place.offset : { x: Math.round(place.centre.x - box.x - box.width / 2), y: Math.round(place.centre.y - box.y - box.height / 2) }
  const operations: CanvasOperation[] = []
  // Group frames first: a member may only name a group that exists.
  for (const node of [...payload.nodes].sort((a, b) => Number(b.type === 'group') - Number(a.type === 'group'))) {
    const ready = { ...node.ready }
    delete ready.dock; delete ready.trash; delete ready.fastCard
    if (ready.groupId) { const group = ids.get(ready.groupId); if (group) ready.groupId = group; else delete ready.groupId }
    operations.push({ type: 'addNode', node: { ...node, id: ids.get(node.id)!, x: node.x + offset.x, y: node.y + offset.y, ready }, ...(node.type === 'group' ? { index: 0 } : {}) })
  }
  for (const edge of payload.edges) {
    const fromNode = ids.get(edge.fromNode), toNode = ids.get(edge.toNode)
    if (fromNode && toNode) operations.push({ type: 'addEdge', edge: { ...edge, id: newId(), fromNode, toNode } })
  }
  return { operations, ids: [...ids.values()] }
}
