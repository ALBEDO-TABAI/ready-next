import assert from 'node:assert/strict'
import test from 'node:test'

import { __getMigrationNamesForTests, runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

const MIGRATION_109 = '109_browser_target_claim_user_takeover'

function createPre109Schema(db: import('better-sqlite3').Database, withLateColumns: boolean): void {
  db.exec(`
    CREATE TABLE browser_target_claims (
      partition TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      physical_target_token TEXT,
      boot_incarnation_id TEXT,
      claim_id TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL,
      profile_id TEXT,
      surface TEXT NOT NULL,
      parent_task_id TEXT NOT NULL,
      browser_task_id TEXT NOT NULL,
      owner_run_id TEXT NOT NULL,
      scope_id TEXT,
      session_id TEXT,
      message_visibility_epoch INTEGER,
      state TEXT NOT NULL,
      suspension_checkpoint_id TEXT,
      suspension_reason TEXT,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ${withLateColumns ? "purpose TEXT NOT NULL DEFAULT 'user' CHECK (purpose IN ('user', 'ongoing')), acquired_turn_id TEXT," : ''}
      PRIMARY KEY (partition, tab_id),
      CHECK (generation >= 1),
      CHECK (surface IN ('user-view', 'agent-view')),
      CHECK (state IN ('held', 'user_owned', 'suspended', 'expired', 'released')),
      CHECK ((physical_target_token IS NULL) = (boot_incarnation_id IS NULL)),
      CHECK (state != 'held' OR physical_target_token IS NOT NULL),
      CHECK (
        (state IN ('user_owned', 'suspended')
          AND suspension_checkpoint_id IS NOT NULL AND suspension_reason IS NOT NULL)
        OR (state IN ('held', 'expired', 'released')
          AND suspension_checkpoint_id IS NULL AND suspension_reason IS NULL)
      )
    );
    CREATE INDEX idx_browser_target_claims_owner
      ON browser_target_claims(owner_run_id, state, updated_at DESC);
    CREATE INDEX idx_browser_target_claims_late
      ON browser_target_claims(${withLateColumns ? 'purpose, acquired_turn_id' : 'scope_id, state'});
    CREATE TRIGGER browser_target_claims_audit_update
      AFTER UPDATE ON browser_target_claims BEGIN SELECT 1; END;
    CREATE TABLE browser_target_claim_children (
      claim_id TEXT NOT NULL REFERENCES browser_target_claims(claim_id)
    );
  `)
  const lateColumns = withLateColumns ? ', purpose, acquired_turn_id' : ''
  const lateValues = withLateColumns ? ", 'ongoing', 'turn-late-109'" : ''
  db.exec(`
    INSERT INTO browser_target_claims (
      partition, tab_id, physical_target_token, boot_incarnation_id,
      claim_id, generation, profile_id, surface,
      parent_task_id, browser_task_id, owner_run_id, scope_id, session_id,
      message_visibility_epoch, state, suspension_checkpoint_id, suspension_reason,
      acquired_at, heartbeat_at, expires_at, updated_at${lateColumns}
    ) VALUES (
      'persist:browser', 'tab-109', 'boot-109:tab-109:1', 'boot-109',
      'claim-109', 1, NULL, 'agent-view',
      'parent-109', 'browser-109', 'run-109', 'scope-109', NULL,
      0, 'held', NULL, NULL, 1, 1, 1000, 1${lateValues}
    );
    INSERT INTO browser_target_claim_children (claim_id) VALUES ('claim-109');
  `)
}

function migrate(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `)
  for (const name of __getMigrationNamesForTests()) {
    if (name === MIGRATION_109) continue
    db.prepare('INSERT OR IGNORE INTO migrations (name, applied_at) VALUES (?, ?)').run(name, '2026-08-12T00:00:00.000Z')
  }
  runMigrations(db as unknown as MigrationDatabase)
}

function markOnly109Pending(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `)
  for (const name of __getMigrationNamesForTests()) {
    if (name === MIGRATION_109) continue
    db.prepare('INSERT OR IGNORE INTO migrations (name, applied_at) VALUES (?, ?)').run(name, '2026-08-12T00:00:00.000Z')
  }
}

