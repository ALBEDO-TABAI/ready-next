import assert from 'node:assert/strict'
import test from 'node:test'
import { segmentHitsRect, snapRect } from '../renderer/modules/canvas/interaction/geometry'
import { adaptiveDock, placementOperations, scaledPlacements, DEFAULT_FONT_SCALE } from '../renderer/modules/canvas/interaction/adaptive'
import { layerOperations } from '../renderer/modules/canvas/interaction/operations'
import { neighbour } from '../renderer/modules/canvas/interaction/navigate'
import { cardsPayload, cardsText, parseCards, pasteOperations } from '../renderer/modules/canvas/interaction/clipboard'
import { applyCanvasOperations } from '../shared/ready-canvas/operations'
import type { CanvasNode, ReadyCanvas } from '../shared/ready-canvas/schema'
import { mixedCanvas } from './fixtures/canvas-surface/mixed'

const text = (id: string, x: number, y: number, width: number, height: number): CanvasNode => ({ id, type: 'text', text: id, x, y, width, height, ready: { kind: 'text' } })

test('magnetic snap sits one gap away or lines edges up; guides only when smart guides are on', () => {
  const fixed = [{ x: 0, y: 0, width: 200, height: 100 }]
  // 20px short of "one gap to the right": inside Stillroom's 26px reach, far outside the old 6px one.
  assert.equal(snapRect({ x: 232, y: 40, width: 80, height: 80 }, fixed, 12, 26).x, 212)
  const aligned = snapRect({ x: 9, y: 300, width: 80, height: 80 }, fixed, 12, 26)
  assert.equal(aligned.x, 0); assert.equal(aligned.y, 300); assert.deepEqual(aligned.guides.map(g => [g.axis, g.value]), [['x', 0]])
  assert.deepEqual(snapRect({ x: 9, y: 300, width: 80, height: 80 }, fixed, 12, 26, false), { x: 0, y: 300, guides: [] })
  assert.equal(snapRect({ x: 260, y: 40, width: 80, height: 80 }, fixed, 12, 26).x, 260, 'out of reach stays put')
})

test('adaptive docking scales to the neighbour, is sticky, and leaves interior or mismatched cards alone', () => {
  const target = [{ id: 'o', x: 0, y: 0, width: 200, height: 200 }]
  const dock = adaptiveDock([{ id: 'm', x: 220, y: 50, width: 300, height: 100 }], target, 12, 26)!
  assert.deepEqual([dock.target, dock.side, dock.k, dock.x, dock.y], ['o', 'right', 2, 212, 0])
  assert.equal(dock.dragX, 212, 'while dragging the docking edge rests on its landing line'); assert.equal(dock.dragY, 50)
  // Held: the same target keeps hold a little beyond the plain reach; a fresh approach from there does not dock.
  const away = [{ id: 'm', x: 250, y: 50, width: 300, height: 100 }]
  assert.equal(adaptiveDock(away, target, 12, 26, dock)?.target, 'o'); assert.equal(adaptiveDock(away, target, 12, 26), null)
  // Below, it takes the neighbour's width.
  const under = adaptiveDock([{ id: 'm', x: 10, y: 215, width: 100, height: 40 }], target, 12, 26)!
  assert.deepEqual([under.side, under.k, under.x, under.y], ['bottom', 2, 0, 212])
  // No overlap on the other axis, or a scale beyond 0.25–4: no docking (plain snapping takes over).
  assert.equal(adaptiveDock([{ id: 'm', x: 220, y: 400, width: 300, height: 100 }], target, 12, 26), null)
  assert.equal(adaptiveDock([{ id: 'm', x: 220, y: 50, width: 300, height: 20 }], target, 12, 26), null)
  // In a dragged pair only the outward edge docks; the pair scales as one about its own bounds.
  const pair = [{ id: 'near', x: 220, y: 0, width: 100, height: 100 }, { id: 'far', x: 330, y: 0, width: 100, height: 100 }]
  const group = adaptiveDock(pair, target, 12, 26)!
  assert.equal(group.source, 'near'); assert.equal(group.k, 2)
  const placed = scaledPlacements([text('near', 220, 0, 100, 100), text('far', 330, 0, 100, 100)], { x: 220, y: 0 }, group, group.k)
  assert.deepEqual(placed.get('near'), { x: 212, y: 0, width: 200, height: 200, fontScale: Math.round(DEFAULT_FONT_SCALE * 2 * 10000) / 10000 })
  assert.equal(placed.get('far')!.x, 432)
})

