import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import type { AgentInputItem } from '@openai/agents'

import type { DatabaseConnection } from '../main/modules/database'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { buildPreparedSkillTurnTruth } from '../main/modules/agent-control/skills/prepared-skill-turn'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { AgentSessionCheckpointRepository, workflowDigest } from '../main/modules/repositories/agent-session-checkpoint-repository'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type SqliteCtor = new (path: string) => DatabaseConnection & MigrationDatabase
const require = createRequire(import.meta.url)

function openDb(): DatabaseConnection & MigrationDatabase {
  const mod = require('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
  const Sqlite = mod.default || mod
  const db = new Sqlite(':memory:')
  runMigrations(db)
  return db
}

function executionBinding(runId: string) {
  return {
    schemaVersion: 1 as const,
    runId,
    ownerAgentIdAtStart: 'butler',
    runOrigin: 'initial' as const,
    kind: 'registered_agent' as const,
    requestedAgentId: 'butler',
    effectiveAgentId: 'butler',
    executionMaterialHash: 'material',
    ownerAssignmentSource: 'conversation_active' as const,
    executionSelectionSource: 'task_owner' as const,
    resolutionKind: 'direct' as const,
  }
}

function preparedSkill() {
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  return buildPreparedSkillTurnTruth({
    identity: { mode: 'none', reason: 'no_skill_signal' },
    authorization,
    requestOrResourceAnchorDigest: 'request-digest',
    floors: { toolNames: new Set(), reasons: [] },
    surface: { composition: 'additive', exclusiveScopeRef: null },
  })
}

test('provider_transfer suspension atomically persists exactly one canonical assistant notice', async (t) => {
  if (skipIfSqliteUnavailable(t, 'provider-transfer-canonical-terminal-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    const taskId = 'task-provider-transfer-canonical'
    const runId = 'run-provider-transfer-canonical'
    const scopeId = 'scope-provider-transfer-canonical'
    const now = '2026-07-23T00:00:00.000Z'
    const binding = executionBinding(runId)
    projections.create({
      taskId, scopeId, runId, taskType: 'research', module: 'browser', status: 'running',
      interactionState: 'running', waitingFor: 'none', steps: [], ownerAgentId: 'butler',
      taskOrigin: 'user_root', executionBinding: binding, createdAt: now, updatedAt: now,
    })
    runMeta.create({ runId, taskId, scopeId, agentId: 'butler', executionBinding: binding, status: 'running' }, Date.parse(now))
    db.prepare(`INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
                VALUES (?, 'butler', 'Provider transfer', ?, ?)`).run(scopeId, now, now)
    db.prepare(`INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
                VALUES ('source-provider-transfer', ?, 'user', 'continue research', ?, '{}')`).run(scopeId, now)
    const route = await repository.bindBrowserWorkflowRoute({
      parentTaskId: taskId,
      ownerRunId: runId,
      sourceMessageId: 'source-provider-transfer',
      executionBinding: binding,
      now,
    })
    const input = [{ role: 'user', content: 'continue research' } as AgentInputItem]
    const checkpoint = await repository.writeCleanBoundary({
      parentTaskId: taskId,
      browserTaskId: route.browserTaskId,
      ownerRunId: runId,
      role: 'suspension',
      suspensionReason: 'provider_transfer',
      publicNotice: '模型服务暂时不可用，浏览器现场和当前进度已保存，可以继续这项任务。',
      sourceItems: input,
      sdkSourceItems: input,
      sdkSourceItemCount: input.length,
      sdkSourcePrefixDigest: workflowDigest(input),
      preparedSkill: preparedSkill(),
      activatedCapabilityGroups: ['browser'],
      now,
    })

    assert.ok(checkpoint.canonicalMessage, 'every Browser suspension must return its canonical notice')
    assert.ok(checkpoint.canonicalMessageDigest)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM chat_messages
                             WHERE conversation_id = ? AND role = 'assistant'`)
      .get<{ count: number }>(scopeId)?.count, 1)
  } finally {
    db.close()
  }
})

const genericSuspensionReasons = [
  'budget',
  'steering',
  'incomplete',
  'background',
  'foreground',
  'capability',
  'config',
  'provider_transfer',
  'owner_crash',
  'manual',
] as const

test('every non-interactive Browser suspension atomically aligns checkpoint, run, projection, and canonical notice', async (t) => {
  if (skipIfSqliteUnavailable(t, 'provider-checkpoint-canonical-suspension-matrix')) return
  for (const reason of genericSuspensionReasons) {
    await t.test(reason, async (t) => {
      if (skipIfSqliteUnavailable(t, `provider-checkpoint-canonical-${reason}`)) return
      const db = openDb()
      try {
        const accessor = { getRawDb: () => db }
        const projections = new TaskProjectionRepository(accessor)
        const repository = new AgentSessionCheckpointRepository(accessor)
        const runMeta = new RunMetaRepository(db)
        const taskId = `task-canonical-${reason}`
        const runId = `run-canonical-${reason}`
        const scopeId = `scope-canonical-${reason}`
        const now = '2026-07-23T01:00:00.000Z'
        const binding = executionBinding(runId)
        projections.create({
          taskId, scopeId, runId, taskType: 'research', module: 'browser', status: 'running',
          interactionState: 'running', waitingFor: 'none', steps: [], ownerAgentId: 'butler',
          taskOrigin: 'user_root', executionBinding: binding, createdAt: now, updatedAt: now,
        })
        runMeta.create({ runId, taskId, scopeId, agentId: 'butler', executionBinding: binding, status: 'running' }, Date.parse(now))
        db.prepare(`INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
                    VALUES (?, 'butler', 'Canonical suspension', ?, ?)`).run(scopeId, now, now)
        const sourceMessageId = `source-canonical-${reason}`
        db.prepare(`INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
                    VALUES (?, ?, 'user', 'continue research', ?, '{}')`).run(sourceMessageId, scopeId, now)
        const route = await repository.bindBrowserWorkflowRoute({
          parentTaskId: taskId,
          ownerRunId: runId,
          sourceMessageId,
          executionBinding: binding,
          now,
        })
        const sourceItems = [{ role: 'user', content: 'continue research' } as AgentInputItem]
        const publicNotice = `saved-${reason}`
        const checkpoint = await repository.writeCleanBoundary({
          parentTaskId: taskId,
          browserTaskId: route.browserTaskId,
          ownerRunId: runId,
          role: 'suspension',
          suspensionReason: reason,
          publicNotice,
          sourceItems,
          sdkSourceItems: sourceItems,
          sdkSourceItemCount: sourceItems.length,
          sdkSourcePrefixDigest: workflowDigest(sourceItems),
          preparedSkill: preparedSkill(),
          activatedCapabilityGroups: ['browser'],
          now,
        })

        assert.equal(checkpoint.canonicalMessage?.content, publicNotice)
        assert.ok(checkpoint.canonicalMessageDigest)
        assert.equal(repository.current(taskId, 'suspension')?.checkpointId, checkpoint.checkpointId)
        const projection = projections.get(taskId)
        assert.equal(projection?.status, 'recoverable_paused')
        assert.equal(projection?.checkpointRefs.suspensionCheckpointId, checkpoint.checkpointId)
        assert.equal(runMeta.get(runId)?.status, 'checkpoint')
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM chat_messages
                                 WHERE conversation_id = ? AND role = 'assistant'`)
          .get<{ count: number }>(scopeId)?.count, 1)
      } finally {
        db.close()
      }
    })
  }
})

