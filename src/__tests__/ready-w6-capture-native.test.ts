import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { ObjectMutations } from '../main/modules/object-service/mutations'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { canvasFixture } from './utils/canvas-fixture'
import { FastCardRepository } from '../main/modules/repositories/fastcard-repository'
import { FastCardMediaCache } from '../main/modules/fastcard/media-cache'
import { FastCardCollectionService } from '../main/modules/fastcard/collection-service'
import { FastCardTransferService } from '../main/modules/fastcard/transfer-service'
import { copyFastCardImage } from '../main/modules/fastcard/document-image'
import { fastCardBoardPort } from '../main/modules/board-engine/fastcard-board-port'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { ObjectPresentationService } from '../main/modules/object-service/presentation'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { CalendarStore } from '../main/modules/database/calendar-store'
import { readCapturedReference } from '../main/modules/agent-control/codex-runtime/captured-reference'
import { resolveCodexExplicitResources } from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'
import { toReadyUri, type ReadyRef } from '../shared/ready-ref'
import { readDocumentSource, setFrontmatterFields } from '../shared/document-operations'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const sources: ReadyRef[] = [
  { kind: 'web', url: 'https://example.com' }, { kind: 'rss-item', id: 'article' },
  { kind: 'rss-item', id: 'article', excerpt: { format: 'reading-v1', expectedRevision: 'v1', range: { start: { run: 0, offset: 0 }, end: { run: 0, offset: 4 } }, offset: 0, length: 4 } },
  { kind: 'book-location', book: 'book', loc: 'c0:0+2' }, { kind: 'page', id: 'book', anchor: '^hl-h' },
  { kind: 'file', id: 'pdf', anchor: 'pdf:{"page":1}' }, { kind: 'conversation', id: 'chat', run: 'run' },
]

test('K4 one Main capture stores content/provenance and reads it back after reopen; retry and collision', async t => {
  if (skipIfSqliteUnavailable(t, 'W6 requires Electron SQLite')) return
  const f = canvasFixture(); t.after(f.close)
  const repository = new FastCardRepository(f.db), cache = new FastCardMediaCache(f.root, async () => { throw new Error('network forbidden') })
  const collection = new FastCardCollectionService(repository, cache)
  for (const [i, ref] of sources.entries()) await t.test(`${ref.kind} → FastCard → canvas disk`, async () => {
    const item = { id: `capture-${i}`, kind: 'text' as const, createdAt: 1, title: '标题', text: `选区原文 ${i}`, source: { ref, pageTitle: '出处' } }
    assert.deepEqual(await collection.add(item), item)
    assert.deepEqual(await new FastCardCollectionService(new FastCardRepository(f.db), cache).add(item), item)
    assert.deepEqual(JSON.parse(f.db.prepare('SELECT payload_json FROM fastcard_items WHERE id=?').get<{ payload_json: string }>(item.id)!.payload_json), item)
    await assert.rejects(collection.add({ ...item, text: '冲突正文' }), /already exists/)
    const transfer = new FastCardTransferService('fixture', repository, cache, fastCardBoardPort(f.service))
    const request = { operationId: `transfer-${i}`, itemIds: [item.id], target: { kind: 'new' as const, title: `board-${i}`, parentPath: f.root } }
    const receipt = await transfer.transfer(request)
    assert.deepEqual(await transfer.transfer(request), receipt)
    const disk = JSON.parse(readFileSync(join(f.root, `board-${i}.canvas`), 'utf8'))
    assert.equal(disk.nodes.length, 1)
    assert.equal(disk.nodes[0].text, item.text)
    assert.equal(disk.nodes[0].ready.sources[0].uri, toReadyUri(ref))
    await transfer.undo(request.operationId)
    assert.deepEqual(repository.list().find(value => value.id === item.id), item)
  })
  const result = await collection.add({ id: 'web-priority', kind: 'text', text: '网页优先', createdAt: 1,
    source: { ref: sources[1], pageUrl: 'https://example.com/original' } })
  assert.deepEqual(result.source?.ref, { kind: 'web', url: 'https://example.com/original' })
  await assert.rejects(collection.add({ id: 'invalid', kind: 'text', text: 'bad', createdAt: 1, source: { ref: { kind: 'unknown', id: 'x' } } }))
})

test('K3 image FastCard copies verified bytes beside the real page; missing media and symlinks fail', async t => {
  if (skipIfSqliteUnavailable(t, 'W6 requires Electron SQLite')) return
  const f = canvasFixture(); t.after(f.close)
  const path = join(f.root, '页面.md'); writeFileSync(path, '正文')
  const page = f.registry.register(path), repository = new FastCardRepository(f.db), cache = new FastCardMediaCache(f.root)
  repository.add({ id: 'image', kind: 'image', createdAt: 1, media: cache.save(png, 'image/png') })
  const input = { itemId: 'image', pageId: page.id }
  const copied = copyFastCardImage(input, f.root, f.registry, repository, cache)
  assert.deepEqual(readFileSync(join(f.root, copied)), png)
  assert.equal(copyFastCardImage(input, f.root, f.registry, repository, cache), copied)
  repository.add({ id: 'missing', kind: 'image', createdAt: 1 })
  assert.throws(() => copyFastCardImage({ ...input, itemId: 'missing' }, f.root, f.registry, repository, cache), /未收全/)
  const unsafe = join(f.root, 'unsafe.md'); writeFileSync(unsafe, '正文'); const unsafePage = f.registry.register(unsafe)
  mkdirSync(join(f.root, 'other')); symlinkSync(join(f.root, 'other'), join(f.root, 'unsafe.assets'))
  assert.throws(() => copyFastCardImage({ ...input, pageId: unsafePage.id }, f.root, f.registry, repository, cache), /Unsafe/)
})

