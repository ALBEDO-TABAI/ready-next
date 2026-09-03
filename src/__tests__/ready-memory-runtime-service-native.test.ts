import assert from 'node:assert/strict'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import {
  ReadyMemoryGenerationCoordinator,
  ReadyMemoryGenerationStore,
  ReadyMemoryRepository,
  ReadyMemoryRuntimeService,
  ReadyMemorySqliteEvidenceLoader,
  isReadyMemoryProductionIdle,
} from '../main/modules/agent-control/ready-memory'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

type NativeDb = import('better-sqlite3').Database
const closedAt = '2026-08-20T00:00:10.000Z'

function createDb(): NativeDb {
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  __runMigrationForTests('113_ready_memory_truth', db as unknown as MigrationDatabase)
  db.exec(`
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY, source_kind TEXT, source_id TEXT, thread_key TEXT,
      parent_conversation_id TEXT, lineage_root_id TEXT, meta_json TEXT,
      message_visibility_epoch INTEGER NOT NULL, closed_at TEXT
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT,
      timestamp TEXT, message_visibility_epoch INTEGER NOT NULL
    );
    CREATE TABLE codex_thread_bindings (
      thread_binding_id TEXT PRIMARY KEY, ready_scope_id TEXT, retired_at TEXT
    );
    CREATE TABLE codex_turn_bindings (
      ready_run_id TEXT PRIMARY KEY, ready_task_id TEXT, thread_binding_id TEXT,
      message_visibility_epoch INTEGER NOT NULL, engine_terminal_status TEXT,
      product_terminal_digest TEXT, host_failure_product_terminal_digest TEXT,
      lifecycle_action TEXT, origin_user_message_id TEXT, ingress_json TEXT, product_closeout_at TEXT,
      host_failure_closeout_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE codex_tool_call_bindings (ready_run_id TEXT);
    CREATE TABLE run_meta (run_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE task_projections (task_id TEXT PRIMARY KEY, run_id TEXT, status TEXT);
  `)
  return db
}

function insertScope(db: NativeDb, input: {
  id: string
  sourceKind?: string
  meta?: Record<string, unknown>
  closed?: boolean
}): void {
  db.prepare(`
    INSERT INTO chat_conversations (
      id, source_kind, source_id, thread_key, parent_conversation_id,
      lineage_root_id, meta_json, message_visibility_epoch, closed_at
    ) VALUES (?, ?, 'app', ?, NULL, ?, ?, 0, ?)
  `).run(input.id, input.sourceKind || 'local', input.id, input.id,
    JSON.stringify(input.meta || { createdBy: 'app' }), input.closed ? closedAt : null)
}

function setup(db: NativeDb, onStateChanged?: (event: import('../shared/ready-memory').ReadyMemoryStateChange) => void) {
  const connection = db as unknown as DatabaseConnection
  const repository = new ReadyMemoryRepository(connection)
  const store = new ReadyMemoryGenerationStore(connection)
  const coordinator = new ReadyMemoryGenerationCoordinator({
    repository,
    store,
    evidenceLoader: new ReadyMemorySqliteEvidenceLoader(connection),
    provider: {
      async submit() { throw new Error('provider must remain idle') },
      async recover() { return { state: 'unknown' as const } },
    },
    workerId: 'worker-test',
    resolveProfile: () => ({
      model: 'unused',
      upstreamProfileSnapshotRef: 'unused',
      upstreamProfileSnapshotDigest: 'a'.repeat(64),
    }),
    makeId: (prefix) => `${prefix}-1`,
    onStateChanged,
  })
  const service = new ReadyMemoryRuntimeService({
    db: connection,
    repository,
    coordinator,
    automaticGenerationAvailable: false,
    now: () => closedAt,
    makeId: (prefix) => `${prefix}-1`,
    onStateChanged,
  })
  return { repository, service }
}

