import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations } from '../main/modules/migrations'
import { FastCardRepository } from '../main/modules/repositories/fastcard-repository'
import { FastCardMediaCache } from '../main/modules/fastcard/media-cache'
import { FastCardTransferService, type FastCardBoardPort } from '../main/modules/fastcard/transfer-service'
import { applyCanvasOperations, serializeCanvas, ReadyCanvasSchema, type CanvasReceipt } from '../shared/ready-canvas'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
// B is not merged: this port uses real files and A's validator/operations, not the B implementation.
function fileBoards(root: string) {
  let failAfterWrite = false
  let failBeforeWrite = false
  const port: FastCardBoardPort = {
    async list() { return ['chosen', '灵感'].filter(id => existsSync(join(root, `${id}.canvas`))).map(id => ({ objectId: id, title: id })) },
    async create(input) {
      const path = join(root, `${input.objectId}.canvas`)
      if (!existsSync(path)) writeFileSync(path, serializeCanvas({ nodes: [], edges: [], ready: { schemaVersion: 1, id: input.objectId, title: input.title } }))
      return { objectId: input.objectId, title: input.title }
    },
    async open(objectId) {
      const relativePath = `${objectId}.canvas`
      const bytes = readFileSync(join(root, relativePath), 'utf8')
      const canvas = ReadyCanvasSchema.parse(JSON.parse(bytes))
      return { objectId, title: canvas.ready.title || objectId, handleId: objectId, libraryRoot: root, relativePath, version: hash(bytes), canvas }
    },
    async apply(request) {
      if (failBeforeWrite) { failBeforeWrite = false; throw new Error('interrupted before publish') }
      const receiptPath = join(root, `${request.operationId}.receipt`)
      if (existsSync(receiptPath)) return JSON.parse(readFileSync(receiptPath, 'utf8')) as CanvasReceipt
      const current = await port.open(request.objectId)
      assert.equal(request.expectedVersion, current.version)
      const operations = request.commands.map(command => {
        if (command.type !== 'addNode' && command.type !== 'deleteNode') throw new Error('Unsupported test handle command')
        return command
      })
      const canvas = applyCanvasOperations(current.canvas, operations).canvas
      const bytes = serializeCanvas(canvas)
      writeFileSync(join(root, current.relativePath), bytes)
      const receipt: CanvasReceipt = { state: 'completed', operationId: request.operationId, objectId: request.objectId,
        beforeVersion: current.version, afterVersion: hash(bytes), affectedNodeIds: request.commands.map(c => 'node' in c ? c.node.id : 'id' in c ? c.id : ''), attachments: [] }
      writeFileSync(receiptPath, JSON.stringify(receipt))
      if (failAfterWrite) { failAfterWrite = false; throw new Error('interrupted after publish') }
      return receipt
    },
  }
  return { port, interruptBefore: () => { failBeforeWrite = true }, interrupt: () => { failAfterWrite = true } }
}

