/**
 * Phase 4 — TTL sweep behaviour for ExecutionStateStore.purgeExpiredExecutions.
 *
 * better-sqlite3 is an electron-native module that can't load in the Node
 * test runner, so we mock the DatabaseConnection interface with an
 * in-memory table model that recognises the exact query shapes the
 * sweep uses. The behaviour under test (terminal filter + finished_at
 * cutoff + explicit child-table delete order) is kept in sync with the
 * implementation by source-level assertions in
 * `execution-state-store-ttl-contract.test.ts`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ExecutionStateStore } from '../main/modules/skills-runtime/execution-state-store'

interface ExecutionRow {
  id: string
  status: 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
  finished_at: string | null
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

class FakeDb {
  public executions = new Map<string, ExecutionRow>()
  public steps = new Map<string, string>() // step id → execution id
  public artifacts = new Map<string, string>() // artifact id → execution id

  prepare(sql: string) {
    const trimmed = sql.replace(/\s+/g, ' ').trim()

    if (trimmed.startsWith('SELECT id FROM skill_executions')) {
      return {
        all: (cutoff: string) => {
          const rows: { id: string }[] = []
          for (const row of this.executions.values()) {
            const terminal = row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled'
            if (!terminal) continue
            if (row.finished_at === null) continue
            if (row.finished_at >= cutoff) continue
            rows.push({ id: row.id })
          }
          return rows
        },
        run: () => { throw new Error('unexpected run() on SELECT') },
        get: () => { throw new Error('unexpected get()') },
      }
    }

    if (trimmed.startsWith('DELETE FROM skill_execution_artifacts')) {
      return {
        run: (...ids: string[]) => {
          let changes = 0
          for (const [aid, executionId] of this.artifacts.entries()) {
            if (ids.includes(executionId)) {
              this.artifacts.delete(aid)
              changes += 1
            }
          }
          return { changes }
        },
        all: () => [],
        get: () => undefined,
      }
    }

    if (trimmed.startsWith('DELETE FROM skill_execution_steps')) {
      return {
        run: (...ids: string[]) => {
          let changes = 0
          for (const [sid, executionId] of this.steps.entries()) {
            if (ids.includes(executionId)) {
              this.steps.delete(sid)
              changes += 1
            }
          }
          return { changes }
        },
        all: () => [],
        get: () => undefined,
      }
    }

    if (trimmed.startsWith('DELETE FROM skill_executions')) {
      return {
        run: (...ids: string[]) => {
          let changes = 0
          for (const id of ids) {
            if (this.executions.delete(id)) changes += 1
          }
          return { changes }
        },
        all: () => [],
        get: () => undefined,
      }
    }

    throw new Error(`FakeDb does not implement: ${trimmed.slice(0, 80)}`)
  }
}

test('purge deletes only terminal rows older than retention window', () => {
  const db = new FakeDb()
  db.executions.set('e-running', { id: 'e-running', status: 'running', finished_at: null })
  db.executions.set('e-blocked', { id: 'e-blocked', status: 'blocked', finished_at: null })
  db.executions.set('e-fresh-done', { id: 'e-fresh-done', status: 'completed', finished_at: daysAgoIso(3) })
  db.executions.set('e-old-done', { id: 'e-old-done', status: 'completed', finished_at: daysAgoIso(10) })
  db.executions.set('e-old-failed', { id: 'e-old-failed', status: 'failed', finished_at: daysAgoIso(100) })
  db.executions.set('e-old-cancelled', { id: 'e-old-cancelled', status: 'cancelled', finished_at: daysAgoIso(8) })

  const store = new ExecutionStateStore(db as unknown as ConstructorParameters<typeof ExecutionStateStore>[0])
  const result = store.purgeExpiredExecutions(7)
  assert.equal(result.deleted, 3)

  const remaining = Array.from(db.executions.keys()).sort()
  assert.deepEqual(remaining, ['e-blocked', 'e-fresh-done', 'e-running'])
})

test('purge is idempotent — second call returns deleted: 0', () => {
  const db = new FakeDb()
  db.executions.set('e-old', { id: 'e-old', status: 'completed', finished_at: daysAgoIso(10) })
  const store = new ExecutionStateStore(db as unknown as ConstructorParameters<typeof ExecutionStateStore>[0])
  assert.equal(store.purgeExpiredExecutions(7).deleted, 1)
  assert.equal(store.purgeExpiredExecutions(7).deleted, 0)
})

test('purge explicitly deletes child rows (steps + artifacts) when parent dies', () => {
  const db = new FakeDb()
  db.executions.set('e-purge', { id: 'e-purge', status: 'completed', finished_at: daysAgoIso(10) })
  db.steps.set('step-1', 'e-purge')
  db.steps.set('step-2', 'e-purge')
  db.artifacts.set('art-1', 'e-purge')

  // Add an active execution with its own children — must be untouched.
  db.executions.set('e-active', { id: 'e-active', status: 'running', finished_at: null })
  db.steps.set('step-keep', 'e-active')
  db.artifacts.set('art-keep', 'e-active')

  const store = new ExecutionStateStore(db as unknown as ConstructorParameters<typeof ExecutionStateStore>[0])
  const result = store.purgeExpiredExecutions(7)
  assert.equal(result.deleted, 1)
  assert.equal(db.steps.size, 1)
  assert.equal(db.steps.has('step-keep'), true)
  assert.equal(db.artifacts.size, 1)
  assert.equal(db.artifacts.has('art-keep'), true)
})

test('terminal rows with null finished_at are not swept', () => {
  // Defensive: a crashed / malformed row that never got finished_at set
  // should not be purged (we don't know how old it is). Only rows with an
  // explicit finished_at < cutoff are eligible.
  const db = new FakeDb()
  db.executions.set('e-malformed', { id: 'e-malformed', status: 'failed', finished_at: null })
  const store = new ExecutionStateStore(db as unknown as ConstructorParameters<typeof ExecutionStateStore>[0])
  assert.equal(store.purgeExpiredExecutions(7).deleted, 0)
  assert.equal(db.executions.size, 1)
})

test('purge with empty db returns deleted: 0 without any DELETE fired', () => {
  const db = new FakeDb()
  let deleteCalled = false
  const originalPrepare = db.prepare.bind(db)
  db.prepare = (sql: string) => {
    if (sql.replace(/\s+/g, ' ').trim().startsWith('DELETE')) deleteCalled = true
    return originalPrepare(sql)
  }
  const store = new ExecutionStateStore(db as unknown as ConstructorParameters<typeof ExecutionStateStore>[0])
  assert.equal(store.purgeExpiredExecutions(7).deleted, 0)
  assert.equal(deleteCalled, false)
})

test('retentionDays is clamped to at least 1 day', () => {
  const db = new FakeDb()
  db.executions.set('e-today', { id: 'e-today', status: 'completed', finished_at: new Date().toISOString() })
  const store = new ExecutionStateStore(db as unknown as ConstructorParameters<typeof ExecutionStateStore>[0])
  // 0 or negative days still leaves a 1-day floor, so "today" rows stay.
  assert.equal(store.purgeExpiredExecutions(0).deleted, 0)
  assert.equal(store.purgeExpiredExecutions(-5).deleted, 0)
})
