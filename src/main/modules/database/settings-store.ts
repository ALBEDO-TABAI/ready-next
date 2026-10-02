import type { DatabaseConnection } from './connection'
import { assertDatabaseConnectionReady } from './connection'

export class SettingsStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}

  private get db(): DatabaseConnection | null {
    return this.getConnection()
  }


  // ===================== Settings (key-value) =====================

  getSetting(key: string): string | undefined {
    assertDatabaseConnectionReady(this.db, 'settings database')
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get<{ value: string }>(key)
    return row?.value
  }

  setSetting(key: string, value: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, new Date().toISOString())
  }

  deleteSetting(key: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  getAllSettings(): Record<string, string> {
    assertDatabaseConnectionReady(this.db, 'settings database')
    const rows = this.db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    return result
  }
}
