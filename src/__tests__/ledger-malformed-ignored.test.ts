/**
 * EP2-T2 — write-direction gate (warning mode) + malformed-ignored consumer
 * behavior: a sick ledger row is skipped with a ledger_malformed metric, the
 * healthy rows still render, and nothing crashes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'

import { selectScopeTaskIndexEntries } from '../main/modules/agent-control/session/daily-task-index-builder'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

test('malformed projection rows are skipped with a metric; healthy rows survive', () => {
  const rows = [
    {
      taskId: 'task-ok', scopeId: 's1', runId: 'r1', taskType: 'short_task', module: 'chat',
      status: 'running', interactionState: 'running', steps: [],
      createdAt: '2026-06-12T08:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
    },
    // identity facts missing / invalid — three malformed shapes
    { taskId: '', status: 'running', updatedAt: '2026-06-12T09:00:00.000Z', steps: [] },
    { taskId: 'task-no-status', status: '', updatedAt: '2026-06-12T09:00:00.000Z', steps: [] },
    { taskId: 'task-bad-ts', status: 'running', updatedAt: 'not-a-date', steps: [] },
  ] as unknown as TaskProjectionRecord[]

  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const entries = selectScopeTaskIndexEntries({ listByScope: () => rows }, 's1')
    assert.equal(entries.length, 1, 'only the healthy row renders')
    assert.equal(entries[0].taskId, 'task-ok')
    const malformed = events.filter((event) => event.metric === 'ledger_malformed')
    assert.equal(malformed.length, 3, 'one metric per sick row')
    assert.equal((malformed[0] as unknown as { consumer: string }).consumer, 'daily_task_index')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('write-direction gate runs in warning mode: exit 0, inventory listed, strict flag available', () => {
  const output = execFileSync('node', ['scripts/check-ledger-write-direction.cjs'], { encoding: 'utf-8' })
  assert.match(output, /check-ledger-write-direction: ok/)
  // the known existing-violation inventory (burn-down list, see ownership
  // matrix spec): startup-run-reconciler×6 (terminal projection/status repair)
  // + database.ts browser_tasks×2. New violations would raise this count —
  // the assertion pins the inventory so additions are loud.
  assert.match(output, /\(8 warnings\)/)
})