test('global memory revisions publish once after commit while conversation policy stays local', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory state change event')) return
  const db = createDb()
  t.after(() => db.close())
  const events: import('../shared/ready-memory').ReadyMemoryStateChange[] = []
  const { service } = setup(db, (event) => events.push(event))
  insertScope(db, { id: 'local-root' })
  service.add({ category: 'fact', content: 'alpha' })
  service.pin({ entryId: 'ready-memory-1', pinned: true })
  service.pin({ entryId: 'ready-memory-1', pinned: true })
  service.setConversationPolicy({ conversationId: 'local-root', contributeToMemories: true })
  assert.deepEqual(events.map((event) => event.reason), ['add', 'pin'])
  assert.equal(events[1].stateRevision > events[0].stateRevision, true)
  assert.equal(events.every((event) => /^[a-f0-9]{64}$/.test(event.evidenceDigest)), true)
})

test('closed local root success is sealed from durable truth while external context is rejected', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory production sealing')) return
  const db = createDb()
  t.after(() => db.close())
  const { repository, service } = setup(db)
  insertScope(db, { id: 'conversation-1', closed: true })
  repository.setGlobalPolicy({ generateMemories: true, updatedAt: '2026-08-20T00:00:00.000Z' })
  repository.setConversationContribution({
    conversationId: 'conversation-1', contributeToMemories: true,
    updatedAt: '2026-08-20T00:00:01.000Z',
  })
  db.prepare(`INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, 0)`).run(
    'message-user', 'conversation-1', 'user', '以后请简洁汇报', '2026-08-20T00:00:02.000Z')
  db.prepare(`INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, 0)`).run(
    'assistant:task-1:run-1:terminal', 'conversation-1', 'assistant',
    '好的，我会保持简洁', '2026-08-20T00:00:04.000Z')
  db.prepare(`INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, 0)`).run(
    'failed-message', 'conversation-1', 'assistant', '不得进入证据', '2026-08-20T00:00:03.000Z')
  db.prepare(`INSERT INTO codex_thread_bindings VALUES ('thread-1', 'conversation-1', NULL)`).run()
  db.prepare(`INSERT INTO run_meta VALUES ('run-1', 'done')`).run()
  db.prepare(`INSERT INTO task_projections VALUES ('task-1', 'run-1', 'completed')`).run()
  db.prepare(`
    INSERT INTO codex_turn_bindings (
      ready_run_id, ready_task_id, thread_binding_id, message_visibility_epoch,
      engine_terminal_status, product_terminal_digest, host_failure_product_terminal_digest,
      lifecycle_action, origin_user_message_id, ingress_json, product_closeout_at,
      host_failure_closeout_at, created_at, updated_at
    ) VALUES ('run-1', 'task-1', 'thread-1', 0, 'completed', ?, NULL, NULL,
      'message-user', ?, ?, NULL, ?, ?)
  `).run('d'.repeat(64), JSON.stringify({
    prepared: { ingress: { explicitResourceEnvelope: { resourceRefs: [] } } },
  }), '2026-08-20T00:00:04.000Z', '2026-08-20T00:00:02.000Z', '2026-08-20T00:00:04.000Z')

  db.exec('BEGIN IMMEDIATE')
  const result = service.sealClosedConversationInOpenTransaction({
    conversationId: 'conversation-1', closedAt,
  })
  db.exec('COMMIT')
  assert.equal(result.reason, 'enqueued')
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM ready_memory_sources').get() as { count: number }).count, 1)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM ready_memory_jobs').get() as { count: number }).count, 1)
  const refs = JSON.parse((db.prepare(`
    SELECT evidence_refs_json FROM ready_memory_sources LIMIT 1
  `).get() as { evidence_refs_json: string }).evidence_refs_json) as Array<{ ref: string }>
  assert.deepEqual(refs.map((ref) => ref.ref), [
    'message-user', 'assistant:task-1:run-1:terminal',
  ])

  db.prepare(`INSERT INTO codex_tool_call_bindings VALUES ('run-1')`).run()
  db.exec('BEGIN IMMEDIATE')
  const rejected = service.sealClosedConversationInOpenTransaction({
    conversationId: 'conversation-1', closedAt,
  })
  db.exec('COMMIT')
  assert.deepEqual(rejected, { enqueued: false, reason: 'untrusted_context' })
})

