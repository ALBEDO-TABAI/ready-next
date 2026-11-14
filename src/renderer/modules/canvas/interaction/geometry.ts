import type { CanvasNode } from '../../../../shared/ready-canvas/schema'
import type { CanvasOperation } from '../../../../shared/ready-canvas/operations'

export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export interface Camera extends Point { zoom: number }
export interface Guide { axis: 'x' | 'y'; value: number; start: number; end: number }
export const intersects = (a: Rect, b: Rect): boolean => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
export const expand = (r: Rect, pad: number): Rect => ({ x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 })
export const rectBetween = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
export function bounds(items: readonly Rect[]): Rect {
  if (!items.length) throw new Error('Bounds require at least one rectangle')
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (const r of items) { x = Math.min(x, r.x); y = Math.min(y, r.y); right = Math.max(right, r.x + r.width); bottom = Math.max(bottom, r.y + r.height) }
  return { x, y, width: right - x, height: bottom - y }
}
/** Liang–Barsky: does the segment a→b touch the rectangle (a connector crossed by the marquee)? */
export function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  let t0 = 0, t1 = 1
  const dx = b.x - a.x, dy = b.y - a.y
  for (const [p, q] of [[-dx, a.x - r.x], [dx, r.x + r.width - a.x], [-dy, a.y - r.y], [dy, r.y + r.height - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue }
    const t = q / p
    if (p < 0) { if (t > t1) return false; t0 = Math.max(t0, t) } else { if (t < t0) return false; t1 = Math.min(t1, t) }
  }
  return true
}
export const screenToWorld = (p: Point, c: Camera): Point => ({ x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom })
export function zoomAt(c: Camera, p: Point, zoom: number): Camera {
  const z = Math.max(0.15, Math.min(4, zoom)), world = screenToWorld(p, c)
  return { x: p.x - world.x * z, y: p.y - world.y * z, zoom: z }
}

