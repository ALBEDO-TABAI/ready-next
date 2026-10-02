import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInputItem } from '@openai/agents'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import type { DatabaseConnection } from '../main/modules/database/connection'
import type { MigrationDatabase } from '../main/modules/migrations'
import { AgentSessionCheckpointRepository, workflowDigest } from '../main/modules/repositories/agent-session-checkpoint-repository'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import {
  openProviderCheckpointTestDb as openDb,
  providerCheckpointExecutionBinding as executionBinding,
  providerCheckpointPreparedSkill as preparedSkill,
} from './provider-checkpoint-test-fixtures'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type TestDatabase = DatabaseConnection & MigrationDatabase

function setupOwner(db: TestDatabase, suffix: string, messageVisibilityEpoch = 0) {
  const accessor = { getRawDb: () => db }
  const projections = new TaskProjectionRepository(accessor)
  const repository = new AgentSessionCheckpointRepository(accessor)
  const runMeta = new RunMetaRepository(db)
  const parentTaskId = `task-${suffix}`
  const scopeId = `scope-${suffix}`
  const ownerRunId = `run-${suffix}`
  const sourceMessageId = `source-${suffix}`
  const now = '2026-08-12T01:00:00.000Z'
  const binding = executionBinding(ownerRunId)

  db.prepare(
    `INSERT INTO chat_conversations (
       id, agent, title, created_at, updated_at, message_visibility_epoch
     ) VALUES (?, 'butler', ?, ?, ?, ?)`,
  ).run(scopeId, suffix, now, now, messageVisibilityEpoch)
  projections.create({
    taskId: parentTaskId,
    scopeId,
    messageVisibilityEpoch,
    runId: ownerRunId,
    taskType: 'short_task',
    module: 'general',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'none',
    steps: [],
    ownerAgentId: 'butler',
    taskOrigin: 'user_root',
    executionBinding: binding,
    createdAt: now,
    updatedAt: now,
  })
  runMeta.create({
    runId: ownerRunId,
    taskId: parentTaskId,
    scopeId,
    messageVisibilityEpoch,
    agentId: 'butler',
    executionBinding: binding,
    status: 'running',
    taskType: 'short_task',
  }, Date.parse(now))
  db.prepare(
    `INSERT INTO chat_messages (
       id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch
     ) VALUES (?, ?, 'user', 'source', ?, '{}', ?)`,
  ).run(sourceMessageId, scopeId, now, messageVisibilityEpoch)

  return {
    db,
    projections,
    repository,
    parentTaskId,
    scopeId,
    ownerRunId,
    now,
  }
}

async function writeSuspension(owner: ReturnType<typeof setupOwner>) {
  const sourceItems = [{ role: 'user', content: 'pause' } as AgentInputItem]
  return owner.repository.writeCleanBoundary({
    parentTaskId: owner.parentTaskId,
    ownerRunId: owner.ownerRunId,
    role: 'suspension',
    suspensionReason: 'manual',
    publicNotice: 'Paused for review.',
    sourceItems,
    sdkSourceItems: sourceItems,
    sdkSourceItemCount: sourceItems.length,
    sdkSourcePrefixDigest: workflowDigest(sourceItems),
    preparedSkill: preparedSkill(),
    activatedCapabilityGroups: [],
    now: owner.now,
  })
}

async function writeSteering(owner: ReturnType<typeof setupOwner>) {
  return owner.repository.persistCanonicalMessageAndSteer({
    parentTaskId: owner.parentTaskId,
    ownerRunId: owner.ownerRunId,
    message: {
      id: `steering-${owner.ownerRunId}`,
      conversationId: owner.scopeId,
      content: 'continue with this resource',
      structuredContent: [{
        type: 'image',
        mimeType: 'image/png',
        base64: 'c3RhbGU=',
      }],
      timestamp: owner.now,
    },
  })
}

async function writeCloseout(owner: ReturnType<typeof setupOwner>) {
  return owner.repository.commitCanonicalCoreCloseout({
    parentTaskId: owner.parentTaskId,
    ownerRunId: owner.ownerRunId,
    status: 'error',
    terminalReason: 'test_terminal',
    initiator: 'error',
    durationMs: 1,
    finalText: 'The run stopped.',
    conversationId: owner.scopeId,
    taskType: 'short_task',
    module: 'general',
    now: owner.now,
  })
}

