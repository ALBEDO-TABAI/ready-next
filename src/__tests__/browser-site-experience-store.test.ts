import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserSiteExperienceStore } from '../main/modules/browser-engine/browser-site-experience-store'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

interface TestDb {
  exec(sql: string): void
  prepare<T = unknown>(sql: string): {
    run(...params: unknown[]): unknown
    all<R = unknown>(...params: unknown[]): R[]
    get<R = unknown>(...params: unknown[]): R | undefined
  }
}

async function buildDb(): Promise<TestDb> {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:') as unknown as TestDb
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  return db
}

test('BrowserSiteExperienceStore queries active same-domain hints', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser site experience query')) return
  const db = await buildDb()
  const store = new BrowserSiteExperienceStore(db as never)
  store.upsert({
    id: 'exp-1',
    domain: 'example.com',
    pathPattern: '/shop',
    appliesToTaskKinds: ['official-entry-resolution'],
    aliases: ['Example'],
    reliableEntryPatterns: ['Use the nav Store link before guessing product URLs'],
    generatedLinkPatterns: ['Product links carry /shop/item/ after site navigation'],
    knownTraps: [{ kind: 'soft_404', description: 'content not found can appear before hydration', recovery: 'wait and read map again' }],
    selectorsOrTargetHints: [{ purpose: 'search', hint: 'header search textbox', confidence: 0.8 }],
    frameHints: [],
    riskLevel: 'medium',
    confidence: 0.82,
    source: 'test-fixture',
    lastVerifiedAt: '2026-06-09T00:00:00.000Z',
    expiresAt: '2026-07-09T00:00:00.000Z',
  })

  const hints = store.queryHints({
    url: 'https://www.example.com/shop/list',
    taskKind: 'official-entry-resolution',
    now: new Date('2026-06-10T00:00:00.000Z'),
  })

  assert.equal(hints.length, 1)
  assert.equal(hints[0].domain, 'example.com')
  assert.equal(hints[0].riskLevel, 'medium')
  assert.match(hints[0].hint, /Use the nav Store link/)
  assert.match(hints[0].hint, /soft_404/)
})

test('BrowserSiteExperienceStore filters expired and cross-task hints', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser site experience filtering')) return
  const db = await buildDb()
  const store = new BrowserSiteExperienceStore(db as never)
  store.upsert({
    id: 'expired',
    domain: 'example.com',
    appliesToTaskKinds: ['visible-list-collect'],
    aliases: [],
    reliableEntryPatterns: ['old pattern'],
    generatedLinkPatterns: [],
    knownTraps: [],
    selectorsOrTargetHints: [],
    frameHints: [],
    riskLevel: 'low',
    confidence: 0.9,
    source: 'test-fixture',
    lastVerifiedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
  })

  assert.equal(store.queryHints({
    url: 'https://example.com/feed',
    taskKind: 'visible-list-collect',
    now: new Date('2026-06-10T00:00:00.000Z'),
  }).length, 0)
  assert.equal(store.queryHints({
    url: 'https://example.com/feed',
    taskKind: 'upload-and-submit-proof',
    now: new Date('2026-01-15T00:00:00.000Z'),
  }).length, 0)
})

test('BrowserSiteExperienceStore cannot lower high-control platform risk', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser site experience high control')) return
  const db = await buildDb()
  const store = new BrowserSiteExperienceStore(db as never)
  store.upsert({
    id: 'xiaohongshu-low',
    domain: 'xiaohongshu.com',
    appliesToTaskKinds: [],
    aliases: [],
    reliableEntryPatterns: ['low risk looking entry'],
    generatedLinkPatterns: [],
    knownTraps: [],
    selectorsOrTargetHints: [],
    frameHints: [],
    riskLevel: 'low',
    confidence: 0.9,
    source: 'test-fixture',
    lastVerifiedAt: '2026-06-09T00:00:00.000Z',
  })

  const hints = store.queryHints({
    url: 'https://www.xiaohongshu.com/explore/abc',
    now: new Date('2026-06-10T00:00:00.000Z'),
  })

  assert.equal(hints.length, 1)
  assert.equal(hints[0].riskLevel, 'high')
})
