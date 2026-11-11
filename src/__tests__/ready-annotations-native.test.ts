import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { configureDocumentWriteService, documentVersion } from '../main/modules/document-engine/document-write-service'
import { AnnotationStorage } from '../main/modules/document-annotations/storage'
import { DocumentAnnotationService } from '../main/modules/document-annotations/service'
import { DocumentTemplateService } from '../main/modules/document-templates/service'
import { anchoredBlocks } from '../shared/document-anchors'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-annotations-'))), databasePath = join(root, 'test.sqlite')
  let db: Database.Database, engine: SearchEngine
  function open() {
    db = new Database(databasePath); runMigrations(db)
    const registry = new ObjectRegistry(db)
    engine = new SearchEngine(db, { fts5Available: true }); engine.getRepository().ensureWorkspace(root)
    const index = async (path: string) => { const result = await engine.indexDocument(root, path); assert.ok(result.ok, result.error) }
    configureDocumentWriteService({ index })
    const pages = new DocumentPageService(registry, { index }), storage = new AnnotationStorage(root)
    return { pages, registry, annotations: new DocumentAnnotationService(storage, registry), templates: new DocumentTemplateService(storage, pages), storage }
  }
  const stop = () => { configureDocumentWriteService(null); engine.cancelPendingWorkspaceResolves(); db.close() }
  return { root, open, stop, close: () => { stop(); rmSync(root, { recursive: true, force: true }) } }
}

test('M5-D comments preserve all body bytes, follow page rename/move and report lost/restored anchors', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-D annotations')) return
  const f = fixture(); const s = f.open()
  try {
    const path = join(f.root, 'A.md'), source = '\uFEFF---\r\ntitle: A\r\n---\r\n\r\n评论正文😀\r\n\r\n其他'
    writeFileSync(path, source); const before = readFileSync(path), block = anchoredBlocks(source)[0]
    const added = await s.annotations.comments({ type: 'add', path, expectedRevision: 0, expectedVersion: documentVersion(source), start: block.start, end: block.end, text: '意见' })
    assert.deepEqual(readFileSync(path), before)
    await assert.rejects(s.annotations.comments({ type: 'resolve', path, expectedRevision: 0, threadId: added.threads[0].id, resolved: true }), /评论已变化/)
    const renamed = await s.pages.operate({ type: 'rename', root: f.root, operationId: 'rename', objectId: added.objectId, title: 'B' })
    mkdirSync(join(f.root, 'dest'))
    const moved = await s.pages.operate({ type: 'move', root: f.root, operationId: 'move', objectId: renamed.objectId, parentPath: join(f.root, 'dest') })
    let result = await s.annotations.comments({ type: 'read', path: moved.path! })
    assert.equal(result.objectId, added.objectId); assert.equal(result.threads[0].location.state, 'located')
    const body = readFileSync(moved.path!, 'utf8')
    await s.pages.save({ path: moved.path!, content: body.replace('评论正文😀', '改写'), expectedVersion: documentVersion(body) })
    result = await s.annotations.comments({ type: 'read', path: moved.path! }); assert.equal(result.threads[0].location.state, 'lost')
    await s.pages.save({ path: moved.path!, content: body, expectedVersion: documentVersion(body.replace('评论正文😀', '改写')) })
    result = await s.annotations.comments({ type: 'read', path: moved.path! }); assert.equal(result.threads[0].location.state, 'located')
    const thread = result.threads[0]
    result = await s.annotations.comments({ type: 'edit', path: moved.path!, expectedRevision: result.revision, threadId: thread.id, messageId: thread.messages[0].id, text: '修改意见' })
    result = await s.annotations.comments({ type: 'resolve', path: moved.path!, expectedRevision: result.revision, threadId: thread.id, resolved: true })
    assert.equal(result.threads[0].resolved, true); assert.equal(result.threads[0].messages[0].text, '修改意见')
    assert.equal(readFileSync(moved.path!, 'utf8'), body)
    result = await s.annotations.comments({ type: 'delete', path: moved.path!, expectedRevision: result.revision, threadId: thread.id })
    assert.equal(result.threads.length, 0)
  } finally { f.close() }
})

