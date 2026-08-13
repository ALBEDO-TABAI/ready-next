import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterCurrentScopeRunSummaries,
  listCurrentProjectionBackedChildRunSummaries,
} from '../main/modules/agent-control/runtime-core/runtime-helpers'
import type { ConversationScope, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { openProviderCheckpointTestDb as openDb } from './provider-checkpoint-test-fixtures'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const now = '2026-08-12T04:00:00.000Z'

function scope(epoch: number, aliasGeneration: number): ConversationScope {
  return {
    id: 'scope-current-visible',
    aliasGeneration,
    messageVisibilityEpoch: epoch,
    agent: 'butler',
    activeAgentId: 'butler',
    handoffGeneration: 0,
    title: 'Current visible',
    sourceKind: 'local',
    sourceId: 'local',
    threadKey: 'scope-current-visible',
    meta: {},
    createdAt: now,
    updatedAt: now,
  }
}

function runSummary(epoch: number, aliasGeneration: number): ScopeRunSummary {
  return {
    scopeId: 'scope-current-visible',
    aliasGeneration,
    messageVisibilityEpoch: epoch,
    agent: 'butler',
    title: 'Current visible',
    sourceKind: 'local',
    sourceId: 'local',
    channelKey: 'local',
    threadKey: 'scope-current-visible',
    phase: 'running',
    runId: `run-${epoch}`,
    taskId: `task-${epoch}`,
    updatedAt: now,
  }
}

test('scope-run and projection-backed child reads expose only the current context epoch', (t) => {
  if (skipIfSqliteUnavailable(t, 'runtime-current-visible-summaries-native')) return
  const db = openDb()
  try {
    db.prepare(
      `INSERT INTO chat_conversations (
         id, agent, title, created_at, updated_at, message_visibility_epoch
       ) VALUES (?, 'butler', ?, ?, ?, 0)`,
    ).run('scope-current-visible', 'Current visible', now, now)
    const projections = new TaskProjectionRepository({ getRawDb: () => db })
    const createChildProjection = (epoch: number) => projections.create({
      taskId: `skill-child:child-${epoch}`,
      scopeId: 'scope-current-visible',
      messageVisibilityEpoch: epoch,
      runId: `run-${epoch}`,
      taskType: 'long_task',
      module: 'skill',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      continuationRef: {
        taskId: `skill-child:child-${epoch}`,
        childRunId: `child-${epoch}`,
        outputDir: `/tmp/child-${epoch}`,
        runStatePath: `/tmp/child-${epoch}/run_state.json`,
      },
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      createdAt: now,
      updatedAt: now,
    })
    createChildProjection(0)

    let currentScope: ConversationScope | null = scope(0, 1)
    const scopeRunSummaries = new Map<string, ScopeRunSummary>([
      ['scope-current-visible', runSummary(0, 1)],
    ])
    const listScopeRuns = () => filterCurrentScopeRunSummaries(
      scopeRunSummaries.values(),
      () => currentScope,
    )
    const listProjectionRuns = () => listCurrentProjectionBackedChildRunSummaries(db)

    assert.deepEqual(listScopeRuns().map((row) => row.runId), ['run-0'])
    assert.deepEqual(
      listProjectionRuns().rows.map((row) => [row.childRunId, row.messageVisibilityEpoch]),
      [['child-0', 0]],
    )

    db.prepare(
      `UPDATE chat_conversations
          SET message_visibility_epoch = 1
        WHERE id = 'scope-current-visible'`,
    ).run()
    currentScope = scope(1, 2)
    assert.deepEqual(listScopeRuns(), [])
    assert.deepEqual(listProjectionRuns().rows, [])

    createChildProjection(1)
    scopeRunSummaries.set('scope-current-visible', runSummary(1, 2))
    assert.deepEqual(listScopeRuns().map((row) => row.runId), ['run-1'])
    assert.deepEqual(
      listProjectionRuns().rows.map((row) => [row.childRunId, row.messageVisibilityEpoch]),
      [['child-1', 1]],
    )

    currentScope = scope(1, 3)
    assert.deepEqual(listScopeRuns().map((row) => row.runId), ['run-1'])
    assert.deepEqual(
      listProjectionRuns().rows.map((row) => [row.childRunId, row.messageVisibilityEpoch]),
      [['child-1', 1]],
    )
  } finally {
    db.close()
  }
})
