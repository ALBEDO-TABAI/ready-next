import type { DatabaseConnection } from '../database/connection'
import { emptyNavigation, NavigationStateSchema, type NavigationState } from '../../../shared/navigation-history'
import type { MigrationDatabase } from '../migrations'

export function migrateNavigationHistory(db: MigrationDatabase): void {
  db.exec('CREATE TABLE navigation_history (id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL, revision INTEGER NOT NULL)')
}
/** Main owns the durable cursor. A stale renderer must reload instead of overwriting newer history. */
export class NavigationHistoryRepository {
  constructor(private readonly db: DatabaseConnection) {}
  read(): NavigationState {
    const row = this.db.prepare('SELECT state_json FROM navigation_history WHERE id=1').get<{ state_json: string }>()
    return row ? NavigationStateSchema.parse(JSON.parse(row.state_json)) : emptyNavigation()
  }
  save(input: NavigationState): NavigationState {
    const state = NavigationStateSchema.parse(input)
    this.db.exec('SAVEPOINT navigation_history_save')
    try {
      if (this.read().revision !== state.revision) throw new Error('Navigation history changed; reload before retrying')
      const saved = { ...state, revision: state.revision + 1 }
      this.db.prepare('INSERT INTO navigation_history(id,state_json,revision) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,revision=excluded.revision').run(JSON.stringify(saved), saved.revision)
      this.db.exec('RELEASE navigation_history_save')
      return saved
    } catch (error) {
      this.db.exec('ROLLBACK TO navigation_history_save'); this.db.exec('RELEASE navigation_history_save'); throw error
    }
  }
}
