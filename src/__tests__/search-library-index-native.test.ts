import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runMigrations } from '../main/modules/migrations'
import { SearchEngine, probeFts5Availability } from '../main/modules/search-engine/indexer'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('page titles are searchable with filename weight, unchanged presentation and incremental updates', async t => {
  if (skipIfSqliteUnavailable(t, 'Library title indexing')) return
  const f = fixture(); t.after(f.close)
  const titlePath = join(f.root, 'Record.md')
  for (const [name, raw] of [
    ['Orchid.md', 'filler common'],
    ['Record.md', '---\ntitle: Orchid\n---\ncommon'],
    ['Result.md', 'Orchid common'],
    ['Untitled.md', '---\ntitle: 12345\n---\ncommon'],
    ['Chinese.md', '---\ntitle: M5验收目标\n---\ncommon'],
  ]) writeFileSync(join(f.root, name), raw)
  assert.equal((await f.engine.reindexWorkspace({ root: f.root })).ok, true)
  const hits = (await f.engine.search('Orchid', { workspaceRoots: [f.root] })).items
  const named = hits.find(h => h.name === 'Orchid.md')!
  const titled = hits.find(h => h.path === titlePath)!
  const body = hits.find(h => h.name === 'Result.md')!
  assert.ok(named && titled && body)
  assert.equal(titled.rank, named.rank)
  assert.ok(titled.rank < body.rank)
  assert.equal(titled.name, 'Record.md')
  assert.equal(titled.title, 'Orchid')
  assert.equal(titled.sourceType, 'document')
  assert.equal(titled.typeLabel, '页面')
  assert.ok(!titled.snippet.includes('Orchid'), 'snippet still comes from the body')
  assert.equal((await f.engine.search('12345')).items.length, 0)
  assert.equal((await f.engine.search('Untitled')).items[0].title, 'Untitled')
  for (const query of ['M5', '验收', 'M5验收目标']) {
    assert.equal((await f.engine.search(query)).items[0].name, 'Chinese.md')
  }
  writeFileSync(titlePath, '---\ntitle: Azalea\n---\ncommon')
  assert.equal((await f.engine.indexDocument(f.root, titlePath)).ok, true)
  assert.equal((await f.engine.search('Azalea')).items[0].path, titlePath)
  assert.ok(!(await f.engine.search('Orchid')).items.some(h => h.path === titlePath))
  const readwise = join(f.root, 'readwise-export.md')
  writeFileSync(readwise, readFileSync(join(process.cwd(), 'scripts/library-retrieval/fixtures/library/English/readwise-export.md')))
  assert.equal((await f.engine.indexDocument(f.root, readwise)).ok, true)
  for (const query of ['readwise', 'export', 'readwise-export']) {
    assert.equal((await f.engine.search(query)).items[0].path, readwise)
  }
})

test('hyphens and underscores split in names and bodies while phrases, CJK, prefixes and filters hold', async t => {
  if (skipIfSqliteUnavailable(t, 'Library compound terms')) return
  const f = fixture(); t.after(f.close)
  for (const [name, raw] of [
    ['readwise-export.md', 'foo_bar 北岸夜跑 hello world #topic [[Target]]'],
    ['foo_bar.md', 'readwise'],
    ['export.md', 'foo'],
    ['Reverse.md', 'export readwise hello separate world'],
    ['Target.md', 'unrelated'],
  ]) writeFileSync(join(f.root, name), raw)
  assert.equal((await f.engine.reindexWorkspace({ root: f.root })).ok, true)
  const names = async (query: string) => (await f.engine.search(query)).items.map(h => h.name)
  for (const query of ['readwise', 'export']) assert.ok((await names(query)).includes('readwise-export.md'))
  for (const query of ['foo', 'bar']) {
    const found = await names(query)
    assert.ok(found.includes('readwise-export.md') && found.includes('foo_bar.md'))
  }
  for (const query of ['readwise-export', '"readwise-export"', '"readwise export"']) {
    assert.deepEqual(await names(query), ['readwise-export.md'])
  }
  for (const query of ['foo_bar', '"foo bar"']) {
    assert.deepEqual((await names(query)).sort(), ['foo_bar.md', 'readwise-export.md'])
  }
  for (const query of ['岸夜', '北', '"hello world"', 'readwise #topic [[Target]] src:document']) {
    assert.deepEqual(await names(query), ['readwise-export.md'])
  }
  assert.deepEqual(await names('readwise #missing'), [])
  assert.deepEqual(await names('readwise [[Missing]]'), [])
  assert.deepEqual(await names('readwise src:bookmark'), [])
})

