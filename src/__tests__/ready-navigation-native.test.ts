import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../main/modules/migrations'
import { NavigationHistoryRepository } from '../main/modules/navigation-history/repository'
import { NavigationController } from '../renderer/modules/workbench/navigation-controller'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('157 persists last 50 objects, anchors and cursor across database reopen and rejects stale writers', async t => {
  if (skipIfSqliteUnavailable(t, 'navigation history')) return
  const root = mkdtempSync(join(tmpdir(), 'rn-h-')), path = join(root, 'ready.db')
  let db = new Database(path)
  try {
    runMigrations(db)
    let repository = new NavigationHistoryRepository(db)
    const controller = new NavigationController(() => ({ read: async () => repository.read(), save: async state => repository.save(state) }))
    for (let i = 0; i < 53; i++) await controller.open({ mode: 'document', ref: { kind: 'page', id: String(i) }, title: `页${i}`, openedAt: i, anchor: [{ selector: '2', top: i * 10, left: 0 }] }, async () => {})
    await controller.step(-1, async () => {})
    const before = repository.read()
    db.close(); db = new Database(path); runMigrations(db); repository = new NavigationHistoryRepository(db)
    const restored = new NavigationController(() => ({ read: async () => repository.read(), save: async state => repository.save(state) }))
    assert.deepEqual(await restored.load(), before)
    assert.equal(before.entries.length, 50); assert.equal(before.entries[0].title, '页3'); assert.equal(before.cursor, 48)
    let target = ''
    await restored.step(1, async entry => { target = entry.title; assert.equal(entry.anchor[0].top, 520) })
    assert.equal(target, '页52')
    assert.throws(() => repository.save(before), /changed/)
    assert.equal(db.prepare("SELECT count(*) AS n FROM migrations WHERE name='157_navigation_history'").get<{ n: number }>()?.n, 1)
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