test('C13 explicit/new/default targets, cached offline media, retry, duplicate, undo and conflict', async t => {
  if (skipIfSqliteUnavailable(t, 'FastCard canvas transfer')) return
  const root = mkdtempSync(join(tmpdir(), 'fastcard-transfer-'))
  const db = new Database(join(root, 'ready.db'))
  try {
    runMigrations(db)
    const repository = new FastCardRepository(db)
    const cache = new FastCardMediaCache(root, async () => { throw new Error('offline') })
    const { port, interrupt } = fileBoards(root)
    const service = () => new FastCardTransferService('library', repository, cache, port)
    await port.create({ objectId: 'chosen', title: 'chosen', operationId: 'create' })
    repository.add({ id: 'image', kind: 'image', createdAt: 1, imageUrl: 'https://expired.example/a', media: cache.save(png, 'image/png'), source: { pageUrl: 'https://example.com', pageTitle: '出处' } })
    const request = { operationId: 'save-1', itemIds: ['image'], target: { kind: 'existing' as const, objectId: 'chosen' } }
    interrupt()
    await assert.rejects(service().transfer(request), /interrupted/)
    assert.equal(repository.list().length, 1)
    const saved = await service().transfer(request)
    assert.equal(repository.list().length, 0)
    assert.deepEqual(await service().transfer(request), saved)
    const board = await port.open('chosen')
    assert.equal(board.canvas.nodes.length, 1)
    const node = board.canvas.nodes[0]
    assert.equal(node.ready.sources?.[0].uri, 'https://example.com')
    assert.equal(node.type, 'file')
    if (node.type === 'file') assert.deepEqual(readFileSync(join(root, node.file)), png)
    await assert.rejects(service().transfer({ ...request, itemIds: ['changed'] }), /operation/)
    repository.add({ id: 'later', kind: 'text', text: 'new collection', createdAt: 5 })
    await service().undo('save-1')
    assert.equal((await port.open('chosen')).canvas.nodes.length, 0)
    assert.deepEqual(repository.list().map(item => item.id), ['later', 'image'])
    assert.equal((await service().undo('save-1')).state, 'undone')
    const again = await service().transfer({ operationId: 'save-2', itemIds: ['image'] })
    assert.equal(again.objectId, 'chosen')
    const edited = await port.open('chosen'); edited.canvas.nodes[0].x++
    writeFileSync(join(root, edited.relativePath), serializeCanvas(edited.canvas))
    await assert.rejects(service().undo('save-2'), /conflict/)
    repository.add({ id: 'text', kind: 'text', text: 'hello', createdAt: 2 })
    const fresh = await service().transfer({ operationId: 'new', itemIds: ['text'], target: { kind: 'new', title: '新画板' } })
    assert.equal((await port.open(fresh.objectId)).canvas.ready.title, '新画板')
    repository.add({ id: 'default', kind: 'text', text: 'default', createdAt: 3 })
    const defaultService = new FastCardTransferService('another-library', repository, cache, port)
    const fallback = await defaultService.transfer({ operationId: 'default', itemIds: ['default'] })
    assert.equal((await port.open(fallback.objectId)).canvas.ready.title, '灵感')
    repository.add({ id: 'unavailable', kind: 'text', createdAt: 4 })
    rmSync(join(root, `${fresh.objectId}.canvas`))
    await assert.rejects(service().transfer({ operationId: 'unavailable', itemIds: ['unavailable'] }), /目标.*不可用/)
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})

test('C13 receipt and removal rollback together; restart finishes without another insertion', async t => {
  if (skipIfSqliteUnavailable(t, 'FastCard transfer recovery')) return
  const root = mkdtempSync(join(tmpdir(), 'fastcard-recovery-'))
  const db = new Database(join(root, 'ready.db'))
  try {
    runMigrations(db)
    const repository = new FastCardRepository(db), cache = new FastCardMediaCache(root)
    const { port } = fileBoards(root)
    repository.add({ id: 'text', kind: 'text', text: 'keep me', createdAt: 1 })
    db.exec("CREATE TRIGGER fail_remove BEFORE DELETE ON fastcard_items BEGIN SELECT RAISE(ABORT, 'removal failed'); END")
    const request = { operationId: 'recover', itemIds: ['text'] }
    await assert.rejects(new FastCardTransferService('lib', repository, cache, port).transfer(request), /removal failed/)
    assert.equal(repository.list().length, 1)
    assert.throws(() => repository.clear(), /转存/)
    db.exec('DROP TRIGGER fail_remove')
    const restarted = new FastCardTransferService('lib', new FastCardRepository(db), cache, port)
    const receipt = await restarted.transfer(request)
    assert.equal((await port.open(receipt.objectId)).canvas.nodes.length, 1)
    assert.equal(repository.list().length, 0)
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})


test('C13 copied assets survive cache loss; restart recovers undo and restores original tray order', async t => {
  if (skipIfSqliteUnavailable(t, 'FastCard attachment and undo recovery')) return
  const root = mkdtempSync(join(tmpdir(), 'fastcard-undo-'))
  let db = new Database(join(root, 'ready.db'))
  try {
    runMigrations(db)
    let repository = new FastCardRepository(db)
    const cache = new FastCardMediaCache(root), { port, interrupt, interruptBefore } = fileBoards(root)
    repository.add({ id: 'a', kind: 'text', text: 'first', createdAt: 1 })
    repository.add({ id: 'b', kind: 'image', imageUrl: 'https://expired.example/a', createdAt: 2, media: cache.save(png, 'image/png') })
    repository.add({ id: 'c', kind: 'text', text: 'last', createdAt: 3 })
    const request = { operationId: 'copy', itemIds: ['b', 'a'], position: { x: 73, y: 41 } }
    interruptBefore()
    await assert.rejects(new FastCardTransferService('lib', repository, cache, port).transfer(request), /before publish/)
    rmSync(join(root, 'fastcard-media'), { recursive: true })
    db.close(); db = new Database(join(root, 'ready.db')); repository = new FastCardRepository(db)
    const service = new FastCardTransferService('lib', repository, cache, port)
    const [saved, duplicate] = await Promise.all([service.transfer(request), service.transfer(request)])
    assert.deepEqual(duplicate, saved)
    const nodes = (await port.open(saved.objectId)).canvas.nodes
    assert.equal(nodes.length, 2); assert.equal(nodes[0].x, 73); assert.equal(nodes[0].y, 41)
    interrupt()
    await assert.rejects(service.undo('copy'), /after publish/)
    db.close(); db = new Database(join(root, 'ready.db')); repository = new FastCardRepository(db)
    const recovered = await new FastCardTransferService('lib', repository, cache, port).recover()
    assert.deepEqual(recovered, [{ operationId: 'copy' }])
    assert.deepEqual(repository.list().map(item => item.id), ['c', 'b', 'a'])
    const restored = repository.list()[1].media
    assert.ok(restored?.status === 'cached')
    assert.deepEqual(cache.read(restored), png)
    assert.equal((await port.open(saved.objectId)).canvas.nodes.length, 0)
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
