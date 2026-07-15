import assert from 'node:assert/strict'
import test from 'node:test'

import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

interface TestDatabase extends MigrationDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all<T = unknown>(...params: unknown[]): T[]
    get<T = unknown>(...params: unknown[]): T | undefined
  }
  close(): void
}

async function openDatabase(): Promise<TestDatabase> {
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as TestDatabase
}

function createRSSSchema(db: TestDatabase): void {
  db.exec(`
    CREATE TABLE rss_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL
    );
    CREATE TABLE rss_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      guid TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      summary TEXT,
      cover_image TEXT,
      author TEXT,
      published_at INTEGER,
      fetched_at INTEGER NOT NULL,
      inbox_visible INTEGER DEFAULT 1,
      read INTEGER DEFAULT 0,
      starred INTEGER DEFAULT 0,
      ai_score INTEGER,
      ai_tags TEXT
    );
    CREATE TABLE rss_analysis_jobs (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      source_url TEXT NOT NULL
    );
  `)
}

function insertItem(db: TestDatabase, item: {
  id: string
  sourceId: string
  guid: string
  title: string
  link: string
  summary?: string | null
  coverImage?: string | null
  publishedAt: number
  fetchedAt: number
  inboxVisible?: number
  read?: number
  starred?: number
}): void {
  db.prepare(`
    INSERT INTO rss_items (
      id, source_id, guid, title, link, summary, cover_image, author,
      published_at, fetched_at, inbox_visible, read, starred
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '作者', ?, ?, ?, ?, ?)
  `).run(
    item.id,
    item.sourceId,
    item.guid,
    item.title,
    item.link,
    item.summary ?? null,
    item.coverImage ?? null,
    item.publishedAt,
    item.fetchedAt,
    item.inboxVisible ?? 1,
    item.read ?? 0,
    item.starred ?? 0,
  )
}

