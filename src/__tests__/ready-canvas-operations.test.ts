import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { applyCanvasOperations, applyCanvasInverse, activeCanvasContent, ReadyCanvasSchema, serializeCanvas, type CanvasOperation } from '../shared/ready-canvas'
import { fragmentHash } from '../shared/document-blocks/positions'

const initial = () => ReadyCanvasSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/ready-canvas/valid/all-types.canvas', import.meta.url), 'utf8')))
const trash = { operationId: 'delete_new', deletedAt: '2026-10-31T00:00:00Z' }

test('each semantic operation returns an exact inverse preserving extensions and array order', () => {
  const canvas = initial()
  const cases: CanvasOperation[][] = [
    [{ type: 'addNode', node: { ...canvas.nodes[0], id: 'new' }, index: 2 }],
    [{ type: 'replaceNode', node: { ...canvas.nodes[0], x: 99 } }],
    [{ type: 'geometry', id: 'text', geometry: { x: 500, height: 20 } }],
    [{ type: 'addEdge', edge: { id: 'new-edge', fromNode: 'audio', toNode: 'video' }, index: 0 }],
    [{ type: 'replaceEdge', edge: { ...canvas.edges[0], label: 'changed' } }],
    [{ type: 'deleteEdge', id: 'edge' }],
    [{ type: 'deleteNode', id: 'image' }],
    [{ type: 'group', ids: ['text'], groupId: 'group' }],
    [{ type: 'group', ids: ['note'], groupId: null }, { type: 'deleteNode', id: 'group' }],
    [{ type: 'appearance', id: 'text', appearance: { fontScale: 2, align: 'center' } }],
    [{ type: 'appearance', id: 'note', appearance: null }],
    [{ type: 'graphic', id: 'rect', file: 'Board.assets/updated-rect.svg', graphic: { type: 'rect', fill: '#ff0000', stroke: '#000000', strokeWidth: 3 } }],
    [{ type: 'textRanges', id: 'text', expectedTextVersion: fragmentHash('第一段\r\n第二段 😀'), ranges: [{ start: 0, end: 3, expectedText: '第一段', replacement: '首段' }] }],
    [{ type: 'trash', ids: ['text', 'note'], trash }],
    [{ type: 'restore', ids: ['trashed'] }],
  ]
  for (const ops of cases) {
    const before = serializeCanvas(canvas), result = applyCanvasOperations(canvas, ops)
    assert.notEqual(serializeCanvas(result.canvas), before, ops[0].type)
    assert.equal(serializeCanvas(applyCanvasInverse(result.canvas, result.inverse)), before, ops[0].type)
    assert.equal(serializeCanvas(canvas), before, 'input remains unchanged')
  }
})

test('batch validates final graph atomically, and failed operations do not change input', () => {
  const canvas = initial(), before = serializeCanvas(canvas)
  const deleted = applyCanvasOperations(canvas, [
    { type: 'replaceNode', node: { ...canvas.nodes[1], ready: { kind: 'note', groupId: 'group' } } },
    { type: 'deleteNode', id: 'text' }, { type: 'deleteEdge', id: 'edge' }, { type: 'deleteEdge', id: 'edge-trash' },
  ])
  assert.ok(!deleted.canvas.nodes.some(n => n.id === 'text'))
  assert.equal(serializeCanvas(applyCanvasInverse(deleted.canvas, deleted.inverse)), before)
  assert.throws(() => applyCanvasOperations(canvas, [{ type: 'deleteNode', id: 'text' }]), /Dangling/)
  assert.throws(() => applyCanvasOperations(canvas, [{ type: 'geometry', id: 'text', geometry: { x: 1.2 } }]))
  assert.throws(() => applyCanvasOperations(canvas, [{ type: 'addNode', node: canvas.nodes[0] }]), /Duplicate/)
  assert.throws(() => applyCanvasOperations(canvas, [{ type: 'group', ids: ['group'], groupId: 'group' }]), /cycle/)
  assert.equal(serializeCanvas(canvas), before)
})

test('text edits retain untouched bytes and reject stale, overlapping and split-emoji ranges', () => {
  const canvas = initial(), body = '第一段\r\n第二段 😀', version = fragmentHash(body)
  const result = applyCanvasOperations(canvas, [{ type: 'textRanges', id: 'text', expectedTextVersion: version, ranges: [{ start: 0, end: 3, expectedText: '第一段', replacement: '首段' }] }])
  assert.equal(result.canvas.nodes[0].text, '首段\r\n第二段 😀')
  assert.throws(() => applyCanvasOperations(result.canvas, [{ type: 'textRanges', id: 'text', expectedTextVersion: version, ranges: [] }]), /text_conflict/)
  for (const ranges of [
    [{ start: 10, end: 10, expectedText: '', replacement: 'x' }],
    [{ start: 0, end: 2, expectedText: '第一', replacement: 'x' }, { start: 1, end: 3, expectedText: '一段', replacement: 'y' }],
    [{ start: 0, end: 3, expectedText: '错误', replacement: 'x' }],
  ]) assert.throws(() => applyCanvasOperations(canvas, [{ type: 'textRanges', id: 'text', expectedTextVersion: version, ranges }]))
})

test('trash/restore keeps IDs, hides incident edges and does not revive an independently trashed edge', () => {
  const canvas = initial()
  canvas.edges.push({ id: 'already-trashed', fromNode: 'text', toNode: 'note', ready: { trash: { ...trash, operationId: 'earlier' } } })
  const removed = applyCanvasOperations(canvas, [{ type: 'trash', ids: ['text'], trash }, { type: 'trash', ids: ['note'], trash: { ...trash, operationId: 'separate' } }]).canvas
  assert.ok(!activeCanvasContent(removed).edges.some(e => e.id === 'edge'))
  assert.deepEqual(removed.nodes.map(n => n.id), canvas.nodes.map(n => n.id))
  const one = applyCanvasOperations(removed, [{ type: 'restore', ids: ['text'] }]).canvas
  assert.ok(!activeCanvasContent(one).edges.some(e => e.id === 'edge'))
  const both = applyCanvasOperations(one, [{ type: 'restore', ids: ['note'] }]).canvas
  assert.ok(activeCanvasContent(both).edges.some(e => e.id === 'edge'))
  assert.equal(both.edges.at(-1)?.ready?.trash?.operationId, 'earlier')
})

test('inverse rejects later edits instead of erasing them', () => {
  const first = applyCanvasOperations(initial(), [{ type: 'geometry', id: 'text', geometry: { x: 10 } }])
  const later = applyCanvasOperations(first.canvas, [{ type: 'geometry', id: 'note', geometry: { y: 20 } }])
  assert.throws(() => applyCanvasInverse(later.canvas, first.inverse), /version_conflict/)
})

test('independent edge recycle and restore does not change node bodies', () => {
  const canvas = initial(), before = serializeCanvas(canvas)
  const result = applyCanvasOperations(canvas, [{ type: 'trash', ids: [], edgeIds: ['edge'], trash }])
  assert.ok(!activeCanvasContent(result.canvas).edges.some(e => e.id === 'edge'))
  const restored = applyCanvasOperations(result.canvas, [{ type: 'restore', ids: [], edgeIds: ['edge'] }]).canvas
  assert.ok(activeCanvasContent(restored).edges.some(e => e.id === 'edge'))
  assert.deepEqual(restored.nodes, canvas.nodes)
  assert.equal(serializeCanvas(applyCanvasInverse(result.canvas, result.inverse)), before)
})