test('retired unresolved history does not keep the production memory worker busy', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory production idle admission')) return
  const db = createDb()
  t.after(() => db.close())
  db.prepare(`INSERT INTO codex_thread_bindings VALUES ('retired-thread', 'old-scope', ?)`)
    .run(closedAt)
  db.prepare(`INSERT INTO run_meta VALUES ('old-run', 'running')`).run()
  db.prepare(`INSERT INTO task_projections VALUES ('old-task', 'old-run', 'running')`).run()
  db.prepare(`
    INSERT INTO codex_turn_bindings VALUES (
      'old-run', 'old-task', 'retired-thread', 0, NULL, NULL, NULL, NULL, NULL, '{}',
      NULL, NULL, ?, ?
    )
  `).run(closedAt, closedAt)
  assert.equal(isReadyMemoryProductionIdle(db as unknown as DatabaseConnection), true)

  db.prepare(`INSERT INTO codex_thread_bindings VALUES ('active-thread', 'new-scope', NULL)`).run()
  db.prepare(`INSERT INTO run_meta VALUES ('active-run', 'running')`).run()
  db.prepare(`INSERT INTO task_projections VALUES ('active-task', 'active-run', 'running')`).run()
  db.prepare(`
    INSERT INTO codex_turn_bindings VALUES (
      'active-run', 'active-task', 'active-thread', 0, NULL, NULL, NULL, NULL, NULL, '{}',
      NULL, NULL, ?, ?
    )
  `).run(closedAt, closedAt)
  assert.equal(isReadyMemoryProductionIdle(db as unknown as DatabaseConnection), false)
})

test('conversation contribution writes accept only active local root app conversations', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory conversation policy authority')) return
  const db = createDb()
  t.after(() => db.close())
  const { repository, service } = setup(db)
  insertScope(db, { id: 'local-root' })
  insertScope(db, { id: 'remote-root', sourceKind: 'feishu' })
  insertScope(db, { id: 'temporary', meta: { createdBy: 'app', temporary: true } })
  assert.equal(service.read({ conversationId: 'remote-root' }).contributeToMemories, null)
  assert.equal(service.read({ conversationId: 'temporary' }).contributeToMemories, null)
  assert.equal(service.setConversationPolicy({
    conversationId: 'local-root', contributeToMemories: false,
  }).contributeToMemories, false)
  assert.throws(() => service.setConversationPolicy({
    conversationId: 'remote-root', contributeToMemories: true,
  }), /ready_memory_conversation_ineligible/)
  assert.throws(() => service.setConversationPolicy({
    conversationId: 'temporary', contributeToMemories: true,
  }), /ready_memory_conversation_ineligible/)
  assert.throws(() => service.setConversationPolicy({
    conversationId: 'missing', contributeToMemories: true,
  }), /ready_memory_conversation_ineligible/)
  assert.equal(repository.getConversationPolicy('remote-root').stateRevision, 0)
  assert.equal(repository.getConversationPolicy('temporary').stateRevision, 0)
  assert.equal(repository.getConversationPolicy('missing').stateRevision, 0)
})

test('production runtime rejects automatic generation when the provider cannot recover submissions', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory generation availability')) return
  const db = createDb()
  t.after(() => db.close())
  const { repository, service } = setup(db)
  assert.throws(() => service.setGlobalPolicy({
    generateMemories: true,
    acknowledgeModelCost: true,
  }), /ready_memory_automatic_generation_unavailable/)
  assert.equal(repository.getGlobalPolicy().generateMemories, false)
  assert.equal(service.read({}).automaticGenerationAvailable, false)
})
