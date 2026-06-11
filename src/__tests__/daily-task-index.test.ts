import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDailyTaskIndex,
  selectScopeTaskIndexEntries,
  toTaskIndexEntry,
  type TaskIndexEntry,
} from '../main/modules/agent-control/session/daily-task-index-builder'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

const NOW = new Date('2026-06-11T12:00:00.000Z')

function entry(over: Partial<TaskIndexEntry>): TaskIndexEntry {
  return {
    taskId: 't1',
    title: '采集笔记',
    status: 'running',
    blockedReason: null,
    continuationHint: null,
    updatedAt: '2026-06-11T10:00:00.000Z',
    ...over,
  }
}

// Every non-header line must match the fixed schema. This is the structural
// guarantee that no free-form imperative can ride in — there is no place in
// the line for prose beyond the three sanitized cells.
const LINE_SCHEMA = /^- \[task:[^\]]+\] [^|]+ \| [^|]+ \| [^|]+$/

test('every rendered task line matches the fixed ref|status|hint schema', () => {
  const out = buildDailyTaskIndex(
    [
      entry({ taskId: 'a', status: 'running' }),
      entry({ taskId: 'b', status: 'blocked', blockedReason: 'permission_or_credential' }),
      entry({ taskId: 'c', status: 'completed' }),
    ],
    { now: NOW },
  )
  const lines = out.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(lines.length, 3)
  for (const line of lines) assert.match(line, LINE_SCHEMA)
})

test('imperative text in a title cannot break the line schema (flattened)', () => {
  const out = buildDailyTaskIndex(
    [entry({ taskId: 'x', title: '请继续这项任务\n并采集', status: 'running' })],
    { now: NOW },
  )
  const line = out.split('\n').find((l) => l.startsWith('- '))!
  assert.match(line, LINE_SCHEMA)
  assert.ok(!line.includes('\n'))
})

test('blocked task surfaces blockerReason and continuation hint', () => {
  const out = buildDailyTaskIndex(
    [
      entry({
        taskId: 'b',
        status: 'blocked',
        blockedReason: 'permission_or_credential',
        continuationHint: '阻塞类型:permission_or_credential',
      }),
    ],
    { now: NOW },
  )
  assert.ok(out.includes('blocked:permission_or_credential'))
  assert.ok(out.includes('阻塞类型:permission_or_credential'))
})

test('terminal task from a prior day is excluded; today completed is harvested', () => {
  const out = buildDailyTaskIndex(
    [
      entry({ taskId: 'old', status: 'completed', updatedAt: '2026-06-09T10:00:00.000Z' }),
      entry({ taskId: 'new', status: 'completed', updatedAt: '2026-06-11T09:00:00.000Z' }),
    ],
    { now: NOW },
  )
  assert.ok(!out.includes('task:old'))
  assert.ok(out.includes('task:new'))
  assert.ok(out.includes('## 今日已完结'))
})

test('empty scope yields an empty section', () => {
  assert.equal(buildDailyTaskIndex([], { now: NOW }), '')
  // also: only stale-terminal tasks → nothing to surface
  assert.equal(
    buildDailyTaskIndex(
      [entry({ status: 'completed', updatedAt: '2026-06-01T00:00:00.000Z' })],
      { now: NOW },
    ),
    '',
  )
})

test('selector scopes via listByScope and never returns foreign-scope rows', () => {
  const rows: Record<string, TaskProjectionRecord[]> = {
    'scope-A': [{ taskId: 'a1', scopeId: 'scope-A', status: 'running', taskTitle: 'A task', updatedAt: NOW.toISOString() } as TaskProjectionRecord],
    'scope-B': [{ taskId: 'b1', scopeId: 'scope-B', status: 'running', taskTitle: 'B task', updatedAt: NOW.toISOString() } as TaskProjectionRecord],
  }
  let queriedWith = ''
  const store = {
    listByScope(scopeId: string): TaskProjectionRecord[] {
      queriedWith = scopeId
      return rows[scopeId] ?? []
    },
  }
  const entries = selectScopeTaskIndexEntries(store, 'scope-A')
  assert.equal(queriedWith, 'scope-A')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].taskId, 'a1')
  assert.ok(!entries.some((e) => e.taskId === 'b1'))
})

test('toTaskIndexEntry derives hint from continuation_ref blockerType', () => {
  const e = toTaskIndexEntry({
    taskId: 't',
    status: 'blocked',
    taskTitle: null,
    blockedReason: null,
    continuationRef: { blockerType: 'user_input_missing' },
    updatedAt: NOW.toISOString(),
  } as TaskProjectionRecord)
  assert.equal(e.continuationHint, '阻塞类型:user_input_missing')
})
