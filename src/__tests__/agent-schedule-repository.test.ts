import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import type { DatabaseConnection } from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import { ScheduleRepository } from '../main/modules/scheduled-tasks/schedule-repository'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type TestDb = DatabaseConnection & MigrationDatabase
type SqliteCtor = new(path: string) => TestDb
const require = createRequire(import.meta.url)

function openDb(): TestDb {
  const module = require('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
  return new (module.default || module)(':memory:')
}

function createLegacyTable(db: TestDb): void {
  db.exec(`CREATE TABLE agent_schedules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cron_expr TEXT NOT NULL, prompt TEXT NOT NULL,
    channel_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, payload_json TEXT,
    last_run_at TEXT, next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
}

test('migration 073 converts lossless cron rows, pauses unsafe rows, and retires the legacy table', (t) => {
  if (skipIfSqliteUnavailable(t, 'agent schedule migration')) return
  const db = openDb()
  try {
    createLegacyTable(db)
    const insert = db.prepare(`INSERT INTO agent_schedules VALUES (?, ?, ?, ?, NULL, 1, ?, NULL, ?, ?, ?)`)
    const now = '2026-07-13T00:00:00.000Z'
    insert.run('daily', 'Daily', '30 8 * * *', 'report', JSON.stringify({ scopeId: 'scope-1', agent: 'analyst', workspaceRoot: '/w' }), '2026-07-14T08:30:00.000Z', now, now)
    insert.run('weekly', 'Weekly', '0 9 * * 1,5', 'review', JSON.stringify({ conversationId: 'scope-2' }), '2026-07-14T09:00:00.000Z', now, now)
    insert.run('no-scope', 'No scope', '0 10 * * *', 'draft', '{}', '2026-07-14T10:00:00.000Z', now, now)
    insert.run('unsafe', 'Unsafe', '*/7 * * * *', 'unsafe', JSON.stringify({ scopeId: 'scope-3' }), '2026-07-14T10:00:00.000Z', now, now)

    __runMigrationForTests('073_agent_scheduled_tasks', db)

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='agent_schedules'").get<{ count: number }>()?.count, 0)
    const daily = db.prepare("SELECT * FROM scheduled_tasks WHERE id='daily'").get<Record<string, unknown>>()!
    assert.deepEqual(JSON.parse(String(daily.schedule_spec_json)), { kind: 'calendar', frequency: 'daily', localTime: '08:30' })
    assert.equal(daily.scope_id, 'scope-1')
    assert.equal(daily.agent_id, 'analyst')
    assert.deepEqual(JSON.parse(String(daily.workspace_roots_json)), ['/w'])
    const weekly = db.prepare("SELECT schedule_spec_json FROM scheduled_tasks WHERE id='weekly'").get<{ schedule_spec_json: string }>()!
    assert.deepEqual(JSON.parse(weekly.schedule_spec_json).weekdays, [1, 5])
    assert.deepEqual(
      db.prepare("SELECT id, enabled, migration_state, next_run_at FROM scheduled_tasks WHERE id IN ('no-scope','unsafe') ORDER BY id").all(),
      [
        { id: 'no-scope', enabled: 0, migration_state: 'needs_scope', next_run_at: null },
        { id: 'unsafe', enabled: 0, migration_state: 'needs_schedule_review', next_run_at: null },
      ],
    )
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_agent_schedule_occurrences_recovery'").get<{ count: number }>()?.count, 1)
  } finally {
    db.close()
  }
})

test('repository atomically reconciles unique occurrences, advances next run, and recovers dispatching work', (t) => {
  if (skipIfSqliteUnavailable(t, 'agent schedule repository')) return
  const db = openDb()
  try {
    createLegacyTable(db)
    __runMigrationForTests('073_agent_scheduled_tasks', db)
    const repository = new ScheduleRepository({ getRawDb: () => db })
    repository.create({
      id: 'schedule-1', name: 'Report', instruction: 'Write report',
      scheduleSpec: { kind: 'calendar', frequency: 'daily', localTime: '09:00' },
      timezone: 'UTC', scopeId: 'scope-1', agentId: 'analyst',
      scopeMode: 'existing',
      nextRunAt: '2026-07-13T09:00:00.000Z', now: '2026-07-13T00:00:00.000Z',
    })
    const reconcile = () => repository.reconcile({
      scheduleId: 'schedule-1', triggeredAt: '2026-07-13T10:00:00.000Z', triggerSource: 'startup',
      nextRunAt: '2026-07-14T09:00:00.000Z',
      occurrences: [
        { scheduledFor: '2026-07-12T09:00:00.000Z', claimStatus: 'skipped_coalesced', delayMs: 90_000_000 },
        { scheduledFor: '2026-07-13T09:00:00.000Z', claimStatus: 'queued', delayMs: 3_600_000 },
      ],
    })
    const first = reconcile()
    assert.equal(first.length, 2)
    assert.equal(reconcile().length, 0, 'repeated reconcile must not claim twice')
    assert.equal(repository.get('schedule-1')?.nextRunAt, '2026-07-14T09:00:00.000Z')
    const queued = first.find((item) => item.claimStatus === 'queued')!
    assert.equal(repository.countScheduledExecutionClaims('schedule-1'), 1)
    assert.equal(repository.updateOccurrenceStatus(queued.id, 'dispatching', { now: '2026-07-13T10:00:01.000Z' })?.attempt, 1)
    assert.equal(repository.listRecoverable().length, 1)
    assert.equal(repository.requeueDispatching(queued.id, '2026-07-13T10:00:02.000Z')?.claimStatus, 'queued')
    assert.equal(repository.listHistory('schedule-1').length, 2)
    repository.reconcile({
      scheduleId: 'schedule-1', triggeredAt: '2026-07-14T10:00:00.000Z', triggerSource: 'timer',
      nextRunAt: null, disableAfterReconcile: true, occurrences: [],
    })
    assert.equal(repository.get('schedule-1')?.enabled, false)
    assert.equal(repository.get('schedule-1')?.nextRunAt, null)
    assert.equal(repository.delete('schedule-1'), true)
    assert.equal(repository.get('schedule-1'), null)
    assert.equal(repository.listHistory('schedule-1').length, 2, 'soft delete preserves occurrence audit')
  } finally {
    db.close()
  }
})
