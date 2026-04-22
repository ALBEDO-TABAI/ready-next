import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runForceLayout, type LayoutNode } from '../renderer/components/graph/useForceLayout'

function seed(nodes: Array<{ id: string; type: 'doc' | 'tag' | 'ghost'; label: string }>, width = 400, height = 300): LayoutNode[] {
  const count = nodes.length
  return nodes.map((node, idx) => {
    const angle = (idx / Math.max(1, count)) * Math.PI * 2
    return {
      ...node,
      x: width / 2 + Math.cos(angle) * 100,
      y: height / 2 + Math.sin(angle) * 100,
      vx: 0,
      vy: 0,
    }
  })
}

describe('runForceLayout', () => {
  it('returns stabilized nodes with finite coordinates for a small graph', () => {
    const nodes = seed([
      { id: 'a', type: 'doc', label: 'A' },
      { id: 'b', type: 'doc', label: 'B' },
      { id: 'c', type: 'tag', label: 'C' },
    ])
    const edges = [
      { source: 'a', target: 'b', kind: 'wikilink' },
      { source: 'b', target: 'c', kind: 'tag-of' },
    ]
    const laid = runForceLayout(nodes, edges, {
      iterations: 80,
      repulsion: 6000,
      springStiffness: 0.05,
      springLength: 110,
      centerGravity: 0.012,
      damping: 0.82,
      width: 400,
      height: 300,
    })
    assert.equal(laid.length, 3)
    for (const n of laid) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `node ${n.id} coords not finite`)
    }
    const a = laid.find((n) => n.id === 'a')!
    const b = laid.find((n) => n.id === 'b')!
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    assert.ok(d > 10, `connected nodes too close after sim (distance=${d})`)
  })

  it('returns an empty array when given no nodes', () => {
    const laid = runForceLayout([], [], {
      iterations: 10,
      repulsion: 6000,
      springStiffness: 0.05,
      springLength: 110,
      centerGravity: 0.012,
      damping: 0.82,
      width: 400,
      height: 300,
    })
    assert.deepEqual(laid, [])
  })

  it('respects pinned (fixed) nodes', () => {
    const nodes = seed([
      { id: 'a', type: 'doc', label: 'A' },
      { id: 'b', type: 'doc', label: 'B' },
    ])
    nodes[0].x = 50
    nodes[0].y = 50
    nodes[0].fixed = true
    const laid = runForceLayout(nodes, [{ source: 'a', target: 'b', kind: 'wikilink' }], {
      iterations: 80,
      repulsion: 6000,
      springStiffness: 0.05,
      springLength: 110,
      centerGravity: 0.012,
      damping: 0.82,
      width: 400,
      height: 300,
    })
    const a = laid.find((n) => n.id === 'a')!
    assert.equal(a.x, 50)
    assert.equal(a.y, 50)
  })
})
