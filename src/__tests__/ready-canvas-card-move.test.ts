import test from 'node:test'
import assert from 'node:assert/strict'
import { planCardMove, planCardMoveUndo, subBoardEffects, type CanvasNode, type ReadyCanvas } from '../shared/ready-canvas'

const text = (id: string, x: number, y: number, ready: Partial<CanvasNode['ready']> = {}): CanvasNode => ({ id, type: 'text', text: id, x, y, width: 200, height: 100, ready: { kind: 'text', ...ready } })
const board = (id: string, nodes: CanvasNode[] = [], edges: ReadyCanvas['edges'] = []): ReadyCanvas => ({ nodes, edges, ready: { schemaVersion: 1, id } })
const subcard = (id: string, child: string, x = 0, y = 0): CanvasNode => ({ id, type: 'file', file: `P/${child}.canvas`, x, y, width: 260, height: 195, ready: { kind: 'subcanvas', ref: { kind: 'canvas', id: child } } })

test('M4 §9.1 a move keeps layout and order, takes inner edges along and drops the ones that would cross boards', () => {
  const source = board('p', [text('a', 100, 100), text('b', 400, 160), text('c', 900, 100), text('gone', 0, 0, { trash: { operationId: 'x', deletedAt: '2026-01-01T00:00:00.000Z' } })],
    [{ id: 'ab', fromNode: 'a', toNode: 'b' }, { id: 'bc', fromNode: 'b', toNode: 'c' }])
  const plan = planCardMove({ source, target: board('c'), nodeIds: ['b', 'a', 'gone', 'nope'], placement: { kind: 'origin' } })
  assert.deepEqual(plan.movedNodeIds, ['a', 'b'], 'board order, not selection order')
  assert.deepEqual([plan.movedEdgeIds, plan.droppedEdgeIds], [['ab'], ['bc']])
  assert.deepEqual(plan.skipped.map(item => item.reason).sort(), ['missing', 'trashed'])
  assert.deepEqual(plan.source.nodes.map(node => node.id), ['c', 'gone'])
  assert.deepEqual(plan.source.edges, [])
  assert.deepEqual(plan.target.nodes.map(node => [node.id, node.x, node.y]), [['a', 0, 0], ['b', 300, 60]])
  assert.deepEqual(plan.target.edges.map(edge => edge.id), ['ab'])
})

test('M4 §9.1 a chosen group brings its members; memberships that would cross boards are cleared on both sides', () => {
  const group: CanvasNode = { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 300, ready: { kind: 'group' } }
  const source = board('p', [group, text('in', 20, 20, { groupId: 'g' }), text('lonely', 600, 0, { groupId: 'g' }), text('docked', 0, 400, { dock: { left: 'in', top: 'stay' } }), text('stay', 0, 600), subcard('sub', 'child', 800, 0)])
  const all = planCardMove({ source, target: board('c'), nodeIds: ['g', 'sub'], placement: { kind: 'origin' } })
  assert.deepEqual(all.movedNodeIds, ['g', 'in', 'lonely'])
  assert.deepEqual(all.skipped, [{ id: 'sub', reason: 'subcanvas' }], 'a sub-board card does not change parents')
  assert.equal(all.target.nodes.find(node => node.id === 'in')!.ready.groupId, 'g')
  assert.deepEqual(all.source.nodes.find(node => node.id === 'docked')!.ready.dock, { top: 'stay' })
  const member = planCardMove({ source, target: board('c'), nodeIds: ['in'], placement: { kind: 'origin' } })
  assert.equal(member.target.nodes[0].ready.groupId, undefined, 'a member that leaves alone leaves its group')
  assert.throws(() => planCardMove({ source, target: board('c'), nodeIds: ['sub'], placement: { kind: 'origin' } }), /nothing_to_move/)
  assert.throws(() => planCardMove({ source, target: board('c', [text('in', 0, 0)]), nodeIds: ['in'], placement: { kind: 'origin' } }), /identity_conflict/)
})

