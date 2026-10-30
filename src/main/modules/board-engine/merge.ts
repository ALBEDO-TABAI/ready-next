import { isDeepStrictEqual } from 'node:util'
import { ReadyCanvasSchema, type CanvasNode, type CanvasEdge, type ReadyCanvas } from '../../../shared/ready-canvas'
import { replaceRanges } from '../../../shared/document-blocks/ranges'
const equal = isDeepStrictEqual
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function change(base: string, next: string) {
  let start = 0, end = base.length, last = next.length
  while (start < end && start < last && base[start] === next[start]) start++
  while (end > start && last > start && base[end - 1] === next[last - 1]) { end--; last-- }
  return { start, end, expectedText: base.slice(start, end), replacement: next.slice(start, last) }
}
function merge(base: unknown, local: unknown, remote: unknown, field = ''): unknown {
  if (equal(local, base)) return remote
  if (equal(remote, base) || equal(local, remote)) return local
  if (field === 'text' && typeof base === 'string' && typeof local === 'string' && typeof remote === 'string') {
    try { return replaceRanges(base, { type: 'replaceRanges', expectedVersion: 0, ranges: [change(base, local), change(base, remote)] }, 0) }
    catch { throw new Error('text_conflict: overlapping body changes') }
  }
  if (record(base) && record(local) && record(remote)) {
    const result: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const value = merge(base[key], local[key], remote[key], key)
      if (value !== undefined) result[key] = value
    }
    return result
  }
  throw new Error(`${field === 'groupId' ? 'group_conflict' : base !== undefined && (local === undefined || remote === undefined) || field === 'trash' ? 'delete_edit_conflict' : 'version_conflict'}: concurrent ${field} changes`)
}
export function mergeCanvas(base: ReadyCanvas, local: ReadyCanvas, remote: ReadyCanvas): ReadyCanvas {
  const result = structuredClone(remote)
  for (const key of ['nodes', 'edges'] as const) {
    const map = (items: (CanvasNode | CanvasEdge)[]) => new Map(items.map(item => [item.id, item] as const))
    const before = map(base[key]), a = map(local[key]), b = map(remote[key])
    const items: unknown[] = []
    for (const id of new Set([...remote[key].map(n => n.id), ...local[key].map(n => n.id)])) {
      const original = before.get(id), left = a.get(id), right = b.get(id)
      if (original && left && right && ('ready' in left && 'ready' in right) &&
        ((!equal(left.ready?.trash, original.ready?.trash) && !equal(original, right)) || (!equal(right.ready?.trash, original.ready?.trash) && !equal(original, left)))) throw new Error('delete_edit_conflict: recycled node was edited')
      const value = merge(original, left, right, id)
      if (value !== undefined) items.push(value)
    }
    Object.assign(result, { [key]: items })
  }
  result.ready = ReadyCanvasSchema.shape.ready.parse(merge(base.ready, local.ready, remote.ready))
  return ReadyCanvasSchema.parse(result)
}