test('migration 076 merges URL aliases by content identity while preserving user state', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-076 rss item identity')) return
  const db = await openDatabase()
  createRSSSchema(db)
  db.prepare('INSERT INTO rss_sources (id, name, url, platform) VALUES (?, ?, ?, ?)')
    .run('source-bili', '影视飓风', 'https://space.bilibili.com/946974', 'bilibili')
  db.prepare('INSERT INTO rss_sources (id, name, url, platform) VALUES (?, ?, ?, ?)')
    .run('source-rss', 'Hacker News', 'https://news.ycombinator.com/rss', 'rss')

  insertItem(db, {
    id: 'dynamic-alias',
    sourceId: 'source-bili',
    guid: 'https://t.bilibili.com/1224473984725155860',
    title: '相同标题',
    link: 'https://t.bilibili.com/1224473984725155860',
    summary: '动态正文。视频地址：https://www.bilibili.com/video/BV1d2N16KEh6',
    publishedAt: 1783933466,
    fetchedAt: 100,
    read: 0,
  })
  insertItem(db, {
    id: 'bilibili_32618f4530e1',
    sourceId: 'source-bili',
    guid: 'https://www.bilibili.com/video/BV1d2N16KEh6',
    title: '相同标题',
    link: 'https://www.bilibili.com/video/BV1d2N16KEh6',
    summary: '干净的视频简介',
    publishedAt: 1783933466,
    fetchedAt: 200,
    inboxVisible: 0,
    read: 1,
    starred: 1,
  })
  insertItem(db, {
    id: 'tracked-alias',
    sourceId: 'source-bili',
    guid: 'https://www.bilibili.com/video/BV1d2N16KEh6/?spm_id_from=333.1387.upload.video_card.click',
    title: '相同标题',
    link: 'https://www.bilibili.com/video/BV1d2N16KEh6/?spm_id_from=333.1387.upload.video_card.click',
    coverImage: 'https://example.com/cover.jpg',
    publishedAt: 1783933466,
    fetchedAt: 300,
  })
  insertItem(db, {
    id: 'same-title-different-video',
    sourceId: 'source-bili',
    guid: 'https://www.bilibili.com/video/BV1LoN76dEmF',
    title: '相同标题',
    link: 'https://www.bilibili.com/video/BV1LoN76dEmF',
    publishedAt: 1783933466,
    fetchedAt: 250,
  })
  insertItem(db, {
    id: 'twitter-legacy',
    sourceId: 'source-rss',
    guid: 'https://twitter.com/a_green_being/status/2076598897779020159',
    title: 'Grok CLI uploaded the whole home directory to GCS',
    link: 'https://twitter.com/a_green_being/status/2076598897779020159',
    publishedAt: 1783949732,
    fetchedAt: 400,
  })
  insertItem(db, {
    id: 'twitter-generic',
    sourceId: 'source-rss',
    guid: 'https://twitter.com/i/status/2076598897779020159',
    title: 'Grok CLI uploaded the whole home directory to GCS',
    link: 'https://twitter.com/i/status/2076598897779020159',
    publishedAt: 1783949732,
    fetchedAt: 500,
    starred: 1,
  })
  db.prepare('INSERT INTO rss_analysis_jobs (id, item_id, source_url) VALUES (?, ?, ?)')
    .run('job-dynamic', 'dynamic-alias', 'https://t.bilibili.com/1224473984725155860')
  db.prepare('INSERT INTO rss_analysis_jobs (id, item_id, source_url) VALUES (?, ?, ?)')
    .run('job-tracked', 'tracked-alias', 'https://www.bilibili.com/video/BV1d2N16KEh6/?spm_id_from=tracking')

  __runMigrationForTests('076_canonicalize_rss_item_identity', db)

  const bilibiliRows = db.prepare(`
    SELECT * FROM rss_items WHERE source_id = 'source-bili' ORDER BY id
  `).all<Record<string, unknown>>()
  assert.equal(bilibiliRows.length, 2, 'same title and timestamp must retain the distinct Bilibili video')
  const merged = bilibiliRows.find((row) => row.id === 'bilibili_32618f4530e1')
  assert.ok(merged)
  assert.equal(merged.link, 'https://www.bilibili.com/video/BV1d2N16KEh6')
  assert.equal(merged.guid, 'https://www.bilibili.com/video/BV1d2N16KEh6')
  assert.equal(merged.summary, '干净的视频简介')
  assert.equal(merged.cover_image, 'https://example.com/cover.jpg')
  assert.equal(merged.read, 0, 'an unread alias keeps the merged item unread')
  assert.equal(merged.starred, 1, 'a starred alias keeps the merged item starred')
  assert.equal(merged.inbox_visible, 1, 'a visible alias keeps the merged item visible')
  assert.equal(merged.fetched_at, 300)

  const distinct = bilibiliRows.find((row) => row.id !== 'bilibili_32618f4530e1')
  assert.equal(distinct?.link, 'https://www.bilibili.com/video/BV1LoN76dEmF')

  const twitterRows = db.prepare(`
    SELECT id, link, guid, starred FROM rss_items WHERE source_id = 'source-rss'
  `).all<Record<string, unknown>>()
  assert.deepEqual(twitterRows, [{
    id: 'twitter_148e678d133e',
    link: 'https://x.com/i/status/2076598897779020159',
    guid: 'https://x.com/i/status/2076598897779020159',
    starred: 1,
  }])

  const jobs = db.prepare('SELECT id, item_id, source_url FROM rss_analysis_jobs ORDER BY id')
    .all<Record<string, unknown>>()
  assert.deepEqual(jobs, [
    {
      id: 'job-dynamic',
      item_id: 'bilibili_32618f4530e1',
      source_url: 'https://www.bilibili.com/video/BV1d2N16KEh6',
    },
    {
      id: 'job-tracked',
      item_id: 'bilibili_32618f4530e1',
      source_url: 'https://www.bilibili.com/video/BV1d2N16KEh6',
    },
  ])

  assert.doesNotThrow(() => __runMigrationForTests('076_canonicalize_rss_item_identity', db))
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rss_items').get<{ count: number }>()?.count, 3)
  db.close()
})