test('M4 §9.1 cards join an existing sub-board beside its content and leave it beside its card, past what is in the way', () => {
  const into = planCardMove({ source: board('p', [text('a', 50, 50)]), target: board('c', [text('x', 10, 20), text('y', 300, 400)]), nodeIds: ['a'], placement: { kind: 'beside-content' } })
  assert.deepEqual([into.target.nodes[2].x, into.target.nodes[2].y], [548, 20])
  const parent = board('p', [subcard('card', 'c', 0, 0), text('block', 308, 0), text('far', 2000, 0)])
  const out = planCardMove({ source: board('c', [text('a', 7, 7), text('b', 7, 207)]), target: parent, nodeIds: ['a', 'b'], placement: { kind: 'beside-node', nodeId: 'card' } })
  assert.deepEqual(out.target.nodes.slice(-2).map(node => [node.x, node.y]), [[556, 0], [556, 200]])
  const moved = planCardMove({ source: board('p', [{ id: 'img', type: 'file', file: 'P.assets/a.png', x: 0, y: 0, width: 10, height: 10, ready: { kind: 'image' } }, text('md', 0, 50)].map(node => node.id === 'md' ? { ...node, text: '![x](P.assets/b.png)' } as CanvasNode : node as CanvasNode)),
    target: board('c'), nodeIds: ['img', 'md'], placement: { kind: 'origin' }, rehome: path => path.replace(/^P\.assets\//, 'P/C.assets/') })
  assert.deepEqual(moved.target.nodes.map(node => node.type === 'file' ? node.file : node.type === 'text' ? node.text : ''), ['P/C.assets/a.png', '![x](P/C.assets/b.png)'])
})

test('M4 §9.2 the inverse moves back what is still there, with later edits, and restores edges whose ends exist again', () => {
  const original = board('p', [text('a', 100, 100), text('b', 400, 160, { dock: { left: 'a' } }), text('c', 900, 100)], [{ id: 'ab', fromNode: 'a', toNode: 'b' }, { id: 'bc', fromNode: 'b', toNode: 'c' }])
  const child = board('c', [text('x', 0, 0)])
  const move = planCardMove({ source: original, target: child, nodeIds: ['a', 'b'], placement: { kind: 'beside-content' } })
  const detail = { targetObjectId: 'c', movedNodeIds: move.movedNodeIds, movedEdgeIds: move.movedEdgeIds, droppedEdgeIds: move.droppedEdgeIds, skipped: move.skipped }
  // Later: one card was edited on the sub-board, a new edge was drawn to a card that stays, the parent got a new card.
  const later = structuredClone(move.target)
  const edited = later.nodes.find(node => node.id === 'a')!; if (edited.type === 'text') edited.text = 'edited'
  later.edges.push({ id: 'ax', fromNode: 'a', toNode: 'x' })
  const parentLater = { ...move.source, nodes: [...move.source.nodes, text('new', 0, 900)] }
  const undo = planCardMoveUndo({ source: parentLater, target: later, original, detail })
  assert.deepEqual(undo.source.nodes.map(node => [node.id, node.x, node.y]), [['a', 100, 100], ['b', 400, 160], ['c', 900, 100], ['new', 0, 900]])
  assert.equal((undo.source.nodes[0] as { text: string }).text, 'edited')
  assert.deepEqual(undo.source.nodes[1].ready.dock, { left: 'a' })
  assert.deepEqual(undo.source.edges.map(edge => edge.id).sort(), ['ab', 'bc'])
  assert.deepEqual([undo.target.nodes.map(node => node.id), undo.target.edges], [['x'], []])
  assert.equal(undo.removedCard, false)
  assert.throws(() => planCardMoveUndo({ source: undo.source, target: undo.target, original, detail }), /nothing_to_undo/)
  // A card purged on the sub-board stays gone; the edge that needed it is not restored.
  const purged = { ...move.target, nodes: move.target.nodes.filter(node => node.id !== 'a').map(node => node.id === 'b' ? { ...node, ready: { kind: 'text' as const } } : node), edges: [] }
  const partial = planCardMoveUndo({ source: move.source, target: purged, original, detail })
  assert.deepEqual(partial.source.nodes.map(node => node.id), ['b', 'c'])
  assert.deepEqual([partial.source.edges.map(edge => edge.id), partial.source.nodes[0].ready.dock], [['bc'], undefined])
})

test('M4 §9.2 undoing 收进子画板 removes the card only when the sub-board is empty again', () => {
  const original = board('p', [text('a', 0, 0), text('b', 300, 0)])
  const move = planCardMove({ source: original, target: board('c'), nodeIds: ['a'], placement: { kind: 'origin' } })
  const withCard = { ...move.source, nodes: [...move.source.nodes, subcard('card', 'c'), text('d', 0, 500, { dock: { top: 'card' } })], edges: [{ id: 'e', fromNode: 'b', toNode: 'card' }] }
  const detail = { targetObjectId: 'c', movedNodeIds: ['a'], movedEdgeIds: [], droppedEdgeIds: [], skipped: [], createdNodeId: 'card' }
  const empty = planCardMoveUndo({ source: withCard, target: move.target, original, detail })
  assert.equal(empty.removedCard, true)
  assert.deepEqual([empty.source.nodes.map(node => node.id), empty.source.edges, empty.source.nodes[2].ready.dock], [['a', 'b', 'd'], [], undefined])
  const kept = planCardMoveUndo({ source: withCard, target: { ...move.target, nodes: [...move.target.nodes, text('other', 900, 0)] }, original, detail })
  assert.equal(kept.removedCard, false)
  assert.ok(kept.source.nodes.some(node => node.id === 'card'))
})

test('M4 §9.3 a sub-board file follows its card: restored before the card is active, recycled after it leaves', () => {
  const trash = { operationId: 't', deletedAt: '2026-01-01T00:00:00.000Z' }
  const active = board('p', [subcard('card', 'c')]), binned = board('p', [{ ...subcard('card', 'c'), ready: { ...subcard('card', 'c').ready, trash } }])
  assert.deepEqual(subBoardEffects(active, binned), { restore: [], trash: ['c'] })
  assert.deepEqual(subBoardEffects(binned, active), { restore: ['c'], trash: [] })
  assert.deepEqual(subBoardEffects(active, board('p')), { restore: [], trash: ['c'] }, 'removing the card (undo of 新建) recycles the file too')
  assert.deepEqual(subBoardEffects(binned, board('p')), { restore: [], trash: [] }, 'purging a binned card leaves the file in the library bin')
  assert.deepEqual(subBoardEffects(board('p'), active), { restore: ['c'], trash: [] })
  assert.deepEqual(subBoardEffects(active, { ...active, nodes: [{ ...active.nodes[0], x: 40 }] }), { restore: [], trash: [] })
})
