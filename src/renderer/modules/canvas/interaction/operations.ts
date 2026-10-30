import { applyCanvasInverse, applyCanvasOperations, type CanvasInverse, type CanvasOperation } from '../../../../shared/ready-canvas/operations'
import { stableJson } from '../../../../shared/ready-canvas/serialization'
import type { CanvasNode, ReadyCanvas } from '../../../../shared/ready-canvas/schema'
import { bounds, expand } from './geometry'

export function groupOperations(nodes: CanvasNode[], id: string): CanvasOperation[] {
  if (!nodes.length) return []
  return [{ type: 'addNode', index: 0, node: { ...expand(bounds(nodes), 24), id, type: 'group', label: '分组', ready: { kind: 'group' } } }, { type: 'group', ids: nodes.map(n => n.id), groupId: id }]
}
export function layerOperations(canvas: ReadyCanvas, ids: string[], placement: 'front' | 'back'): CanvasOperation[] {
  const selected = new Set(ids), moving = canvas.nodes.filter(n => selected.has(n.id))
  return [...moving.map(n => ({ type: 'deleteNode' as const, id: n.id })), ...moving.map((node, i) => ({ type: 'addNode' as const, node, ...(placement === 'back' ? { index: i } : {}) }))]
}
/** Inverses stay guarded by A. Translate the checked result into the same public operation channel. */
function restoreOperations(before: ReadyCanvas, after: ReadyCanvas): CanvasOperation[] {
  return [
    ...before.edges.map(e => ({ type: 'deleteEdge' as const, id: e.id })),
    ...before.nodes.map(n => ({ type: 'deleteNode' as const, id: n.id })),
    ...after.nodes.map(node => ({ type: 'addNode' as const, node })),
    ...after.edges.map(edge => ({ type: 'addEdge' as const, edge })),
  ]
}
interface Entry { before: ReadyCanvas; after: ReadyCanvas; operations: CanvasOperation[]; inverse: CanvasInverse[] }
export interface PreparedEdit extends Entry { direction: 'edit' | 'undo' | 'redo'; entry: Entry }
export class CanvasHistory {
  private undo: Entry[] = []
  private redo: Entry[] = []
  get canUndo(): boolean { return this.undo.length > 0 }
  get canRedo(): boolean { return this.redo.length > 0 }
  clear(): void { this.undo = []; this.redo = [] }
  prepare(before: ReadyCanvas, operations: CanvasOperation[]): PreparedEdit {
    const result = applyCanvasOperations(before, operations), entry = { before, after: result.canvas, operations, inverse: result.inverse }
    return { ...entry, entry, direction: 'edit' }
  }
  prepareUndo(current: ReadyCanvas): PreparedEdit | undefined {
    const entry = this.undo.at(-1)
    if (!entry) return
    const after = applyCanvasInverse(current, entry.inverse)
    const operations = restoreOperations(current, after), { inverse } = applyCanvasOperations(current, operations)
    return { ...entry, before: current, after, operations, inverse, direction: 'undo', entry }
  }
  prepareRedo(current: ReadyCanvas): PreparedEdit | undefined {
    const entry = this.redo.at(-1)
    if (!entry) return
    if (stableJson(current) !== stableJson(entry.before)) throw new Error('version_conflict: redo would overwrite later work')
    return { ...entry, before: current, direction: 'redo', entry }
  }
  accept(change: PreparedEdit): void {
    if (change.direction === 'undo') { this.undo.pop(); this.redo.push(change.entry) }
    else if (change.direction === 'redo') { this.redo.pop(); this.undo.push(change.entry) }
    else { this.undo.push(change.entry); this.redo = [] }
  }
}

export function ungroupOperations(canvas: ReadyCanvas, ids: string[]): CanvasOperation[] {
  const selected = new Set(ids), remove = new Set(canvas.nodes.filter(n => n.type === 'group' && (selected.has(n.id) || canvas.nodes.some(c => c.ready.groupId === n.id) && canvas.nodes.filter(c => c.ready.groupId === n.id).every(c => selected.has(c.id)))).map(n => n.id))
  const operations: CanvasOperation[] = []
  for (const node of canvas.nodes) {
    if (remove.has(node.id)) { operations.push({ type: 'deleteNode', id: node.id }); continue }
    const ready = { ...node.ready }, dock = { ...ready.dock }
    let changed = false
    if (ready.groupId && (selected.has(node.id) || remove.has(ready.groupId))) { delete ready.groupId; changed = true }
    for (const side of ['left', 'top'] as const) if (dock[side] && remove.has(dock[side])) { delete dock[side]; changed = true }
    if (ready.dock) ready.dock = dock
    if (changed) operations.push({ type: 'replaceNode', node: { ...node, ready } })
  }
  for (const edge of canvas.edges) if (remove.has(edge.fromNode) || remove.has(edge.toNode)) operations.push({ type: 'deleteEdge', id: edge.id })
  return operations
}