test('K4 assistant page goes through durable draft/finalize and keeps ready_source on disk', async t => {
  if (skipIfSqliteUnavailable(t, 'W6 requires Electron SQLite')) return
  const f = canvasFixture(); t.after(f.close)
  const service = new DocumentDraftService(f.db, { registry: f.registry, index: async (_root, path) => { f.registry.register(path) } })
  const source = toReadyUri({ kind: 'conversation', id: 'chat', run: 'run' })
  const content = setFrontmatterFields('完整回答\n\n第二段', { set: { ready_source: source } })
  const draft = await service.create({ origin: 'new', tabId: 'answer', vaultRoot: f.root, title: '回答', content })
  assert.equal(existsSync(join(f.root, '回答.md')), false)
  assert.equal(service.read(draft.draftId)?.content, content)
  const result = await service.finalize(draft.draftId, draft.revision, { parentPath: f.root, title: '回答', operationId: 'save-answer' })
  assert.equal(readDocumentSource(readFileSync(result.path, 'utf8')).frontmatter.ready_source, source)
  assert.ok(readFileSync(result.path, 'utf8').includes('第二段'))
})

test('K3 calendar links and page/file moves use the real owning stores', async t => {
  if (skipIfSqliteUnavailable(t, 'W6 requires Electron SQLite')) return
  const f = canvasFixture(); t.after(f.close)
  const calendar = new CalendarStore(() => f.db)
  calendar.putCalendar({ id: 'local', accountId: 'local', name: '日历', visible: true, color: '#000000' })
  for (const [i, ref] of sources.entries()) {
    const id = `event-${i}`
    calendar.restore({ put: [{ id, uid: id, calendarId: 'local', title: '关联', allDay: true, start: '2026-11-12', end: '2026-11-13', status: 'confirmed', transparency: 'transparent', createdAt: 1, updatedAt: 1 }], remove: [],
      links: [{ eventId: id, links: [{ id: `link-${i}`, eventId: id, purpose: 'related', target: ref }] }] }, { [id]: 0 })
    assert.deepEqual(calendar.snapshot().links?.find(link => link.eventId === id)?.target, ref)
  }
  const pages = new DocumentPageService(f.registry, { index: async path => { f.registry.register(path) } })
  for (const extension of ['md', 'txt']) {
    const path = join(f.root, `move.${extension}`); writeFileSync(path, '移动的原文')
    const object = f.registry.register(path), target = join(f.root, `target-${extension}`); mkdirSync(target)
    if (extension === 'md') await pages.operate({ type: 'move', root: f.root, objectId: object.id, parentPath: target, operationId: `move-${extension}` })
    else await new ObjectMutations(f.registry).move(path, join(target, `move.${extension}`))
    const moved = new ObjectPresentationService(f.registry).locate(object.id)!
    assert.equal(moved.path, join(target, `move.${extension}`))
    assert.equal(readFileSync(moved.path, 'utf8'), '移动的原文')
    assert.equal(existsSync(path), false)
  }
})

test('K3 captured resources read Main truth, reject missing scope/run and grant no tools or write authority', async () => {
  const sources = { cards: () => [{ id: 'card', kind: 'text' as const, createdAt: 1, text: 'Main 真值' }], conversation: () => [
    { id: 'q', role: 'user', content: '问题', meta: { runId: 'run' } }, { id: 'a', role: 'assistant', content: '回答', meta: { runId: 'run' } }] }
  const resolved = await resolveCodexExplicitResources({ selections: [{ kind: 'ready_reference', id: crypto.randomUUID(), name: '伪造标题', ref: { kind: 'fastcard', id: 'card' } }],
    resolveSkill: () => null, resolveReadyReference: selection => readCapturedReference(selection.ref, sources) })
  assert.ok(JSON.stringify(resolved.input).includes('Main 真值'))
  assert.equal(resolved.requestResources[0].canWrite, false)
  assert.deepEqual(resolved.authorities, [])
  assert.deepEqual(resolved.libraryResources, [])
  assert.throws(() => readCapturedReference({ kind: 'conversation', id: 'chat', run: 'missing' }, sources), /不存在/)
  assert.throws(() => readCapturedReference({ kind: 'fastcard', id: 'missing' }, sources), /不存在/)
  assert.throws(() => readCapturedReference({ kind: 'file', id: 'ungranted' }, sources), /授权/)
  const answer = '完整回答'.repeat(500)
  assert.ok(readCapturedReference({ kind: 'conversation', id: 'chat', run: 'run' }, { ...sources,
    conversation: () => sources.conversation().map(message => message.role === 'assistant' ? { ...message, content: answer } : message),
  }).text.endsWith(answer), 'a resource must not be truncated to the hover preview')
})
