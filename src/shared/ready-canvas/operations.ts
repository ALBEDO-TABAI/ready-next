import { replaceRanges, type ReplacementRange } from '../document-blocks/ranges'
import { fragmentHash } from '../document-blocks/positions'
import { AppearanceSchema, GraphicSchema, ReadyCanvasSchema, TrashSchema, type Appearance, type CanvasEdge, type CanvasNode, type Graphic, type ReadyCanvas, type Trash } from './schema'
import { serializeCanvas } from './serialization'

type Geometry = Pick<CanvasNode, 'x' | 'y' | 'width' | 'height'>
export type CanvasOperation =
  | { type: 'addNode'; node: CanvasNode; index?: number }
  | { type: 'replaceNode'; node: CanvasNode }
  | { type: 'deleteNode'; id: string }
  | { type: 'geometry'; id: string; geometry: Partial<Geometry> }
  | { type: 'addEdge'; edge: CanvasEdge; index?: number }
  | { type: 'replaceEdge'; edge: CanvasEdge }
  | { type: 'deleteEdge'; id: string }
  | { type: 'group'; ids: string[]; groupId: string | null }
  | { type: 'appearance'; id: string; appearance: Appearance | null }
  | { type: 'graphic'; id: string; graphic: Graphic; file: string }
  | { type: 'textRanges'; id: string; expectedTextVersion: string; ranges: readonly ReplacementRange[] }
  | { type: 'trash'; ids: string[]; edgeIds?: string[]; trash: Trash }
  | { type: 'restore'; ids: string[]; edgeIds?: string[] }
  | { type: 'purge'; ids: string[]; edgeIds?: string[] }
export type CanvasCommand = CanvasOperation
  | { type: 'batch'; operations: CanvasOperation[] }
  | { type: 'importAttachment'; sourceToken: string; node: CanvasNode }
  | { type: 'createSubcanvas'; path: string; canvas: ReadyCanvas; node: CanvasNode }
export interface CanvasWriteRequest {
  objectId: string; handleId: string; expectedVersion: string; operationId: string; commands: CanvasCommand[]
}
export interface CanvasBufferConfirmation { tabId: string; bufferVersion: number; openGeneration: number }
export type CanvasConflictCode = 'version_conflict' | 'text_conflict' | 'delete_edit_conflict' | 'group_conflict'
  | 'identity_conflict' | 'operation_id_reused' | 'buffer_confirmation_expired'
export interface CanvasConflict { code: CanvasConflictCode; message: string; nodeIds: string[]; actualVersion?: string }
export type CanvasWriteState = 'prepared' | 'awaiting-buffer' | 'published' | 'indexed' | 'completed' | 'conflict' | 'recovery-required'
export interface CanvasReceipt {
  state: 'completed'; operationId: string; objectId: string; beforeVersion: string; afterVersion: string
  affectedNodeIds: string[]; attachments: Array<{ path: string; sha256: string; verified: true }>
}
export type CanvasWriteResult = CanvasReceipt
  | { state: 'merged_dirty'; operationId: string; objectId: string; confirmation: CanvasBufferConfirmation }
  | { state: 'conflict'; operationId: string; conflict: CanvasConflict }
  | { state: 'recovery-required'; operationId: string; phase: 'prepared' | 'published' | 'indexed'; message: string }
/** Private-to-history inverse, not a Main write command. Exact post-state guards later edits. */
export interface CanvasInverse { type: 'restoreSnapshot'; expectedSnapshot: string; snapshot: ReadyCanvas }

