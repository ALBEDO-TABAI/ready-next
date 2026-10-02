import assert from 'node:assert/strict'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database/connection'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import {
  READY_MEMORY_SNAPSHOT_CONTENT_BUDGET_CHARS,
  READY_MEMORY_SUMMARY_BUDGET_CHARS,
  ReadyMemoryRepository,
  ReadyMemoryRepositoryError,
} from '../main/modules/agent-control/ready-memory'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

type NativeDb = import('better-sqlite3').Database

const t0 = '2026-08-20T00:00:00.000Z'
const t1 = '2026-08-20T00:00:01.000Z'
const t2 = '2026-08-20T00:00:02.000Z'
const t3 = '2026-08-20T00:00:03.000Z'
const t4 = '2026-08-20T00:00:04.000Z'
const t5 = '2026-08-20T00:00:05.000Z'

function createDb(withTurnBindings = false): NativeDb {
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  if (withTurnBindings) {
    db.exec(`
      CREATE TABLE codex_turn_bindings (
        ready_run_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }
  __runMigrationForTests('113_ready_memory_truth', db as unknown as MigrationDatabase)
  return db
}

function repository(db: NativeDb): ReadyMemoryRepository {
  return new ReadyMemoryRepository(db as unknown as DatabaseConnection)
}

test('Ready memory defaults and manual CRUD maintain separate monotonic revisions', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory manual CRUD')) return
  const db = createDb()
  t.after(() => db.close())
  const repo = repository(db)

  const defaults = repo.getGlobalPolicy()
  assert.match(defaults.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual({ ...defaults, updatedAt: '<migration-time>' }, {
    useMemories: true,
    generateMemories: false,
    stateRevision: 1,
    revocationRevision: 0,
    lastRevocationReason: null,
    updatedAt: '<migration-time>',
  })
  assert.deepEqual(repo.getConversationPolicy('conversation-1'), {
    conversationId: 'conversation-1',
    contributeToMemories: false,
    stateRevision: 0,
    updatedAt: null,
  })
  assert.equal(repo.setConversationContribution({
    conversationId: 'conversation-1', contributeToMemories: true, updatedAt: t0,
  }).contributeToMemories, true)

  const added = repo.addManualMemory({
    entryId: 'manual-1', category: 'preference', content: '偏好简洁汇报', createdAt: t1,
  })
  assert.equal(added.stateRevision, 2)
  assert.equal(added.revocationRevision, 0)

  const edited = repo.editMemory({ entryId: 'manual-1', content: '偏好简洁直白的汇报', updatedAt: t2 })
  assert.equal(edited.stateRevision, 3)
  assert.equal(edited.revocationRevision, 1)
  assert.equal(repo.getGlobalPolicy().lastRevocationReason, 'edit')

  const pinned = repo.setMemoryPinned('manual-1', true, t3)
  assert.equal(pinned.pinned, true)
  assert.equal(pinned.stateRevision, 4)
  assert.equal(pinned.revocationRevision, 1)

  assert.equal(repo.deleteMemory('manual-1', t4), true)
  assert.equal(repo.getEntry('manual-1'), null)
  assert.deepEqual(repo.getGlobalPolicy(), {
    useMemories: true,
    generateMemories: false,
    stateRevision: 5,
    revocationRevision: 2,
    lastRevocationReason: 'delete',
    updatedAt: t4,
  })
})

test('snapshot is deterministic, immutable, bounded, and excludes revoked or disabled memories', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory deterministic snapshot')) return
  const db = createDb()
  t.after(() => db.close())
  const repo = repository(db)

  repo.addManualMemory({
    entryId: 'short', category: 'fact', content: '用户在新加坡时区', pinned: true, createdAt: t0,
  })
  repo.addManualMemory({
    entryId: 'long', category: 'project', content: '长'.repeat(READY_MEMORY_SUMMARY_BUDGET_CHARS * 2),
    createdAt: t1,
  })
  const first = repo.buildSnapshot(t2)
  const second = repo.buildSnapshot(t2)
  assert.deepEqual(first, second)
  assert.equal(first.entries[0]?.entryId, 'short')
  assert.equal(first.entries[1]?.content, '长'.repeat(READY_MEMORY_SUMMARY_BUDGET_CHARS * 2))
  assert.deepEqual(first.summaryEntryIds, ['short', 'long'])
  assert.equal(first.summary.includes('用户在新加坡时区'), true)
  assert.ok(first.summaryChars <= READY_MEMORY_SUMMARY_BUDGET_CHARS)
  assert.equal(first.truncated, true)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.entries), true)
  assert.equal('currentInput' in first, false)

  const frozenDigest = first.snapshotDigest
  assert.equal(repo.deleteMemory('short', t3), true)
  const afterDelete = repo.buildSnapshot(t4)
  assert.notEqual(afterDelete.snapshotDigest, frozenDigest)
  assert.equal(afterDelete.entries.some((entry) => entry.entryId === 'short'), false)
  assert.equal(repo.searchSnapshot(first, '新加坡').map((entry) => entry.entryId).join(','), 'short')
  assert.equal(afterDelete.revocationRevision, first.revocationRevision + 1)

  const disabledPolicy = repo.setGlobalPolicy({ useMemories: false, updatedAt: t5 })
  assert.equal(disabledPolicy.lastRevocationReason, 'use_off')
  const disabled = repo.buildSnapshot(t5)
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.summary, '')
  assert.deepEqual(disabled.entries, [])
  assert.deepEqual(repo.searchSnapshot(disabled, '长'), [])
  repo.setGlobalPolicy({ generateMemories: true, updatedAt: t5 })
  assert.equal(repo.setGlobalPolicy({ generateMemories: false, updatedAt: t5 }).lastRevocationReason, 'generate_off')
})

test('active, superseded, and expired states stay explicit and only active rows enter snapshots', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory entry states')) return
  const db = createDb()
  t.after(() => db.close())
  const repo = repository(db)

  repo.addManualMemory({ entryId: 'old', category: 'fact', content: '旧事实', createdAt: t0 })
  repo.addManualMemory({ entryId: 'new', category: 'fact', content: '新事实', createdAt: t1 })
  repo.addManualMemory({
    entryId: 'temporary', category: 'project', content: '临时项目', expiresAt: t2, createdAt: t1,
  })
  assert.equal(repo.supersedeMemory('old', 'new', t2).status, 'superseded')
  assert.equal(repo.expireMemories(t3), 1)
  assert.deepEqual(Object.fromEntries(
    repo.listEntries().map((entry) => [entry.entryId, entry.status]),
  ), {
    new: 'active',
    temporary: 'expired',
    old: 'superseded',
  })
  assert.deepEqual(repo.buildSnapshot(t4).entries.map((entry) => entry.entryId), ['new'])

  repo.resetMemories(t5)
  assert.deepEqual(repo.listEntries(), [])
  assert.equal(repo.getGlobalPolicy().lastRevocationReason, 'reset')
})

test('snapshot total entry content stays within its aggregate budget', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory snapshot aggregate budget')) return
  const db = createDb()
  t.after(() => db.close())
  const repo = repository(db)
  repo.addManualMemory({
    entryId: 'first-large', category: 'project', content: '甲'.repeat(16_000),
    pinned: true, createdAt: t0,
  })
  repo.addManualMemory({
    entryId: 'second-large', category: 'project', content: '乙'.repeat(16_000), createdAt: t1,
  })
  const snapshot = repo.buildSnapshot(t2)
  assert.deepEqual(snapshot.entries.map((entry) => entry.entryId), ['first-large'])
  assert.ok(snapshot.entries.reduce((sum, entry) => sum + Array.from(entry.content).length, 0)
    <= READY_MEMORY_SNAPSHOT_CONTENT_BUDGET_CHARS)
  assert.equal(snapshot.truncated, true)
})

test('source and extraction job hooks dedupe, recover only leases, and never retry submitted or unknown work', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory source and job receipts')) return
  const db = createDb()
  t.after(() => db.close())
  const repo = repository(db)
  const digest = 'a'.repeat(64)

  assert.deepEqual(repo.enqueueExtractionForSuccessfulSource({
    sourceId: 'source-disabled', conversationId: 'conversation-1', sourceDigest: digest,
    sourceUpdatedAt: t0, evidenceRefs: [{ messageId: 'm1' }], jobId: 'job-disabled', createdAt: t0,
  }), { enqueued: false, reason: 'generation_disabled', source: null, job: null })

  repo.setGlobalPolicy({ generateMemories: true, updatedAt: t1 })
  db.exec('BEGIN IMMEDIATE')
  const rolledBack = repo.enqueueExtractionForSuccessfulSource({
    sourceId: 'source-1', conversationId: 'conversation-1', sourceDigest: digest,
    sourceUpdatedAt: t0, evidenceRefs: [{ messageId: 'm1' }], jobId: 'job-1', createdAt: t1,
  })
  assert.equal(rolledBack.enqueued, true)
  db.exec('ROLLBACK')
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM ready_memory_jobs').get() as { count: number }).count, 0)

  const enqueued = repo.enqueueExtractionForSuccessfulSource({
    sourceId: 'source-1', conversationId: 'conversation-1', sourceDigest: digest,
    sourceUpdatedAt: t0, evidenceRefs: [{ messageId: 'm1' }], jobId: 'job-1', createdAt: t1,
  })
  assert.equal(enqueued.enqueued, true)
  const duplicate = repo.enqueueExtractionForSuccessfulSource({
    sourceId: 'source-duplicate', conversationId: 'conversation-2', sourceDigest: digest,
    sourceUpdatedAt: t0, evidenceRefs: [], jobId: 'job-duplicate', createdAt: t2,
  })
  assert.equal(duplicate.reason, 'duplicate')
  assert.equal(duplicate.source.sourceId, 'source-1')
  assert.equal(duplicate.job.jobId, 'job-1')

  assert.equal(repo.leaseNextJob({
    leaseOwner: 'worker-1', leaseToken: 'lease-1', leasedAt: t1, leaseExpiresAt: t2,
  })?.attemptCount, 1)
  assert.equal(repo.recoverExpiredLeases(t3), 1)
  assert.equal(repo.leaseNextJob({
    leaseOwner: 'worker-2', leaseToken: 'lease-2', leasedAt: t3, leaseExpiresAt: t5,
  })?.attemptCount, 2)
  assert.equal(repo.markJobSubmitted({
    jobId: 'job-1', leaseToken: 'lease-2', providerRequestId: 'provider-1',
    receipt: { budgetLane: 'memory', accepted: true }, submittedAt: t4,
    expectedRevocationRevision: repo.getGlobalPolicy().revocationRevision,
  }).status, 'submitted')
  assert.deepEqual(repo.getJob('job-1')?.submissionReceipt, {
    accepted: true, budgetLane: 'memory',
  })
  assert.equal(repo.recoverExpiredLeases('2026-08-20T00:01:00.000Z'), 0)
  assert.equal(repo.leaseNextJob({
    leaseOwner: 'worker-3', leaseToken: 'lease-3', leasedAt: t4, leaseExpiresAt: t5,
  }), null)

  const unknown = repo.recordJobTerminal({
    jobId: 'job-1', providerRequestId: 'provider-1', status: 'unknown',
    receipt: { queryRequired: true }, terminalAt: t5,
  })
  assert.equal(unknown.status, 'unknown')
  repo.resetMemories('2026-08-20T00:01:00.000Z')
  assert.equal(repo.getJob('job-1')?.status, 'unknown', 'reset must preserve an in-flight cost receipt')
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM ready_memory_sources WHERE source_id = 'source-1'
  `).get() as { count: number }).count, 1)
  assert.equal(repo.recoverExpiredLeases('2026-08-20T00:02:00.000Z'), 0)
  assert.equal(repo.leaseNextJob({
    leaseOwner: 'worker-4', leaseToken: 'lease-4',
    leasedAt: '2026-08-20T00:02:00.000Z', leaseExpiresAt: '2026-08-20T00:03:00.000Z',
  }), null)
  assert.equal(repo.recordJobTerminal({
    jobId: 'job-1', providerRequestId: 'provider-1', status: 'succeeded',
    receipt: { providerStatus: 'completed' }, terminalAt: '2026-08-20T00:02:00.000Z',
  }).status, 'succeeded')
})

