import assert from 'node:assert/strict'
import test from 'node:test'

import { dispatchScheduledOccurrence, type ScheduleExecutionDeps } from '../main/modules/scheduled-tasks/schedule-execution'
import type { ScheduledTaskDefinition, ScheduledTaskOccurrence } from '../main/modules/scheduled-tasks/schedule-repository'

const schedule: ScheduledTaskDefinition = {
  id: 'schedule-1', name: 'Daily report', instruction: 'Write the report', scheduleSpecVersion: 1,
  scheduleSpec: { kind: 'calendar', frequency: 'daily', localTime: '09:00' }, timezone: 'UTC',
  scopeId: 'scope-1', scopeMode: 'existing', agentId: 'analyst', workspaceRoots: ['/workspace'], enabled: true,
  nextRunAt: null, lastOccurrenceAt: null, missedPolicy: 'coalesce_latest', migrationState: null,
  createdAt: '2026-07-13T00:00:00Z', updatedAt: '2026-07-13T00:00:00Z', deletedAt: null,
}
const occurrence: ScheduledTaskOccurrence = {
  id: 'occ-1', scheduleId: schedule.id, scheduledFor: '2026-07-13T09:00:00Z',
  triggeredAt: '2026-07-13T09:00:01Z', triggerSource: 'timer', claimStatus: 'queued', attempt: 0,
  runId: null, taskId: null, delayMs: 1000, startedAt: null, finishedAt: null,
  errorKind: null, errorMessage: null, createdAt: '2026-07-13T09:00:01Z', updatedAt: '2026-07-13T09:00:01Z',
}

function harness(overrides: Partial<ScheduleExecutionDeps> = {}) {
  const events: string[] = []
  let sent: Parameters<ScheduleExecutionDeps['send']>[0] | null = null
  const deps: ScheduleExecutionDeps = {
    getSchedule: () => schedule,
    scopeExists: () => true,
    agentAvailable: () => true,
    workspaceAvailable: () => true,
    pauseSchedule: (_, reason) => events.push(`pause:${reason}`),
    markDispatching: () => { events.push('dispatching'); return true },
    markDispatched: () => events.push('dispatched'),
    markFailed: (_, kind) => events.push(`failed:${kind}`),
    send: async (payload) => { sent = payload; return { success: true } },
    ...overrides,
  }
  return { deps, events, get sent() { return sent } }
}

test('dispatch keeps the verbatim instruction and carries schedule origin separately', async () => {
  const run = harness()
  const result = await dispatchScheduledOccurrence(occurrence, run.deps)
  assert.equal(result.success, true)
  assert.equal(run.sent?.message, 'Write the report')
  assert.equal(run.sent?.envelope.userRequestVerbatim, 'Write the report')
  assert.equal(run.sent?.scopeId, 'scope-1')
  assert.equal(run.sent?.agent, 'analyst')
  assert.deepEqual(run.sent?.workspaceRoots, ['/workspace'])
  assert.deepEqual(run.events, ['dispatching', 'dispatched'])
})

test('missing scope pauses the schedule and never sends or creates a hidden target', async () => {
  let sent = false
  const run = harness({ scopeExists: () => false, send: async () => { sent = true; return { success: true } } })
  const result = await dispatchScheduledOccurrence(occurrence, run.deps)
  assert.equal(result.errorKind, 'blocked_scope_missing')
  assert.equal(sent, false)
  assert.deepEqual(run.events, ['pause:blocked_scope_missing', 'failed:blocked_scope_missing'])
})

test('unavailable agent or workspace blocks before dispatch', async () => {
  for (const override of [
    { agentAvailable: () => false },
    { workspaceAvailable: () => false },
  ]) {
    const run = harness(override)
    const result = await dispatchScheduledOccurrence(occurrence, run.deps)
    assert.match(result.errorKind || '', /^blocked_(agent|workspace)_/)
    assert.equal(run.sent, null)
  }
})

test('provider dispatch failure is written to the occurrence ledger', async () => {
  const run = harness({ send: async () => ({ success: false, error: 'provider unavailable', errorKind: 'provider_unavailable' }) })
  const result = await dispatchScheduledOccurrence(occurrence, run.deps)
  assert.equal(result.success, false)
  assert.deepEqual(run.events, ['dispatching', 'failed:provider_unavailable'])
})

test('a named skill that becomes unavailable is surfaced without claiming success', async () => {
  const unavailableSkill = { ...schedule, instruction: 'Use send-im to notify the team' }
  const run = harness({
    getSchedule: () => unavailableSkill,
    send: async () => ({
      success: false,
      error: 'The requested skill is not installed',
      errorKind: 'tool_not_registered',
    }),
  })

  const result = await dispatchScheduledOccurrence(occurrence, run.deps)

  assert.equal(result.errorKind, 'tool_not_registered')
  assert.deepEqual(run.events, ['dispatching', 'failed:tool_not_registered'])
})

test('an already-claimed final occurrence still runs after future scheduling is disabled', async () => {
  const disabled = { ...schedule, enabled: false }
  const run = harness({ getSchedule: () => disabled })

  const result = await dispatchScheduledOccurrence(occurrence, run.deps)

  assert.equal(result.success, true)
  assert.deepEqual(run.events, ['dispatching', 'dispatched'])
})