test('canonical assistant write failure rolls back every suspension state write', async (t) => {
  if (skipIfSqliteUnavailable(t, 'provider-checkpoint-canonical-rollback')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    const taskId = 'task-canonical-rollback'
    const runId = 'run-canonical-rollback'
    const scopeId = 'scope-canonical-rollback'
    const now = '2026-07-23T02:00:00.000Z'
    const binding = executionBinding(runId)
    projections.create({
      taskId, scopeId, runId, taskType: 'research', module: 'browser', status: 'running',
      interactionState: 'running', waitingFor: 'none', steps: [], ownerAgentId: 'butler',
      taskOrigin: 'user_root', executionBinding: binding, createdAt: now, updatedAt: now,
    })
    runMeta.create({ runId, taskId, scopeId, agentId: 'butler', executionBinding: binding, status: 'running' }, Date.parse(now))
    db.prepare(`INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
                VALUES (?, 'butler', 'Rollback suspension', ?, ?)`).run(scopeId, now, now)
    db.prepare(`INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
                VALUES ('source-canonical-rollback', ?, 'user', 'continue', ?, '{}')`).run(scopeId, now)
    const route = await repository.bindBrowserWorkflowRoute({
      parentTaskId: taskId,
      ownerRunId: runId,
      sourceMessageId: 'source-canonical-rollback',
      executionBinding: binding,
      now,
    })
    const sourceItems = [{ role: 'user', content: 'continue' } as AgentInputItem]
    db.exec(`CREATE TRIGGER reject_canonical_notice BEFORE INSERT ON chat_messages
             WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'injected canonical failure'); END`)

    await assert.rejects(repository.writeCleanBoundary({
      parentTaskId: taskId,
      browserTaskId: route.browserTaskId,
      ownerRunId: runId,
      role: 'suspension',
      suspensionReason: 'provider_transfer',
      publicNotice: 'saved',
      sourceItems,
      sdkSourceItems: sourceItems,
      sdkSourceItemCount: sourceItems.length,
      sdkSourcePrefixDigest: workflowDigest(sourceItems),
      preparedSkill: preparedSkill(),
      activatedCapabilityGroups: ['browser'],
      now,
    }), /injected canonical failure/)
    assert.equal(repository.current(taskId, 'suspension'), null)
    assert.equal(projections.get(taskId)?.status, 'running')
    assert.equal(runMeta.get(runId)?.status, 'running')
    assert.equal(db.prepare(`SELECT status FROM browser_tasks WHERE id = ?`)
      .get<{ status: string }>(route.browserTaskId)?.status, 'running')
  } finally {
    db.close()
  }
})
