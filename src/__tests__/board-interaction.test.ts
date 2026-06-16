import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getArrowVectorBounds,
  getBoardNodeBounds,
  getMarqueeSelectedNodeIds,
  normalizeBoardRect,
  resolveArrowEndpointDrag,
  resolveBoardSnapOffset,
} from '../renderer/components/document/boardInteraction'

test('marquee selection returns every node intersecting the dragged rectangle', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0, width: 80, height: 80 },
    { id: 'b', x: 120, y: 20, width: 80, height: 80 },
    { id: 'c', x: 260, y: 0, width: 80, height: 80 },
  ]

  const marquee = normalizeBoardRect({ x: 90, y: 0 }, { x: 220, y: 140 })

  assert.deepEqual(getMarqueeSelectedNodeIds(nodes, marquee), ['b'])
})

test('group bounds cover all selected nodes', () => {
  assert.deepEqual(getBoardNodeBounds([
    { id: 'a', x: 20, y: 10, width: 40, height: 20 },
    { id: 'b', x: -10, y: 80, width: 30, height: 50 },
  ]), { x: -10, y: 10, width: 70, height: 120 })
})

test('snap offset aligns a moving group edge to a nearby fixed node edge', () => {
  const result = resolveBoardSnapOffset({
    movingBounds: { x: 0, y: 0, width: 100, height: 80 },
    fixedNodes: [{ id: 'fixed', x: 128, y: 0, width: 100, height: 80 }],
    dx: 30,
    dy: 0,
    threshold: 8,
  })

  assert.equal(result.dx, 28)
  assert.equal(result.dy, 0)
  assert.deepEqual(result.guides, [
    { axis: 'x', value: 128 },
    { axis: 'y', value: 0 },
  ])
})

test('snap offset does not move a group when candidates are outside the threshold', () => {
  const result = resolveBoardSnapOffset({
    movingBounds: { x: 0, y: 0, width: 100, height: 80 },
    fixedNodes: [{ id: 'fixed', x: 150, y: 180, width: 100, height: 80 }],
    dx: 30,
    dy: 0,
    threshold: 8,
  })

  assert.equal(result.dx, 30)
  assert.equal(result.dy, 0)
  assert.deepEqual(result.guides, [])
})

test('arrow head drag changes the arrow vector from the fixed tail', () => {
  const result = resolveArrowEndpointDrag({
    x: 100,
    y: 80,
    width: 120,
    height: 60,
    x2: 120,
    y2: 60,
  }, 'head', 30, -90)

  assert.deepEqual(result, {
    x: 100,
    y: 80,
    width: 150,
    height: 30,
    x2: 150,
    y2: -30,
  })
  assert.deepEqual(getArrowVectorBounds(result), { x: 0, y: -30, width: 150, height: 30 })
})

test('arrow tail drag preserves the absolute arrow head', () => {
  const result = resolveArrowEndpointDrag({
    x: 100,
    y: 80,
    width: 120,
    height: 60,
    x2: 120,
    y2: 60,
  }, 'tail', 20, 10)

  assert.deepEqual(result, {
    x: 120,
    y: 90,
    width: 100,
    height: 50,
    x2: 100,
    y2: 50,
  })
  assert.equal(result.x + result.x2, 220)
  assert.equal(result.y + result.y2, 140)
})
