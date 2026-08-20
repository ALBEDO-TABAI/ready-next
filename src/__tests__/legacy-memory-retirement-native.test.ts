import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BELIEF_CARD_STORAGE_DIRNAME,
  LEGACY_AGENT_MEMORY_DIRNAME,
  migrateLegacyBeliefCardStorage,
} from '../main/modules/agent-control/knowledge/belief-card-storage-migration'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import { assembleFeedEntries } from '../main/modules/claude-bridge/ipc/emergence-feed-group'
import {
  __runMigrationForTests,
  runMigrations,
  type MigrationDatabase,
} from '../main/modules/migrations'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

const RETIRED_TABLES = [
  'agent_trigger_refs',
  'agent_memory_access_log',
  'agent_triggers',
  'agent_memory_metadata',
  'agent_knowledge',
  'user_profiles',
  'agent_personalities',
] as const

function tableNames(db: { prepare(sql: string): { all(): unknown[] } }): Set<string> {
  return new Set((db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as Array<{ name: string }>).map((row) => row.name))
}

test('migration 114 drops retired memory truth without touching Ready identity or session recall', (t) => {
  if (skipIfSqliteUnavailable(t, 'legacy memory retirement upgrade')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE agents (id TEXT PRIMARY KEY);
    CREATE TABLE session_recall_metadata (conversation_id TEXT PRIMARY KEY);
    CREATE TABLE agent_memory_metadata (id TEXT PRIMARY KEY);
    CREATE TABLE agent_triggers (id TEXT PRIMARY KEY);
    CREATE TABLE agent_trigger_refs (
      trigger_id TEXT REFERENCES agent_triggers(id) ON DELETE CASCADE,
      memory_id TEXT REFERENCES agent_memory_metadata(id) ON DELETE CASCADE
    );
    CREATE TABLE agent_memory_access_log (
      id TEXT PRIMARY KEY,
      memory_id TEXT REFERENCES agent_memory_metadata(id) ON DELETE CASCADE
    );
    CREATE TABLE agent_knowledge (id TEXT PRIMARY KEY);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY);
    CREATE TABLE agent_personalities (id TEXT PRIMARY KEY);
    INSERT INTO agents VALUES ('butler');
    INSERT INTO session_recall_metadata VALUES ('conversation-1');
  `)

  __runMigrationForTests('114_drop_retired_memory_truth', db as unknown as MigrationDatabase)
  __runMigrationForTests('114_drop_retired_memory_truth', db as unknown as MigrationDatabase)

  const names = tableNames(db)
  for (const tableName of RETIRED_TABLES) assert.equal(names.has(tableName), false)
  assert.equal(names.has('agents'), true)
  assert.equal(names.has('session_recall_metadata'), true)
  assert.deepEqual(db.prepare('SELECT id FROM agents').all(), [{ id: 'butler' }])
})

test('fresh database ends with Ready memory and recall truth but no retired memory tables', (t) => {
  if (skipIfSqliteUnavailable(t, 'legacy memory retirement fresh database')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())

  runMigrations(db as unknown as MigrationDatabase)

  const names = tableNames(db)
  for (const tableName of RETIRED_TABLES) assert.equal(names.has(tableName), false)
  for (const tableName of [
    'agents',
    'chat_conversations',
    'session_recall_metadata',
    'ready_memory_sources',
    'ready_memory_entries',
    'ready_memory_jobs',
    'ready_memory_policies',
  ]) assert.equal(names.has(tableName), true, `missing ${tableName}`)
})

test('migration 115 interrupts unfinished scopes from the retired execution loop', (t) => {
  if (skipIfSqliteUnavailable(t, 'legacy execution scope retirement upgrade')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec(`
    CREATE TABLE execution_call_scopes (
      call_scope_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (
        status IN ('prepared', 'running', 'checkpointed', 'settled', 'interrupted', 'cancelled')
      ),
      updated_at INTEGER NOT NULL
    );
    INSERT INTO execution_call_scopes VALUES
      ('prepared', 'prepared', 1),
      ('running', 'running', 1),
      ('checkpointed', 'checkpointed', 1),
      ('settled', 'settled', 1),
      ('cancelled', 'cancelled', 1);
  `)

  __runMigrationForTests('115_interrupt_retired_execution_scopes', db as unknown as MigrationDatabase)
  __runMigrationForTests('115_interrupt_retired_execution_scopes', db as unknown as MigrationDatabase)

  assert.deepEqual(db.prepare(`
    SELECT call_scope_id, status FROM execution_call_scopes ORDER BY call_scope_id
  `).all(), [
    { call_scope_id: 'cancelled', status: 'cancelled' },
    { call_scope_id: 'checkpointed', status: 'interrupted' },
    { call_scope_id: 'prepared', status: 'interrupted' },
    { call_scope_id: 'running', status: 'interrupted' },
    { call_scope_id: 'settled', status: 'settled' },
  ])
})

test('legacy belief cards move to independent storage idempotently and conflicts are archived', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-belief-storage-'))
  try {
    const legacyRoot = join(root, LEGACY_AGENT_MEMORY_DIRNAME)
    const storageRoot = join(root, BELIEF_CARD_STORAGE_DIRNAME)
    mkdirSync(join(legacyRoot, 'knowledge', 'sites'), { recursive: true })
    mkdirSync(join(legacyRoot, 'agents', 'butler', 'knowledge'), { recursive: true })
    mkdirSync(join(storageRoot, 'knowledge'), { recursive: true })
    writeFileSync(join(legacyRoot, 'knowledge', 'project.md'), 'legacy-project')
    writeFileSync(join(legacyRoot, 'knowledge', 'sites', 'example.md'), [
      '---',
      'title: Example 站点失败学习',
      'description: 从浏览器失败中积累的站点提示',
      'confidence: H',
      'tag: knowledge',
      'created: 2026-08-20',
      'status: staged',
      'site: example.com',
      'source: failure-learning:example.com',
      '---',
      '需要用户确认后生效。',
    ].join('\n'))
    writeFileSync(join(legacyRoot, 'agents', 'butler', 'knowledge', 'ready.md'), 'ready-card')
    writeFileSync(join(legacyRoot, 'knowledge', 'routing-copywriter.md'), 'retired-routing-card')
    writeFileSync(join(legacyRoot, 'USER.md'), 'retired-user-profile')
    writeFileSync(join(storageRoot, 'knowledge', 'project.md'), 'newer-project')

    const first = migrateLegacyBeliefCardStorage(root)
    const second = migrateLegacyBeliefCardStorage(root)

    assert.deepEqual(first.migrated, ['knowledge/sites/example.md'])
    assert.equal(first.archivedConflicts.length, 1)
    assert.deepEqual(second.migrated, [])
    assert.equal(readFileSync(join(storageRoot, 'knowledge', 'project.md'), 'utf8'), 'newer-project')
    const migratedSiteCard = new BeliefCardStore({ memoryRoot: storageRoot })
      .readCard('knowledge/sites/example.md', { includeStaged: true })
    assert.equal(migratedSiteCard?.frontmatter.site, 'example.com')
    const feed = assembleFeedEntries({
      listRecentProjections: () => [],
      listCrystallizeSignals: () => migratedSiteCard ? [{
        relPath: migratedSiteCard.relPath,
        title: migratedSiteCard.frontmatter.title,
        tag: migratedSiteCard.frontmatter.tag,
        status: migratedSiteCard.frontmatter.status,
        source: migratedSiteCard.frontmatter.source ?? null,
        stage: migratedSiteCard.frontmatter.stage ?? null,
      }] : [],
    })
    assert.equal(feed.some((entry) => entry.card.action.ref === 'knowledge/sites/example.md'), true)
    assert.equal(existsSync(join(storageRoot, 'agents', 'butler', 'knowledge', 'ready.md')), false)
    assert.equal(existsSync(join(storageRoot, 'knowledge', 'routing-copywriter.md')), false)
    assert.equal(existsSync(join(storageRoot, 'USER.md')), false)
    assert.equal(first.archivedConflicts.every((path) => existsSync(join(storageRoot, path))), true)

    const freshRoot = join(root, 'fresh')
    mkdirSync(freshRoot)
    assert.deepEqual(migrateLegacyBeliefCardStorage(freshRoot).migrated, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