export function applyCanvasOperations(input: ReadyCanvas, operations: readonly CanvasOperation[]): { canvas: ReadyCanvas; inverse: CanvasInverse[] } {
  const before = ReadyCanvasSchema.parse(input)
  const canvas = structuredClone(before)
  function node(id: string): CanvasNode {
    const found = canvas.nodes.find(n => n.id === id)
    if (!found) throw new Error(`Node not found: ${id}`)
    return found
  }
  function insert<T>(items: T[], item: T, index = items.length): void {
    if (!Number.isSafeInteger(index) || index < 0 || index > items.length) throw new Error('Invalid insertion index')
    items.splice(index, 0, structuredClone(item))
  }
  function replace<T extends { id: string }>(items: T[], item: T): void {
    const index = items.findIndex(current => current.id === item.id)
    if (index < 0) throw new Error(`Item not found: ${item.id}`)
    items[index] = structuredClone(item)
  }
  for (const operation of operations) {
    switch (operation.type) {
      case 'addNode': insert(canvas.nodes, operation.node, operation.index); break
      case 'replaceNode': replace(canvas.nodes, operation.node); break
      case 'deleteNode': node(operation.id); canvas.nodes = canvas.nodes.filter(n => n.id !== operation.id); break
      case 'geometry': {
        const n = node(operation.id)
        for (const key of ['x', 'y', 'width', 'height'] as const) if (operation.geometry[key] !== undefined) n[key] = operation.geometry[key]
        break
      }
      case 'addEdge': insert(canvas.edges, operation.edge, operation.index); break
      case 'replaceEdge': replace(canvas.edges, operation.edge); break
      case 'deleteEdge':
        if (!canvas.edges.some(e => e.id === operation.id)) throw new Error(`Edge not found: ${operation.id}`)
        canvas.edges = canvas.edges.filter(e => e.id !== operation.id); break
      case 'group':
        for (const id of operation.ids) {
          const r = node(id).ready
          if (operation.groupId === null) delete r.groupId
          else r.groupId = operation.groupId
        }
        break
      case 'appearance':
        if (operation.appearance === null) delete node(operation.id).ready.appearance
        else node(operation.id).ready.appearance = AppearanceSchema.parse(operation.appearance)
        break
      case 'graphic': {
        const n = node(operation.id)
        if (n.type !== 'file' || n.ready.kind !== 'graphic') throw new Error('Graphic operation requires a graphic file node')
        n.ready.graphic = GraphicSchema.parse(operation.graphic); n.file = operation.file
        break
      }
      case 'textRanges': {
        const n = node(operation.id)
        if (n.type !== 'text' || n.ready.kind === 'draft') throw new Error('Only text/note bodies support range editing')
        if (fragmentHash(n.text) !== operation.expectedTextVersion) throw new Error('text_conflict: stale node body')
        // The disk revision is owned by Main; M3 range validation checks exact text and UTF-16 boundaries.
        n.text = replaceRanges(n.text, { type: 'replaceRanges', expectedVersion: 0, ranges: operation.ranges }, 0)
        break
      }
      case 'trash': {
        const trash = TrashSchema.parse(operation.trash)
        for (const id of operation.ids) {
          const n = node(id)
          if (n.ready.trash) throw new Error(`Already trashed: ${id}`)
          n.ready.trash = { ...trash }
        }
        for (const id of operation.edgeIds ?? []) {
          const e = canvas.edges.find(edge => edge.id === id)
          if (!e || e.ready?.trash) throw new Error(`Missing or already trashed edge: ${id}`)
          e.ready ??= {}; e.ready.trash = { ...trash }
        }
        break
      }
      case 'purge': {
        const ids = new Set(operation.ids), edgeIds = new Set(operation.edgeIds ?? [])
        for (const id of ids) if (!node(id).ready.trash) throw new Error(`只能永久删除已回收的卡片：${id}`)
        for (const id of edgeIds) {
          const edge = canvas.edges.find(e => e.id === id)
          if (!edge?.ready?.trash) throw new Error(`只能永久删除已回收的连线：${id}`)
        }
        canvas.nodes = canvas.nodes.filter(n => !ids.has(n.id))
        canvas.edges = canvas.edges.filter(e => !ids.has(e.fromNode) && !ids.has(e.toNode) && !edgeIds.has(e.id))
        for (const { ready } of canvas.nodes) {
          if (ready.groupId && ids.has(ready.groupId)) delete ready.groupId
          for (const side of ['left', 'top'] as const) if (ready.dock?.[side] && ids.has(ready.dock[side])) delete ready.dock[side]
        }
        break
      }
      case 'restore': {
        for (const id of operation.ids) {
          const n = node(id)
          if (!n.ready.trash) throw new Error(`Not trashed: ${id}`)
          delete n.ready.trash
        }
        for (const id of operation.edgeIds ?? []) {
          const e = canvas.edges.find(edge => edge.id === id)
          if (!e?.ready?.trash) throw new Error(`Missing or not trashed edge: ${id}`)
          delete e.ready.trash
        }
        break
      }
      default: throw new Error('Unknown pure canvas operation; external effects require Main preparation')
    }
  }
  const result = ReadyCanvasSchema.parse(canvas)
  return { canvas: result, inverse: [{ type: 'restoreSnapshot', expectedSnapshot: serializeCanvas(result), snapshot: structuredClone(before) }] }
}
export function applyCanvasInverse(input: ReadyCanvas, inverse: readonly CanvasInverse[]): ReadyCanvas {
  let canvas = ReadyCanvasSchema.parse(input)
  for (const step of inverse) {
    if (serializeCanvas(canvas) !== step.expectedSnapshot) throw new Error('version_conflict: inverse would overwrite later work')
    canvas = structuredClone(ReadyCanvasSchema.parse(step.snapshot))
  }
  return canvas
}

/** Visibility derives from endpoint state, independent of an edge's own recycle action. */
export function activeCanvasContent(canvas: ReadyCanvas): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes = canvas.nodes.filter(node => !node.ready.trash), ids = new Set(nodes.map(node => node.id))
  return { nodes, edges: canvas.edges.filter(edge => !edge.ready?.trash && ids.has(edge.fromNode) && ids.has(edge.toNode)) }
}
