import assert from 'node:assert/strict'
import test from 'node:test'
import { bounds, screenToWorld, zoomAt, snapRect, SpatialIndex, clusters, layout } from '../renderer/modules/canvas/interaction/geometry'
import { CanvasHistory, groupOperations, layerOperations } from '../renderer/modules/canvas/interaction/operations'
import { applyCanvasInverse, applyCanvasOperations } from '../shared/ready-canvas/operations'
import { mixedCanvas } from './fixtures/canvas-surface/mixed'

test('zoom preserves the world point under the cursor; local coordinates include pan', () => {
  const camera = { x: 50, y: 30, zoom: 2 }, cursor = { x: 250, y: 130 }
  assert.deepEqual(screenToWorld(cursor, camera), { x: 100, y: 50 })
  assert.deepEqual(screenToWorld(cursor, zoomAt(camera, cursor, 4)), { x: 100, y: 50 })
})
test('magnetic gap and alignment guides are derived from nearby rectangles', () => {
  const fixed = [{ id: 'fixed', x: 0, y: 0, width: 100, height: 100 }]
  const result = snapRect({ x: 122, y: 3, width: 50, height: 50 }, fixed, 24, 6)
  assert.equal(result.x, 124); assert.equal(result.y, 0)
  assert.ok(result.guides.some(g => g.axis === 'y' && g.value === 0))
  assert.equal(snapRect({ x: 200, y: 200, width: 50, height: 50 }, fixed, 24, 6).x, 200)
})
test('spatial queries and clusters omit distant nodes, including negative coordinates', () => {
  const nodes = mixedCanvas(1000).nodes, index = new SpatialIndex(nodes)
  const near = index.query({ x: -10, y: -10, width: 540, height: 170 })
  assert.deepEqual(near.map(n => n.id), ['n0', 'n1', 'n2'])
  assert.ok(index.lastVisited < 100)
  assert.deepEqual(clusters(nodes.slice(0, 3), 64).map(c => c.map(n => n.id)), [['n0', 'n1', 'n2']])
  assert.equal(clusters(nodes.slice(0, 3), 24).length, 3)
})
test('P/L layout respects gaps; R uses a seed and records reusable final coordinates', () => {
  const nodes = mixedCanvas(12).nodes
  for (const kind of ['P', 'L'] as const) {
    const next = applyCanvasOperations(mixedCanvas(), layout(nodes, kind, 24, 42)).canvas
    for (let i = 0; i < next.nodes.length; i++) for (let j = i + 1; j < next.nodes.length; j++) {
      const a = next.nodes[i], b = next.nodes[j]
      assert.ok(a.x + a.width + 23 <= b.x || b.x + b.width + 23 <= a.x || a.y + a.height + 23 <= b.y || b.y + b.height + 23 <= a.y)
    }
  }
  assert.deepEqual(layout(nodes, 'R', 24, 42), layout(nodes, 'R', 24, 42))
  assert.notDeepEqual(layout(nodes, 'R', 24, 42), layout(nodes, 'R', 24, 43))
})
test('group, layer and history operations preserve IDs, edges and later edits', () => {
  const canvas = mixedCanvas(), history = new CanvasHistory()
  const grouped = history.prepare(canvas, groupOperations(canvas.nodes.slice(0, 2), 'g'))
  history.accept(grouped)
  assert.equal(grouped.after.nodes.find(n => n.id === 'n0')?.ready.groupId, 'g')
  assert.ok(bounds(grouped.after.nodes.slice(0, 2)).width > 0)
  const undo = history.prepareUndo(grouped.after)!
  assert.deepEqual(undo.after, canvas)
  assert.deepEqual(applyCanvasInverse(undo.after, undo.inverse), grouped.after)
  history.accept(undo)
  const redo = history.prepareRedo(canvas)!
  assert.deepEqual(redo.after, grouped.after); history.accept(redo)
  const edited = applyCanvasOperations(redo.after, [{ type: 'geometry', id: 'n0', geometry: { x: 123 } }]).canvas
  assert.throws(() => history.prepareUndo(edited), /conflict/)
  const front = applyCanvasOperations(canvas, layerOperations(canvas, ['n0'], 'front')).canvas
  assert.equal(front.nodes.at(-1)?.id, 'n0'); assert.deepEqual(front.edges, canvas.edges)
})

test('negative arrows retain their visible frame and edge endpoints honor standard sides', async () => {
  const { cardFrame, visualBounds } = await import('../renderer/modules/canvas/interaction/graphics')
  const { edgePath } = await import('../renderer/modules/canvas/interaction/gestures')
  const node = { id: 'arrow', type: 'file' as const, file: 'Lab.assets/a.svg', x: 100, y: 100, width: 100, height: 50,
    ready: { kind: 'graphic' as const, graphic: { type: 'arrow' as const, x2: -100, y2: -50, stroke: '#ff5a1f', strokeWidth: 2 } } }
  assert.deepEqual(cardFrame(node), { x: -12, y: 38, width: 124, height: 74 })
  const index = new SpatialIndex([{ ...node, ...visualBounds(node) }])
  assert.equal(index.query({ x: -10, y: 40, width: 5, height: 5 })[0]?.id, 'arrow')
  assert.equal(edgePath({ x: 0, y: 0, width: 100, height: 100 }, { x: 200, y: 0, width: 100, height: 100 }, { id: 'e', fromNode: 'a', toNode: 'b', fromSide: 'bottom', toSide: 'top' }), 'M50,100 L250,0')
})
