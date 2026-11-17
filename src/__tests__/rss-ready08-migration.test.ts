import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __getMigrationNamesForTests, __runMigrationForTests, runMigrations } from '../main/modules/migrations'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { ChatStore } from '../main/modules/database/chat-store'
import { ChannelStore } from '../main/modules/database/channel-store'
import { RSSStore } from '../main/modules/database/rss-store'
import { backupBeforeRSSMigration } from '../main/modules/database/rss-migration-backup'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('full Ready 0.8 schema upgrades RSS atomically and retains conversation/channel states on disk reopen', (t) => {
  if (skipIfSqliteUnavailable(t, 'Ready 0.8 migration')) return
  const SQLite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
  const root = mkdtempSync(join(tmpdir(), 'rss-ready08-')), path = join(root, 'ready.db')
  let db = new SQLite(path)
  try {
    db.exec('CREATE TABLE migrations(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL)')
    const oldNames = __getMigrationNamesForTests().filter((name) => Number(name.slice(0, 3)) <= 123)
    assert.equal(oldNames.length, 123)
    for (const name of oldNames) {
      db.exec('BEGIN'); __runMigrationForTests(name, db)
      db.prepare('INSERT INTO migrations(name,applied_at) VALUES(?,?)').run(name, 'synthetic-old')
      db.exec('COMMIT')
    }
    const chat = new ChatStore(() => db), channels = new ChannelStore(() => db)
    chat.createConversation('conversation', 'ready', 'Synthetic old chat')
    chat.addChatMessage('message', 'conversation', 'user', 'Preserved old message', '2026-09-30T00:00:00Z')
    db.exec("UPDATE chat_conversations SET message_visibility_epoch=message_visibility_epoch+1,closed_at='2026-10-01T00:00:00Z',closed_reason='closed',close_evidence_digest='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE id='conversation'")
    channels.upsertAgentChannel({ id: 'channel', type: 'telegram', name: 'Synthetic', enabled: false, configJson: '{}' })
    channels.upsertAgentChannelEvent({ eventId: 'event', channelId: 'channel', status: 'pending' })
    db.exec("UPDATE agent_channel_events SET payload_json='{\"synthetic\":true}' WHERE event_id='event'; INSERT INTO rss_sources(id,name,url) VALUES('source','Source','https://upgrade.invalid/feed'); INSERT INTO rss_items(id,source_id,guid,title,link,summary,read,starred,inbox_visible,ai_tags) VALUES('old','source','old','Old article','https://upgrade.invalid/old','Original summary',1,1,0,'旧标签,完整名称');")
    const preserved = () => ({ chat: db.prepare('SELECT * FROM chat_conversations WHERE id=?').get('conversation'), message: db.prepare('SELECT * FROM chat_messages WHERE id=?').get('message'), channel: db.prepare('SELECT * FROM agent_channel_events WHERE event_id=?').get('event') })
    const before = preserved()
    db.pragma?.('journal_mode=WAL'); db.pragma?.('foreign_keys=ON')
    const backup = backupBeforeRSSMigration(db, path)!
    assert.ok(backup.includes('before-rss-124'))
    const broken = { exec(sql: string) { if (sql.includes('CREATE TABLE rss_definitions')) throw new Error('synthetic migration failure'); db.exec(sql) }, prepare: db.prepare.bind(db), close: () => {}, pragma: db.pragma?.bind(db) }
    assert.throws(() => runMigrations(broken), /synthetic migration failure/)
    assert.equal(db.prepare('SELECT name FROM migrations WHERE name=?').get('125_rss_organization'), undefined)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='rss_definitions'").get(), undefined)
    assert.deepEqual(preserved(), before)
    db.close(); db = new SQLite(path); runMigrations(db)
    // Migration 161 adds a nullable marker to messages; an old message is kept as it was and marks nothing replaced.
    assert.deepEqual(preserved(), { ...before, message: { ...(before.message as Record<string, unknown>), replaced_by_run_id: null } })
    const rss = new RSSStore(() => db), article = rss.content.getArticle('old')!
    assert.equal(article.read, true); assert.equal(article.starred, true); assert.equal(article.inboxVisible, false)
    assert.equal(article.summary, 'Original summary')
    assert.ok(article.classifications.some((entry) => entry.name === '旧标签,完整名称'))
    assert.equal(db.prepare('SELECT daily_eligible AS value FROM rss_items WHERE id=?').get<{ value: number }>('old')!.value, 0)
    assert.deepEqual(db.prepare('SELECT name FROM migrations WHERE applied_at=? ORDER BY id').all<{ name: string }>('synthetic-old').map((row) => row.name), oldNames)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migrations').get<{ n: number }>()!.n, __getMigrationNamesForTests().length)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.ok(readdirSync(join(root, 'backups')).length > 0)
    const old = new SQLite(backup)
    try { assert.equal(old.prepare('SELECT COUNT(*) AS n FROM migrations').get<{ n: number }>()!.n, 123) } finally { old.close() }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