test('M5-D durable template retry after interrupted response creates exactly one page and preserves attachments', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-D templates')) return
  const f = fixture(); let s = f.open()
  try {
    mkdirSync(join(f.root, '模板')); writeFileSync(join(f.root, '模板', 'image.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(f.root, '模板', '会.md'), '---\nready_id: template-old\n---\n# {{title}}\n\n{{title}} {{date}}\n\n![图](image.png)\n\n源 ^id\n\n![[#^id]]')
    const request = { type: 'create' as const, template: '会.md', title: '会议', operationId: 'template-once', parentPath: f.root }
    const failing = new DocumentTemplateService(s.storage, s.pages, () => { throw new Error('interrupted response') })
    await assert.rejects(failing.execute(request), /interrupted response/)
    const bytes = readFileSync(join(f.root, '会议.md'))
    assert.equal(bytes.toString().split('# 会议').length - 1, 1, 'preserve the user-authored template H1 without injecting another')
    f.stop(); s = f.open(); await s.pages.recover(); await s.templates.recover()
    writeFileSync(join(f.root, '模板', '会.md'), 'template changed')
    const retried = await s.templates.execute(request)
    assert.equal(retried.kind, 'created'); assert.deepEqual(readFileSync(join(f.root, '会议.md')), bytes)
    assert.deepEqual(readdirSync(f.root).filter(name => name.endsWith('.md')), ['会议.md'])
    assert.deepEqual(readFileSync(join(f.root, '会议.assets', 'template-once-0-image.png')), Buffer.from([1, 2, 3]))
    await assert.rejects(s.templates.execute({ ...request, title: 'other' }), /操作编号/)
  } finally { f.close() }
})

test('M5-D synced reads refresh source, source saves reject stale versions, missing and cycles fail visibly', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-D synced blocks')) return
  const f = fixture(), s = f.open()
  try {
    const source = join(f.root, 'source.md'), ref = join(f.root, 'ref.md')
    writeFileSync(source, 'old ^id'); writeFileSync(ref, '![[source#^id]]')
    const read = s.annotations.synced(ref, '![[source#^id]]'); assert.equal(read.content, 'old')
    await s.pages.save({ path: source, expectedVersion: read.version, content: 'new ^id' })
    assert.equal(s.annotations.synced(ref, '![[source#^id]]').content, 'new')
    await assert.rejects(s.pages.save({ path: source, expectedVersion: read.version, content: 'overwrite ^id' }), /changed|version|冲突/i)
    writeFileSync(source, 'deleted'); assert.throws(() => s.annotations.synced(ref, '![[source#^id]]'), /原位置已变化/)
    writeFileSync(source, '![[source#^id]]\n\n^id'); assert.throws(() => s.annotations.synced(ref, '![[source#^id]]'), /循环/)
    assert.throws(() => s.annotations.synced(ref, '![[../outside#^id]]'), /outside vault/)
  } finally { f.close() }
})

test('M5-D corrupted comment metadata is never silently cleared', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-D metadata')) return
  const f = fixture(), s = f.open()
  try {
    const path = join(f.root, 'A.md'); writeFileSync(path, 'body')
    const id = s.registry.register(path).id
    mkdirSync(join(f.root, '.ready', 'comments'), { recursive: true })
    const metadata = s.storage.path('comments', id); writeFileSync(metadata, '{broken')
    await assert.rejects(s.annotations.comments({ type: 'read', path }), /JSON|position|property/i)
    assert.equal(readFileSync(metadata, 'utf8'), '{broken'); assert.equal(readFileSync(path, 'utf8'), 'body')
  } finally { f.close() }
})

test('M5-D inserting a template copies attachments once and relative synced links can reach a parent folder', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-D template insertion')) return
  const f = fixture(), s = f.open()
  try {
    mkdirSync(join(f.root, '模板')); mkdirSync(join(f.root, 'sub'))
    writeFileSync(join(f.root, '模板', 'image.png'), 'asset')
    writeFileSync(join(f.root, '模板', 'guide.pdf'), 'pdf')
    writeFileSync(join(f.root, '模板', 'external.md'), 'external ^id')
    writeFileSync(join(f.root, '模板', 'T.md'), '{{title}}\n\n![图](image.png)\n\n[手册](guide.pdf#page=2)\n\n![[external#^id]]')
    const target = join(f.root, 'sub', 'target.md'); writeFileSync(target, 'keep')
    const request = { type: 'expand' as const, template: 'T.md', title: 'Title', targetPath: target, operationId: 'insert-once' }
    const first = await s.templates.execute(request)
    assert.equal(first.kind, 'expanded')
    assert.deepEqual(await s.templates.execute(request), first)
    assert.equal(readFileSync(target, 'utf8'), 'keep')
    assert.deepEqual(readdirSync(join(f.root, 'sub', 'target.assets')), ['insert-once-0-image.png', 'insert-once-1-guide.pdf'])
    assert.equal(readFileSync(join(f.root, 'sub', 'target.assets', 'insert-once-1-guide.pdf'), 'utf8'), 'pdf')
    if (first.kind === 'expanded') { assert.match(first.content, /guide.pdf#page=2/); assert.match(first.content, /!\[\[\.\.\/模板\/external#\^id\]\]/) }
    assert.equal(readFileSync(join(f.root, 'sub', 'target.assets', 'insert-once-0-image.png'), 'utf8'), 'asset')
    writeFileSync(join(f.root, 'source.md'), '源 ^id')
    assert.equal(s.annotations.synced(target, '![[../source#^id]]').content, '源')
  } finally { f.close() }
})
