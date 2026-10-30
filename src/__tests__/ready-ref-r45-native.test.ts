import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { runMigrations, __runMigrationForTests } from '../main/modules/migrations'
import { readChatReadyRefDisplay } from '../main/modules/database/ready-ref-migration'
import { ChatStore } from '../main/modules/database/chat-store'
import { RSSStore } from '../main/modules/database/rss-store'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { RSSReferenceSchema, rssReferencePath } from '../shared/rss-reference'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const migration = '145_chat_ready_refs'
function fixture() {
  const db: DatabaseConnection = new Database(':memory:'); runMigrations(db)
  db.exec("INSERT INTO chat_conversations(id,agent,title,created_at,updated_at,source_id) VALUES ('open','butler','Open','now','now','open'),('closed','butler','Closed','now','now','closed');")
  const rss = new RSSStore(() => db)
  const source = rss.addRSSSource({ name: 'Fixture', url: 'https://example.test/feed' })
  rss.upsertRSSItems([{ id: 'item', source_id: source, guid: 'item', title: 'Article', link: 'https://example.test/article', summary: 'Saved text' }])
  const reference = RSSReferenceSchema.parse({ kind: 'article', read: { itemId: 'item', expectedRevision: rss.content.getArticle('item')!.revision, offset: 1, length: 3 } })
  const legacy = `ready-rss://reference?data=${encodeURIComponent(JSON.stringify(reference))}`
  const attachments = [
    { id: 'browser', name: 'Web', source: 'browser-tab', browserTabId: 'expired', path: 'browser-tab://expired', url: 'https://example.test/page' },
    { id: 'draft', name: 'Draft', source: 'document-tab', path: 'doc-tab://tab', selection: 'unsaved text' },
    { id: 'quote', name: 'Quote', source: 'document-quote', path: 'document-quote://123', selection: 'quoted text' },
    { id: 'rss', name: 'RSS', source: 'rss-reference', path: `rss-reference://${encodeURIComponent(JSON.stringify(reference))}`, rssReference: reference },
    { id: 'missing', name: 'Missing', source: 'browser-tab', path: 'browser-tab://missing' },
  ]
  const content = `[source](${legacy})\n\n\`${legacy}\`\n\n\`\`\`\n${legacy}\n\`\`\``
  for (const [id, scope, role] of [['a', 'open', 'user'], ['b', 'closed', 'user'], ['c', 'open', 'assistant'], ['tool', 'open', 'tool']]) {
    db.prepare('INSERT INTO chat_messages(id,conversation_id,role,content,timestamp,meta_json,message_visibility_epoch) VALUES (?,?,?,?,?,?,0)')
      .run(id, scope, role, content, 'now', JSON.stringify({ attachments, receipt: legacy, readyRefDisplay: { content: 'untrusted display' } }))
  }
  db.exec("UPDATE chat_conversations SET closed_at='closed' WHERE id='closed'")
  return { db, reference, content }
}

test('R45 real SQLite preserves immutable history and text, rewrites structured attachments and rebuilds indexes exactly once', t => {
  if (skipIfSqliteUnavailable(t, 'R45 history migration')) return
  const { db, reference, content } = fixture(); t.after(() => db.close())
  const immutable = db.prepare("SELECT * FROM chat_messages WHERE id<>'a' ORDER BY id").all()
  __runMigrationForTests(migration, db)
  const row = db.prepare("SELECT * FROM chat_messages WHERE id='a'").get<{meta_json:string;content:string}>()!
  const meta = JSON.parse(row.meta_json)
  assert.equal(row.content, content)
  assert.equal(meta.attachments[0].path, 'ready://web?url=https%3A%2F%2Fexample.test%2Fpage')
  assert.equal(meta.attachments[0].browserTabId, undefined)
  assert.deepEqual(meta.attachments.slice(1,3).map((a: {path:string;selection:string}) => [a.path,a.selection]), [['','unsaved text'],['','quoted text']])
  assert.equal(meta.attachments[3].path, rssReferencePath(reference))
  assert.ok(meta.attachments[4].referenceMigration.reason)
  assert.deepEqual(db.prepare("SELECT * FROM chat_messages WHERE id<>'a' ORDER BY id").all(), immutable)
  const display = readChatReadyRefDisplay(db, 'b')!
  assert.equal(display.attachments?.[3].path, rssReferencePath(reference))
  assert.equal(display.content, content.replace(content.slice(9, content.indexOf(')')), rssReferencePath(reference)))
  const chat = new ChatStore(() => db)
  assert.deepEqual(chat.getChatMessages('closed'), [])
  assert.ok(JSON.parse(chat.getChatMessages('open')[0].meta_json!).readyRefDisplay)
  assert.equal(JSON.parse(chat.getChatMessages('open').find(row => row.id === 'tool')!.meta_json!).readyRefDisplay, undefined)
  assert.equal(db.prepare("SELECT count(*) n FROM session_recall_attachment_index WHERE source_message_id='a'").get<{n:number}>()!.n, 5)
  assert.equal(db.prepare("SELECT content FROM chat_messages_fts WHERE message_id='a'").get<{content:string}>()!.content, content)
  const before = db.prepare('SELECT total_changes() n').get()
  __runMigrationForTests(migration, db)
  assert.deepEqual(db.prepare('SELECT total_changes() n').get(), before)
  db.exec("UPDATE chat_ready_ref_display SET content_digest='bad' WHERE message_id='b'")
  assert.throws(() => readChatReadyRefDisplay(db, 'b'), /摘要/)
})

