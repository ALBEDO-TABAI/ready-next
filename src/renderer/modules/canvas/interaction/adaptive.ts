import type { CanvasNode } from '../../../../shared/ready-canvas/schema'
import type { CanvasOperation } from '../../../../shared/ready-canvas/operations'
import { bounds, type Point, type Rect } from './geometry'
import { resizedGraphic } from './graphics'

// Stillroom's adaptive docking and proportional scaling, on Ready's explicit integer geometry (M4 §10).

export type Side = 'left' | 'right' | 'top' | 'bottom'
export interface DockItem extends Rect { id: string }
export interface AdaptiveDock {
  /** Where the scaled selection's own bounds land, and by how much it scales. */
  x: number; y: number; k: number
  target: string; source: string; side: Side; score: number
  /** Where the bounds sit while still dragging: the docking edge on its landing line, the other axis free. */
  dragX: number; dragY: number
  /** The short mark across the seam between the two cards. */
  marker: { x1: number; y1: number; x2: number; y2: number }
}
/** A text card without its own size reads at 13px; `appearance.fontScale` counts in 24px units. */
export const DEFAULT_FONT_SCALE = 13 / 24
export const MIN_CARD_WIDTH = 80, MIN_CARD_HEIGHT = 36
const MIN_DOCK_SCALE = 0.25, MAX_DOCK_SCALE = 4

/** Cards dock and are docked to; group frames and drawings only travel with the selection. */
export const dockable = (node: CanvasNode): boolean => node.type !== 'group' && node.ready.kind !== 'graphic'

/** One decision owns both the marker and the release transform. Only edges on the outside of the dragged set take part. */
export function adaptiveDock(members: readonly DockItem[], others: readonly DockItem[], gap: number, radius: number, previous: AdaptiveDock | null = null): AdaptiveDock | null {
  if (!members.length) return null
  const box = bounds(members), candidates: AdaptiveDock[] = []
  for (const m of members) for (const o of others) for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const horizontal = side === 'left' || side === 'right', negative = side === 'left' || side === 'top'
    // An interior card must not pull the rest through the target.
    const edge = horizontal ? (negative ? m.x + m.width : m.x) : (negative ? m.y + m.height : m.y)
    const outer = horizontal ? (negative ? box.x + box.width : box.x) : (negative ? box.y + box.height : box.y)
    if (Math.abs(edge - outer) > 1) continue
    const targetEdge = horizontal ? (negative ? o.x : o.x + o.width) : (negative ? o.y : o.y + o.height)
    const landing = targetEdge + (negative ? -gap : gap), distance = Math.abs(edge - landing)
    const held = previous?.target === o.id && previous.source === m.id && previous.side === side
    const lo = Math.max(horizontal ? m.y : m.x, horizontal ? o.y : o.x)
    const hi = Math.min(horizontal ? m.y + m.height : m.x + m.width, horizontal ? o.y + o.height : o.x + o.width)
    if (distance > radius * (held ? 1.6 : 1) || hi < lo) continue
    const k = horizontal ? o.height / m.height : o.width / m.width
    if (!(k >= MIN_DOCK_SCALE && k <= MAX_DOCK_SCALE)) continue
    const memberX = horizontal ? (negative ? o.x - gap - m.width * k : o.x + o.width + gap) : o.x
    const memberY = horizontal ? o.y : (negative ? o.y - gap - m.height * k : o.y + o.height + gap)
    const mid = (lo + hi) / 2, seam = (targetEdge + landing) / 2, half = Math.max(radius * 0.45, gap / 2 + 4)
    const offCentre = Math.abs(horizontal ? m.y + m.height / 2 - o.y - o.height / 2 : m.x + m.width / 2 - o.x - o.width / 2)
    candidates.push({ source: m.id, target: o.id, side, k, score: distance + offCentre * 0.2,
      x: memberX - (m.x - box.x) * k, y: memberY - (m.y - box.y) * k,
      dragX: box.x + (horizontal ? landing - edge : 0), dragY: box.y + (horizontal ? 0 : landing - edge),
      marker: horizontal ? { x1: seam - half, y1: mid, x2: seam + half, y2: mid } : { x1: mid, y1: seam - half, x2: mid, y2: seam + half } })
  }
  candidates.sort((a, b) => a.score - b.score || a.target.localeCompare(b.target) || a.source.localeCompare(b.source))
  const held = candidates.find(c => c.target === previous?.target && c.source === previous.source && c.side === previous.side)
  if (held) {
    // Sticky: another source edge on the same target side takes over only when clearly closer.
    const adjacent = candidates.find(c => c.target === held.target && c.side === held.side)!
    return adjacent.score + radius * 0.35 < held.score ? adjacent : held
  }
  return candidates[0] ?? null
}

