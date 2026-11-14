import type { DatabaseConnection } from '../database/connection'
import { assertDatabaseConnectionReady } from '../database/connection'
import type { MigrationDatabase } from '../migrations'

export interface BrowserWorkTabOwner {
  browserTaskId: string
  ownerRunId: string
  parentTaskId: string
  scopeId: string
  messageVisibilityEpoch: number
}

export interface BrowserWorkTabOwnership extends BrowserWorkTabOwner {
  tabId: string
  profile: string
  openerTabId: string | null
}

const sameOwner = `t.browserTaskId = browser_work_tab_ownership.browser_task_id
  AND t.ownerRunId = browser_work_tab_ownership.owner_run_id
  AND t.parentTaskId = browser_work_tab_ownership.parent_task_id
  AND t.scopeId = browser_work_tab_ownership.scope_id
  AND t.messageVisibilityEpoch = browser_work_tab_ownership.message_visibility_epoch`
const staleOwnership = `NOT EXISTS (SELECT 1 FROM browser_work_tab_tasks t WHERE ${sameOwner})`

export function migrateBrowserWorkTabOwnership(db: MigrationDatabase): void {
  db.exec(`
    CREATE TABLE browser_work_tab_ownership (
      tab_id TEXT PRIMARY KEY NOT NULL,
      browser_task_id TEXT NOT NULL REFERENCES browser_tasks(id) ON DELETE CASCADE,
      owner_run_id TEXT NOT NULL,
      parent_task_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      message_visibility_epoch INTEGER NOT NULL,
      profile TEXT NOT NULL,
      opener_tab_id TEXT
    );
    CREATE VIEW browser_work_tab_tasks AS
      SELECT b.id AS browserTaskId, p.run_id AS ownerRunId,
             p.task_id AS parentTaskId, p.scope_id AS scopeId,
             p.message_visibility_epoch AS messageVisibilityEpoch
      FROM browser_tasks b
      JOIN task_projections p ON p.task_id = b.parent_task_id
      JOIN chat_conversations c ON c.id = p.scope_id
      WHERE b.status NOT IN ('completed', 'failed', 'cancelled')
        AND p.status NOT IN ('completed', 'failed', 'cancelled', 'killed', 'done')
        AND b.created_by_run_id = p.run_id
        AND json_extract(b.active_execution_binding_json, '$.runId') = p.run_id
        AND c.closed_at IS NULL
        AND c.message_visibility_epoch = p.message_visibility_epoch;
  `)
  // Invalidation is part of the owning write, including canonical closeout and session deletion.
  for (const table of ['browser_tasks', 'task_projections', 'chat_conversations']) {
    for (const event of ['UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER browser_work_tabs_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} BEGIN
          DELETE FROM browser_work_tab_ownership WHERE ${staleOwnership};
        END`)
    }
  }
}

/** Durable grouping only. Physical targets, write admission and execution remain boot-local. */
export class BrowserWorkTabOwnershipStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}

  private get db(): DatabaseConnection {
    const db = this.getConnection()
    assertDatabaseConnectionReady(db)
    return db
  }

  captureOwner(browserTaskId: string): BrowserWorkTabOwner {
    const owner = this.db.prepare('SELECT * FROM browser_work_tab_tasks WHERE browserTaskId = ?')
      .get<BrowserWorkTabOwner>(browserTaskId)
    if (!owner) throw new Error('browser_work_tab_owner_not_active')
    return owner
  }

  add(tab: { id: string; profile?: string | null }, openerTabId: string | null, owner: BrowserWorkTabOwner): void {
    const saved = this.db.prepare(`
      INSERT INTO browser_work_tab_ownership (
        tab_id, browser_task_id, owner_run_id, parent_task_id, scope_id, message_visibility_epoch, profile, opener_tab_id
      )
      SELECT ?, browserTaskId, ownerRunId, parentTaskId, scopeId, messageVisibilityEpoch, ?, ? FROM browser_work_tab_tasks
      WHERE browserTaskId = ? AND ownerRunId = ? AND parentTaskId = ? AND scopeId = ?
        AND messageVisibilityEpoch = ?
      RETURNING tab_id
    `).get(tab.id, tab.profile || '', openerTabId, owner.browserTaskId, owner.ownerRunId,
      owner.parentTaskId, owner.scopeId, owner.messageVisibilityEpoch)
    if (!saved) throw new Error('browser_work_tab_owner_changed')
  }

  list(): BrowserWorkTabOwnership[] {
    return this.db.prepare(`
      SELECT t.*, tab_id AS tabId, profile, opener_tab_id AS openerTabId
      FROM browser_work_tab_ownership JOIN browser_work_tab_tasks t ON ${sameOwner}
      ORDER BY browser_work_tab_ownership.rowid
    `).all<BrowserWorkTabOwnership>()
  }

  reconcile(tabs: Iterable<{ id: string; profile?: string | null }>): void {
    const restored = Array.from(tabs, tab => ({ id: tab.id, profile: tab.profile || '' }))
    this.db.prepare(`DELETE FROM browser_work_tab_ownership
      WHERE ${staleOwnership} OR NOT EXISTS (
        SELECT 1 FROM json_each(?) restored
        WHERE json_extract(restored.value, '$.id') = tab_id
          AND json_extract(restored.value, '$.profile') = profile
      )`).run(JSON.stringify(restored))
  }

  close<T extends { success: boolean }>(tabId: string, close: () => T): T {
    const db = this.db
    if (!db.prepare('SELECT 1 FROM browser_work_tab_ownership WHERE tab_id = ?').get(tabId)) return close()
    db.exec('SAVEPOINT browser_work_tab_close')
    try {
      db.prepare('DELETE FROM browser_work_tab_ownership WHERE tab_id = ?').run(tabId)
      const result = close()
      if (!result.success) db.exec('ROLLBACK TO browser_work_tab_close')
      db.exec('RELEASE browser_work_tab_close')
      return result
    } catch (error) {
      db.exec('ROLLBACK TO browser_work_tab_close')
      db.exec('RELEASE browser_work_tab_close')
      throw error
    }
  }
}
