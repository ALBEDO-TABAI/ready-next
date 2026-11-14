import type { Point, Rect } from './geometry'

export type Direction = 'left' | 'right' | 'up' | 'down'
const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/** The card an arrow key moves to: the nearest one whose centre lies in that direction, favouring the ones in line. */
export function neighbour<T extends Rect & { id: string }>(items: readonly T[], from: T, direction: Direction): T | undefined {
  const origin = centre(from), horizontal = direction === 'left' || direction === 'right', sign = direction === 'left' || direction === 'up' ? -1 : 1
  let best: T | undefined, bestScore = Infinity
  for (const item of items) {
    if (item.id === from.id) continue
    const c = centre(item), along = ((horizontal ? c.x - origin.x : c.y - origin.y)) * sign, across = Math.abs(horizontal ? c.y - origin.y : c.x - origin.x)
    if (along <= 0 || across > along * 2) continue
    const score = along + across * 2
    if (score < bestScore) { best = item; bestScore = score }
  }
  return best
}
