import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { databaseFixture } from './utils/database-native-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('DB-B cold Main read: 1000 indexed rows <=500ms without warming the database cache', t => {
  if (skipIfSqliteUnavailable(t, 'M5-B cold read performance')) return
  const f = databaseFixture(1000)
  t.after(() => f.close())
  const start = performance.now(), snapshot = f.service.read(f.databaseId), elapsed = performance.now() - start
  console.log(`DB-B COLD READ files=1000 elapsed=${elapsed.toFixed(1)}ms`)
  assert.deepEqual(new Set(snapshot.rows.map(row => row.id)), new Set(f.ids))
  assert.ok(snapshot.rows.every(row => row.values.未知 && row.version))
  assert.ok(elapsed <= 500, `Cold Main read took ${elapsed.toFixed(1)}ms`)
})
