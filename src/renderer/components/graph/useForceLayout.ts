import { useEffect, useMemo, useRef, useState } from 'react'

export interface GraphNode {
  id: string
  type: 'doc' | 'tag' | 'ghost'
  label: string
  sourceType?: string
}

export interface GraphEdge {
  source: string
  target: string
  kind: string
}

export interface LayoutNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
  fixed?: boolean
}

export interface UseForceLayoutOptions {
  width?: number
  height?: number
  iterations?: number
  /** Repulsion coefficient (Coulomb-like) */
  repulsion?: number
  /** Spring stiffness along edges */
  springStiffness?: number
  /** Preferred edge length */
  springLength?: number
  /** Center attraction (weak) */
  centerGravity?: number
  /** Velocity damping per tick */
  damping?: number
}

/**
 * Lightweight force-directed layout. Runs `iterations` Verlet ticks inside a
 * single effect and returns the stabilized node positions. For interactive
 * dragging, consumers can call `pin(id, x, y)` before the next render.
 *
 * Complexity is O(N²) per tick; designed for graphs with ≤ 500 nodes.
 */
export function useForceLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: UseForceLayoutOptions = {},
): { nodes: LayoutNode[]; pin: (id: string, x: number, y: number) => void; release: (id: string) => void } {
  const {
    width = 800,
    height = 600,
    iterations = 240,
    repulsion = 6000,
    springStiffness = 0.05,
    springLength = 110,
    centerGravity = 0.012,
    damping = 0.82,
  } = options

  const pinnedRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const [, setTick] = useState(0)

  const initial = useMemo<LayoutNode[]>(() => {
    const count = nodes.length
    const ring = Math.min(width, height) * 0.38
    return nodes.map((node, idx) => {
      const angle = (idx / Math.max(1, count)) * Math.PI * 2
      return {
        ...node,
        x: width / 2 + Math.cos(angle) * ring * (0.6 + (idx % 5) * 0.08),
        y: height / 2 + Math.sin(angle) * ring * (0.6 + (idx % 3) * 0.1),
        vx: 0,
        vy: 0,
      }
    })
  }, [nodes, width, height])

  const simulated = useMemo(() => {
    if (nodes.length === 0) return []
    const laid = runForceLayout(initial, edges, {
      iterations,
      repulsion,
      springStiffness,
      springLength,
      centerGravity,
      damping,
      width,
      height,
    })
    // Apply pins (so dragged node snaps where user put it)
    const idIndex = new Map(laid.map((n, i) => [n.id, i] as const))
    for (const [id, { x, y }] of pinnedRef.current.entries()) {
      const idx = idIndex.get(id)
      if (idx !== undefined) {
        laid[idx].x = x
        laid[idx].y = y
        laid[idx].fixed = true
      }
    }
    return laid
  }, [initial, edges, iterations, repulsion, springStiffness, springLength, centerGravity, damping, width, height, nodes])

  useEffect(() => { setTick((n) => n + 1) }, [nodes.length])

  const pin = (id: string, x: number, y: number): void => {
    pinnedRef.current.set(id, { x, y })
    setTick((n) => n + 1)
  }
  const release = (id: string): void => {
    pinnedRef.current.delete(id)
    setTick((n) => n + 1)
  }

  return { nodes: simulated, pin, release }
}

interface RunForceLayoutOptions {
  iterations: number
  repulsion: number
  springStiffness: number
  springLength: number
  centerGravity: number
  damping: number
  width: number
  height: number
}

/** Pure force simulation — exported for unit tests. */
export function runForceLayout(
  seeds: LayoutNode[],
  edges: GraphEdge[],
  opts: RunForceLayoutOptions,
): LayoutNode[] {
  if (seeds.length === 0) return []
  const state = seeds.map((n) => ({ ...n }))
  const idIndex = new Map(state.map((n, i) => [n.id, i] as const))

  for (let step = 0; step < opts.iterations; step += 1) {
    for (let i = 0; i < state.length; i += 1) {
      const a = state[i]
      if (a.fixed) continue
      for (let j = 0; j < state.length; j += 1) {
        if (i === j) continue
        const b = state[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 1) { dist = 1; dx = (i % 2 === 0 ? 1 : -1); dy = (j % 2 === 0 ? 1 : -1) }
        const force = opts.repulsion / (dist * dist)
        a.vx += (dx / dist) * force
        a.vy += (dy / dist) * force
      }
    }

    for (const edge of edges) {
      const aIdx = idIndex.get(edge.source)
      const bIdx = idIndex.get(edge.target)
      if (aIdx === undefined || bIdx === undefined) continue
      const a = state[aIdx]
      const b = state[bIdx]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001
      const diff = dist - opts.springLength
      const force = opts.springStiffness * diff
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      if (!a.fixed) { a.vx += fx; a.vy += fy }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy }
    }

    const cx = opts.width / 2
    const cy = opts.height / 2
    for (const n of state) {
      if (n.fixed) continue
      n.vx += (cx - n.x) * opts.centerGravity
      n.vy += (cy - n.y) * opts.centerGravity
    }

    for (const n of state) {
      if (n.fixed) continue
      n.vx *= opts.damping
      n.vy *= opts.damping
      n.x += n.vx
      n.y += n.vy
    }
  }
  return state
}
