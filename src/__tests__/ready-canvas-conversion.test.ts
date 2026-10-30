import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { importReadyboard, importStillroom, importJsonCanvas, serializeCanvas, ReadyCanvasSchema, graphicSvg, sha256, type ImportOptions, type ImportAsset } from '../shared/ready-canvas'

const source = (name: string) => readFileSync(new URL(`./fixtures/ready-canvas/${name}`, import.meta.url), 'utf8')
const bytes = (text: string) => new TextEncoder().encode(text)
const assets: ImportAsset[] = [
  { source: 'assets/image.png', bytes: bytes('image'), mime: 'image/png' },
  { source: 'assets/video.mp4', bytes: bytes('video'), mime: 'video/mp4' },
  { source: 'assets/copied.md', bytes: bytes('actual saved copy'), mime: 'text/markdown' },
]
const options: ImportOptions = { objectId: 'cv_import', canvasPath: 'Folder/Board.canvas', sourceUri: 'ready://doc/file/source_1', assets }

test('readyboard preserves body, ID, order, appearance, actual markdown copy and editable SVGs', async () => {
  const result = await importReadyboard(source('readyboard.json'), options)
  assert.deepEqual(result.canvas.nodes.map(n => n.id), ['text', 'note', 'image', 'video', 'markdown', 'rect', 'arrow', 'path'])
  assert.equal(result.canvas.nodes[0].type, 'text')
  assert.equal(result.canvas.nodes[0].text, '保留\r\n😀')
  assert.deepEqual(result.canvas.nodes[0].ready.appearance, { color: '#181818', fontScale: 1.5, rotation: 30 })
  assert.equal(result.canvas.nodes[0].x, 0); assert.equal(result.canvas.nodes[0].y, 3)
  assert.ok(result.transformations.some(t => t.startsWith('text: rounded')))
  assert.equal(result.canvas.nodes[6].x, 8)
  assert.equal(result.canvas.nodes[6].width, 124)
  assert.equal(result.attachments.length, 6)
  const copied = result.attachments.find(a => a.source === 'assets/copied.md')!
  assert.equal(result.canvas.nodes[4].file, copied.path)
  assert.equal(new TextDecoder().decode(copied.bytes), 'actual saved copy')
  assert.equal(result.canvas.nodes[4].ready.ref, undefined)
  assert.deepEqual(result.canvas.nodes[6].ready.graphic, { type: 'arrow', x2: -100, y2: 80, stroke: '#ff0000', strokeWidth: 3 })
  assert.equal(result.canvas.edges.length, 0)
  assert.equal(result.incomplete.length, 0)
  assert.deepEqual(result.localState, { viewport: { x: 20, y: 30, zoom: 1.5 } })
  assert.equal(result.identityMap[0].canvasId, 'cv_import')
  assert.equal(result.canvas.nodes[0].ready.sources?.[0].uri, options.sourceUri)
  for (const asset of result.attachments) assert.equal(asset.sha256, await sha256(asset.bytes))
  const again = await importReadyboard(source('readyboard.json'), options)
  assert.equal(serializeCanvas(result.canvas), serializeCanvas(again.canvas))
  assert.equal(result.sourceFingerprint, again.sourceFingerprint)
  const changed = await importReadyboard(source('readyboard.json'), { ...options, assets: assets.map(a => ({ ...a, bytes: bytes('changed') })) })
  assert.notEqual(result.sourceFingerprint, changed.sourceFingerprint)
})

test('readyboard external receipts add once, preserve incomplete media and reject corrupt input', async () => {
  const receipt = { id: 'new', asset: { src: 'assets/new.png', kind: 'image' as const, name: 'new.png' } }
  const withReceipts = { ...options, externalReceipts: [{ id: 'receipt1', asset: { src: 'assets/image.png', kind: 'image' as const, name: 'existing' } }, receipt] }
  const result = await importReadyboard(source('readyboard.json'), withReceipts)
  assert.equal(result.canvas.nodes.length, 9)
  assert.equal(result.canvas.nodes.filter(n => n.id === 'receipt-new').length, 1)
  assert.ok(result.incomplete.some(i => i.reason.includes('assets/new.png')))
  assert.equal((await importReadyboard(source('readyboard.json'), withReceipts)).sourceFingerprint, result.sourceFingerprint)
  const bad = JSON.parse(source('readyboard.json')); bad.nodes[0].x = 'bad'
  await assert.rejects(importReadyboard(JSON.stringify(bad), options))
  bad.nodes[0].x = 0; bad.nodes[2].src = '../secret'
  await assert.rejects(importReadyboard(JSON.stringify(bad), options))
})

