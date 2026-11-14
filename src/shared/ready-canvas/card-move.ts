import { rewriteMarkdownMediaRefs } from '../markdown-asset-refs'
import { ReadyCanvasSchema, type CanvasEdge, type CanvasNode, type ReadyCanvas } from './schema'

// Moving cards between a board and its sub-board (M4 §9): pure planning. Main reads and publishes the two files.

export type CardMoveSkip = { id: string; reason: 'missing' | 'trashed' | 'subcanvas' | 'draft' }
export type CardMovePlacement = { kind: 'origin' } | { kind: 'beside-content' } | { kind: 'beside-node'; nodeId: string }
export interface CardMoveDetail {
  targetObjectId: string; movedNodeIds: string[]; movedEdgeIds: string[]; droppedEdgeIds: string[]; skipped: CardMoveSkip[]
  /** The sub-board card this move added to the source board (收进子画板). */
  createdNodeId?: string
}
export interface CardMovePlan { source: ReadyCanvas; target: ReadyCanvas; movedNodeIds: string[]; movedEdgeIds: string[]; droppedEdgeIds: string[]; skipped: CardMoveSkip[]; box: Box }
export interface SubBoardEffects { restore: string[]; trash: string[] }
interface Box { x: number; y: number; width: number; height: number }

const GAP = 48
const active = (canvas: ReadyCanvas) => canvas.nodes.filter(node => !node.ready.trash)
function boxOf(nodes: readonly Box[]): Box {
  const x = Math.min(...nodes.map(n => n.x)), y = Math.min(...nodes.map(n => n.y))
  return { x, y, width: Math.max(...nodes.map(n => n.x + n.width)) - x, height: Math.max(...nodes.map(n => n.y + n.height)) - y }
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** Memberships that would point outside the node's board are cleared on both sides. */
function withoutRefs(node: CanvasNode, gone: (id: string) => boolean): CanvasNode {
  const ready = { ...node.ready }
  if (ready.groupId && gone(ready.groupId)) delete ready.groupId
  if (ready.dock) {
    const dock = { ...ready.dock }
    for (const side of ['left', 'top'] as const) if (dock[side] && gone(dock[side])) delete dock[side]
    if (dock.left || dock.top) ready.dock = dock; else delete ready.dock
  }
  return { ...node, ready }
}
function rehomed(node: CanvasNode, rehome: (path: string) => string): CanvasNode {
  const next = structuredClone(node)
  if (next.type === 'file') next.file = rehome(next.file)
  if (next.type === 'group' && next.background) next.background = rehome(next.background)
  if (next.type === 'text') next.text = rewriteMarkdownMediaRefs(next.text, ref => ref.localCandidate ? rehome(ref.rawDest) : null)
  if (next.ready.preview?.image) next.ready.preview.image = rehome(next.ready.preview.image)
  if (next.ready.media?.poster) next.ready.media.poster = rehome(next.ready.media.poster)
  return next
}
function place(box: Box, target: ReadyCanvas, placement: CardMovePlacement): { x: number; y: number } {
  const others = active(target)
  if (placement.kind === 'origin' || !others.length) return { x: 0, y: 0 }
  if (placement.kind === 'beside-content') { const content = boxOf(others); return { x: content.x + content.width + GAP, y: content.y } }
  const anchor = others.find(node => node.id === placement.nodeId)
  if (!anchor) throw new Error('identity_conflict: the sub-board card is not on the target board')
  const spot = { ...box, x: anchor.x + anchor.width + GAP, y: anchor.y }
  // Slide right past whatever is in the way (Stillroom's move-out); each step clears one card, so this ends.
  for (let hit = others.find(node => overlaps(spot, node)); hit; hit = others.find(node => overlaps(spot, node))) spot.x = hit.x + hit.width + GAP
  return { x: spot.x, y: spot.y }
}

/** Take cards out of `source` and put them on `target`, keeping their layout, order and the edges between them. */
export function planCardMove(input: {
  source: ReadyCanvas; target: ReadyCanvas; nodeIds: readonly string[]; placement: CardMovePlacement; rehome?: (path: string) => string
}): CardMovePlan {
  const source = ReadyCanvasSchema.parse(input.source), target = ReadyCanvasSchema.parse(input.target)
  const byId = new Map(source.nodes.map(node => [node.id, node])), wanted = new Set(input.nodeIds)
  // A chosen group brings its members.
  for (let grew = true; grew;) {
    grew = false
    for (const node of source.nodes) if (node.ready.groupId && wanted.has(node.ready.groupId) && !wanted.has(node.id)) { wanted.add(node.id); grew = true }
  }
  const skipped: CardMoveSkip[] = [], moving = new Set<string>()
  for (const id of wanted) {
    const node = byId.get(id)
    if (!node) skipped.push({ id, reason: 'missing' })
    else if (node.ready.trash) skipped.push({ id, reason: 'trashed' })
    else if (node.ready.kind === 'subcanvas' || node.ready.kind === 'draft') skipped.push({ id, reason: node.ready.kind })
    else moving.add(id)
  }
  if (!moving.size) throw new Error('nothing_to_move: no card in the selection can change boards')
  const movedEdges = source.edges.filter(edge => moving.has(edge.fromNode) && moving.has(edge.toNode))
  const dropped = source.edges.filter(edge => moving.has(edge.fromNode) !== moving.has(edge.toNode))
  const taken = new Set([...target.nodes, ...target.edges].map(item => item.id))
  const clash = [...moving, ...movedEdges.map(edge => edge.id)].find(id => taken.has(id))
  if (clash) throw new Error(`identity_conflict: ${clash} already exists on the target board`)
  const nodes = source.nodes.filter(node => moving.has(node.id)), box = boxOf(nodes), at = place(box, target, input.placement)
  const dx = at.x - box.x, dy = at.y - box.y, rehome = input.rehome ?? (path => path)
  const arrived = nodes.map(node => { const next = rehomed(withoutRefs(node, id => !moving.has(id)), rehome); next.x += dx; next.y += dy; return next })
  const gone = new Set([...movedEdges, ...dropped].map(edge => edge.id))
  return {
    source: ReadyCanvasSchema.parse({ ...source, nodes: source.nodes.filter(node => !moving.has(node.id)).map(node => withoutRefs(node, id => moving.has(id))), edges: source.edges.filter(edge => !gone.has(edge.id)) }),
    target: ReadyCanvasSchema.parse({ ...target, nodes: [...target.nodes, ...arrived], edges: [...target.edges, ...movedEdges] }),
    movedNodeIds: nodes.map(node => node.id), movedEdgeIds: movedEdges.map(edge => edge.id), droppedEdgeIds: dropped.map(edge => edge.id), skipped, box,
  }
}

/**
 * The inverse of a move, by rule on what the two boards hold now (M4 §9.2): the cards that are still on the target
 * go back with whatever was edited since, to where they were; edges come back when both ends are there again.
 */
export function planCardMoveUndo(input: {
  source: ReadyCanvas; target: ReadyCanvas; original: ReadyCanvas; detail: CardMoveDetail; rehome?: (path: string) => string
}): { source: ReadyCanvas; target: ReadyCanvas; returnedNodeIds: string[]; removedCard: boolean } {
  const source = ReadyCanvasSchema.parse(input.source), target = ReadyCanvasSchema.parse(input.target), original = ReadyCanvasSchema.parse(input.original)
  const there = new Map(target.nodes.map(node => [node.id, node])), before = new Map(original.nodes.map(node => [node.id, node]))
  const returning = input.detail.movedNodeIds.filter(id => there.has(id) && before.has(id))
  if (!returning.length) throw new Error('nothing_to_undo: the moved cards are no longer on that board')
  const back = new Set(returning), here = new Set(source.nodes.map(node => node.id))
  const clash = returning.find(id => here.has(id))
  if (clash) throw new Error(`identity_conflict: ${clash} is already back on the board`)
  const present = (id: string) => here.has(id) || back.has(id)
  const rehome = input.rehome ?? (path => path)
  const nodes = [...source.nodes]
  const order = new Map(original.nodes.map((node, index) => [node.id, index]))
  for (const id of returning.sort((a, b) => order.get(a)! - order.get(b)!)) {
    const was = before.get(id)!, now = rehomed(there.get(id)!, rehome)
    const ready = { ...now.ready, ...(was.ready.groupId ? { groupId: was.ready.groupId } : {}), ...(was.ready.dock ? { dock: was.ready.dock } : {}) }
    // Back into the old stacking order: below the first card that used to be above it.
    const above = nodes.findIndex(node => order.has(node.id) && order.get(node.id)! > order.get(id)!)
    nodes.splice(above < 0 ? nodes.length : above, 0, withoutRefs({ ...now, x: was.x, y: was.y, ready }, ref => !present(ref)))
  }
  const edgeIds = new Set(source.edges.map(edge => edge.id)), moved = new Map(target.edges.map(edge => [edge.id, edge]))
  const edges: CanvasEdge[] = [...source.edges]
  for (const edge of original.edges) {
    if (edgeIds.has(edge.id) || ![...input.detail.movedEdgeIds, ...input.detail.droppedEdgeIds].includes(edge.id)) continue
    if (present(edge.fromNode) && present(edge.toNode)) edges.push(input.detail.movedEdgeIds.includes(edge.id) ? moved.get(edge.id) ?? edge : edge)
  }
  let nextSource = { ...source, nodes, edges }
  const nextTarget = { ...target, nodes: target.nodes.filter(node => !back.has(node.id)).map(node => withoutRefs(node, id => back.has(id))), edges: target.edges.filter(edge => !back.has(edge.fromNode) && !back.has(edge.toNode)) }
  // A sub-board this move created and that is empty again goes away with its card.
  const card = input.detail.createdNodeId
  const removedCard = !!card && !nextTarget.nodes.length && nodes.some(node => node.id === card)
  if (removedCard) nextSource = { ...nextSource, nodes: nodes.filter(node => node.id !== card).map(node => withoutRefs(node, id => id === card)), edges: edges.filter(edge => edge.fromNode !== card && edge.toNode !== card) }
  return { source: ReadyCanvasSchema.parse(nextSource), target: ReadyCanvasSchema.parse(nextTarget), returnedNodeIds: returning, removedCard }
}

/** Which sub-boards a board owns, and whether their card is on the board or in its bin. */
export function subBoardOwners(canvas: ReadyCanvas): Map<string, 'active' | 'trashed'> {
  const owners = new Map<string, 'active' | 'trashed'>()
  for (const node of canvas.nodes) {
    if (node.ready.kind !== 'subcanvas' || node.ready.ref?.kind !== 'canvas') continue
    if (!node.ready.trash) owners.set(node.ready.ref.id, 'active')
    else if (!owners.has(node.ready.ref.id)) owners.set(node.ready.ref.id, 'trashed')
  }
  return owners
}
/** A sub-board file follows its card (M4 §9.3): back before the card is, to the library bin after the card leaves. */
export function subBoardEffects(before: ReadyCanvas, after: ReadyCanvas): SubBoardEffects {
  const was = subBoardOwners(before), now = subBoardOwners(after)
  return {
    restore: [...now].filter(([id, state]) => state === 'active' && was.get(id) !== 'active').map(([id]) => id),
    trash: [...was].filter(([id, state]) => state === 'active' && now.get(id) !== 'active').map(([id]) => id),
  }
}
