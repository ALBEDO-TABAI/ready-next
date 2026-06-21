import assert from 'node:assert/strict'
import test from 'node:test'

import type { ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'
import {
  drainPendingProjectionSyncs,
  isTerminalProjectionSyncPayload,
  PendingProjectionSyncRepository,
  terminalProjectionStatusFromSummary,
} from '../main/modules/agent-control/task-projection/projection-terminal-retry-ledger'

interface FakeRow {
  id: string
  status: 'pending' | 'exhausted'
  attempts: number
  next_attempt_at: string | null
  last_error: string | null
  payload_json: string
  created_at: string
  updated_at: string
}

function createFakeDb() {
  const rows = new Map<string, FakeRow>()
  return {
    rows,
    getRawDb: () => ({
      prepare: (sql: string) => ({
        run: (...params: unknown[]) => {
          const normalizedSql = sql.trim()
          if (normalizedSql.includes('INSERT INTO pending_projection_syncs')) {
            const [id, attempts, nextAttemptAt, lastError, payloadJson, createdAt, updatedAt] = params
            const existing = rows.get(String(id))
            rows.set(String(id), {
              id: String(id),
              status: 'pending',
              attempts: Number(attempts),
              next_attempt_at: String(nextAttemptAt),
              last_error: String(lastError),
              payload_json: String(payloadJson),
              created_at: existing?.created_at || String(createdAt),
              updated_at: String(updatedAt),
            })
            return
          }
          if (normalizedSql.startsWith('UPDATE pending_projection_syncs')) {
            const [status, attempts, nextAttemptAt, lastError, updatedAt, id] = params
            const existing = rows.get(String(id))
            if (!existing) return
            rows.set(String(id), {
              ...existing,
              status: status as FakeRow['status'],
              attempts: Number(attempts),
              next_attempt_at: typeof nextAttemptAt === 'string' ? nextAttemptAt : null,
              last_error: String(lastError),
              updated_at: String(updatedAt),
            })
            return
          }
          if (normalizedSql.startsWith('DELETE FROM pending_projection_syncs')) {
            rows.delete(String(params[0]))
          }
        },
        get: (...params: unknown[]) => {
          const normalizedSql = sql.trim()
          if (normalizedSql.startsWith('SELECT * FROM pending_projection_syncs WHERE id = ?')) {
            return rows.get(String(params[0]))
          }
          return undefined
        },
        all: (...params: unknown[]) => {
          const normalizedSql = sql.trim()
          if (normalizedSql.includes('WHERE status =')) {
            const [now, limit] = params
            return [...rows.values()]
              .filter((row) => row.status === 'pending' && row.next_attempt_at !== null && row.next_attempt_at <= String(now))
              .sort((a, b) => `${a.next_attempt_at}:${a.created_at}`.localeCompare(`${b.next_attempt_at}:${b.created_at}`))
              .slice(0, Number(limit))
          }
          return []
        },
      }),
    }),
  }
}

function summary(patch: Partial<ScopeRunSummary> = {}): ScopeRunSummary {
  return {
    scopeId: 'scope-1',
    agent: 'main',
    title: 'Test',
    sourceKind: 'local',
    sourceId: 'local',
    channelKey: 'local:local',
    threadKey: 'thread-1',
    phase: 'done',
    runId: 'run-1',
    taskId: 'task-1',
    updatedAt: '2026-06-20T00:00:00.000Z',
    terminalReason: 'done',
    ...patch,
  } as ScopeRunSummary
}

function payload(patch: Partial<ScopeRunEventPayload> = {}): ScopeRunEventPayload {
  return {
    type: 'finished',
    scopeId: 'scope-1',
    agent: 'main',
    phase: 'done',
    runId: 'run-1',
    taskId: 'task-1',
    timestamp: '2026-06-20T00:00:00.000Z',
    ...patch,
  } as ScopeRunEventPayload
}

test('classifies only terminal projection sync payloads for retry', () => {
  assert.equal(terminalProjectionStatusFromSummary(summary({ terminalReason: 'done' })), 'completed')
  assert.equal(terminalProjectionStatusFromSummary(summary({ terminalReason: 'failed_skill' })), 'failed')
  assert.equal(terminalProjectionStatusFromSummary(summary({ terminalReason: 'blocked_config' })), 'failed')
  assert.equal(terminalProjectionStatusFromSummary(summary({ terminalReason: 'cancelled_runtime' })), 'killed')
  assert.equal(terminalProjectionStatusFromSummary(summary({ terminalReason: 'main_no_progress_timeout' })), 'killed')
  assert.equal(isTerminalProjectionSyncPayload(summary({ terminalReason: 'checkpoint_background' })), false)
  assert.equal(isTerminalProjectionSyncPayload(summary({ terminalReason: 'blocked_external' })), false)
  assert.equal(isTerminalProjectionSyncPayload(summary({ terminalReason: null })), false)
})

test('terminal sync failure enqueues a pending ledger row', () => {
  const fake = createFakeDb()
  const repository = new PendingProjectionSyncRepository(fake)
  const row = repository.upsertPending({
    summary: summary({ terminalReason: 'done' }),
    eventPayload: payload(),
    error: new Error('disk unavailable'),
    now: new Date('2026-06-20T00:00:00.000Z'),
  })
  assert.ok(row)
  assert.equal(row.status, 'pending')
  assert.equal(row.attempts, 0)
  assert.equal(row.payload.summary.terminalReason, 'done')
  assert.equal(row.lastError, 'disk unavailable')
})

test('non-terminal sync failure does not enqueue', () => {
  const fake = createFakeDb()
  const repository = new PendingProjectionSyncRepository(fake)
  const row = repository.upsertPending({
    summary: summary({ terminalReason: 'checkpoint_background' }),
    eventPayload: payload({ phase: 'checkpoint' }),
    error: new Error('temporary'),
    now: new Date('2026-06-20T00:00:00.000Z'),
  })
  assert.equal(row, null)
  assert.equal(fake.rows.size, 0)
})

test('due terminal row retries and deletes on success', async () => {
  const fake = createFakeDb()
  const repository = new PendingProjectionSyncRepository(fake)
  const row = repository.upsertPending({
    summary: summary({ terminalReason: 'done' }),
    eventPayload: payload(),
    error: new Error('first failure'),
    now: new Date('2026-06-20T00:00:00.000Z'),
  })
  assert.ok(row)
  const metrics: string[] = []
  const result = await drainPendingProjectionSyncs({
    repository,
    now: new Date('2026-06-20T00:00:00.000Z'),
    sync: async () => {},
    onMetric: (metric) => metrics.push(metric.name),
  })
  assert.deepEqual(result, { attempted: 1, succeeded: 1, failed: 0, exhausted: 0 })
  assert.equal(fake.rows.size, 0)
  assert.deepEqual(metrics, ['projection.sync_retry_succeeded'])
})

test('repeated retry failures become exhausted and emit metric', async () => {
  const fake = createFakeDb()
  const repository = new PendingProjectionSyncRepository(fake)
  const row = repository.upsertPending({
    summary: summary({ terminalReason: 'failed_skill' }),
    eventPayload: payload({ phase: 'error' }),
    error: new Error('first failure'),
    now: new Date('2026-06-20T00:00:00.000Z'),
  })
  assert.ok(row)
  const metrics: string[] = []
  for (const now of [
    '2026-06-20T00:00:00.000Z',
    '2026-06-20T00:00:31.000Z',
    '2026-06-20T00:01:32.000Z',
  ]) {
    await drainPendingProjectionSyncs({
      repository,
      now: new Date(now),
      sync: async () => { throw new Error('still failing') },
      onMetric: (metric) => metrics.push(metric.name),
    })
  }
  const exhausted = [...fake.rows.values()][0]
  assert.equal(exhausted.status, 'exhausted')
  assert.equal(exhausted.attempts, 3)
  assert.ok(metrics.includes('projection.sync_exhausted'))
})
