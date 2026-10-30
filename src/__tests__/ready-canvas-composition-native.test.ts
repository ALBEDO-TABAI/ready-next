import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canvasFixture, textNode } from './utils/canvas-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { CanvasCompositionService } from '../main/modules/canvas-composition/service'
import { compositionOrder } from '../main/modules/canvas-composition/convert'
import { hashBytes } from '../main/modules/document-drafts/files'
import { graphicSvg, type CanvasNode } from '../shared/ready-canvas'
import { toReadyUri } from '../shared/ready-ref'
import { serializeCanvas } from '../shared/ready-canvas'

// C4/C12 executable contract: Main freezes the confirmed selection, owns both
// receipts, and resumes a publication without creating another document/card.
test('composition order keeps clusters together and breaks coordinate ties by drawing order', () => {
  const nodes = [
    { ...textNode('lower'), y: 120 }, { ...textNode('far'), x: 1000, y: 30 },
    textNode('first'), textNode('second'),
  ]
  assert.deepEqual(compositionOrder(nodes).map(n => n.id), ['first', 'second', 'lower', 'far'])
})

for (const phase of ['prepared', 'attachments', 'card', 'completed'] as const) {
  test(`C12 composition restart at ${phase} keeps one draft and one card`, async t => {
    if (skipIfSqliteUnavailable(t, 'Canvas composition')) return
    const f = canvasFixture()
    try {
      const opened = await f.service.create({ operationId: 'board', path: 'X.canvas', canvas: {
        nodes: [textNode('one'), textNode('two')], edges: [], ready: { schemaVersion: 1, id: 'board' },
      } })
      const drafts = new DocumentDraftService(f.db, { registry: f.registry, index: async () => {} })
      const input = { objectId: opened.objectId, expectedVersion: opened.version, operationId: 'compose', nodeIds: ['one'], tabId: 'tab', title: 'Draft' }
      const interrupted = new CanvasCompositionService(f.service, drafts, { checkpoint: at => { if (at === phase) throw new Error('interrupted') } })
      await assert.rejects(interrupted.compose(input), /interrupted/)
      const resumed = new CanvasCompositionService(f.service, drafts)
      const result = await resumed.compose(input)
      assert.deepEqual(await resumed.compose(input), result)
      assert.equal(drafts.list(f.root).length, 1)
      const draft = drafts.read(result.draftId)!
      assert.match(draft.content, /hello world/)
      assert.match(draft.content, /ready:\/\/canvas\/board#node=one/)
      const board = (await f.service.read(opened.handleId)).canvas
      assert.equal(board.nodes.length, 3)
      assert.equal(board.nodes.filter(n => n.ready.kind === 'draft').length, 1)
      assert.equal(board.nodes[2].ready.draftId, result.draftId)
      assert.deepEqual(board.nodes.slice(0, 2), opened.canvas.nodes)
      await assert.rejects(resumed.compose({ ...input, nodeIds: ['two'] }), /operation/)
    } finally { f.close() }
  })
}

test('C12 converts all material types, finalizes in X with rewritten assets and one portable document card', async t => {
  if (skipIfSqliteUnavailable(t, 'Canvas composition')) return
  const f = canvasFixture()
  try {
    mkdirSync(join(f.root, 'X.assets'))
    writeFileSync(join(f.root, 'X.assets', 'image.png'), 'image')
    writeFileSync(join(f.root, 'X.assets', 'audio.mp3'), 'audio')
    writeFileSync(join(f.root, 'X.assets', 'video.mp4'), 'video')
    writeFileSync(join(f.root, 'source.md'), '---\nready_id: page\n---\nSource')
    f.registry.register(join(f.root, 'source.md'))
    const graphic = { type: 'rect' as const, fill: '#ffffff', stroke: '#000000', strokeWidth: 1 }
    writeFileSync(join(f.root, 'X.assets', 'shape.svg'), graphicSvg(graphic, 200, 100))
    const file = (id: string, kind: 'image' | 'audio' | 'video' | 'graphic' | 'document', path: string): CanvasNode => ({
      id, type: 'file', file: path, x: 0, y: 0, width: 200, height: 100, ready: { kind },
    })
    const nodes: CanvasNode[] = [textNode('text'), file('image', 'image', 'X.assets/image.png'),
      file('audio', 'audio', 'X.assets/audio.mp3'), file('video', 'video', 'X.assets/video.mp4'),
      { ...file('shape', 'graphic', 'X.assets/shape.svg'), ready: { kind: 'graphic', graphic } },
      { ...file('page', 'document', 'source.md'), ready: { kind: 'document', ref: { kind: 'page', id: 'page' } } },
      { ...textNode('quote'), ready: { kind: 'note', sources: [{ uri: toReadyUri({ kind: 'book-location', book: 'book', loc: 'chapter' }), method: 'highlight' }] } },
      { id: 'link', type: 'link', url: 'https://example.com', x: 0, y: 0, width: 200, height: 100, ready: { kind: 'link' } },
    ]
    const board = await f.service.create({ operationId: 'board', path: 'X.canvas', canvas: { nodes, edges: [], ready: { schemaVersion: 1, id: 'board' } } })
    let composition: CanvasCompositionService
    let fail = true
    const drafts = new DocumentDraftService(f.db, { registry: f.registry, index: async () => {}, completeCanvas: async (...args) => {
      if (fail) throw new Error('interrupted canvas')
      await composition.complete(...args)
    } })
    composition = new CanvasCompositionService(f.service, drafts)
    const created = await composition.compose({ objectId: 'board', expectedVersion: board.version, operationId: 'compose', nodeIds: nodes.map(n => n.id), tabId: 'tab', title: 'Draft' })
    const draft = drafts.read(created.draftId)!
    assert.equal(draft.attachments.length, 2)
    assert.match(draft.content, /!\[\[ready:\/\/doc\/page\/page\]\]/)
    assert.match(draft.content, /!\[\[ready:\/\/read\/book\/book#chapter\]\]/)
    assert.match(draft.content, /ready:\/\/doc\/file\//)
    const request = { parentObjectId: 'board', title: 'Final name', operationId: 'final', keepDocumentCard: true }
    await assert.rejects(drafts.finalize(created.draftId, created.revision, { ...request, title: 'bad#name' }), /画板无法引用/)
    assert.equal(drafts.read(created.draftId)?.finalize, null)
    await assert.rejects(drafts.finalize(created.draftId, created.revision, request), /文档已保存，画板待完成/)
    assert.equal(drafts.read(created.draftId)?.state, 'editing')
    fail = false
    const receipt = await drafts.finalize(created.draftId, created.revision, request)
    assert.deepEqual(await drafts.finalize(created.draftId, created.revision, request), receipt)
    assert.equal(receipt.path, join(f.root, 'X', 'Final name.md'))
    const content = readFileSync(receipt.path, 'utf8')
    assert.equal(hashBytes(content), receipt.contentHash)
    assert.match(content, new RegExp(`ready_id: ${receipt.objectId}`))
    assert.match(content, /Final%20name.assets/)
    assert.doesNotMatch(content, /\.ready\/canvas-composition/)
    assert.equal(readdirSync(join(f.root, 'X')).filter(n => n.endsWith('.md')).length, 1)
    assert.equal(readdirSync(join(f.root, 'X', 'Final name.assets')).length, 2)
    const finalCard = (await f.service.read(board.handleId)).canvas.nodes.find(n => n.id === created.cardId)!
    assert.equal(finalCard.type, 'file')
    assert.equal(finalCard.ready.kind, 'document')
    assert.deepEqual(finalCard.ready.ref, { kind: 'page', id: receipt.objectId })
    assert.equal(f.registry.get(receipt.objectId)?.content_hash, receipt.contentHash)
  } finally { f.close() }
})

test('C3 unconfirmed versions and dirty canvas buffers cannot silently become a draft', async t => {
  if (skipIfSqliteUnavailable(t, 'Canvas composition')) return
  const f = canvasFixture()
  try {
    const board = await f.service.create({ operationId: 'board', path: 'X.canvas', canvas: { nodes: [textNode('text')], edges: [], ready: { schemaVersion: 1, id: 'board' } } })
    const drafts = new DocumentDraftService(f.db, { registry: f.registry, index: async () => {} })
    const composition = new CanvasCompositionService(f.service, drafts)
    const input = { objectId: 'board', expectedVersion: board.version, operationId: 'compose', nodeIds: ['text'], tabId: 'tab', title: 'Draft' }
    await assert.rejects(composition.compose({ ...input, expectedVersion: '0'.repeat(64) }), /重新确认/)
    const dirty = structuredClone(board.canvas)
    if (dirty.nodes[0].type === 'text') dirty.nodes[0].text = '未保存的输入'
    f.service.updateBuffer({ objectId: 'board', tabId: 'canvas-tab', bufferVersion: 1, openGeneration: 1, baseVersion: board.version, canvas: dirty })
    await assert.rejects(composition.compose(input), /先保存画板/)
    assert.equal(drafts.list(f.root).length, 0)
    assert.equal(serializeCanvas(f.service.buffer('board')!.canvas), serializeCanvas(dirty))
    assert.deepEqual((await f.service.read(board.handleId)).canvas, board.canvas)
  } finally { f.close() }
})

test('document preview reads the current page, is bounded, and rejects resources outside this vault', async t => {
  if (skipIfSqliteUnavailable(t, 'Canvas composition')) return
  const f = canvasFixture()
  const outside = mkdtempSync(join(tmpdir(), 'ready-preview-outside-'))
  try {
    const path = join(f.root, 'page.md'); writeFileSync(path, '---\ntitle: 第一版\n---\nbody')
    const page = f.registry.register(path)
    const drafts = new DocumentDraftService(f.db, { registry: f.registry, index: async () => {} })
    const service = new CanvasCompositionService(f.service, drafts)
    const first = await service.preview({ kind: 'page', id: page.id })
    assert.equal(first.title, '第一版'); assert.equal(first.markdown, 'body')
    writeFileSync(path, '# 第二版\n' + '中'.repeat(20000))
    const next = await service.preview({ kind: 'page', id: page.id })
    assert.equal(next.truncated, true); assert.ok(next.markdown.length < 16384); assert.notEqual(first.version, next.version)
    await assert.rejects(service.preview({ kind: 'page', id: 'missing' }), /原文/)
    await assert.rejects(service.preview({ kind: 'web', url: 'https://example.com' }), /不支持/)
    const external = join(outside, 'outside.md'); writeFileSync(external, 'outside')
    const externalObject = f.registry.register(external)
    await assert.rejects(service.preview({ kind: 'page', id: externalObject.id }), /outside vault/)
    const board = await f.service.create({ operationId: 'preview-board', path: 'P.canvas', canvas: {
      nodes: [{ id: 'document', type: 'file', file: 'page.md', x: 0, y: 0, width: 100, height: 100, ready: { kind: 'document' } }],
      edges: [], ready: { schemaVersion: 1, id: 'preview-board' },
    } })
    assert.deepEqual((await service.preview({ objectId: board.objectId, nodeId: 'document' })).ref, { kind: 'page', id: page.id })
  } finally { f.close(); rmSync(outside, { recursive: true, force: true }) }
})

test('composition IPC validates and authorizes before touching the selected board', async t => {
  if (skipIfSqliteUnavailable(t, 'Canvas composition')) return
  const f = canvasFixture()
  try {
    const { registerCanvasCompositionIPC } = await import('../main/modules/canvas-composition/ipc')
    const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
    const drafts = new DocumentDraftService(f.db, { registry: f.registry, index: async () => {} })
    const composition = new CanvasCompositionService(f.service, drafts)
    let authorized = false
    registerCanvasCompositionIPC({ handle: (name, handler) => { handlers.set(name, handler) } }, async () => {
      if (!authorized) throw new Error('sender denied')
      return composition
    })
    const invoke = (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args)
    assert.deepEqual(await invoke('canvasComposition:compose', {}), { ok: false, code: 'composition_failed', message: 'sender denied' })
    authorized = true
    assert.partialDeepStrictEqual(await invoke('canvasComposition:compose', {}), { ok: false })
    assert.equal(drafts.list(f.root).length, 0)
    assert.deepEqual(await invoke('canvasComposition:recover'), { ok: true, value: [] })
  } finally { f.close() }
})
