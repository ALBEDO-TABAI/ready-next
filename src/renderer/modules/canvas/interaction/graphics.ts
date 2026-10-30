import { graphicFrame } from '../../../../shared/ready-canvas/graphics'
import type { CanvasNode, Graphic } from '../../../../shared/ready-canvas/schema'
import type { Rect } from './geometry'

/** A's arrow coordinates are vectors from the node origin, including negative directions. */
export function cardFrame(node: CanvasNode): Rect {
  const frame = node.ready.graphic ? graphicFrame(node.ready.graphic, node.width, node.height) : { x: 0, y: 0, width: node.width, height: node.height }
  return { x: node.x + frame.x, y: node.y + frame.y, width: frame.width, height: frame.height }
}
export function visualBounds(node: CanvasNode): Rect {
  const frame = cardFrame(node), angle = (node.ready.appearance?.rotation ?? 0) * Math.PI / 180
  if (!angle) return frame
  const width = Math.abs(frame.width * Math.cos(angle)) + Math.abs(frame.height * Math.sin(angle))
  const height = Math.abs(frame.height * Math.cos(angle)) + Math.abs(frame.width * Math.sin(angle))
  return { x: frame.x + (frame.width - width) / 2, y: frame.y + (frame.height - height) / 2, width, height }
}
export function resizedGraphic(g: Graphic, sx: number, sy: number): Graphic {
  return g.type === 'arrow' ? { ...g, x2: g.x2 * sx, y2: g.y2 * sy } : g.type === 'path' ? { ...g, points: g.points.map(p => ({ x: p.x * sx, y: p.y * sy })) } : g
}
