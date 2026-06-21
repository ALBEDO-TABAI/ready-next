'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { validateProjectionTerminalRetrySources } = require('../check-projection-terminal-retry-ledger.cjs')

const VALID_RUNTIME = `
import { drainPendingProjectionSyncs, isTerminalProjectionSyncPayload, PendingProjectionSyncRepository } from '../task-projection/projection-terminal-retry-ledger'
class Runtime {
  private readonly pendingProjectionSyncs = new PendingProjectionSyncRepository(this.db)
  private projectionSyncRetryDrainInFlight = null
  async start(): Promise<void> {
    this.scheduleTerminalProjectionSyncRetryDrain('startup')
  }
  recordScopeRunEvent(payload, projectionTruth) {
    const summary = this.recordRunProjectionEvent(payload, projectionTruth)
    if (summary) {
      void syncTaskProjection(this.taskProjectionStore, summary, payload, projectionTruth).catch((error) => {
        this.handleProjectionSyncFailure(summary, payload, projectionTruth, error)
      })
    }
    return summary
  }
  private handleProjectionSyncFailure(summary, payload, projectionTruth, error): void {
    logAgentMetric('projection.sync_failed', {})
    if (!isTerminalProjectionSyncPayload(summary)) return
    this.pendingProjectionSyncs.upsertPending({ summary, eventPayload: payload, projectionTruth, error })
    this.scheduleTerminalProjectionSyncRetryDrain('terminal_sync_failed')
  }
  private scheduleTerminalProjectionSyncRetryDrain(reason): void {
    if (this.projectionSyncRetryDrainInFlight) return
    this.projectionSyncRetryDrainInFlight = this.drainTerminalProjectionSyncRetries(reason)
  }
  private async drainTerminalProjectionSyncRetries(reason): Promise<void> {
    await drainPendingProjectionSyncs({
      repository: this.pendingProjectionSyncs,
      sync: async (entry) => syncTaskProjection(this.taskProjectionStore, entry.summary, entry.eventPayload, entry.projectionTruth),
    })
  }
}
`

const VALID_LEDGER = `
export const TERMINAL_PROJECTION_RETRY_MAX_ATTEMPTS = 3
export function terminalProjectionStatusFromSummary(summary) { return summary.terminalReason === 'done' ? 'completed' : null }
const SQL = 'pending_projection_syncs'
function metric() { return { name: 'projection.sync_exhausted' } }
`

const VALID_MIGRATIONS = `
{
  name: '061_pending_projection_syncs',
  up: (db) => {
    db.exec('CREATE TABLE IF NOT EXISTS pending_projection_syncs (id TEXT PRIMARY KEY)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_pending_projection_syncs_due ON pending_projection_syncs(status, next_attempt_at)')
  }
}
`

function validate(overrides = {}) {
  return validateProjectionTerminalRetrySources({
    runtime: VALID_RUNTIME,
    ledger: VALID_LEDGER,
    migrations: VALID_MIGRATIONS,
    ...overrides,
  })
}

test('accepts runtime, ledger, and migration wiring', () => {
  const result = validate()
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('rejects runtime that does not enqueue terminal failures', () => {
  const result = validate({ runtime: VALID_RUNTIME.replace('this.pendingProjectionSyncs.upsertPending({ summary, eventPayload: payload, projectionTruth, error })', '') })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /upsertPending/)
})

test('rejects runtime that drops existing sync failure metric', () => {
  const result = validate({ runtime: VALID_RUNTIME.replace("logAgentMetric('projection.sync_failed', {})", '') })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /projection\.sync_failed/)
})

test('rejects runtime that does not drain on startup', () => {
  const result = validate({ runtime: VALID_RUNTIME.replace("this.scheduleTerminalProjectionSyncRetryDrain('startup')", '') })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /startup/)
})

test('rejects missing migration table', () => {
  const result = validate({ migrations: VALID_MIGRATIONS.replace('CREATE TABLE IF NOT EXISTS pending_projection_syncs', 'CREATE TABLE IF NOT EXISTS other') })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /pending_projection_syncs table/)
})