test('R45 migration rollback resumes after interruption without partial messages or duplicate mappings', t => {
  if (skipIfSqliteUnavailable(t, 'R45 interrupted migration')) return
  const { db } = fixture(); t.after(() => db.close())
  const before = db.prepare('SELECT * FROM chat_messages ORDER BY id').all()
  db.exec("CREATE TRIGGER interrupt_r45 BEFORE INSERT ON chat_ready_ref_display WHEN NEW.message_id='b' BEGIN SELECT RAISE(ABORT,'interrupted'); END")
  assert.throws(() => __runMigrationForTests(migration, db), /interrupted/)
  assert.deepEqual(db.prepare('SELECT * FROM chat_messages ORDER BY id').all(), before)
  assert.equal(db.prepare('SELECT count(*) n FROM chat_ready_ref_display').get<{n:number}>()!.n, 0)
  db.exec('DROP TRIGGER interrupt_r45')
  __runMigrationForTests(migration, db)
  assert.equal(db.prepare('SELECT count(*) n FROM chat_ready_ref_display').get<{n:number}>()!.n, 3)
})

test('R45 migration resolves saved document identity and records malformed, missing and stale RSS causes without widening', t => {
  if (skipIfSqliteUnavailable(t, 'R45 rejected references')) return
  const { db, reference } = fixture(); t.after(() => db.close())
  db.prepare(`INSERT INTO objects(id,kind,current_path,path_key,last_known_path,status,identity_state,observed_since)
    VALUES ('document','markdown','/fixture/saved.md','/fixture/saved.md','/fixture/saved.md','present','local',1)`).run()
  const attachments = [
    { id: 'doc', name: 'Document', source: 'document-tab', path: '/fixture/saved.md', selection: 'uncommitted edits', dirty: true },
    { id: 'quote', name: 'Quote', source: 'document-quote', path: '/fixture/saved.md', selection: 'selected' },
    { id: 'bad', name: 'Bad encoding', source: 'rss-reference', path: 'rss-reference://%XX' },
    { id: 'version', name: 'Missing revision', source: 'rss-reference', path: 'rss-reference://x', rssReference: { kind: 'article', read: { itemId: 'item' } } },
    { id: 'stale', name: 'Stale', source: 'rss-reference', path: 'rss-reference://x', rssReference: { ...reference, read: { itemId: 'item', expectedRevision: 'stale' } } },
    { id: 'range', name: 'Bad range', source: 'rss-reference', path: 'rss-reference://x', rssReference: { kind: 'excerpt', read: { itemId: 'item', expectedRevision: reference.kind === 'article' ? reference.read.expectedRevision : '', format: 'reading-v1', range: { start: { run: 0, offset: 0 }, end: { run: 0, offset: 999 } } } } },
  ]
  db.prepare("UPDATE chat_messages SET meta_json=? WHERE id='a'").run(JSON.stringify({ attachments }))
  __runMigrationForTests(migration, db)
  const result = JSON.parse(db.prepare("SELECT meta_json FROM chat_messages WHERE id='a'").get<{meta_json:string}>()!.meta_json).attachments
  assert.deepEqual(result.slice(0,2).map((a: {path:string}) => a.path), ['ready://doc/page/document', 'ready://doc/page/document'])
  assert.equal(result[0].selection, 'uncommitted edits'); assert.equal(result[0].dirty, true)
  for (const a of result.slice(2)) { assert.equal(a.path, ''); assert.ok(a.referenceMigration.reason) }
  assert.match(result[4].referenceMigration.reason, /article_changed/)
  assert.match(result[5].referenceMigration.reason, /range/)
})

test('R45 smoke fixture and display projections survive closing and reopening an actual database file', async t => {
  if (skipIfSqliteUnavailable(t, 'R45 disk restart')) return
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { seedR45History } = await import(new URL('../../scripts/verify-ready-next-smoke-electron.cjs', import.meta.url).href)
  const root = mkdtempSync(join(tmpdir(), 'r45-restart-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const { db } = fixture()
  __runMigrationForTests(migration, db)
  const history = await seedR45History(db, 'http://127.0.0.1:12345/')
  const expected = readChatReadyRefDisplay(db, 'b')
  const file = join(root, 'ready.db')
  db.prepare('VACUUM INTO ?').run(file); db.close()
  const reopened = new Database(file); t.after(() => reopened.close())
  runMigrations(reopened)
  assert.deepEqual(readChatReadyRefDisplay(reopened, 'b'), expected)
  const chat = new ChatStore(() => reopened)
  const rows = chat.getChatMessages(history.scopeId)
  const attachments = JSON.parse(rows[0].meta_json!).attachments
  assert.equal(attachments[0].path, 'ready://web?url=http%3A%2F%2F127.0.0.1%3A12345%2F')
  assert.equal(attachments[0].browserTabId, undefined)
  assert.equal(attachments[1].path, rssReferencePath(history.reference))
  const rss = new RSSStore(() => reopened)
  assert.equal(rss.content.readExcerpt(attachments[1].rssReference.read).text, 'exact')
})