/** A card's geometry after a gesture; a text card carries the size its words scale to. */
export interface Placement extends Rect { fontScale?: number }
const scalesText = (node: CanvasNode): boolean => node.type === 'text' && node.ready.kind !== 'draft'
export function scaledFont(node: CanvasNode, k: number): number | undefined {
  if (!scalesText(node) || k === 1) return undefined
  return Math.min(16, Math.max(0.05, Math.round((node.ready.appearance?.fontScale ?? DEFAULT_FONT_SCALE) * k * 10000) / 10000))
}
/** Scale cards about `origin`, landing that point on `destination`. Main only takes integers: every value is rounded. */
export function scaledPlacements(nodes: readonly CanvasNode[], origin: Point, destination: Point, k: number): Map<string, Placement> {
  const result = new Map<string, Placement>()
  for (const n of nodes) {
    const fontScale = scaledFont(n, k)
    result.set(n.id, { x: Math.round(destination.x + (n.x - origin.x) * k), y: Math.round(destination.y + (n.y - origin.y) * k),
      width: Math.max(1, Math.round(n.width * k)), height: Math.max(1, Math.round(n.height * k)), ...(fontScale === undefined ? {} : { fontScale }) })
  }
  return result
}
/** The node as it will be saved: geometry, a drawing stretched with its frame, text at its new size. */
export function placedNode(node: CanvasNode, p: Placement): CanvasNode {
  const ready = { ...node.ready }
  if (ready.graphic) ready.graphic = resizedGraphic(ready.graphic, p.width / node.width, p.height / node.height)
  if (p.fontScale !== undefined) ready.appearance = { ...ready.appearance, fontScale: p.fontScale }
  return { ...node, x: p.x, y: p.y, width: p.width, height: p.height, ready }
}
/** One batch for one gesture. A drawing's SVG is derived from its size, so its attachment is prepared first. */
export async function placementOperations(nodes: readonly CanvasNode[], placements: ReadonlyMap<string, Placement>,
  prepare?: (draft: Rect & { id: string; graphic: NonNullable<CanvasNode['ready']['graphic']> }) => Promise<string>): Promise<CanvasOperation[]> {
  const operations: CanvasOperation[] = []
  for (const node of nodes) {
    const p = placements.get(node.id)
    if (!p) continue
    const next = placedNode(node, p), resized = p.width !== node.width || p.height !== node.height
    if (p.x === node.x && p.y === node.y && !resized && p.fontScale === undefined) continue
    operations.push({ type: 'geometry', id: node.id, geometry: { x: p.x, y: p.y, width: p.width, height: p.height } })
    if (next.ready.graphic && resized) {
      if (!prepare) throw new Error('尚未连接图形附件服务')
      operations.push({ type: 'graphic', id: node.id, graphic: next.ready.graphic, file: await prepare({ id: node.id, x: p.x, y: p.y, width: p.width, height: p.height, graphic: next.ready.graphic }) })
    }
    if (p.fontScale !== undefined) operations.push({ type: 'appearance', id: node.id, appearance: next.ready.appearance! })
  }
  return operations
}
