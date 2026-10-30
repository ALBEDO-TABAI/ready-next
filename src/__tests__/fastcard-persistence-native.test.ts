import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations } from '../main/modules/migrations'
import { FastCardRepository } from '../main/modules/repositories/fastcard-repository'
import { setupBrowserFastCardIPC } from '../main/modules/browser-engine/ipc-fastcard'
import type { FastCardItem } from '../shared/fastcard'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const item: FastCardItem = {
  id: 'all-fields', kind: 'video', createdAt: 1234567890,
  title: '标题', text: '正文\n第二行', imageUrl: 'https://example.com/a.png', alt: '',
  caption: '图注', description: '描述', originalText: 'hello', translatedText: '你好',
  targetLanguage: 'zh-CN', tags: ['one', '中文'],
  source: { pageUrl: 'https://example.com', pageTitle: '来源', domain: 'example.com', tabId: null, capturedAt: 12 },
  video: { originalUrl: 'original', pageUrl: 'page', playableUrl: 'play', downloadUrl: 'download',
    posterUrl: 'poster', title: 'video', author: 'author', platform: 'platform', durationSeconds: 1.5,
    parseStatus: 'failed', error: '解析失败' },
}

// C7: receipt means durable; fresh connections preserve every field and insertion order.
// Host Node skips with an [ABI-SKIP] token; verify:native runs this file under Electron for real coverage.
test('C7 repository round trip, restart, ordering, repeat delivery and deletion', (t) => {
  if (skipIfSqliteUnavailable(t, 'FastCard persistence')) return
  const dir = mkdtempSync(join(tmpdir(), 'ready-fastcard-'))
  let db = new Database(join(dir, 'ready.db'))
  try {
    runMigrations(db)
    const repository = new FastCardRepository(db)
    assert.deepEqual(repository.add(item), item)
    assert.deepEqual(repository.add(item), item)
    assert.throws(() => repository.add({ ...item, text: 'conflict' }), /already exists/)
    const variants = ['text', 'image', 'translation', 'image-description'] as const
    const items = variants.map((kind, index) => ({ ...item, id: kind, kind, createdAt: index }))
    for (const value of items) repository.add(value)
    db.close()
    db = new Database(join(dir, 'ready.db'))
    runMigrations(db)
    const restarted = new FastCardRepository(db)
    assert.deepEqual(restarted.list(), [...items].reverse().concat(item))
    restarted.remove('image')
    restarted.remove('missing')
    assert.deepEqual(restarted.list().map(value => value.id), ['image-description', 'translation', 'text', 'all-fields'])
    restarted.clear()
    assert.deepEqual(new FastCardRepository(db).list(), [])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C7 registered IPC add/list/remove/clear return receipts and expose failures', async (t) => {
  if (skipIfSqliteUnavailable(t, 'FastCard IPC persistence')) return
  const db = new Database(':memory:')
  runMigrations(db)
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  setupBrowserFastCardIPC({
    getMainWindow: () => null, preloadPath: '', rendererFile: '',
    getRepository: () => new FastCardRepository(db),
    ipc: { handle: (channel, listener) => { handlers.set(channel, listener) } },
  })
  const invoke = async (action: string, payload?: unknown) => {
    const handler = handlers.get(`browser:fastCard${action}`)
    assert.ok(handler, `registered channel: ${action}`)
    return await handler({}, payload)
  }
  try {
    assert.deepEqual(await invoke('Add', item), { success: true, data: item })
    assert.deepEqual(await invoke('List'), { success: true, data: [item] })
    assert.partialDeepStrictEqual(await invoke('Add', { ...item, kind: 'unknown' }), { success: false })
    assert.partialDeepStrictEqual(await invoke('Add', { ...item, video: { parseStatus: 'bad' } }), { success: false })
    assert.partialDeepStrictEqual(await invoke('Remove', 123), { success: false })
    assert.deepEqual(await invoke('List'), { success: true, data: [item] })
    db.exec('PRAGMA query_only = ON')
    for (const [action, payload] of [['Add', { ...item, id: 'denied' }], ['Remove', item.id], ['Clear', undefined]]) {
      assert.partialDeepStrictEqual(await invoke(String(action), payload), { success: false })
      assert.deepEqual(await invoke('List'), { success: true, data: [item] })
    }
    db.exec('PRAGMA query_only = OFF')
    assert.deepEqual(await invoke('Remove', item.id), { success: true })
    assert.deepEqual(await invoke('List'), { success: true, data: [] })
    await invoke('Add', item)
    assert.deepEqual(await invoke('Clear'), { success: true })
    assert.deepEqual(await invoke('List'), { success: true, data: [] })
  } finally { db.close() }
  assert.partialDeepStrictEqual(await invoke('Add', item), { success: false })
  assert.partialDeepStrictEqual(await invoke('List'), { success: false })
})
