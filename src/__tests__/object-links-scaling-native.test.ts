import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { seedSearchObject } from './utils/object-repository-fixtures'
import { ObjectLinkRepository } from '../main/modules/search-engine/object-links'

// R1b / B8 contract: count actual relation writes, never elapsed time.
test('single-document indexing revisits only outgoing, matching-name and bound incoming links', async t => {
  if (skipIfSqliteUnavailable(t, 'Object links scaling')) return
  const f = fixture()
  try {
    const workspaceId = f.engine.getRepository().ensureWorkspace(f.root)
    f.db.transaction(() => {
      for (let i = 0; i < 2000; i++) seedSearchObject(f.db, workspaceId, join(f.root, `bulk/${i}.md`))
    })()
    mkdirSync(join(f.root, 'notes'))
    mkdirSync(join(f.root, 'targets'))
    const source = join(f.root, 'notes/source.md')
    const matching = ['Match', 'Match.md', '../targets/Match', '../targets/Match.md', 'targets/Match']
    writeFileSync(source, [...matching, ...Array.from({ length: 295 }, (_, i) => `missing-${i}`)].map(text => `[[${text}]]`).join('\n'))
    assert.equal((await f.engine.indexDocument(f.root, source)).ok, true)
    const links = new ObjectLinkRepository(f.db)
    const sourceId = f.registry.find(source)!.id
    assert.equal(links.outgoing({ objectId: sourceId }).filter(link => !link.resolved).length, 300)
    f.db.exec(`CREATE TEMP TABLE resolved_rows(id TEXT, source_id TEXT);
      CREATE TEMP TRIGGER count_relation_resolution AFTER UPDATE ON object_links BEGIN
        INSERT INTO resolved_rows VALUES(NEW.id, NEW.source_id);
      END;`)

    const unrelated = join(f.root, 'unrelated.md')
    writeFileSync(unrelated, '[[own-missing]]')
    assert.equal((await f.engine.indexDocument(f.root, unrelated)).ok, true)
    assert.deepEqual(f.db.prepare('SELECT DISTINCT source_id FROM resolved_rows').all(), [{ source_id: f.registry.find(unrelated)!.id }])
    assert.equal(f.db.prepare('SELECT COUNT(DISTINCT id) AS n FROM resolved_rows').get<{ n: number }>()!.n, 1)

    f.db.exec('DELETE FROM resolved_rows')
    const target = join(f.root, 'targets/Match.md')
    writeFileSync(target, '# Match')
    assert.equal((await f.engine.indexDocument(f.root, target)).ok, true)
    const targetId = f.registry.find(target)!.id
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM resolved_rows').get<{ n: number }>()!.n, 5)
    assert.deepEqual(links.incoming({ objectId: targetId }).map(link => link.rawTarget).sort(), matching.sort())
    assert.equal(links.outgoing({ objectId: sourceId }).filter(link => link.resolved).length, 5)

    // Bound incoming rows must be revisited even when their text no longer matches.
    f.db.prepare("UPDATE objects SET current_path=?,path_key=? WHERE id=?").run(join(f.root, 'renamed.md'), join(f.root, 'renamed.md'), targetId)
    f.db.prepare("UPDATE documents SET path=?,name='renamed.md' WHERE object_id=?").run(join(f.root, 'renamed.md'), targetId)
    f.db.exec('DELETE FROM resolved_rows')
    const documentId = f.db.prepare('SELECT id FROM documents WHERE object_id=?').get<{ id: number }>(targetId)!.id
    links.resolveDocument(documentId)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM resolved_rows').get<{ n: number }>()!.n, 5)
    assert.equal(links.incoming({ objectId: targetId }).filter(link => link.resolved).length, 5, 'repair bindings retain priority after rename')
  } finally { f.close() }
})

test('filename fallback uses the expression index in both document and workspace resolution', async t => {
  if (skipIfSqliteUnavailable(t, 'Object links filename index')) return
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'nested'))
    writeFileSync(join(f.root, 'nested/Target.MD'), '# Target')
    assert.equal((await f.engine.indexDocument(f.root, join(f.root, 'nested/Target.MD'))).ok, true)
    const statements: string[] = []
    const prepare = f.db.prepare.bind(f.db)
    t.mock.method(f.db, 'prepare', (sql: string) => {
      if (sql.startsWith('SELECT * FROM objects WHERE workspace_id=')) statements.push(sql)
      return prepare(sql)
    })
    const source = join(f.root, 'source.md')
    writeFileSync(source, '[[target]]')
    assert.equal((await f.engine.indexDocument(f.root, source)).ok, true)
    const links = new ObjectLinkRepository(f.db)
    assert.equal(links.outgoing({ objectId: f.registry.find(source)!.id })[0].resolved, true)
    assert.ok(statements.length > 0)
    const workspaceId = f.engine.getRepository().ensureWorkspace(f.root)
    // allow-source-grep: query plans are a structural performance contract; correct results alone cannot prove indexed lookup. Inspect executed SQL, not source text.
    const assertIndexed = () => {
      for (const sql of statements) {
        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>(workspaceId, 'target', 'target.md')
        assert.ok(plan.some(row => /USING INDEX objects_workspace_filename .*workspace_id=\? AND <expr>=\?/.test(row.detail)), JSON.stringify(plan))
      }
    }
    assertIndexed()
    statements.length = 0
    f.db.exec('DELETE FROM object_link_repairs')
    links.resolveWorkspace(workspaceId)
    assert.ok(statements.length > 0)
    assertIndexed()
  } finally { f.close() }
})
