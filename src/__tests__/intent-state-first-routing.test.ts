/**
 * EP2-I1 — state-first follow-up routing (05 §2.1, S4-1 increment).
 * Hard rule: with task-ref FACTS present and no continuable ref, continuation
 * semantics do not exist — any "继续" is new_task, and the classifier never
 * digs through recalled memory to find a different task (P6 行为层封口).
 * With a continuable ref, vague interrogatives fall into status_query.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyFollowupIntent,
  hasContinuableTaskRef,
  type FollowupTaskRef,
} from '../shared/agent-followup-intent'
import { selectFollowupTaskRefs } from '../main/modules/agent-control/intent-state-first'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/contracts/run-contracts'

const running: FollowupTaskRef = {
  taskId: 'task-run',
  status: 'running',
  interactionState: 'running',
  summary: '采集 A 博主主页',
}
const completed: FollowupTaskRef = { taskId: 'task-done', status: 'completed', interactionState: 'running' }
const failed: FollowupTaskRef = { taskId: 'task-fail', status: 'failed', interactionState: 'running' }
const pendingAdjudication: FollowupTaskRef = {
  taskId: 'task-checkin',
  status: 'completed',
  interactionState: 'check_in_pending',
}

test('hasContinuableTaskRef: active/blocked/check_in_pending qualify, terminal rows do not', () => {
  assert.equal(hasContinuableTaskRef([running]), true)
  assert.equal(hasContinuableTaskRef([{ ...running, status: 'blocked' }]), true)
  assert.equal(hasContinuableTaskRef([pendingAdjudication]), true)
  assert.equal(hasContinuableTaskRef([completed, failed]), false)
  assert.equal(hasContinuableTaskRef([]), false)
})

test('state-first hard rule: no continuable ref → 继续 is new_task, never continue_task', () => {
  for (const text of ['继续', '接着弄', 'resume', '继续刚才的']) {
    const result = classifyFollowupIntent(text, { hasActiveTaskContext: true, taskRefs: [] })
    assert.equal(result.kind, 'new_task', `"${text}" with zero task refs must be new_task`)
    const terminalOnly = classifyFollowupIntent(text, { hasActiveTaskContext: true, taskRefs: [completed, failed] })
    assert.equal(terminalOnly.kind, 'new_task', `"${text}" with only terminal refs must be new_task`)
  }
})

test('continuable ref present: 继续 stays semantic without selecting a task id', () => {
  const result = classifyFollowupIntent('继续', { hasActiveTaskContext: true, taskRefs: [completed, running] })
  assert.equal(result.kind, 'new_task')
  assert.equal(result.continuationCue, true)
  assert.equal(result.targetTaskId, undefined, 'code must not select a resumable task')
})

test('active ref + vague interrogative phrasing falls into status_query (fact-fed fallback)', () => {
  for (const text of ['现在啥情况', '卡在哪了', '那个任务呢']) {
    const result = classifyFollowupIntent(text, { hasActiveTaskContext: true, taskRefs: [running] })
    assert.equal(result.kind, 'status_query', `"${text}" with an active ref must be status_query`)
  }
  // same phrasing with no refs stays new_task — there is nothing to report on
  const noTask = classifyFollowupIntent('现在啥情况', { hasActiveTaskContext: false, taskRefs: [] })
  assert.equal(noTask.kind, 'new_task')
})

test('legacy callers without task facts preserve the cue without selecting a task', () => {
  const legacy = classifyFollowupIntent('继续', { hasActiveTaskContext: true })
  assert.equal(legacy.kind, 'new_task')
  assert.equal(legacy.continuationCue, true)
  const statusLegacy = classifyFollowupIntent('怎么样了', { hasActiveTaskContext: true })
  assert.equal(statusLegacy.kind, 'status_query')
})

test('selectFollowupTaskRefs maps scope projections into classifier facts', () => {
  const records: TaskProjectionRecord[] = [
    {
      taskId: 'task-1', scopeId: 'scope-a', runId: 'run-1', taskType: 'multi_step_task', module: 'browser',
      status: 'running', interactionState: 'running', steps: [], taskSummary: '采集主页',
      blockedReason: null, createdAt: '2026-06-12T08:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
    },
    {
      taskId: 'task-2', scopeId: 'scope-a', runId: 'run-2', taskType: 'short_task', module: 'chat',
      status: 'completed', interactionState: 'check_in_pending', steps: [],
      createdAt: '2026-06-12T07:00:00.000Z', updatedAt: '2026-06-12T08:00:00.000Z',
    },
  ]
  const store: Pick<TaskProjectionStore, 'listByScope'> = {
    listByScope: (scopeId) => records.filter((record) => record.scopeId === scopeId),
  }
  const refs = selectFollowupTaskRefs(store, 'scope-a')
  assert.equal(refs.length, 2)
  assert.deepEqual(refs[0], {
    taskId: 'task-1', status: 'running', interactionState: 'running',
    summary: '采集主页', blockerCategory: null, ownerAgentId: null,
    continuationCheckpointId: null, browserTaskId: null, canResume: false,
  })
  assert.equal(refs[1].interactionState, 'check_in_pending')
  assert.deepEqual(selectFollowupTaskRefs(store, 'scope-other'), [])
  assert.deepEqual(selectFollowupTaskRefs(null, 'scope-a'), [], 'missing store degrades to no facts')
})
