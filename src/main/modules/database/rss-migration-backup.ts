import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseConnection } from './connection'
import { RSS_CONTENT_MIGRATION } from '../rss-engine/content-schema'

/** Capture the existing database, including committed WAL data, before the RSS schema changes. */
export function backupBeforeRSSMigration(db: DatabaseConnection, databasePath: string): string | null {
  if (databasePath === ':memory:') return null
  const migrations = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'").get()
  if (!migrations || db.prepare('SELECT name FROM migrations WHERE name=?').get(RSS_CONTENT_MIGRATION)) return null
  if (!db.prepare('SELECT name FROM migrations LIMIT 1').get()) return null
  const directory = join(dirname(databasePath), 'backups')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `before-rss-079-${Date.now()}-${randomUUID()}.sqlite`)
  db.prepare('VACUUM INTO ?').run(path)
  return path
}
