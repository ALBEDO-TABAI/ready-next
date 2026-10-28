import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations } from '../main/modules/migrations'
import { RSSStore } from '../main/modules/database/rss-store'
import { CalendarStore } from '../main/modules/database/calendar-store'
import { BrowserStore } from '../main/modules/database/browser-store'
import { ChatStore } from '../main/modules/database/chat-store'
import { SettingsStore } from '../main/modules/database/settings-store'
import { ChannelStore } from '../main/modules/database/channel-store'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('domain stores share the owning connection and stop using it after close', (t) => {
  if (skipIfSqliteUnavailable(t, 'domain store ownership')) return
  const manager = new DatabaseManager(true)
  const { rss, settings } = manager
  try {
    const db = manager.getRawDb()!
    db.exec('BEGIN')
    const id = rss.addRSSSource({ name: 'Rollback', url: 'https://example.test/rollback' })
    settings.setSetting('storage-test', 'rolled-back')
    db.exec('ROLLBACK')
    assert.equal(rss.getRSSSources().some((source) => source.id === id), false)
    assert.equal(settings.getSetting('storage-test'), undefined)
    assert.equal('getRSSSources' in manager, false, 'no second domain API on the connection owner')
    assert.equal('getSetting' in manager, false)
  } finally {
    manager.close()
  }
  assert.deepEqual(rss.getRSSSources(), [])
  assert.throws(() => rss.addRSSSource({ name: 'Closed', url: 'https://example.test/closed' }), /not available/)
  assert.throws(() => settings.getSetting('storage-test'), /not available/)
  assert.equal(manager.getRawDb(), null)
})

test('all six stores read the same persisted records after a connection is reopened', (t) => {
  if (skipIfSqliteUnavailable(t, 'domain store persistence')) return
  const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new(path: string) => DatabaseConnection
  const directory = mkdtempSync(join(tmpdir(), 'ready-domain-stores-'))
  const path = join(directory, 'synthetic.db')
  let db: DatabaseConnection | null = new Sqlite(path)
  const getConnection = () => db
  const rss = new RSSStore(getConnection)
  const calendar = new CalendarStore(getConnection)
  const browser = new BrowserStore(getConnection)
  const chat = new ChatStore(getConnection)
  const settings = new SettingsStore(getConnection)
  const channels = new ChannelStore(getConnection)
  try {
    runMigrations(db)
    const sourceId = rss.addRSSSource({ name: 'Test', url: 'https://example.test/feed' })
    rss.upsertRSSItems([{ id: 'item', source_id: sourceId, guid: 'item', title: 'Design', link: 'https://example.test/item' }])
    const definition = rss.organization.save({ name: '设计', description: '设计资讯' })
    rss.organization.setManual({ itemId: 'item', expectedArticleRevision: rss.content.getArticle('item')!.revision, definitionId: definition.id, expectedRuleRevision: definition.ruleRevision, decision: true })
    rss.markRSSRead('item')
    rss.toggleRSSStarred('item')
    rss.dismissRSSItemsFromInbox(['item'])
    const calendarId = calendar.addCalendarSource({ name: 'Test calendar', color: '#123456' })
    const eventId = 'domain-store-event'
    calendar.mutate({type:'create',event:{id:eventId,uid:eventId,calendarId,title:'Test event',start:1000000,end:2000000,allDay:false,timeZone:'UTC',status:'confirmed',transparency:'opaque',createdAt:Date.now(),updatedAt:Date.now()}},{})
    browser.addBookmark('https://example.test', 'Test bookmark')
    chat.createConversation('conversation', 'assistant', 'Test conversation')
    chat.addChatMessage('message', 'conversation', 'user', 'Test message', '2026-09-30T00:00:00Z')
    settings.setSetting('storage-test', 'saved')
    channels.upsertAgentChannel({ id: 'channel', type: 'feishu', name: 'Test channel', enabled: false, configJson: '{}' })
    db.close()
    db = null
    assert.deepEqual(rss.getRSSSources(), [])
    db = new Sqlite(path)
    const [item] = rss.getRSSItemsByIds(['item'])
    assert.deepEqual([item?.classifications[0].name, item?.read, item?.starred, item?.inbox_visible], ['设计', 1, 1, 0])
    assert.equal(calendar.getCalendarEventById(eventId)?.title, 'Test event')
    assert.equal(browser.getBookmarks()[0]?.title, 'Test bookmark')
    assert.equal(chat.getChatMessages('conversation')[0]?.content, 'Test message')
    assert.equal(settings.getSetting('storage-test'), 'saved')
    assert.equal(channels.getAgentChannel('channel')?.name, 'Test channel')
  } finally {
    db?.close()
    db = null
    rmSync(directory, { recursive: true, force: true })
  }
})
