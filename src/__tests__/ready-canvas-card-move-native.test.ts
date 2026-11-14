import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { canvasFixture, textNode } from './utils/canvas-fixture'
import { CanvasService } from '../main/modules/board-engine/canvas-service'
import { SubBoardCoordinator } from '../main/modules/board-engine/sub-boards'
import { DocumentPageService } from '../main/modules/document-pages/service'
import type { CanvasNode, ReadyCanvas } from '../shared/ready-canvas'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSScAAAAASUVORK5CYII=', 'base64')
const at = (id: string, x: number, y = 0): CanvasNode => ({ ...textNode(id), x, y })
function setup() {
  const f = canvasFixture(), pages = new DocumentPageService(f.registry, { index: async () => {} })
  const read = (path: string): ReadyCanvas => JSON.parse(readFileSync(join(f.root, path), 'utf8'))
  return { ...f, pages, boards: new SubBoardCoordinator(f.service, pages), read, ids: (path: string) => read(path).nodes.map(node => node.id) }
}
async function parent(f: ReturnType<typeof setup>) {
  mkdirSync(join(f.root, 'P.assets')); writeFileSync(join(f.root, 'P.assets/pic.png'), PNG)
  const image: CanvasNode = { id: 'img', type: 'file', file: 'P.assets/pic.png', x: 300, y: 0, width: 100, height: 100, ready: { kind: 'image' } }
  return f.service.create({ path: 'P.canvas', operationId: 'create', canvas: { nodes: [at('a', 0), image, at('stay', 900)],
    edges: [{ id: 'a-img', fromNode: 'a', toNode: 'img' }, { id: 'a-stay', fromNode: 'a', toNode: 'stay' }], ready: { schemaVersion: 1, id: 'p', title: '父画板' } } })
}

test('M4 §9.1 收进子画板 writes the child, the card and the removal as one replayable operation; attachments follow the cards', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas card moves')) return
  const f = setup()
  try {
    const p = await parent(f)
    const request = { operationId: 'collect', objectId: p.objectId, handleId: p.handleId, expectedVersion: p.version, nodeIds: ['a', 'img'], target: { kind: 'new' as const, path: 'P/子画板.canvas', title: '子画板', cardId: 'card' } }
    const result = await f.boards.moveCards(request)
    assert.equal(result.state, 'completed')
    if (result.state !== 'completed') return
    assert.deepEqual([result.move.movedNodeIds, result.move.movedEdgeIds, result.move.droppedEdgeIds, result.move.createdNodeId], [['a', 'img'], ['a-img'], ['a-stay'], 'card'])
    const board = f.read('P.canvas'), child = f.read('P/子画板.canvas'), card = board.nodes.find(node => node.id === 'card')!
    assert.deepEqual([f.ids('P.canvas'), board.edges, f.ids('P/子画板.canvas'), child.edges.map(edge => edge.id)], [['stay', 'card'], [], ['a', 'img'], ['a-img']])
    assert.deepEqual([card.ready.kind, card.type === 'file' && card.file, card.ready.ref], ['subcanvas', 'P/子画板.canvas', { kind: 'canvas', id: result.move.targetObjectId }])
    assert.equal(child.ready.title, '子画板')
    const moved = child.nodes[1]
    assert.equal(moved.type === 'file' && moved.file, 'P/子画板.assets/pic.png')
    assert.deepEqual(readFileSync(join(f.root, 'P/子画板.assets/pic.png')), PNG)
    assert.ok(existsSync(join(f.root, 'P.assets/pic.png')), 'the source attachment is never deleted')
    assert.equal(f.registry.get(result.move.targetObjectId)?.status, 'present')
    // Same id and input: the same receipt, nothing written twice. Same id, other input: refused.
    assert.deepEqual(await f.boards.moveCards(request), result)
    assert.deepEqual(await new SubBoardCoordinator(new CanvasService(f.registry, f.root), f.pages).moveCards(request), result)
    await assert.rejects(f.boards.moveCards({ ...request, nodeIds: ['stay'] }), /operation_id_reused/)
    assert.deepEqual(f.boards.summaries('p'), [{ nodeId: 'card', objectId: result.move.targetObjectId, available: true, title: '子画板', count: 2, images: ['P/子画板.assets/pic.png'] }])
    // The parent stays writable, and the inverse brings everything back and takes the empty sub-board away for good.
    const reopened = await f.service.read(p.handleId)
    assert.equal((await f.boards.write({ ...reopened, expectedVersion: reopened.version, operationId: 'later', commands: [{ type: 'geometry', id: 'stay', geometry: { y: 50 } }] })).state, 'completed')
    const undone = await f.boards.undoMove({ operationId: 'undo', moveOperationId: 'collect' })
    assert.equal(undone.state, 'completed')
    const back = f.read('P.canvas')
    assert.deepEqual([back.nodes.map(node => [node.id, node.x, node.y]), back.edges.map(edge => edge.id).sort()], [[['a', 0, 0], ['img', 300, 0], ['stay', 900, 50]], ['a-img', 'a-stay']])
    const image = back.nodes[1]
    assert.equal(image.type === 'file' && image.file, 'P.assets/pic.png')
    assert.equal(existsSync(join(f.root, 'P/子画板.canvas')), false)
    assert.equal(f.registry.get(result.move.targetObjectId)?.status, 'deleted')
    assert.deepEqual(f.pages.trash(f.root), [], 'an undone empty sub-board is not left in the library bin')
    assert.deepEqual(await f.boards.undoMove({ operationId: 'undo', moveOperationId: 'collect' }), undone)
    await assert.rejects(f.boards.undoMove({ operationId: 'undo-again', moveOperationId: 'collect' }), /canvas is unavailable|nothing_to_undo/)
  } finally { f.close() }
})

