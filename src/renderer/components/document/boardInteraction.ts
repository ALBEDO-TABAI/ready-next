export interface BoardRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BoardNodeBounds extends BoardRect {
  id: string
}

export interface BoardSnapGuide {
  axis: 'x' | 'y'
  value: number
}

export interface BoardSnapResult {
  dx: number
  dy: number
  guides: BoardSnapGuide[]
}

export interface BoardArrowGeometry {
  x: number
  y: number
  width: number
  height: number
  x2: number
  y2: number
}

export type BoardArrowEndpoint = 'tail' | 'head'

function rectRight(rect: BoardRect): number {
  return rect.x + rect.width
}

function rectBottom(rect: BoardRect): number {
  return rect.y + rect.height
}

export function normalizeBoardRect(start: { x: number; y: number }, end: { x: number; y: number }): BoardRect {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

export function boardRectsIntersect(a: BoardRect, b: BoardRect): boolean {
  return a.x <= rectRight(b) && rectRight(a) >= b.x && a.y <= rectBottom(b) && rectBottom(a) >= b.y
}

export function getBoardNodeBounds(nodes: readonly BoardNodeBounds[]): BoardRect | null {
  if (nodes.length === 0) return null
  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxX = Math.max(...nodes.map(rectRight))
  const maxY = Math.max(...nodes.map(rectBottom))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function getMarqueeSelectedNodeIds(nodes: readonly BoardNodeBounds[], marquee: BoardRect): string[] {
  if (marquee.width <= 0 || marquee.height <= 0) return []
  return nodes.filter((node) => boardRectsIntersect(node, marquee)).map((node) => node.id)
}

function anchorsFor(rect: BoardRect, axis: 'x' | 'y'): number[] {
  if (axis === 'x') return [rect.x, rect.x + rect.width / 2, rectRight(rect)]
  return [rect.y, rect.y + rect.height / 2, rectBottom(rect)]
}

function bestAxisSnap(
  moving: BoardRect,
  fixedNodes: readonly BoardNodeBounds[],
  axis: 'x' | 'y',
  threshold: number,
): { diff: number; value: number } | null {
  let best: { diff: number; value: number; distance: number } | null = null
  for (const movingValue of anchorsFor(moving, axis)) {
    for (const fixed of fixedNodes) {
      for (const fixedValue of anchorsFor(fixed, axis)) {
        const diff = fixedValue - movingValue
        const distance = Math.abs(diff)
        if (distance > threshold) continue
        if (!best || distance < best.distance) best = { diff, value: fixedValue, distance }
      }
    }
  }
  return best ? { diff: best.diff, value: best.value } : null
}

export function resolveBoardSnapOffset(params: {
  movingBounds: BoardRect
  fixedNodes: readonly BoardNodeBounds[]
  dx: number
  dy: number
  threshold: number
}): BoardSnapResult {
  const moving = {
    ...params.movingBounds,
    x: params.movingBounds.x + params.dx,
    y: params.movingBounds.y + params.dy,
  }
  const xSnap = bestAxisSnap(moving, params.fixedNodes, 'x', params.threshold)
  const ySnap = bestAxisSnap(moving, params.fixedNodes, 'y', params.threshold)
  return {
    dx: params.dx + (xSnap?.diff ?? 0),
    dy: params.dy + (ySnap?.diff ?? 0),
    guides: [
      ...(xSnap ? [{ axis: 'x' as const, value: xSnap.value }] : []),
      ...(ySnap ? [{ axis: 'y' as const, value: ySnap.value }] : []),
    ],
  }
}

export function getArrowVectorBounds(node: Pick<BoardArrowGeometry, 'x2' | 'y2'>): BoardRect {
  return {
    x: Math.min(0, node.x2),
    y: Math.min(0, node.y2),
    width: Math.max(1, Math.abs(node.x2)),
    height: Math.max(1, Math.abs(node.y2)),
  }
}

export function resolveArrowEndpointDrag(
  node: BoardArrowGeometry,
  endpoint: BoardArrowEndpoint,
  dx: number,
  dy: number,
): BoardArrowGeometry {
  if (endpoint === 'head') {
    const x2 = node.x2 + dx
    const y2 = node.y2 + dy
    return {
      ...node,
      x2,
      y2,
      width: Math.max(1, Math.abs(x2)),
      height: Math.max(1, Math.abs(y2)),
    }
  }
  const headX = node.x + node.x2
  const headY = node.y + node.y2
  const x = node.x + dx
  const y = node.y + dy
  const x2 = headX - x
  const y2 = headY - y
  return {
    ...node,
    x,
    y,
    x2,
    y2,
    width: Math.max(1, Math.abs(x2)),
    height: Math.max(1, Math.abs(y2)),
  }
}