test('scaled cards are saved as integers in one batch: text keeps pace, a drawing gets its new attachment', async () => {
  const shape: CanvasNode = { id: 'shape', type: 'file', file: 'B.assets/old.svg', x: 100, y: 0, width: 90, height: 30, ready: { kind: 'graphic', graphic: { type: 'arrow', x2: 90, y2: 30, stroke: '#000000', strokeWidth: 2 } } }
  const nodes = [text('t', 0, 0, 101, 33), shape], board: ReadyCanvas = { nodes, edges: [], ready: { id: 'b', schemaVersion: 1 } }
  const placements = scaledPlacements(nodes, { x: 0, y: 0 }, { x: 5, y: 5 }, 1.5)
  const prepared: string[] = []
  const operations = await placementOperations(nodes, placements, async draft => { prepared.push(`${draft.width}x${draft.height}`); return 'B.assets/new.svg' })
  const after = applyCanvasOperations(board, operations).canvas
  const [t, s] = after.nodes
  assert.deepEqual([t.x, t.y, t.width, t.height], [5, 5, 152, 50]); assert.equal(t.ready.appearance?.fontScale, 0.8125)
  assert.deepEqual([s.x, s.y, s.width, s.height], [155, 5, 135, 45]); assert.deepEqual(prepared, ['135x45'])
  assert.ok(s.type === 'file' && s.file === 'B.assets/new.svg' && s.ready.graphic?.type === 'arrow' && s.ready.graphic.x2 === 135)
  await assert.rejects(placementOperations(nodes, placements), /图形附件/)
})

test('a layer step trades places with the next card only; front and back still jump', () => {
  const canvas = mixedCanvas(5), order = (ops: ReturnType<typeof layerOperations>) => applyCanvasOperations(canvas, ops).canvas.nodes.map(n => n.id).join()
  assert.equal(order(layerOperations(canvas, ['n1'], 'forward')), 'n0,n2,n1,n3,n4')
  assert.equal(order(layerOperations(canvas, ['n1', 'n2'], 'forward')), 'n0,n3,n1,n2,n4')
  assert.equal(order(layerOperations(canvas, ['n3'], 'backward')), 'n0,n1,n3,n2,n4')
  assert.deepEqual(layerOperations(canvas, ['n4'], 'forward'), [], 'already on top: nothing to save')
  assert.equal(order(layerOperations(canvas, ['n1'], 'front')), 'n0,n2,n3,n4,n1')
  assert.equal(applyCanvasOperations(canvas, layerOperations(canvas, ['n1'], 'forward')).canvas.edges.length, 1)
})

test('arrow keys pick the nearest card in that direction; a marquee picks the connectors it crosses', () => {
  const cards = [text('a', 0, 0, 100, 100), text('b', 200, 20, 100, 100), text('c', 400, 0, 100, 100), text('d', 0, 300, 100, 100)]
  assert.equal(neighbour(cards, cards[0], 'right')?.id, 'b'); assert.equal(neighbour(cards, cards[1], 'right')?.id, 'c')
  assert.equal(neighbour(cards, cards[0], 'down')?.id, 'd'); assert.equal(neighbour(cards, cards[0], 'left'), undefined)
  assert.equal(segmentHitsRect({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 40, y: 40, width: 20, height: 20 }), true)
  assert.equal(segmentHitsRect({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 10, width: 20, height: 20 }), false)
})

test('copied cards paste as new cards with their connectors and groups; sub-boards and drafts are not copied', () => {
  const canvas = mixedCanvas(8)
  const grouped = applyCanvasOperations(canvas, [{ type: 'addNode', index: 0, node: { id: 'g', type: 'group', x: -20, y: -20, width: 500, height: 200, ready: { kind: 'group' } } }, { type: 'group', ids: ['n0', 'n1'], groupId: 'g' }]).canvas
  const payload = cardsPayload(grouped.nodes, grouped.edges)!
  assert.ok(!payload.nodes.some(n => n.ready.kind === 'subcanvas'), 'a sub-board has one owner')
  assert.match(cardsText(payload), /灵感 0/)
  let seq = 0
  const { operations, ids } = pasteOperations(parseCards(JSON.stringify(payload))!, { offset: { x: 24, y: 24 } }, () => `copy${seq++}`)
  const after = applyCanvasOperations(grouped, operations).canvas
  assert.equal(after.nodes.length, grouped.nodes.length + payload.nodes.length); assert.equal(ids.length, payload.nodes.length)
  const copyOf = (id: string) => after.nodes.find(n => n.id === ids[payload.nodes.findIndex(p => p.id === id)])!
  assert.deepEqual([copyOf('n0').x, copyOf('n0').y], [24, 24]); assert.equal(copyOf('n0').ready.groupId, copyOf('g').id)
  const edge = after.edges.at(-1)!
  assert.deepEqual([edge.fromNode, edge.toNode], [copyOf('n0').id, copyOf('n1').id]); assert.notEqual(edge.id, 'edge0')
  // From another board: centred where asked. Anything that is not our cards is not parsed as cards.
  const centred = pasteOperations(cardsPayload([text('x', 1000, 1000, 100, 50)], [])!, { centre: { x: 0, y: 0 } }).operations[0]
  assert.ok(centred.type === 'addNode' && centred.node.x === -50 && centred.node.y === -25)
  assert.equal(parseCards('https://example.com'), null); assert.equal(parseCards('{"kind":"other"}'), null)
})
