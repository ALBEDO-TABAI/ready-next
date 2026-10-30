import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { databaseFixture } from './utils/database-native-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('DB-B cold and warm reads retain identities and unknown values; changed and new files refresh together', t => {
  if (skipIfSqliteUnavailable(t, 'M5-B read correctness')) return
  const f = databaseFixture(2)
  t.after(() => f.close())
  const revisions = f.ids.map(id => f.registry.get(id)!.revision)
  const before = f.paths.map((_, i) => f.read(i))
  const first = f.service.read(f.databaseId)
  assert.deepEqual(first.rows.map(row => row.id), f.ids)
  assert.deepEqual(f.ids.map(id => f.registry.get(id)!.revision), revisions, 'reading indexed, unchanged files must not re-register them')
  assert.deepEqual(first.rows[0].values.未知, { keep: true })
  assert.deepEqual(f.paths.map((_, i) => f.read(i)), before)
  first.rows[0].values.未知 = 'caller mutation'
  assert.deepEqual(f.service.read(f.databaseId).rows[0].values.未知, { keep: true })
  // A filesystem replacement keeps the row identity, even with the same bytes.
  const replacement = join(f.root, 'replacement.md')
  writeFileSync(replacement, before[0]); renameSync(replacement, f.paths[0])
  writeFileSync(f.paths[1], before[1].replace('分数: 2', '分数: 9'))
  const added = join(f.root, '库', 'new.md'); writeFileSync(added, '---\n分数: 12\n---\nnew body\n')
  const next = f.service.read(f.databaseId)
  assert.equal(next.rows.length, 3)
  assert.equal(next.rows.find(row => row.id === f.ids[0])!.version, first.rows[0].version)
  assert.equal(next.rows.find(row => row.id === f.ids[1])!.values.分数, 9)
  assert.equal(next.rows.find(row => row.title === 'new')!.id, f.registry.find(added)!.id)
  assert.ok(f.registry.get(f.ids[0])!.revision > revisions[0])
  assert.ok(f.registry.get(f.ids[1])!.revision > revisions[1])
})

test('DB-B cached reads still obey registry revisions and reject conflicting identities', t => {
  if (skipIfSqliteUnavailable(t, 'M5-B read revisions')) return
  const f = databaseFixture(1)
  t.after(() => f.close())
  f.service.read(f.databaseId)
  f.db.prepare("UPDATE objects SET identity_state='conflict',embedded_ready_id=id,revision=revision+1 WHERE id=?").run(f.ids[0])
  assert.throws(() => f.service.read(f.databaseId), /Object unavailable/)
  f.db.prepare("UPDATE objects SET identity_state='local',embedded_ready_id=NULL,revision=revision+1 WHERE id=?").run(f.ids[0])
  assert.equal(f.service.read(f.databaseId).rows[0].id, f.ids[0])
})