const stillOptions = { ...options, sourceKind: 'complete-zip' as const, childObjectIds: { folder: 'cv_folder' }, assets: [
  { source: 'media/pic', bytes: bytes('pic'), mime: 'image/png' },
  { source: 'media/sound', bytes: bytes('sound'), mime: 'audio/wav' },
  { source: 'media/movie', bytes: bytes('movie'), mime: 'video/mp4' },
  { source: 'media/poster', bytes: bytes('poster'), mime: 'image/png' },
] }
test('Stillroom splits folder membership into subcanvases, converts HTML and preserves media, source, style and trash', async () => {
  const result = await importStillroom(source('stillroom.json'), stillOptions)
  assert.equal(result.incomplete.length, 0, JSON.stringify(result.incomplete))
  assert.deepEqual(result.canvas.nodes.map(n => n.id), ['folder', 'audio', 'video', 'link', 'trash'])
  const child = result.subcanvases[0]
  assert.equal(child.path, 'Folder/Board/folder.canvas')
  assert.equal(child.canvas.ready.id, 'cv_folder')
  assert.deepEqual(child.canvas.nodes.map(n => n.id), ['text', 'image'])
  assert.equal(child.canvas.nodes[0].text, '# text\n\nHello **世界**\n\n-   一')
  assert.equal(child.canvas.nodes[0].ready.appearance?.align, 'center')
  assert.equal(child.canvas.nodes[0].ready.appearance?.weight, 'medium')
  assert.equal(child.canvas.nodes[0].ready.appearance?.collapsed, true)
  assert.ok(Math.abs(child.canvas.nodes[0].ready.appearance!.fontScale! - 0.9) < 1e-12)
  assert.deepEqual(child.canvas.nodes[1].ready.dock, { left: 'text' })
  assert.equal(child.canvas.nodes[1].ready.appearance?.rotation, 90)
  assert.deepEqual(child.canvas.nodes[1].ready.appearance?.crop, { mode: 'position', x: 25, y: 75 })
  assert.ok(String(child.canvas.nodes[1].file).startsWith('Folder/Board/folder.assets/'))
  assert.equal(result.canvas.nodes[1].ready.media?.durationMs, 65000)
  assert.equal(result.canvas.nodes[1].ready.media?.transcript, '你好')
  assert.ok(result.canvas.nodes[2].ready.media?.poster?.startsWith('Folder/Board.assets/'))
  assert.equal(result.canvas.nodes[3].url, 'https://example.test/a')
  assert.equal(result.canvas.nodes[3].ready.preview?.description, '链接备注')
  assert.ok(result.canvas.nodes[3].ready.sources?.some(s => s.uri === 'https://example.test/a'))
  assert.equal(result.canvas.nodes[4].ready.trash?.operationId, 'import-trash')
  assert.equal(result.attachments.length, 4)
  assert.deepEqual(result.localState, { cam: { x: 0, y: 0, z: 1 }, prefs: { dark: true } })
  assert.equal(serializeCanvas(result.canvas), serializeCanvas((await importStillroom(source('stillroom.json'), stillOptions)).canvas))
})

test('Stillroom incomplete exports and unsupported content cannot masquerade as complete imports', async () => {
  const autosave = await importStillroom(source('stillroom.json'), { ...stillOptions, sourceKind: 'autosave-json' })
  assert.ok(autosave.incomplete.some(i => i.reason.includes('not a complete')))
  const missing = await importStillroom(source('stillroom.json'), { ...stillOptions, assets: [] })
  assert.ok(missing.incomplete.some(i => i.sourceId === 'image' && i.reason.includes('media/pic')))
  const raw = JSON.parse(source('stillroom.json')); raw.notes[1].text = '<iframe src="https://example.test"></iframe><p>Keep</p>'
  const incomplete = await importStillroom(JSON.stringify(raw), stillOptions)
  assert.ok(incomplete.incomplete.some(i => i.reason.includes('HTML')))
  assert.ok(String(incomplete.subcanvases[0].canvas.nodes[0].text).includes('Keep'))
  raw.notes[0].parentId = 'folder'
  await assert.rejects(importStillroom(JSON.stringify(raw), stillOptions), /cycle/)
  raw.notes[0].parentId = 'missing'
  await assert.rejects(importStillroom(JSON.stringify(raw), stillOptions), /parent/)
  await assert.rejects(importStillroom(source('stillroom.json'), { ...stillOptions, childObjectIds: {} }))
})

