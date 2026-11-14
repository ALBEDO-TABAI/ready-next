import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { canvasFixture, textNode } from './utils/canvas-fixture'
import { SubBoardCoordinator } from '../main/modules/board-engine/sub-boards'
import { importStillroomSpace } from '../main/modules/board-engine/stillroom-entry'
import { CanvasImportService } from '../main/modules/canvas-import/service'
import { DocumentPageService } from '../main/modules/document-pages/service'
import type { CanvasCommand, CanvasNode, ReadyCanvas } from '../shared/ready-canvas'

const TRASH = { operationId: 'bin', deletedAt: '2026-11-14T00:00:00.000Z' }
async function setup() {
  const f = canvasFixture(), pages = new DocumentPageService(f.registry, { index: async () => {} }), boards = new SubBoardCoordinator(f.service, pages)
  const handle = await f.service.create({ path: 'P.canvas', operationId: 'create', canvas: { nodes: [textNode('a')], edges: [], ready: { schemaVersion: 1, id: 'p' } } })
  let step = 0
  /** One board write through the coordinator, as the renderer sends it. */
  const write = async (commands: CanvasCommand[]) => {
    const current = await f.service.read(handle.handleId)
    return boards.write({ objectId: 'p', handleId: handle.handleId, expectedVersion: current.version, operationId: `write-${++step}`, commands })
  }
  const card: CanvasNode = { id: 'card', type: 'file', file: 'P/C.canvas', x: 400, y: 0, width: 260, height: 195, ready: { kind: 'subcanvas', ref: { kind: 'canvas', id: 'c' } } }
  const child: ReadyCanvas = { nodes: [textNode('inside')], edges: [], ready: { schemaVersion: 1, id: 'c', title: 'C' } }
  assert.equal((await write([{ type: 'createSubcanvas', path: 'P/C.canvas', canvas: child, node: card }])).state, 'completed')
  const read = (): ReadyCanvas => JSON.parse(readFileSync(join(f.root, 'P.canvas'), 'utf8'))
  return { ...f, pages, boards, write, read, card, here: () => existsSync(join(f.root, 'P/C.canvas')), status: () => f.registry.get('c')?.status }
}

test('M4 §9.3 a sub-board file goes to the library bin with its card and comes back with it, content intact', async t => {
  if (skipIfSqliteUnavailable(t, 'sub-board lifecycle')) return
  const f = await setup()
  try {
    assert.equal((await f.write([{ type: 'trash', ids: ['card'], trash: TRASH }])).state, 'completed')
    assert.deepEqual([f.here(), f.status(), f.pages.trash(f.root).map(item => item.objectId)], [false, 'trashed', ['c']])
    // The parent stays writable while the card is in its bin, and the card shows no sub-board to open.
    assert.equal((await f.write([{ type: 'geometry', id: 'a', geometry: { x: 10 } }])).state, 'completed')
    assert.deepEqual(f.boards.summaries('p'), [])
    assert.equal((await f.write([{ type: 'restore', ids: ['card'] }])).state, 'completed')
    assert.deepEqual([f.here(), f.status(), f.pages.trash(f.root)], [true, 'present', []])
    assert.equal(JSON.parse(readFileSync(join(f.root, 'P/C.canvas'), 'utf8')).nodes[0].id, 'inside')
    assert.equal(f.boards.summaries('p')[0].count, 1)
    // ⌘Z of a delete arrives as a snapshot (remove + add): the file follows the card's state, not the operation's name.
    assert.equal((await f.write([{ type: 'trash', ids: ['card'], trash: TRASH }])).state, 'completed')
    assert.equal(f.status(), 'trashed')
    assert.equal((await f.write([{ type: 'deleteNode', id: 'card' }, { type: 'addNode', node: f.card }])).state, 'completed')
    assert.deepEqual([f.here(), f.status()], [true, 'present'])
  } finally { f.close() }
})

