import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { CanvasImportService } from '../main/modules/canvas-import/service'
import { readSpaceZip } from '../main/modules/canvas-import/zip'
import { CanvasService } from '../main/modules/board-engine/canvas-service'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { canvasFixture } from './utils/canvas-fixture'
const fixture = (name: string) => readFileSync(new URL(`./fixtures/ready-canvas/${name}`, import.meta.url))

test('C10 four import sources preserve source bytes, repeated imports and incomplete status', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas import')) return
  const f = canvasFixture()
  try {
    const service = new CanvasImportService(f.service)
    mkdirSync(join(f.root, 'source')); mkdirSync(join(f.root, 'source', 'assets'))
    for (const [name, content] of [['image.png', 'image'], ['video.mp4', 'video'], ['copied.md', 'actual saved copy']]) writeFileSync(join(f.root, 'source', 'assets', name), content)
    const { READY_BOARD_STATE_SCRIPT_ID } = await import('../shared/ready-board')
    const old = join(f.root, 'source', 'old.readyboard'), oldBytes = Buffer.from(`<html><script id="${READY_BOARD_STATE_SCRIPT_ID}" type="application/json">${fixture('readyboard.json')}</script></html>`); writeFileSync(old, oldBytes)
    const req = { operationId: 'old', sourcePath: old, targetPath: 'Old.canvas', kind: 'readyboard' as const }
    const receipt = await service.import(req)
    assert.equal(receipt.status, 'complete'); assert.deepEqual(await service.import(req), receipt)
    assert.deepEqual(readFileSync(old), oldBytes)
    const plain = join(f.root, 'plain.json'); writeFileSync(plain, JSON.stringify({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'plain' }] }))
    assert.equal((await service.import({ operationId: 'plain', sourcePath: plain, targetPath: 'Plain.canvas', kind: 'json-canvas' })).status, 'complete')
    const auto = join(f.root, 'auto.json'); writeFileSync(auto, fixture('stillroom.json'))
    assert.equal((await service.import({ operationId: 'auto', sourcePath: auto, targetPath: 'Auto.canvas', kind: 'stillroom-json' })).status, 'incomplete')
    const zip = new JSZip(); zip.file('space.json', JSON.stringify({ app: 'stillroom', version: 1, notes: [] }))
    const archive = join(f.root, 'space.zip'), bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); writeFileSync(archive, bytes)
    assert.equal((await service.import({ operationId: 'zip', sourcePath: archive, targetPath: 'Space.canvas', kind: 'stillroom-zip' })).status, 'complete')
    assert.deepEqual(readFileSync(archive), bytes)
    assert.equal((await service.import({ ...req, operationId: 'duplicate' })).objectId, receipt.objectId)
    await assert.rejects(service.import({ operationId: 'collision', sourcePath: plain, targetPath: 'Old.canvas', kind: 'json-canvas' }), /name_collision/)
    assert.deepEqual(readFileSync(old), oldBytes)
  } finally { f.close() }
})

test('C10 interrupted import resumes its stored source and identities after restart', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas import recovery')) return
  const f = canvasFixture()
  try {
    const source = join(f.root, 'plain.json'); writeFileSync(source, '{"nodes":[],"edges":[]}')
    const request = { operationId: 'resume', sourcePath: source, targetPath: 'Resume.canvas', kind: 'json-canvas' as const }
    const failing = new CanvasImportService(new CanvasService(f.registry, f.root, { checkpoint: phase => { if (phase === 'published') throw new Error('crash') } }))
    await assert.rejects(failing.import(request), /crash/)
    const before = readFileSync(join(f.root, 'Resume.canvas'))
    const restarted = new CanvasImportService(new CanvasService(f.registry, f.root)); await restarted.recover()
    assert.equal((await restarted.import(request)).status, 'complete')
    assert.deepEqual(readFileSync(join(f.root, 'Resume.canvas')), before)
  } finally { f.close() }
})

test('C10 ZIP traversal and expansion limits are rejected before publication', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas zip')) return
  const zip = new JSZip(); zip.file('space.json', '{}'); zip.file('../outside', 'unsafe')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); assert.throws(() => readSpaceZip(bytes))
  const big = new JSZip(); big.file('space.json', ' '.repeat(20000)); const compressed = await big.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  assert.throws(() => readSpaceZip(compressed, 1000), /limit/)
})

test('C10 complete Stillroom ZIP publishes folder media; autosave with that media remains incomplete', async t => {
  if (skipIfSqliteUnavailable(t, 'Stillroom media')) return
  const f = canvasFixture()
  try {
    const note = { id: 'folder', type: 'folder', title: 'Folder', text: '', createdAt: 1, updatedAt: 1, canvasX: 0, canvasY: 0, parentId: null, deletedAt: null, metadata: {} }
    const space = { app: 'stillroom', version: 1, notes: [note, { ...note, id: 'image', type: 'image', parentId: 'folder', mediaUrl: 'idb:blob-key', metadata: { originalFilename: 'image.png' } }] }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSScAAAAASUVORK5CYII=', 'base64')
    const zip = new JSZip(); zip.file('space.json', JSON.stringify(space)); zip.file('media/blob-key', png)
    const sourcePath = join(f.root, 'full.zip'); writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    const importer = new CanvasImportService(f.service), result = await importer.import({ sourcePath, targetPath: 'Full.canvas', operationId: 'full', kind: 'stillroom-zip' })
    assert.equal(result.status, 'complete', JSON.stringify(result.incomplete))
    const root = await f.service.open(result.objectId), childPath = String(root.canvas.nodes[0].file)
    const child = JSON.parse(readFileSync(join(f.root, childPath), 'utf8'))
    assert.deepEqual(readFileSync(join(f.root, child.nodes[0].file)), png)
    mkdirSync(join(f.root, 'media')); writeFileSync(join(f.root, 'media/blob-key'), png)
    const auto = join(f.root, 'auto-with-media.json'); writeFileSync(auto, JSON.stringify(space))
    assert.equal((await importer.import({ sourcePath: auto, mediaDirectory: join(f.root, 'media'), targetPath: 'AutoMedia.canvas', operationId: 'auto-media', kind: 'stillroom-json' })).status, 'incomplete')
  } finally { f.close() }
})
