import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { __runMigrationForTests } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const require = createRequire(import.meta.url)
function fixture() {
  const Database = require('better-sqlite3') as new (path: string) => DatabaseConnection
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE documents (id INTEGER PRIMARY KEY, workspace_id INTEGER, path TEXT,
    source_type TEXT, source_id TEXT, source_meta_json TEXT, UNIQUE(workspace_id, path));`)
  return db
}
const migration = '135_search_ready_refs'
const migrate = (db: DatabaseConnection) => __runMigrationForTests(migration, db)

test('search refs migrate in place, remove invalid index rows and perform no writes on replay', t => {
  if (skipIfSqliteUnavailable(t, 'search ReadyRef migration')) return
  const db = fixture()
  t.after(() => db.close())
  const insert = db.prepare('INSERT INTO documents VALUES (?, 1, ?, ?, ?, ?)')
  insert.run(1, 'rss://article /中文', 'rss', 'article /中文', '{}')
  insert.run(2, 'calendar://series#1800000000', 'calendar', 'series#1800000000', '{"allDay":false}')
  insert.run(3, 'agent://conversation', 'agent', 'conversation', '{}')
  insert.run(4, 'https://example.com/a?q=中文#part', 'bookmark', 'bookmark', '{}')
  insert.run(5, 'bookmark://empty', 'bookmark', 'empty', '{}')
  insert.run(6, 'rss://', 'rss', '', '{}')
  insert.run(7, '/workspace/file.md', 'document', null, null)
  insert.run(8, 'calendar://all-day#1793318400', 'calendar', 'all-day#1793318400', '{"allDay":true}')
  insert.run(9, 'calendar://series-only', 'calendar', 'series-only', '{"startTime":1800000000}')
  insert.run(10, 'calendar://bad#nan', 'calendar', 'bad#nan', '{"allDay":false}')
  insert.run(11, 'ready://calendar/event/bad#occurrence=nan', 'calendar', 'bad', '{}')
  insert.run(12, 'rss://bad-json', 'rss', 'bad-json', '{')
  migrate(db)
  const rows = () => db.prepare('SELECT id, path FROM documents ORDER BY id').all()
  const expected = [
    { id: 1, path: 'ready://rss/item/article%20%2F%E4%B8%AD%E6%96%87' },
    { id: 2, path: 'ready://calendar/event/series#occurrence=1800000000000' },
    { id: 3, path: 'ready://agent/conversation/conversation' },
    { id: 4, path: 'ready://web?url=https%3A%2F%2Fexample.com%2Fa%3Fq%3D%E4%B8%AD%E6%96%87%23part' },
    { id: 7, path: '/workspace/file.md' },
    { id: 8, path: 'ready://calendar/event/all-day#occurrence=2026-10-30' },
    { id: 9, path: 'ready://calendar/event/series-only' },
  ]
  assert.deepEqual(rows(), expected)
  const changes = db.prepare('SELECT total_changes() AS n').get()
  migrate(db)
  assert.deepEqual(rows(), expected)
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), changes)
})

test('search ref duplicates keep one canonical row per object, scoped by workspace', t => {
  if (skipIfSqliteUnavailable(t, 'search ReadyRef conflict')) return
  const db = fixture()
  t.after(() => db.close())
  db.exec(`INSERT INTO documents VALUES (1,1,'rss://a','rss','a','{}'),
    (2,1,'ready://rss/item/a','rss','a','{}'),
    (3,1,'bookmark://empty','bookmark','empty','{}'),
    (4,2,'rss://a','rss','a','{}')`)
  migrate(db)
  // The row already in canonical form is kept; the old-form duplicate is dropped.
  assert.deepEqual(db.prepare('SELECT id, workspace_id, path FROM documents ORDER BY id').all(), [
    { id: 2, workspace_id: 1, path: 'ready://rss/item/a' },
    { id: 4, workspace_id: 2, path: 'ready://rss/item/a' },
  ])
  migrate(db)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get<{n:number}>()?.n, 2)
})

test('migration rolls back deletions and updates when the affected row count differs', t => {
  if (skipIfSqliteUnavailable(t, 'search ReadyRef row count')) return
  const db = fixture()
  t.after(() => db.close())
  db.exec(`INSERT INTO documents VALUES (1,1,'rss://a','rss','a','{}'), (2,1,'bookmark://empty','bookmark','empty','{}');
    CREATE TRIGGER refuse_update BEFORE UPDATE ON documents BEGIN SELECT RAISE(IGNORE); END;`)
  const before = db.prepare('SELECT * FROM documents').all()
  assert.throws(() => migrate(db), /row count mismatch/)
  assert.deepEqual(db.prepare('SELECT * FROM documents').all(), before)
})

test('real adapters, search, graph and file tools preserve non-file references without granting file reads', async t => {
  if (skipIfSqliteUnavailable(t, 'search ReadyRef adapter/tool integration')) return
  const { runMigrations } = await import('../main/modules/migrations')
  const { SearchEngine } = await import('../main/modules/search-engine/indexer')
  const { BookmarkAdapter, RssAdapter, CalendarAdapter, AgentMessageAdapter } = await import('../main/modules/search-engine/adapters')
  const { queryDocumentGraph } = await import('../main/modules/database/document-graph-query')
  const { isOpenableDocumentNode } = await import('../renderer/components/graph/graph-view-model')
  const { executeFileManagementTool, buildFileLocatePathCandidates } = await import('../main/modules/tools/file-management-tools')
  const { __setWorkerDbBridgeForTest } = await import('../main/modules/database/worker-bridge')
  const Database = require('better-sqlite3') as new (path: string) => DatabaseConnection
  const db = new Database(':memory:')
  t.after(() => { __setWorkerDbBridgeForTest(null); db.close() })
  runMigrations(db)
  db.exec(`
    INSERT INTO browser_bookmarks(id,url,title) VALUES ('b','https://example.com/path?q=1#top','needle bookmark'), ('empty','','needle empty'), ('bad','file:///tmp/a','needle bad');
    INSERT INTO rss_sources(id,name,url) VALUES ('feed','Feed','https://example.com/feed');
    INSERT INTO rss_items(id,source_id,guid,title,link) VALUES ('article /中文','feed','g','needle rss','https://example.com/article');
    INSERT INTO calendar_sources(id,name,color) VALUES ('cal','Calendar','#000000');
    INSERT INTO calendar_events(id,calendar_id,title,start_time,end_time,all_day,recurrence_rule,ics_uid,created_at,updated_at)
      VALUES ('timed','cal','needle timed',1800000000,1800003600,0,'FREQ=DAILY;COUNT=2','timed@fixture',1,1);
    INSERT INTO calendar_events(id,calendar_id,title,start_date,end_date,all_day,recurrence_rule,ics_uid,created_at,updated_at)
      VALUES ('day','cal','needle day','2026-10-30','2026-10-31',1,'FREQ=DAILY;COUNT=2','day@fixture',1,1);
    INSERT INTO calendar_event_overrides(id,parent_event_id,occurrence_start,kind,patch_json,created_at,updated_at)
      VALUES ('ov1','timed',1800000000,'single','{"start_time":1800007200,"end_time":1800010800}',1,1),
      ('ov2','day',1793318400,'single','{"start_date":"2026-11-02","end_date":"2026-11-03"}',1,1);
    INSERT INTO chat_conversations(id,agent,title,created_at,updated_at) VALUES ('conversation','butler','needle conversation','2026-10-30','2026-10-30');
    INSERT INTO chat_messages(id,conversation_id,role,content,timestamp,message_visibility_epoch) VALUES ('message','conversation','user','needle visible message','2026-10-30',0);
  `)
  const engine = new SearchEngine(db, { fts5Available: true })
  const repository = engine.getRepository()
  const workspaceId = repository.ensureWorkspace('@shared')
  const ctx = { repository, workspaceId, workspaceRoot: '@shared' }
  const bookmarks = await new BookmarkAdapter().reindex(ctx)
  assert.deepEqual(bookmarks, { indexed: 1, skipped: 2, removed: 0, scanned: 3 })
  for (const adapter of [new RssAdapter(), new CalendarAdapter(), new AgentMessageAdapter()]) await adapter.reindex(ctx)
  const paths = db.prepare('SELECT path FROM documents ORDER BY path').all<{path:string}>().map(r => r.path)
  assert.deepEqual(paths, [
    'ready://agent/conversation/conversation',
    'ready://calendar/event/day', 'ready://calendar/event/day#occurrence=2026-10-30',
    'ready://calendar/event/timed', 'ready://calendar/event/timed#occurrence=1800000000000',
    'ready://rss/item/article%20%2F%E4%B8%AD%E6%96%87',
    'ready://web?url=https%3A%2F%2Fexample.com%2Fpath%3Fq%3D1%23top',
  ])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browser_bookmarks').get<{n:number}>()?.n, 3)
  const beforeMigration = db.prepare('SELECT id, path FROM documents ORDER BY id').all<{id:number;path:string}>()
  const identities = db.prepare('SELECT id, source_type, source_id, source_meta_json FROM documents').all<{
    id: number; source_type: string; source_id: string; source_meta_json: string
  }>()
  for (const row of identities) {
    const oldPath = row.source_type === 'bookmark' ? JSON.parse(row.source_meta_json).url : `${row.source_type}://${row.source_id}`
    db.prepare('UPDATE documents SET path=? WHERE id=?').run(oldPath, row.id)
  }
  const stablePaths = beforeMigration
  db.prepare("INSERT INTO object_links(id,source_ref,kind,raw_target,target_text,target_ref,resolved) VALUES ('test',?,'wikilink','article','article',?,1)").run(stablePaths.find(r=>r.id===identities[0].id)!.path,stablePaths.find(r=>r.id===identities[1].id)!.path)
  migrate(db)
  assert.deepEqual(db.prepare('SELECT id, path FROM documents ORDER BY id').all(), beforeMigration)
  assert.equal(queryDocumentGraph(db).edges.length, 1)
  const search = await engine.search('needle')
  assert.deepEqual(search.items.map(i => i.path).sort(), paths)
  const graph = queryDocumentGraph(db)
  assert.deepEqual(graph.nodes.map(n => n.path).sort(), paths)
  for (const node of graph.nodes) assert.equal(isOpenableDocumentNode(node), false)
  __setWorkerDbBridgeForTest({
    searchDocuments: opts => engine.search(opts.query, opts),
    getDocumentGraph: async () => { throw new Error('unused') },
    reindexWorkspace: async () => { throw new Error('unused') },
    reindexAllSources: async () => { throw new Error('unused') },
    shutdown: async () => {}, __isAvailable: () => true,
  })
  const found = JSON.parse(await executeFileManagementTool('file_search', { query: 'needle' }, { searchEngine: engine }))
  assert.deepEqual(found.items.map((i: {path:string}) => i.path).sort(), paths)
  for (const path of [...paths, 'ready://rss/item/missing.md']) {
    for (const tool of ['file_locate', 'file_read_excerpt']) {
      const result = JSON.parse(await executeFileManagementTool(tool, { path }, { searchEngine: engine }))
      assert.equal(result.ok, false, `${tool}: ${path}`)
      assert.match(result.error, /non-filesystem/)
      assert.equal(result.content, undefined)
    }
  }
  assert.deepEqual(buildFileLocatePathCandidates('[secret.md](ready://rss/item/missing.md)'), ['ready://rss/item/missing.md'])
  const { resolveIndexedDocumentCandidate } = await import('../main/modules/tools/file-locate-path')
  db.prepare(`INSERT INTO documents(workspace_id,path,name,source_type) VALUES (?, '/tmp/missing.md','missing.md','document')`).run(workspaceId)
  assert.equal(resolveIndexedDocumentCandidate(db, 'ready://rss/item/missing.md').kind, 'missing')
})

// The existing worker-bridge injection substitutes only the database transport in this test process.
export const __breaksInvariants = ['database.worker-bridge.singleton-replaced-for-isolated-search-test'] as const