test('migration 109 preserves deployed late columns, objects, child FKs, and allows checkpoint-free user takeover', (t) => {
  if (skipIfSqliteUnavailable(t, 'migration 109 browser takeover')) return
  const Database = loadSqliteAfterGuardForTest()
  for (const withLateColumns of [false, true]) {
    for (const foreignKeysBefore of [0, 1]) {
      for (const legacyBefore of [0, 1]) {
        const db = new Database(':memory:')
        try {
          db.pragma(`foreign_keys = ${foreignKeysBefore ? 'ON' : 'OFF'}`)
          db.pragma(`legacy_alter_table = ${legacyBefore ? 'ON' : 'OFF'}`)
          createPre109Schema(db, withLateColumns)
          const columnsBefore = db.prepare('PRAGMA table_info(browser_target_claims)').all<{ name: string }>()
          const objectsBefore = db.prepare(`
            SELECT type, name, sql FROM sqlite_master
             WHERE tbl_name = 'browser_target_claims' AND type IN ('index', 'trigger') AND sql IS NOT NULL
             ORDER BY type, name
          `).all()

          migrate(db)

          assert.deepEqual(db.prepare('PRAGMA table_info(browser_target_claims)').all(), columnsBefore)
          assert.deepEqual(db.prepare(`
            SELECT type, name, sql FROM sqlite_master
             WHERE tbl_name = 'browser_target_claims' AND type IN ('index', 'trigger') AND sql IS NOT NULL
             ORDER BY type, name
          `).all(), objectsBefore)
          assert.deepEqual(db.prepare('PRAGMA foreign_key_list(browser_target_claim_children)').all<{ table: string }>()
            .map((row) => row.table), ['browser_target_claims'])
          if (withLateColumns) {
            assert.deepEqual(db.prepare(`
              SELECT purpose, acquired_turn_id FROM browser_target_claims WHERE claim_id = 'claim-109'
            `).get(), { purpose: 'ongoing', acquired_turn_id: 'turn-late-109' })
          }
          const result = db.prepare(`
            UPDATE browser_target_claims
               SET state = 'user_owned', suspension_reason = 'browser_target_user_owned',
                   suspension_checkpoint_id = NULL
             WHERE claim_id = 'claim-109'
          `).run()
          assert.equal(result.changes, 1)
          assert.equal(Number(db.pragma('foreign_keys', { simple: true })), foreignKeysBefore)
          assert.equal(Number(db.pragma('legacy_alter_table', { simple: true })), legacyBefore)
          assert.deepEqual(db.pragma('foreign_key_check'), [])
          assert.equal(db.pragma('quick_check', { simple: true }), 'ok')

          const rowAfter = db.prepare(`SELECT * FROM browser_target_claims WHERE claim_id = 'claim-109'`).get()
          migrate(db)
          assert.deepEqual(db.prepare(`SELECT * FROM browser_target_claims WHERE claim_id = 'claim-109'`).get(), rowAfter)
          assert.equal(Number(db.pragma('foreign_keys', { simple: true })), foreignKeysBefore)
          assert.equal(Number(db.pragma('legacy_alter_table', { simple: true })), legacyBefore)
        } finally {
          db.close()
        }
      }
    }
  }
})

test('migration 109 restores foreign keys when transaction start fails', (t) => {
  if (skipIfSqliteUnavailable(t, 'migration 109 begin failure cleanup')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    createPre109Schema(db, true)
    markOnly109Pending(db)
    let rollbackCalls = 0
    const wrapper: MigrationDatabase = {
      get inTransaction() { return db.inTransaction },
      prepare: (sql) => db.prepare(sql) as unknown as ReturnType<MigrationDatabase['prepare']>,
      exec: (sql) => {
        if (sql.trim() === 'BEGIN') throw new Error('injected_begin_failure')
        if (sql.trim() === 'ROLLBACK') rollbackCalls += 1
        db.exec(sql)
      },
    }

    assert.throws(() => runMigrations(wrapper), /injected_begin_failure/)
    assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1)
    assert.equal(rollbackCalls, 0, 'a failed BEGIN must not roll back an unowned transaction')
    assert.equal(db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(MIGRATION_109), undefined)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})

test('migration 109 rolls back its own transaction and restores foreign keys when migration work fails', (t) => {
  if (skipIfSqliteUnavailable(t, 'migration 109 work failure cleanup')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.pragma('legacy_alter_table = OFF')
    createPre109Schema(db, true)
    markOnly109Pending(db)
    let rollbackCalls = 0
    const wrapper: MigrationDatabase = {
      get inTransaction() { return db.inTransaction },
      prepare: (sql) => db.prepare(sql) as unknown as ReturnType<MigrationDatabase['prepare']>,
      exec: (sql) => {
        if (sql.trim().startsWith('ALTER TABLE browser_target_claims RENAME TO')) {
          throw new Error('injected_migration_failure')
        }
        if (sql.trim() === 'ROLLBACK') rollbackCalls += 1
        db.exec(sql)
      },
    }

    assert.throws(() => runMigrations(wrapper), /injected_migration_failure/)
    assert.equal(rollbackCalls, 1)
    assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1)
    assert.equal(Number(db.pragma('legacy_alter_table', { simple: true })), 0)
    assert.equal(db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(MIGRATION_109), undefined)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM browser_target_claims").get<{ count: number }>()?.count, 1)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})
