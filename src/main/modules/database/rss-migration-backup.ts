import { RSS_SIEVE_LEARNING_MIGRATION } from '../rss-engine/sieve-learning-schema'
import { RSS_SIEVE_MIGRATION } from '../rss-engine/sieve-schema'
import { RSS_DIGEST_MIGRATION } from '../rss-engine/digest-schema'
import { RSS_CATALOG_MIGRATION } from '../rss-engine/catalog-schema'
import { RSS_METHOD_VALIDITY_MIGRATION } from '../rss-engine/method-validity-schema'
import { RSS_TRANSLATION_MIGRATION } from '../rss-engine/translation-schema'
import { RSS_RESULT_MIGRATION } from '../rss-engine/result-schema'
import { RSS_ORGANIZATION_MIGRATION } from '../rss-engine/organization-schema'
import { RSS_PROCESSING_MIGRATION } from '../rss-engine/processing-schema'
import { RSS_EVENT_MIGRATION } from '../rss-engine/event-schema'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseConnection } from './connection'
import { RSS_CONTENT_MIGRATION } from '../rss-engine/content-schema'

/** Capture the existing database, including committed WAL data, before the RSS schema changes. */
export function backupBeforeRSSMigration(db: DatabaseConnection, databasePath: string): string | null {
  if (databasePath === ':memory:') return null
  const migrations = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'").get()
  if (!migrations) return null
  const pending = [RSS_CONTENT_MIGRATION, RSS_ORGANIZATION_MIGRATION, RSS_PROCESSING_MIGRATION, RSS_EVENT_MIGRATION, RSS_RESULT_MIGRATION, RSS_DIGEST_MIGRATION, RSS_CATALOG_MIGRATION, RSS_METHOD_VALIDITY_MIGRATION, RSS_TRANSLATION_MIGRATION, RSS_SIEVE_MIGRATION, RSS_SIEVE_LEARNING_MIGRATION].find((name) => !db.prepare('SELECT name FROM migrations WHERE name=?').get(name))
  if (!pending) return null
  if (!db.prepare('SELECT name FROM migrations LIMIT 1').get()) return null
  const directory = join(dirname(databasePath), 'backups')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const prefix = `before-rss-${pending.slice(0, 3)}-`
  const path = join(directory, `${prefix}${Date.now()}-${randomUUID()}.sqlite`)
  db.prepare('VACUUM INTO ?').run(path)
  // A step that keeps failing would otherwise leave one full copy per launch; keep only the newest.
  for (const name of readdirSync(directory)) {
    if (name.startsWith(prefix) && name.endsWith('.sqlite') && join(directory, name) !== path) rmSync(join(directory, name), { force: true })
  }
  return path
}
