import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { ObjectRelationsService } from '../main/modules/object-relations/service'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { configureDocumentWriteService } from '../main/modules/document-engine/document-write-service'

test('M5-C relations retain identity after rename/move, expose unresolved links and exact backlink count', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-C object relations')) return
  const f = fixture()
  try {
    const a = join(f.root, 'a.md'), b = join(f.root, 'b.md')
    writeFileSync(b, '# Target')
    await f.engine.indexDocument(f.root, b)
    writeFileSync(a, '[[b]]\n[[missing]]')
    await f.engine.indexDocument(f.root, a)
    const source = f.registry.find(a)!.id, target = f.registry.find(b)!.id
    const service = new ObjectRelationsService(f.db)
    assert.equal(service.query(source).outgoing.length, 2)
    assert.equal(service.query(source).outgoing.filter(row => !row.ref).length, 1)
    assert.match(service.query(source).outgoing.find(row => !row.ref)!.reason!, /./)
    assert.equal(service.query(target).backlinkCount, 1)
    assert.equal(service.query(target).incoming[0].ref?.kind, 'page')
    mkdirSync(join(f.root, 'nested'))
    const index = async (path: string) => { assert.ok((await f.engine.indexDocument(f.root, path)).ok) }
    configureDocumentWriteService({ index })
    const pages = new DocumentPageService(f.registry, { index })
    await pages.operate({ type: 'rename', root: f.root, objectId: target, title: 'renamed', operationId: 'rename' })
    await pages.operate({ type: 'move', root: f.root, objectId: target, parentPath: join(f.root, 'nested'), operationId: 'move' })
    const moved = join(f.root, 'nested/renamed.md')
    assert.equal(f.registry.find(moved)!.id, target)
    assert.equal(service.query(target).backlinkCount, 1)
    assert.equal(service.query(source).outgoing.find(row => row.ref)?.title, 'renamed')
    assert.throws(() => service.query(''), /./)
    writeFileSync(a, Array.from({ length: 1005 }, () => '[[nested/renamed]]').join('\n'))
    await index(a)
    const limited = service.query(target)
    assert.equal(limited.incoming.length, 1000)
    assert.equal(limited.backlinkCount, 1005)
    assert.equal(limited.truncated, true)
    await pages.operate({ type: 'trash', root: f.root, objectId: target, operationId: 'trash' })
    assert.equal(service.query(source).outgoing.filter(row => row.ref).length, 0)
  } finally { configureDocumentWriteService(null); f.close() }
})