test('ordinary JSON Canvas retains all standard types and extensions, and existing Ready identity', async () => {
  const result = await importJsonCanvas(source('plain.json'), { ...options, assets: [] })
  assert.equal(result.canvas.ready.id, options.objectId)
  assert.deepEqual(result.canvas.nodes.map(n => n.ready.kind), ['text', 'document', 'link', 'group'])
  assert.deepEqual(result.canvas.vendor, undefined)
  assert.deepEqual(result.canvas.plugin, { root: 'retained' })
  assert.deepEqual(result.canvas.nodes[0].plugin, { a: [1, 2] })
  assert.equal(result.canvas.nodes[1].subpath, '#anchor')
  assert.equal(result.canvas.nodes[1].file, 'notes/copy.md')
  assert.deepEqual(result.canvas.edges[0].plugin, { v: 1 })
  assert.ok(result.incomplete.some(i => i.reason.includes('Main verification')))
  const existing = await importJsonCanvas(serializeCanvas(result.canvas), { ...options, objectId: 'do_not_replace' })
  assert.equal(existing.canvas.ready.id, options.objectId)
  assert.equal(serializeCanvas(existing.canvas), serializeCanvas(result.canvas))
  const raw = JSON.parse(serializeCanvas(result.canvas)); raw.ready.schemaVersion = 9
  await assert.rejects(importJsonCanvas(JSON.stringify(raw), options), /Readonly/)
  const empty = await importJsonCanvas('{}', options)
  assert.deepEqual(empty.canvas.nodes, []); assert.deepEqual(empty.canvas.edges, [])
})

test('generated graphics reject executable paint or malformed geometry', () => {
  assert.throws(() => graphicSvg({ type: 'rect', fill: 'url(https://bad)', stroke: '#000', strokeWidth: 1 }, 10, 10))
  const svg = graphicSvg({ type: 'arrow', x2: -40, y2: 10, stroke: '#f00', strokeWidth: 2 }, 100, 100)
  assert.ok(svg.includes('x2="-40"'))
  assert.ok(svg.includes('viewBox="-52 -12 64 34"'))
  assert.ok(svg.includes('marker-end="url(#arrow)"'))
  assert.throws(() => ReadyCanvasSchema.parse({ nodes: [], edges: [], ready: { schemaVersion: 1, id: '' } }))
})

test('Stillroom inline media uses the same attachment plan and keeps literal Markdown title characters', async () => {
  const raw = JSON.parse(source('stillroom.json'))
  raw.notes[1].title = '*literal*'
  raw.notes[1].text = '<p>Photo <img src="idb:pic" alt="test"></p><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>'
  const result = await importStillroom(JSON.stringify(raw), stillOptions)
  const text = String(result.subcanvases[0].canvas.nodes[0].text)
  assert.ok(text.startsWith('# \\*literal\\*'))
  assert.ok(text.includes('![test](Folder/Board/folder.assets/'))
  assert.ok(text.includes('| A |'))
  assert.ok(text.includes('| B |'))
  assert.equal(result.attachments.filter(a => a.source === 'media/pic').length, 1)
  assert.ok(result.attachments.find(a => a.source === 'media/pic')?.path.endsWith('.png'))
  assert.equal(result.incomplete.length, 0)
})

test('ordinary Canvas copies supplied files, group background and inline media with a complete manifest', async () => {
  const raw = JSON.parse(source('plain.json'))
  raw.nodes[0].text = '![photo](assets/image.png)\n`![literal](absent.png)`'
  raw.nodes[3].background = 'assets/image.png'
  const result = await importJsonCanvas(JSON.stringify(raw), { ...options, assets: [...assets, { source: 'notes/copy.md', bytes: bytes('copy'), mime: 'text/markdown' }] })
  assert.equal(result.attachments.length, 2)
  assert.equal(result.incomplete.length, 0)
  assert.ok(String(result.canvas.nodes[0].text).includes('Folder/Board.assets/'))
  assert.ok(String(result.canvas.nodes[0].text).includes('`![literal](absent.png)`'))
  assert.equal(result.canvas.nodes[3].background, result.attachments.find(a => a.source === 'assets/image.png')?.path)
})

test('identified media import rejects bytes that disagree with its recorded hash', async () => {
  const canvas = { nodes: [{ id: 'image', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'Board.assets/image.png',
    ready: { kind: 'image', media: { mime: 'image/png', sha256: 'a'.repeat(64) } } }], edges: [], ready: { schemaVersion: 1, id: 'cv_original' } }
  await assert.rejects(importJsonCanvas(JSON.stringify(canvas), { ...options, assets: [{ source: 'Board.assets/image.png', mime: 'image/png', bytes: bytes('different') }] }), /Media hash mismatch/)
})