test('M4 §9.3 removing the card recycles the file; a purged card leaves it in the library bin; an occupied place blocks the restore', async t => {
  if (skipIfSqliteUnavailable(t, 'sub-board lifecycle')) return
  const f = await setup()
  try {
    // Undo of 新建子画板 takes the card off the board: the file must not stay behind without a card.
    assert.equal((await f.write([{ type: 'deleteNode', id: 'card' }])).state, 'completed')
    assert.deepEqual([f.here(), f.status()], [false, 'trashed'])
    assert.equal((await f.write([{ type: 'addNode', node: f.card }])).state, 'completed')
    assert.deepEqual([f.here(), f.status()], [true, 'present'])
    assert.equal((await f.write([{ type: 'trash', ids: ['card'], trash: TRASH }])).state, 'completed')
    // Something else took the name meanwhile: the card cannot come back, and the board is not changed.
    writeFileSync(join(f.root, 'P/C.canvas'), JSON.stringify({ nodes: [], edges: [], ready: { schemaVersion: 1, id: 'squatter' } }))
    const before = readFileSync(join(f.root, 'P.canvas'), 'utf8')
    await assert.rejects(f.write([{ type: 'restore', ids: ['card'] }]), /子画板文件无法恢复到原位置/)
    assert.equal(readFileSync(join(f.root, 'P.canvas'), 'utf8'), before)
    assert.equal((await f.write([{ type: 'purge', ids: ['card'] }])).state, 'completed')
    assert.deepEqual([f.read().nodes.map(node => node.id), f.status(), f.pages.trash(f.root).map(item => item.objectId)], [['a'], 'trashed', ['c']])
  } finally { f.close() }
})

test('M4 §9.3 a recycle the app did not get to is finished at startup, once', async t => {
  if (skipIfSqliteUnavailable(t, 'sub-board lifecycle')) return
  const f = await setup()
  try {
    // The board write completed, then the app stopped before the file was recycled.
    const current = await f.service.open('p')
    assert.equal((await f.service.write({ ...current, expectedVersion: current.version, operationId: 'interrupted', commands: [{ type: 'trash', ids: ['card'], trash: TRASH }] })).state, 'completed')
    assert.equal(f.status(), 'present')
    const restarted = new SubBoardCoordinator(f.service, f.pages)
    await restarted.recover()
    assert.deepEqual([f.here(), f.status()], [false, 'trashed'])
    // The person takes the sub-board back from the library bin as a board of its own: recovery leaves it alone.
    await f.pages.operate({ type: 'restore', root: f.root, objectId: 'c', operationId: 'by-hand' })
    await restarted.recover()
    assert.deepEqual([f.here(), f.status()], [true, 'present'])
    // Bringing the card back then finds the file already in place.
    assert.equal((await f.write([{ type: 'restore', ids: ['card'] }])).state, 'completed')
    assert.equal(f.boards.summaries('p')[0].available, true)
    // The other way round — the sub-board recycled from the library while its card is on the board: the board stays
    // writable, the card says the sub-board is away, and it works again once the file is back.
    await f.pages.operate({ type: 'trash', root: f.root, objectId: 'c', operationId: 'from-sidebar' })
    assert.equal((await f.write([{ type: 'geometry', id: 'a', geometry: { x: 33 } }])).state, 'completed')
    assert.equal(f.boards.summaries('p')[0].available, false)
    await f.pages.operate({ type: 'restore', root: f.root, objectId: 'c', operationId: 'from-sidebar-back' })
    assert.equal(f.boards.summaries('p')[0].available, true)
  } finally { f.close() }
})

test('M4 §9.4 a Stillroom space comes in as a sub-board of the open board, with the import receipt', async t => {
  if (skipIfSqliteUnavailable(t, 'Stillroom entry')) return
  const f = await setup()
  try {
    const note = { id: 'folder', type: 'folder', title: 'Folder', text: '', createdAt: 1, updatedAt: 1, canvasX: 0, canvasY: 0, parentId: null, deletedAt: null, metadata: {} }
    const zip = new JSZip(); zip.file('space.json', JSON.stringify({ app: 'stillroom', version: 1, notes: [note, { ...note, id: 'text', type: 'text', text: '<p>hello</p>', parentId: 'folder' }] }))
    const sourcePath = join(f.root, `space-${Date.now()}.zip`); writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }))
    const imports = new CanvasImportService(f.service), current = await f.service.open('p')
    const result = await importStillroomSpace({ canvas: f.service, imports, subBoards: f.boards }, { operationId: 'import', objectId: 'p', handleId: current.handleId, expectedVersion: current.version, at: { x: 0, y: 600 }, sourcePath })
    assert.deepEqual([result.receipt.status, result.card.state], ['complete', 'completed'])
    assert.match(result.receipt.path, /^P\/space-\d+\.canvas$/)
    const placed = f.read().nodes.find(node => node.id === result.nodeId)!
    assert.deepEqual([placed.ready.kind, placed.type === 'file' && placed.file, placed.ready.ref], ['subcanvas', result.receipt.path, { kind: 'canvas', id: result.receipt.objectId }])
    const space: ReadyCanvas = JSON.parse(readFileSync(join(f.root, result.receipt.path), 'utf8'))
    assert.equal(space.nodes[0].ready.kind, 'subcanvas', 'the Stillroom folder is a sub-board of the imported space')
    assert.equal(f.boards.summaries('p').find(item => item.nodeId === result.nodeId)?.available, true)
  } finally { f.close() }
})
