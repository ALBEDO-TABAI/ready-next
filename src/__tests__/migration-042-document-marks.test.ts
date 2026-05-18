import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

interface MigrationDb {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all<R = unknown>(...params: unknown[]): R[]
    get<R = unknown>(...params: unknown[]): R | undefined
  }
}

async function buildInMemoryDb(): Promise<MigrationDb> {
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDb
}

test('migration 042 — creates document marks table and indexes', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-042 document marks')) return
  const { runMigrations } = await import('../main/modules/migrations')
  const db = await buildInMemoryDb()
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])

  const columns = db
    .prepare(`PRAGMA table_info(document_marks)`)
    .all<{ name: string }>()
    .map((column) => column.name)

  assert.deepEqual(
    ['id', 'kind', 'document_path', 'title', 'group_name', 'note_text', 'excerpt', 'line_start', 'line_end', 'anchor_title', 'anchor_ordinal', 'anchor_progress', 'anchor_status', 'sort_order', 'created_at', 'updated_at']
      .every((name) => columns.includes(name)),
    true,
  )

  db.prepare(`
    INSERT INTO document_marks (
      id, kind, document_path, title, group_name, excerpt,
      line_start, line_end, anchor_status, sort_order, created_at, updated_at
    )
    VALUES (
      'dm-1', 'bookmark', '/tmp/doc.md', '标题', '默认', '摘录',
      3, 3, 'linked', 1, '2026-05-18T00:00:00.000Z', '2026-05-18T00:00:00.000Z'
    )
  `).run()

  const row = db
    .prepare(`SELECT kind, document_path, title, group_name FROM document_marks WHERE id = 'dm-1'`)
    .get<{ kind: string; document_path: string; title: string; group_name: string }>()

  assert.deepEqual(row, {
    kind: 'bookmark',
    document_path: '/tmp/doc.md',
    title: '标题',
    group_name: '默认',
  })
})