test('without FTS5 filenames and titles filter compound terms; body search remains unavailable', async t => {
  if (skipIfSqliteUnavailable(t, 'Library degraded title search')) return
  const f = fixture(); t.after(f.close)
  f.db.exec('DROP TRIGGER documents_ad; DROP TABLE documents_fts')
  assert.equal(probeFts5Availability(f.db), false)
  const engine = new SearchEngine(f.db, { fts5Available: false })
  t.after(() => engine.cancelPendingWorkspaceResolves())
  for (const [name, raw] of [
    ['readwise-export.md', 'bodyonly'],
    ['Other.md', '---\ntitle: foo_bar\n---\nbodyonly'],
    ['Partial.md', '---\ntitle: readwise\n---\nbodyonly'],
  ]) {
    const path = join(f.root, name); writeFileSync(path, raw)
    assert.equal((await engine.indexDocument(f.root, path)).ok, true)
  }
  const names = async (query: string) => {
    const found = await engine.search(query)
    assert.equal(found.degraded, true)
    return found.items.map(h => h.name).sort()
  }
  assert.deepEqual(await names('readwise'), ['Partial.md', 'readwise-export.md'])
  assert.deepEqual(await names('export'), ['readwise-export.md'])
  for (const query of ['foo', 'bar', 'foo_bar', '"foo bar"']) assert.deepEqual(await names(query), ['Other.md'])
  assert.deepEqual(await names('readwise-export'), ['readwise-export.md'])
  assert.deepEqual(await names('not-present'), [])
  assert.deepEqual(await names('bodyonly'), [])
})

test('old libraries upgrade without a user rebuild, recover interruptions and retain incremental/delete behavior', async t => {
  if (skipIfSqliteUnavailable(t, 'Library search index migration')) return
  const f = fixture(); t.after(f.close)
  for (let i = 0; i < 53; i += 1) {
    writeFileSync(join(f.root, `page-${i}.md`), `---\ntitle: Title${i} 验收目标\n---\nreadwise-export foo_bar`)
  }
  assert.equal((await f.engine.reindexWorkspace({ root: f.root })).ok, true)
  const path = join(f.root, 'page-52.md')
  const bytes = readFileSync(path)
  const objectId = f.registry.find(path)!.id
  f.engine.cancelPendingWorkspaceResolves()
  f.db.exec(`DROP TRIGGER documents_ad;
    ALTER TABLE documents_fts RENAME TO fixture_current_fts;
    CREATE VIRTUAL TABLE documents_fts USING fts5(name,body,tokenize="unicode61 remove_diacritics 2 tokenchars '_-'");
    INSERT INTO documents_fts(rowid,name,body) SELECT rowid,name,body FROM fixture_current_fts;
    DROP TABLE fixture_current_fts;
    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN DELETE FROM documents_fts WHERE rowid=old.id; END;
    UPDATE documents SET content_hash='fts-cjk-bigram-v2:old';
    DELETE FROM migrations WHERE name='160_search_titles_and_token_boundaries';`)
  const old = f.engine
  assert.deepEqual((await old.search('Title52')).items, [])
  assert.deepEqual((await old.search('readwise')).items, [])
  f.db.exec("CREATE TRIGGER reject_search_upgrade BEFORE UPDATE OF content_hash ON documents BEGIN SELECT RAISE(ABORT,'fixture upgrade interrupted'); END")
  assert.throws(() => runMigrations(f.db), /fixture upgrade interrupted/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM documents_fts').get().n, 53)
  assert.deepEqual((await old.search('readwise')).items, [])
  f.db.exec('DROP TRIGGER reject_search_upgrade')
  runMigrations(f.db)
  const engine = new SearchEngine(f.db, { fts5Available: true })
  t.after(() => engine.cancelPendingWorkspaceResolves())
  assert.equal((await engine.search('Title52')).items[0].path, path)
  for (const query of ['readwise', 'export', 'foo', 'bar', 'readwise-export', 'foo_bar', '验收']) {
    assert.equal((await engine.search(query)).items.length, 53, query)
  }
  runMigrations(f.db)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM documents_fts').get().n, 53)
  assert.equal((await engine.reindexWorkspace({ root: f.root })).indexed, 53)
  assert.equal((await engine.reindexWorkspace({ root: f.root })).indexed, 0)
  assert.equal(f.registry.find(path)!.id, objectId)
  assert.deepEqual(readFileSync(path), bytes)
  engine.getRepository().deletePath(engine.getRepository().ensureWorkspace(f.root), path)
  assert.deepEqual((await engine.search('Title52')).items, [])
})
