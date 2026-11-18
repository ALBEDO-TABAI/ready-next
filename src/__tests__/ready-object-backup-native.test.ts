import { verifyPrivateFile } from '../main/utils/windows-private-files'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { backupBeforeObjectMigration } from '../main/modules/object-service/schema'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection

// Migration 138 rebuilds file identity and its dependants, so a pre-138 database is copied first.
test('a database that still has file_identities is copied before the object migration', (t) => {
  if (skipIfSqliteUnavailable(t, 'Object migration backup')) return
  const dir = mkdtempSync(join(tmpdir(), 'ready-object-backup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'ready.db')
  const db = new Database(path)
  db.exec("CREATE TABLE file_identities (file_key TEXT PRIMARY KEY); INSERT INTO file_identities VALUES ('k1')")
  const backup = backupBeforeObjectMigration(db, path)
  db.close()
  assert.ok(backup && backup.startsWith(join(dir, 'backups')), String(backup))
  if (process.platform === 'win32') verifyPrivateFile(backup)
  else assert.equal(statSync(backup).mode & 0o777, 0o600)
  const copy = new Database(backup)
  assert.deepEqual(copy.prepare('SELECT file_key FROM file_identities').all(), [{ file_key: 'k1' }])
  copy.close()
})

test('no backup for in-memory, fresh or already migrated databases', (t) => {
  if (skipIfSqliteUnavailable(t, 'Object migration backup skip')) return
  const dir = mkdtempSync(join(tmpdir(), 'ready-object-backup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const memory = new Database(':memory:')
  memory.exec('CREATE TABLE file_identities (file_key TEXT PRIMARY KEY)')
  assert.equal(backupBeforeObjectMigration(memory, ':memory:'), null)
  memory.close()
  const path = join(dir, 'ready.db')
  const fresh = new Database(path)
  assert.equal(backupBeforeObjectMigration(fresh, path), null)
  fresh.exec('CREATE TABLE objects (id TEXT PRIMARY KEY)')
  assert.equal(backupBeforeObjectMigration(fresh, path), null)
  fresh.close()
  assert.deepEqual(readdirSync(dir).filter(name => name === 'backups'), [])
})
