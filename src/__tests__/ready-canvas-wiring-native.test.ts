import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canvasFixture } from './utils/canvas-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { fastCardBoardPort } from '../main/modules/board-engine/fastcard-board-port'
import { FastCardTransferService } from '../main/modules/fastcard/transfer-service'
import { FastCardRepository } from '../main/modules/repositories/fastcard-repository'
import { FastCardMediaCache } from '../main/modules/fastcard/media-cache'
import { CanvasService } from '../main/modules/board-engine/canvas-service'
import { CanvasImportService } from '../main/modules/canvas-import/service'
import { hashBytes } from '../main/modules/document-drafts/files'

test('production FastCard adapter saves unopened/new/default canvases, reads back and undoes without duplicate cards', async t => {
  if (skipIfSqliteUnavailable(t, 'M4 production wiring')) return
  const f = canvasFixture()
  try {
    const changes: string[] = []
    const canvas = new CanvasService(f.registry, f.root, { changed: id => { changes.push(id) } })
    const repository = new FastCardRepository(f.db), cache = new FastCardMediaCache(f.root)
    const transfer = new FastCardTransferService(hashBytes(f.root), repository, cache, fastCardBoardPort(canvas))
    repository.add({ id: 'first', kind: 'text', text: '来源文字', createdAt: 1, source: { pageUrl: 'https://example.com' } })
    const request = { operationId: 'default-save', itemIds: ['first'] }
    const receipt = await transfer.transfer(request)
    const disk = () => JSON.parse(readFileSync(join(f.root, '灵感.canvas'), 'utf8'))
    assert.equal(disk().nodes.length, 1)
    assert.equal(disk().nodes[0].text, '来源文字')
    assert.equal(disk().nodes[0].ready.sources[0].uri, 'https://example.com')
    assert.deepEqual(await transfer.transfer(request), receipt)
    assert.equal(disk().nodes.length, 1)
    assert.deepEqual(repository.list(), [])
    assert.ok(changes.includes(receipt.objectId), 'completed writes notify open surfaces')
    await transfer.undo(request.operationId)
    assert.equal(disk().nodes.length, 0)
    assert.equal(repository.list()[0].id, 'first')
    const next = await transfer.transfer({ operationId: 'new-save', itemIds: ['first'], target: { kind: 'new', title: '指定画板', parentPath: f.root } })
    assert.equal(JSON.parse(readFileSync(join(f.root, '指定画板.canvas'), 'utf8')).ready.id, next.objectId)
    repository.add({ id: 'second', kind: 'text', text: '后续', createdAt: 2 })
    await transfer.transfer({ operationId: 'existing-save', itemIds: ['second'], target: { kind: 'existing', objectId: next.objectId } })
    assert.equal(JSON.parse(readFileSync(join(f.root, '指定画板.canvas'), 'utf8')).nodes.length, 2)
  } finally { f.close() }
})

test('window gate readyboard fixture converts once without changing source bytes', async t => {
  if (skipIfSqliteUnavailable(t, 'M4 import fixture')) return
  const f = canvasFixture()
  try {
    const fixtureBytes = readFileSync(new URL('../../scripts/fixtures/ready-next-canvas.readyboard', import.meta.url))
    const path = join(f.root, '旧画板.readyboard'); writeFileSync(path, fixtureBytes)
    const service = new CanvasImportService(f.service)
    const input = { operationId: 'import', sourcePath: path, targetPath: '旧画板.canvas', kind: 'readyboard' as const }
    const result = await service.import(input)
    assert.equal(result.status, 'complete')
    assert.deepEqual(await service.import(input), result)
    assert.deepEqual(readFileSync(path), fixtureBytes)
    assert.equal(JSON.parse(readFileSync(join(f.root, '旧画板.canvas'), 'utf8')).nodes[0].text, '旧画板原文')
  } finally { f.close() }
})