test('turn binding freezes one snapshot and one matching read receipt', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory turn receipts')) return
  const db = createDb(true)
  t.after(() => db.close())
  const repo = repository(db)
  db.prepare(`
    INSERT INTO codex_turn_bindings (ready_run_id, revision, updated_at) VALUES ('run-1', 1, ?)
  `).run(t0)
  repo.addManualMemory({ entryId: 'entry-1', category: 'fact', content: '已冻结事实', createdAt: t1 })
  const snapshot = repo.buildSnapshot(t2)
  assert.equal(repo.freezeSnapshotForTurn('run-1', snapshot, t2), true)
  assert.equal(repo.freezeSnapshotForTurn('run-1', snapshot, t2), false)
  const receipt = repo.createReadReceipt(snapshot, ['entry-1'], t3)
  assert.equal(repo.recordReadReceiptForTurn('run-1', snapshot, receipt, t3), true)
  assert.equal(repo.recordReadReceiptForTurn('run-1', snapshot, receipt, t3), false)
  assert.equal(repo.getEntry('entry-1')?.lastUsedAt, t3)

  repo.addManualMemory({ entryId: 'entry-2', category: 'fact', content: '后续事实', createdAt: t4 })
  const next = repo.buildSnapshot(t5)
  assert.throws(
    () => repo.freezeSnapshotForTurn('run-1', next, t5),
    (error: unknown) => error instanceof ReadyMemoryRepositoryError
      && error.code === 'turn_snapshot_conflict',
  )
  const stored = db.prepare(`
    SELECT ready_memory_snapshot_json, ready_memory_snapshot_digest,
           ready_memory_read_receipt_digest
    FROM codex_turn_bindings WHERE ready_run_id = 'run-1'
  `).get() as {
    ready_memory_snapshot_json: string
    ready_memory_snapshot_digest: string
    ready_memory_read_receipt_digest: string
  }
  assert.equal(stored.ready_memory_snapshot_digest, snapshot.snapshotDigest)
  assert.equal(stored.ready_memory_read_receipt_digest, receipt.receiptDigest)
  const storedSnapshot = JSON.parse(stored.ready_memory_snapshot_json) as {
    frozenAt: string
    entries: Array<{ entryId: string; content: string }>
  }
  assert.equal(storedSnapshot.frozenAt, t2)
  assert.deepEqual(storedSnapshot.entries, [{
    entryId: 'entry-1', content: '已冻结事实',
    category: 'fact', contentDigest: snapshot.entries[0]?.contentDigest,
    origin: 'manual', pinned: false, sourceRefs: [], stateRevision: 2,
  }])
})

test('successful turn receipt marks both summary and searched memories used', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory last used receipt')) return
  const db = createDb(true)
  t.after(() => db.close())
  const repo = repository(db)
  db.prepare(`INSERT INTO codex_turn_bindings (ready_run_id, revision, updated_at)
    VALUES ('run-use', 1, ?)`).run(t0)
  repo.addManualMemory({
    entryId: 'summary-entry', category: 'fact',
    content: '摘'.repeat(READY_MEMORY_SUMMARY_BUDGET_CHARS - 8), pinned: true, createdAt: t1,
  })
  repo.addManualMemory({ entryId: 'tool-entry', category: 'fact', content: '检索事实', createdAt: t2 })
  const snapshot = repo.buildSnapshot(t3)
  assert.deepEqual(snapshot.summaryEntryIds, ['summary-entry'])
  repo.freezeSnapshotForTurn('run-use', snapshot, t3)
  const receipt = repo.createReadReceipt(snapshot, ['tool-entry'], t4)
  repo.recordReadReceiptForTurn('run-use', snapshot, receipt, t4)
  assert.equal(repo.getEntry('summary-entry')?.lastUsedAt, t4)
  assert.equal(repo.getEntry('tool-entry')?.lastUsedAt, t4)
})