test('M4 §9.1 cards move into an existing sub-board and back out; conflicts change neither file', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas card moves')) return
  const f = setup()
  try {
    let p = await parent(f)
    const made = await f.boards.moveCards({ operationId: 'collect', objectId: 'p', handleId: p.handleId, expectedVersion: p.version, nodeIds: ['img'], target: { kind: 'new', path: 'P/C.canvas', title: 'C', cardId: 'card' } })
    assert.equal(made.state, 'completed'); if (made.state !== 'completed') return
    const childId = made.move.targetObjectId
    const stale = await f.boards.moveCards({ operationId: 'stale', objectId: 'p', handleId: p.handleId, expectedVersion: p.version, nodeIds: ['a'], target: { kind: 'existing', objectId: childId } })
    assert.equal(stale.state === 'conflict' && stale.conflict.code, 'version_conflict')
    p = await f.service.read(p.handleId)
    // Drag onto the sub-board card: the card lands beside what the sub-board already holds.
    const into = await f.boards.moveCards({ operationId: 'into', objectId: 'p', handleId: p.handleId, expectedVersion: p.version, nodeIds: ['a'], target: { kind: 'existing', objectId: childId } })
    assert.equal(into.state, 'completed')
    assert.deepEqual([f.ids('P.canvas'), f.read('P/C.canvas').nodes.map(node => [node.id, node.x, node.y])], [['stay', 'card'], [['img', 0, 0], ['a', 148, 0]]])
    // 移出到上一级 from inside the sub-board: beside its card on the parent.
    let c = await f.service.open(childId)
    const out = await f.boards.moveCards({ operationId: 'out', objectId: childId, handleId: c.handleId, expectedVersion: c.version, nodeIds: ['a', 'img'], target: { kind: 'existing', objectId: 'p' } })
    assert.equal(out.state, 'completed')
    const card = f.read('P.canvas').nodes.find(node => node.id === 'card')!
    const landed = f.read('P.canvas').nodes.filter(node => ['a', 'img'].includes(node.id))
    assert.deepEqual([f.ids('P/C.canvas'), landed.map(node => node.id)], [[], ['img', 'a']])
    assert.ok(landed.every(node => node.x >= card.x + card.width + 48), 'beside the sub-board card')
    assert.equal(landed[0].type === 'file' && landed[0].file, 'P.assets/pic.png', 'the attachment that is already on the parent is reused')
    // Undo of the move out after the parent changed: the cards go back in, the later card stays.
    p = await f.service.read(p.handleId)
    assert.equal((await f.boards.write({ ...p, expectedVersion: p.version, operationId: 'add', commands: [{ type: 'addNode', node: at('later', 0, 900) }] })).state, 'completed')
    assert.equal((await f.boards.undoMove({ operationId: 'undo-out', moveOperationId: 'out' })).state, 'completed')
    assert.deepEqual([f.ids('P.canvas'), f.ids('P/C.canvas')], [['stay', 'card', 'later'], ['img', 'a']])
    // Boards that are not parent and child, an unsaved buffer on the other board, a stale handle: refused, files untouched.
    const other = await f.service.create({ path: 'Other.canvas', operationId: 'other' })
    p = await f.service.read(p.handleId); c = await f.service.read(c.handleId)
    const before = [readFileSync(join(f.root, 'P.canvas'), 'utf8'), readFileSync(join(f.root, 'P/C.canvas'), 'utf8')]
    await assert.rejects(f.boards.moveCards({ operationId: 'unrelated', objectId: 'p', handleId: p.handleId, expectedVersion: p.version, nodeIds: ['stay'], target: { kind: 'existing', objectId: other.objectId } }), /identity_conflict/)
    await assert.rejects(f.boards.moveCards({ operationId: 'handle', objectId: 'p', handleId: c.handleId, expectedVersion: p.version, nodeIds: ['stay'], target: { kind: 'existing', objectId: childId } }), /handle/)
    await assert.rejects(f.boards.moveCards({ operationId: 'outside', objectId: 'p', handleId: p.handleId, expectedVersion: p.version, nodeIds: ['stay'], target: { kind: 'new', path: 'Elsewhere.canvas', title: 'x', cardId: 'x' } }), /outside parent/)
    const dirty = structuredClone(c.canvas); dirty.nodes[0].x = 77
    f.service.updateBuffer({ objectId: childId, tabId: 'tab', openGeneration: 1, bufferVersion: 1, baseVersion: c.version, canvas: dirty })
    const blocked = await f.boards.moveCards({ operationId: 'dirty', objectId: 'p', handleId: p.handleId, expectedVersion: p.version, nodeIds: ['stay'], target: { kind: 'existing', objectId: childId } })
    assert.equal(blocked.state === 'conflict' && blocked.conflict.code, 'version_conflict')
    assert.deepEqual([readFileSync(join(f.root, 'P.canvas'), 'utf8'), readFileSync(join(f.root, 'P/C.canvas'), 'utf8')], before)
  } finally { f.close() }
})