/** Build once per accepted board change. Large cards use a separate bounded list. */
export class SpatialIndex<T extends Rect & { id: string }> {
  private cells = new Map<string, T[]>()
  private large: T[] = []
  lastVisited = 0
  constructor(items: readonly T[], private cellSize = 512) {
    for (const item of items) {
      const keys = this.keys(item)
      if (!keys) this.large.push(item)
      else for (const key of keys) { const cell = this.cells.get(key) ?? []; cell.push(item); this.cells.set(key, cell) }
    }
  }
  private keys(r: Rect): string[] | null {
    const x0 = Math.floor(r.x / this.cellSize), x1 = Math.floor((r.x + r.width) / this.cellSize)
    const y0 = Math.floor(r.y / this.cellSize), y1 = Math.floor((r.y + r.height) / this.cellSize)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return null
    const keys: string[] = []
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x}:${y}`)
    return keys
  }
  query(r: Rect): T[] {
    const seen = new Set<string>(), result: T[] = [], keys = this.keys(r)
    this.lastVisited = 0
    const visit = (item: T) => { if (seen.has(item.id)) return; seen.add(item.id); this.lastVisited++; if (intersects(item, r)) result.push(item) }
    if (keys) for (const key of keys) for (const item of this.cells.get(key) ?? []) visit(item)
    else for (const cell of this.cells.values()) for (const item of cell) visit(item)
    for (const item of this.large) visit(item)
    return result
  }
}

/** Stillroom gap snap plus Ready centre/edge guides; candidates already spatially restricted. */
export function snapRect(r: Rect, others: readonly Rect[], gap: number, radius: number): Point & { guides: Guide[] } {
  const guides: Guide[] = [], result = { x: r.x, y: r.y }
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 'width' : 'height', cross = axis === 'x' ? 'y' : 'x', crossSize = axis === 'x' ? 'height' : 'width'
    let best = radius + 1, delta = 0, guide: Guide | undefined
    for (const other of others) {
      const candidates: Array<{ d: number; value?: number }> = []
      if (r[cross] < other[cross] + other[crossSize] + radius && r[cross] + r[crossSize] > other[cross] - radius) {
        candidates.push({ d: other[axis] + other[size] + gap - r[axis] }, { d: other[axis] - r[size] - gap - r[axis] })
      }
      for (const factor of [0, 0.5, 1]) {
        const value = other[axis] + other[size] * factor
        candidates.push({ d: value - (r[axis] + r[size] * factor), value })
      }
      for (const candidate of candidates) if (Math.abs(candidate.d) <= radius && Math.abs(candidate.d) < best) {
        best = Math.abs(candidate.d); delta = candidate.d
        guide = candidate.value === undefined ? undefined : { axis, value: candidate.value, start: Math.min(r[cross], other[cross]) - 16, end: Math.max(r[cross] + r[crossSize], other[cross] + other[crossSize]) + 16 }
      }
    }
    result[axis] = Math.round(r[axis] + delta)
    if (guide) guides.push(guide)
  }
  return { ...result, guides }
}

/** Visible-region sweep; never called from pointermove. */
export function clusters<T extends Rect & { id: string }>(items: readonly T[], tolerance = 64): T[][] {
  const sorted = [...items].sort((a, b) => a.x - b.x), parent = sorted.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    for (let j = i + 1; j < sorted.length && sorted[j].x <= a.x + a.width + tolerance; j++) {
      const b = sorted[j], dx = Math.max(0, a.x - b.x - b.width, b.x - a.x - a.width), dy = Math.max(0, a.y - b.y - b.height, b.y - a.y - a.height)
      if (Math.hypot(dx, dy) <= tolerance) parent[find(j)] = find(i)
    }
  }
  const result = new Map<number, T[]>()
  sorted.forEach((item, i) => { const key = find(i), group = result.get(key) ?? []; group.push(item); result.set(key, group) })
  return [...result.values()]
}

export function layout(nodes: readonly CanvasNode[], kind: 'P' | 'L' | 'R', gap = 24, seed = 1): CanvasOperation[] {
  if (nodes.length < 2) return []
  const box = bounds(nodes), sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)
  let state = seed >>> 0
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
  const placements = new Map<string, Rect>()
  if (kind === 'R') {
    const radius = Math.sqrt(nodes.reduce((sum, n) => sum + n.width * n.height, 0)) * 0.9
    sorted.forEach((n, i) => {
      const angle = i * 2.399963 + random() * 0.6, distance = radius * Math.sqrt((i + 0.5) / nodes.length) * (0.8 + random() * 0.5)
      placements.set(n.id, { x: Math.round(box.x + box.width / 2 + Math.cos(angle) * distance - n.width / 2), y: Math.round(box.y + box.height / 2 + Math.sin(angle) * distance - n.height / 2), width: n.width, height: n.height })
    })
  } else if (kind === 'L') {
    const cols = Math.max(2, Math.round(Math.sqrt(nodes.length))), colWidth = Math.max(...nodes.map(n => n.width)), heights: number[] = Array(cols).fill(box.y)
    sorted.sort((a, b) => b.height - a.height).forEach(n => {
      const col = heights.indexOf(Math.min(...heights))
      placements.set(n.id, { x: Math.round(box.x + col * (colWidth + gap) + (colWidth - n.width) / 2), y: heights[col], width: n.width, height: n.height })
      heights[col] += n.height + gap
    })
  } else {
    const rowHeight = Math.round(Math.max(120, Math.min(300, nodes.reduce((sum, n) => sum + n.height, 0) / nodes.length)))
    const target = Math.max(Math.sqrt(nodes.reduce((sum, n) => sum + n.width * n.height, 0)) * 1.4, Math.max(...nodes.map(n => n.width)))
    let x = box.x, y = box.y, rowMax = 0
    for (const n of sorted) {
      const media = n.ready.kind === 'image' || n.ready.kind === 'video', height = media ? rowHeight : n.height, width = media ? Math.max(1, Math.round(n.width * rowHeight / n.height)) : n.width
      if (x > box.x && x + width > box.x + target) { x = box.x; y += rowMax + gap; rowMax = 0 }
      placements.set(n.id, { x, y, width, height }); x += width + gap; rowMax = Math.max(rowMax, height)
    }
  }
  // Coordinates, not random instructions, are the durable redo payload. Clear stale docking.
  return nodes.map(node => { const ready = { ...node.ready }; delete ready.dock; return { type: 'replaceNode', node: { ...node, ...placements.get(node.id), ready } } })
}
