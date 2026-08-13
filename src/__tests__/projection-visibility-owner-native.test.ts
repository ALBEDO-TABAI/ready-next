import assert from 'node:assert/strict'
import test from 'node:test'

import type { ConversationScope, ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'
import { ProjectionSyncCoordinator } from '../main/modules/agent-control/runtime-core/projection-sync-coordinator'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { RunProjection } from '../main/modules/agent-control/task-projection/run-projection'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { openProviderCheckpointTestDb as openDb } from './provider-checkpoint-test-fixtures'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const now = '2026-08-12T08:00:00.000Z'

function scope(epoch: number, aliasGeneration: number | null): ConversationScope {
  return {
    id: 'scope-projection-owner',
    aliasGeneration,
    messageVisibilityEpoch: epoch,
    agent: 'butler',
    activeAgentId: 'butler',
    handoffGeneration: 0,
    title: 'Projection owner',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-projection-owner',
    meta: {},
    createdAt: now,
    updatedAt: now,
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('context-owned scope-run events publish once, survive alias rollover, and reject reset-stale owners', async (t) => {
  if (skipIfSqliteUnavailable(t, 'projection-visibility-owner-native')) return
  const db = openDb()
  try {
    db.prepare(`
      INSERT INTO chat_conversations (
        id, agent, title, source_kind, source_id, thread_key,
        created_at, updated_at, message_visibility_epoch
      ) VALUES (?, 'butler', ?, 'local', 'app', ?, ?, ?, 0)
    `).run('scope-projection-owner', 'Projection owner', 'scope-projection-owner', now, now)
    const runMeta = new RunMetaRepository(db)
    runMeta.create({
      runId: 'sdk-run-0',
      taskId: 'sdk-task-0',
      scopeId: 'scope-projection-owner',
      messageVisibilityEpoch: 0,
      agentId: 'butler',
      status: 'running',
    })

    let currentScope = scope(0, 1)
    let currentAliasGeneration: number | null = 1
    const summaries = new Map<string, ScopeRunSummary>()
    const emitted: ScopeRunEventPayload[] = []
    const taskProjections = new TaskProjectionRepository({ getRawDb: () => db })
    const runProjection = new RunProjection({
      getScope: (scopeId) => scopeId === currentScope.id ? currentScope : null,
      getPrevious: (scopeId) => summaries.get(scopeId),
      setSummary: (scopeId, summary) => {
        summaries.set(scopeId, summary)
        return true
      },
      toChannelKey: () => 'local:app',
    })
    const coordinator = new ProjectionSyncCoordinator({
      db: { getRawDb: () => db } as never,
      taskProjectionStore: taskProjections,
      runProjection,
      readAliasGeneration: () => currentAliasGeneration,
      readActiveProductRunVisibilityIdentity: () => null,
      readCommittedProductRunVisibilityIdentity: () => null,
      emit: (event, payload) => {
        if (event === 'scopeRunEvent') emitted.push(payload as ScopeRunEventPayload)
      },
    })
    const base: ScopeRunEventPayload = {
      type: 'started',
      scopeId: currentScope.id,
      messageVisibilityEpoch: 0,
      visibilityOwnerKind: 'context_background',
      visibilityOwnerLedger: { kind: 'run_meta', id: 'sdk-run-0' },
      agent: 'butler',
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      runId: 'sdk-run-0',
      taskId: 'sdk-task-0',
      phase: 'planning',
      taskTitle: 'SDK task',
      taskSummary: 'epoch zero',
      timestamp: now,
    }

    coordinator.publishScopeRunEvent(base)
    await nextTurn()
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]?.aliasGeneration, 1)
    assert.equal(emitted[0]?.messageVisibilityEpoch, 0)

    currentAliasGeneration = 2
    currentScope = scope(0, 2)
    coordinator.publishScopeRunEvent({
      ...base,
      type: 'updated',
      phase: 'responding',
      taskSummary: 'same context after stop',
    })
    await nextTurn()
    assert.equal(emitted.length, 2)
    assert.equal(emitted[1]?.aliasGeneration, 2)
    assert.equal(summaries.get(currentScope.id)?.taskSummary, 'same context after stop')

    const beforeReset = db.prepare(`
      SELECT revision, task_summary FROM task_projections WHERE task_id = 'sdk-task-0'
    `).get<{ revision: number; task_summary: string | null }>()
    assert.ok(beforeReset)
    db.prepare(`
      UPDATE chat_conversations
         SET message_visibility_epoch = 1
       WHERE id = 'scope-projection-owner'
    `).run()
    currentAliasGeneration = 3
    currentScope = scope(1, 3)
    coordinator.publishScopeRunEvent({
      ...base,
      type: 'updated',
      phase: 'done',
      taskSummary: 'stale epoch zero terminal',
    })
    await nextTurn()
    assert.equal(emitted.length, 2)
    const afterStale = db.prepare(`
      SELECT revision, task_summary FROM task_projections WHERE task_id = 'sdk-task-0'
    `).get<{ revision: number; task_summary: string | null }>()
    assert.deepEqual(afterStale, beforeReset)

    runMeta.create({
      runId: 'sdk-run-1',
      taskId: 'sdk-task-1',
      scopeId: 'scope-projection-owner',
      messageVisibilityEpoch: 1,
      agentId: 'butler',
      status: 'running',
    })
    coordinator.publishScopeRunEvent({
      ...base,
      messageVisibilityEpoch: 1,
      visibilityOwnerLedger: { kind: 'run_meta', id: 'sdk-run-1' },
      runId: 'sdk-run-1',
      taskId: 'sdk-task-1',
      taskSummary: 'new context',
    })
    await nextTurn()
    assert.equal(emitted.length, 3)
    assert.equal(emitted[2]?.messageVisibilityEpoch, 1)
    assert.equal(emitted[2]?.aliasGeneration, 3)
  } finally {
    db.close()
  }
})

test('product provisional and committed terminal publishers have disjoint authority', async (t) => {
  if (skipIfSqliteUnavailable(t, 'projection-product-visibility-owner-native')) return
  const db = openDb()
  try {
    db.prepare(`
      INSERT INTO chat_conversations (
        id, agent, title, source_kind, source_id, thread_key,
        created_at, updated_at, message_visibility_epoch
      ) VALUES (?, 'butler', ?, 'local', 'app', ?, ?, ?, 0)
    `).run('scope-projection-owner', 'Projection owner', 'scope-projection-owner', now, now)

    type ProductOwner = {
      readyRunId: string
      readyScopeId: string
      readyAliasId: string
      aliasGeneration: number
      messageVisibilityEpoch: number
    }
    const owner = (readyRunId: string, aliasGeneration: number): ProductOwner => ({
      readyRunId,
      readyScopeId: 'scope-projection-owner',
      readyAliasId: 'scope-projection-owner',
      aliasGeneration,
      messageVisibilityEpoch: 0,
    })
    const active = new Map<string, ProductOwner>([
      ['product-stop', owner('product-stop', 1)],
      ['product-reset', owner('product-reset', 2)],
    ])
    const committed = new Map<string, ProductOwner>()
    let currentScope = scope(0, 1)
    const summaries = new Map<string, ScopeRunSummary>()
    const emitted: ScopeRunEventPayload[] = []
    const coordinator = new ProjectionSyncCoordinator({
      db: { getRawDb: () => db } as never,
      taskProjectionStore: new TaskProjectionRepository({ getRawDb: () => db }),
      runProjection: new RunProjection({
        getScope: (scopeId) => scopeId === currentScope.id ? currentScope : null,
        getPrevious: (scopeId) => summaries.get(scopeId),
        setSummary: (scopeId, summary) => {
          summaries.set(scopeId, summary)
          return true
        },
        toChannelKey: () => 'local:app',
      }),
      readAliasGeneration: () => currentScope.aliasGeneration,
      readActiveProductRunVisibilityIdentity: (runId) => active.get(runId) ?? null,
      readCommittedProductRunVisibilityIdentity: (runId) => committed.get(runId) ?? null,
      emit: (event, payload) => {
        if (event === 'scopeRunEvent') emitted.push(payload as ScopeRunEventPayload)
      },
    })
    const event = (runId: string, aliasGeneration: number): ScopeRunEventPayload => ({
      type: 'started',
      scopeId: 'scope-projection-owner',
      aliasGeneration,
      messageVisibilityEpoch: 0,
      visibilityOwnerKind: 'product_alias',
      agent: 'butler',
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      runId,
      taskId: `task-${runId}`,
      phase: 'planning',
      taskTitle: runId,
      timestamp: now,
    })

    coordinator.publishScopeRunEvent(event('product-stop', 1))
    await nextTurn()
    assert.equal(emitted.length, 1)

    // Stop rolls the alias generation but keeps the context epoch. Once the
    // closeout commits, provisional publication loses authority and the exact
    // committed terminal owns a single final publication.
    currentScope = scope(0, 2)
    active.delete('product-stop')
    committed.set('product-stop', owner('product-stop', 1))
    coordinator.publishScopeRunEvent({
      ...event('product-stop', 1),
      type: 'updated',
      phase: 'responding',
    })
    coordinator.publishScopeRunEvent({
      ...event('product-stop', 99),
      type: 'updated',
      phase: 'responding',
    })
    assert.equal(emitted.length, 1)
    const stopTerminal: ScopeRunEventPayload = {
      ...event('product-stop', 1),
      type: 'updated',
      phase: 'cancelled',
      terminalReason: 'cancelled_user',
    }
    coordinator.publishCommittedScopeRunEvent(stopTerminal)
    coordinator.publishCommittedScopeRunEvent(stopTerminal)
    assert.equal(emitted.length, 2)
    assert.equal(emitted[1]?.phase, 'cancelled')

    coordinator.publishScopeRunEvent(event('product-reset', 2))
    await nextTurn()
    assert.equal(emitted.length, 3)
    active.delete('product-reset')
    committed.set('product-reset', owner('product-reset', 2))
    db.prepare(`
      UPDATE chat_conversations
         SET message_visibility_epoch = 1
       WHERE id = 'scope-projection-owner'
    `).run()
    currentScope = scope(1, 3)
    const summaryBeforeResetTerminal = summaries.get(currentScope.id)
    const resetTerminal: ScopeRunEventPayload = {
      ...event('product-reset', 2),
      type: 'updated',
      phase: 'error',
      terminalReason: 'persistence_failed',
    }
    coordinator.publishCommittedScopeRunEvent(resetTerminal)
    coordinator.publishCommittedScopeRunEvent(resetTerminal)
    assert.equal(emitted.length, 4)
    assert.equal(emitted[3]?.runId, 'product-reset')
    assert.equal(emitted[3]?.messageVisibilityEpoch, 0)
    assert.equal(summaries.get(currentScope.id), summaryBeforeResetTerminal)

    coordinator.publishCommittedScopeRunEvent({
      ...resetTerminal,
      runId: 'forged-product',
    })
    assert.equal(emitted.length, 4)
    await nextTurn()
  } finally {
    db.close()
  }
})