test('M4 §9.1 an interruption between the two files leaves the cards on both boards, and recovery finishes the same move', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas card moves')) return
  const f = setup()
  try {
    const p = await parent(f)
    const made = await f.boards.moveCards({ operationId: 'collect', objectId: 'p', handleId: p.handleId, expectedVersion: p.version, nodeIds: ['img'], target: { kind: 'new', path: 'P/C.canvas', title: 'C', cardId: 'card' } })
    assert.equal(made.state, 'completed'); if (made.state !== 'completed') return
    let failed = false
    const failing = new CanvasService(f.registry, f.root, { publish: async () => { failed = true; throw new Error('injected interruption') } })
    const opened = await failing.open('p')
    const request = { operationId: 'into', objectId: 'p', handleId: opened.handleId, expectedVersion: opened.version, nodeIds: ['a'], target: { kind: 'existing' as const, objectId: made.move.targetObjectId } }
    const interrupted = await new SubBoardCoordinator(failing, f.pages).moveCards(request)
    assert.equal(failed, true)
    assert.equal(interrupted.state, 'recovery-required')
    assert.ok(f.ids('P.canvas').includes('a') && f.ids('P/C.canvas').includes('a'), 'never on neither board')
    const restarted = new CanvasService(f.registry, f.root)
    assert.deepEqual((await restarted.recover()).map(result => result.state), ['completed'])
    assert.deepEqual([f.ids('P.canvas'), f.ids('P/C.canvas')], [['stay', 'card'], ['img', 'a']])
    const replay = await new SubBoardCoordinator(restarted, f.pages).moveCards({ ...request, handleId: 'expired' })
    assert.equal(replay.state === 'completed' && replay.move.movedNodeIds[0], 'a')
  } finally { f.close() }
})