test('current and same-epoch successor checkpoint writers remain accepted', async (t) => {
  if (skipIfSqliteUnavailable(t, 'agent-session-message-visibility-current-native')) return

  const currentDb = openDb()
  try {
    const current = setupOwner(currentDb, 'message-visibility-current')
    const suspension = await writeSuspension(current)
    assert.equal(suspension.canonicalMessage?.conversationId, current.scopeId)
    assert.equal(
      currentDb.prepare('SELECT status FROM run_meta WHERE run_id = ?')
        .get<{ status: string }>(current.ownerRunId)?.status,
      'checkpoint',
    )
  } finally {
    currentDb.close()
  }

  const successorDb = openDb()
  try {
    const successor = setupOwner(
      successorDb,
      'publication-diverged-alias-generation-2',
      4,
    )
    const steering = await writeSteering(successor)
    assert.equal(steering.value.receipt.ownerRunIdAtIngress, successor.ownerRunId)
    assert.equal(
      successorDb.prepare('SELECT message_visibility_epoch FROM chat_messages WHERE id = ?')
        .get<{ message_visibility_epoch: number }>(`steering-${successor.ownerRunId}`)
        ?.message_visibility_epoch,
      4,
    )
  } finally {
    successorDb.close()
  }
})

test('reset rejects old notice, steering, and closeout writers with whole-transaction zero writes', async (t) => {
  if (skipIfSqliteUnavailable(t, 'agent-session-message-visibility-reset-native')) return

  const writers = [
    { name: 'notice', write: writeSuspension },
    { name: 'steering', write: writeSteering },
    { name: 'closeout', write: writeCloseout },
  ] as const

  for (const writer of writers) {
    const db = openDb()
    try {
      const owner = setupOwner(db, `message-visibility-stale-${writer.name}`)
      const beforeProjection = owner.projections.get(owner.parentTaskId)
      assert.ok(beforeProjection)
      const beforeProjectionRaw = db.prepare(
        `SELECT revision, steering_receipts_json, checkpoint_refs_json
           FROM task_projections WHERE task_id = ?`,
      ).get<{
        revision: number
        steering_receipts_json: string | null
        checkpoint_refs_json: string | null
      }>(owner.parentTaskId)
      assert.ok(beforeProjectionRaw)
      db.prepare(
        `UPDATE chat_conversations
            SET message_visibility_epoch = message_visibility_epoch + 1
          WHERE id = ?`,
      ).run(owner.scopeId)

      await assert.rejects(
        writer.write(owner),
        /conversation_message_visibility_epoch_stale/,
      )

      assert.equal(owner.projections.get(owner.parentTaskId), null)
      const afterProjectionRaw = db.prepare(
        `SELECT revision, steering_receipts_json, checkpoint_refs_json
           FROM task_projections WHERE task_id = ?`,
      ).get<{
        revision: number
        steering_receipts_json: string | null
        checkpoint_refs_json: string | null
      }>(owner.parentTaskId)
      assert.deepEqual(afterProjectionRaw, beforeProjectionRaw)
      assert.equal(
        db.prepare('SELECT status FROM run_meta WHERE run_id = ?')
          .get<{ status: string }>(owner.ownerRunId)?.status,
        'running',
      )
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM agent_session_checkpoints WHERE parent_task_id = ?')
          .get<{ count: number }>(owner.parentTaskId)?.count,
        0,
      )
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM agent_steering_message_resources WHERE message_id = ?')
          .get<{ count: number }>(`steering-${owner.ownerRunId}`)?.count,
        0,
      )
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?')
          .get<{ count: number }>(owner.scopeId)?.count,
        1,
      )
    } finally {
      db.close()
    }
  }
})

test('missing SDK run identity never falls back to the current scope epoch', async (t) => {
  if (skipIfSqliteUnavailable(t, 'agent-session-message-visibility-missing-run-native')) return
  const db = openDb()
  try {
    const owner = setupOwner(db, 'message-visibility-missing-run')
    db.prepare('DELETE FROM run_meta WHERE run_id = ?').run(owner.ownerRunId)
    await assert.rejects(
      writeSteering(owner),
      /conversation_message_visibility_run_missing/,
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM agent_steering_message_resources')
        .get<{ count: number }>()?.count,
      0,
    )
  } finally {
    db.close()
  }
})
