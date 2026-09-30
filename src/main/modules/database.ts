import type { DatabaseConnection } from './database/connection'
import { DatabaseUnavailableError, assertDatabaseConnectionReady } from './database/connection'
export { DatabaseUnavailableError, assertDatabaseConnectionReady } from './database/connection'
import { RSSStore } from './database/rss-store'
import { CalendarStore } from './database/calendar-store'
import { BrowserStore } from './database/browser-store'
import { ChatStore } from './database/chat-store'
import { SettingsStore } from './database/settings-store'
import { ChannelStore } from './database/channel-store'
import { createRequire } from 'module'
import { join } from 'path'
import { runMigrations } from './migrations'
import { backupBeforeRSSMigration } from './database/rss-migration-backup'
import { createRotatingLogger } from '../utils/rotating-logger'

// Use CommonJS `require('electron')` rather than `import { app } from 'electron'`.
// Electron's Node entry (node_modules/electron/index.js) exports a string path
// via `module.exports =`, so ESM `import { app }` fails with
// "does not provide an export named 'app'" in non-Electron Node contexts
// (tsx tests, tool-registry static-import chain). In real Electron runtime
// `require('electron')` returns the module with `app`/`BrowserWindow`/...,
// and call-time access still works identically.
const electronModule = (() => {
  try { return createRequire(import.meta.url)('electron') as typeof import('electron') }
  catch { return {} as typeof import('electron') }
})()
const { app } = electronModule

type BetterSqliteConstructor = new (path: string) => DatabaseConnection

let DatabaseConstructor: BetterSqliteConstructor | null = null
let DatabaseConstructorLoadError: unknown = null
const require = createRequire(import.meta.url)
const databaseLogger = createRotatingLogger('ready-database.log')

function logDatabase(message: string): void {
  try { databaseLogger.append(`[${new Date().toISOString()}] ${message}\n`) } catch { /* ignore */ }
}

function formatDatabaseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Lazy load better-sqlite3 to handle missing module gracefully
try {
  const betterSqlite3 = require('better-sqlite3') as BetterSqliteConstructor & {
    default?: BetterSqliteConstructor
  }
  DatabaseConstructor = betterSqlite3.default || betterSqlite3
  logDatabase('better-sqlite3 loaded successfully')
} catch (error) {
  DatabaseConstructorLoadError = error
  logDatabase(`better-sqlite3 load failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  console.warn('better-sqlite3 not available; primary database cannot open until native bindings are rebuilt')
}

export function assertBetterSqliteNativeAvailable(): void {
  if (!DatabaseConstructor) {
    throw new DatabaseUnavailableError(
      `better-sqlite3 native binding is unavailable for this runtime (ABI ${process.versions.modules || 'unknown'})`,
      DatabaseConstructorLoadError,
    )
  }

  let probeDb: DatabaseConnection | null = null
  try {
    probeDb = new DatabaseConstructor(':memory:')
    const row = probeDb.prepare('SELECT 1 AS ok').get<{ ok: number }>()
    if (row?.ok !== 1) {
      throw new Error(`unexpected sqlite smoke result: ${JSON.stringify(row)}`)
    }
  } catch (error) {
    throw new DatabaseUnavailableError(
      `better-sqlite3 loaded but failed a SQLite smoke check (ABI ${process.versions.modules || 'unknown'}): ${formatDatabaseError(error)}`,
      error,
    )
  } finally {
    try { probeDb?.close() } catch { /* ignore probe cleanup */ }
  }
}

export interface PrimaryDatabaseReadyOptions {
  checkNative?: () => void
  getDatabaseInstance?: () => Pick<DatabaseManager, 'getRawDb'>
}

export function assertPrimaryDatabaseReady(options: PrimaryDatabaseReadyOptions = {}): void {
  const checkNative = options.checkNative || assertBetterSqliteNativeAvailable
  checkNative()

  const manager = options.getDatabaseInstance ? options.getDatabaseInstance() : getDatabase()
  const rawDb = manager.getRawDb()
  assertDatabaseConnectionReady(rawDb, 'primary database')

  try {
    rawDb.prepare('SELECT value FROM settings WHERE key = ?').get('__ready_db_probe__')
  } catch (error) {
    throw new DatabaseUnavailableError(
      `primary database opened but settings table probe failed: ${formatDatabaseError(error)}`,
      error,
    )
  }
}

// SQLite PRAGMA tuning. Defaults (cache_size=2000 pages ~8MB, journal=DELETE,
// synchronous=FULL, mmap_size=0) cause cache miss on every query for a multi-GB
// DB. Each pragma runs in its own try/catch so a single platform-specific
// failure (e.g. WAL on a Windows network drive) does not block the others.
const PERFORMANCE_PRAGMAS: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'journal_mode', value: 'WAL' },
  { name: 'synchronous', value: 'NORMAL' },
  { name: 'cache_size', value: '-65536' },     // 64 MB cache (negative = KB)
  { name: 'mmap_size', value: '2147483648' },  // 2 GB mmap window
  { name: 'temp_store', value: 'MEMORY' },
]

export function applyPerformancePragmas(db: DatabaseConnection): void {
  if (typeof db.pragma !== 'function') {
    logDatabase('pragma() unavailable on db; skipping performance tuning')
    return
  }
  for (const { name, value } of PERFORMANCE_PRAGMAS) {
    try {
      const result = db.pragma(`${name} = ${value}`)
      logDatabase(`pragma applied ${name}=${value} result=${JSON.stringify(result)}`)
    } catch (error) {
      logDatabase(`pragma failed ${name}=${value} error=${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    const userVersion = db.pragma('user_version', { simple: true })
    logDatabase(`pragma user_version=${JSON.stringify(userVersion)}`)
  } catch (error) {
    logDatabase(`pragma user_version read failed error=${error instanceof Error ? error.message : String(error)}`)
  }
}

export class DatabaseManager {
  private db: DatabaseConnection | null = null
  private dbPath: string
  private useMemoryDb: boolean
  readonly rss = new RSSStore(() => this.db)
  readonly calendar = new CalendarStore(() => this.db)
  readonly browser = new BrowserStore(() => this.db)
  readonly chat = new ChatStore(() => this.db)
  readonly settings = new SettingsStore(() => this.db)
  readonly channels = new ChannelStore(() => this.db)


  constructor(useMemoryDb = false) {
    this.useMemoryDb = useMemoryDb

    if (this.useMemoryDb) {
      this.dbPath = ':memory:'
    } else {
      if (!DatabaseConstructor) {
        throw new DatabaseUnavailableError(
          'better-sqlite3 native binding is unavailable; cannot open primary ready.db',
          DatabaseConstructorLoadError,
        )
      }
      try {
        if (!app || typeof app.getPath !== 'function') {
          throw new Error('Electron app.getPath is unavailable')
        }
        const userDataPath = app.getPath('userData')
        this.dbPath = join(userDataPath, 'ready.db')
      } catch (error) {
        throw new DatabaseUnavailableError(
          `Cannot resolve Ready userData database path: ${formatDatabaseError(error)}`,
          error,
        )
      }
    }

    this.init()
  }

  private init(): void {
    try {
      if (!DatabaseConstructor) {
        logDatabase('DatabaseConstructor unavailable; database disabled')
        throw new DatabaseUnavailableError(
          'better-sqlite3 native binding is unavailable; database disabled',
          DatabaseConstructorLoadError,
        )
      }

      logDatabase(`opening database path=${this.dbPath}`)
      this.db = new DatabaseConstructor(this.dbPath)
      applyPerformancePragmas(this.db)
      this.createTables()
      logDatabase(`database initialized path=${this.dbPath}`)
    } catch (error) {
      logDatabase(`database initialization failed path=${this.dbPath} error=${error instanceof Error ? error.stack || error.message : String(error)}`)
      console.error('Database initialization failed:', error)
      try { this.db?.close() } catch (closeError) {
        logDatabase(`failed initialization cleanup: ${formatDatabaseError(closeError)}`)
      }
      this.db = null
      if (error instanceof DatabaseUnavailableError) throw error
      throw new DatabaseUnavailableError(
        `Database initialization failed for ${this.dbPath}: ${formatDatabaseError(error)}`,
        error,
      )
    }
  }

  getRawDb(): DatabaseConnection | null {
    return this.db
  }

  private createTables(): void {
    if (!this.db) return

    const backup = backupBeforeRSSMigration(this.db, this.dbPath)
    if (backup) logDatabase(`RSS migration backup created: ${backup}`)
    // Run the migration system to create/update all tables and indexes
    runMigrations(this.db)

    // Seed default calendar sources
    const defaultSources = [
      { id: 'work', name: '工作日程', color: '#5B8DEF' },
      { id: 'content', name: '内容创作', color: '#E97A2B' },
      { id: 'holiday', name: '节假日', color: '#34D399' },
      { id: 'personal', name: '个人', color: '#8B5CF6' }
    ]

    const insertSource = this.db.prepare(
      'INSERT OR IGNORE INTO calendar_sources (id, name, color) VALUES (?, ?, ?)'
    )
    for (const source of defaultSources) {
      insertSource.run(source.id, source.name, source.color)
    }
  }

  getDatabase(): DatabaseConnection | null {
    return this.db
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

// Singleton instance
let dbInstance: DatabaseManager | null = null

export function getDatabase(): DatabaseManager {
  if (!dbInstance) {
    dbInstance = new DatabaseManager()
  }
  return dbInstance
}

// For backward compatibility
export { DatabaseManager as Database }
