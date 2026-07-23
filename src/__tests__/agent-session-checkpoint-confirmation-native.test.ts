import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import type { AgentInputItem } from '@openai/agents'
import type { DatabaseConnection } from '../main/modules/database'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { AgentSessionCheckpointRepository, workflowDigest } from '../main/modules/repositories/agent-session-checkpoint-repository'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { browserWorkflowStableDigest } from '../main/modules/browser-engine/browser-workflow-evidence'
import { reconcileStartupRunsOnStartup } from '../main/modules/app-control/startup-run-reconciler'
import { buildPreparedSkillTurnTruth } from '../main/modules/agent-control/skills/prepared-skill-turn'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { AgentSessionInputController } from '../main/modules/agent-control/runtime-core/agent-session-input-controller'
import {
  buildBrowserVerifierRecoveryItem,
  createBrowserSuspensionController,
  withoutBrowserVerifierRecoveryItems,
} from '../main/modules/agent-control/runtime-core/agent-sdk-browser-suspension'
import type { ToolBridgeRuntimeContext } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import {
  KIMI_K3_SESSION_IDENTITY,
  KIMI_K3_SESSION_IDENTITY_FIELD,
  inspectKimiK3History,
} from '../shared/ai-providers/kimi-k3'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { BrowserTargetClaimRepository, BrowserTargetClaimService } from '../main/modules/browser-engine/browser-target-claims'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import {
  kimiK3ProviderTestData as k3ProviderData,
  openProviderCheckpointTestDb as openDb,
  providerCheckpointExecutionBinding as executionBinding,
  providerCheckpointPreparedSkill as preparedSkill,
} from './provider-checkpoint-test-fixtures'


test('browser confirmation suspension writes one canonical notice and audits rejected and accepted resumes', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-confirmation-canonical-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const parentTaskId = 'parent-browser-confirmation'
    const scopeId = 'scope-browser-confirmation'
    const ownerRunId = 'run-browser-confirmation'
    const now = '2026-07-22T01:00:00.000Z'
    projections.create({
      taskId: parentTaskId,
      scopeId,
      runId: ownerRunId,
      taskType: 'browser_transaction',
      module: 'browser',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      executionBinding: executionBinding(ownerRunId),
      createdAt: now,
      updatedAt: now,
    })
    runMeta.create({
      runId: ownerRunId,
      taskId: parentTaskId,
      scopeId,
      agentId: 'butler',
      executionBinding: executionBinding(ownerRunId),
      status: 'running',
    }, Date.parse(now))
    db.prepare(
      `INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
       VALUES (?, 'butler', 'Browser confirmation', ?, ?)`,
    ).run(scopeId, now, now)
    const sourceMessageId = 'message-browser-confirmation'
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
       VALUES (?, ?, 'user', '执行页面脚本', ?, '{}')`,
    ).run(sourceMessageId, scopeId, now)
    const route = await repository.bindBrowserWorkflowRoute({
      parentTaskId,
      ownerRunId,
      sourceMessageId,
      executionBinding: executionBinding(ownerRunId),
      now,
    })
    const request = {
      version: 1 as const,
      kind: 'browser_power_confirmation' as const,
      requestId: 'power-request-1',
      wakeKind: 'browser_power_confirmation' as const,
      toolName: 'browser_eval' as const,
      effects: ['page_mutation'] as const,
      actionIntent: { objectRef: 'page', inputHash: 'input-hash' },
      target: {
        scopeId,
        ownerRunId,
        browserTaskId: route.browserTaskId,
        tabId: 'tab-1',
        documentKeyHash: 'document-key',
        origin: 'https://example.test',
        targetDigest: 'target-digest',
      },
      purpose: 'read page state',
    }
    const sourceItems = [{ role: 'user', content: '执行页面脚本' } as AgentInputItem]
    const suspension = await repository.writeCleanBoundary({
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      role: 'suspension',
      suspensionReason: 'browser_power_confirmation',
      suspensionRequest: request,
      sourceItems,
      sdkSourceItems: sourceItems,
      sdkSourceItemCount: sourceItems.length,
      sdkSourcePrefixDigest: workflowDigest(sourceItems),
      preparedSkill: preparedSkill(),
      activatedCapabilityGroups: ['browser'],
      now,
    })
    assert.ok(suspension.canonicalMessage)
    assert.match(suspension.canonicalMessage.content, /等待你的确认/)
    assert.equal(suspension.canonicalMessage.conversationId, scopeId)
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM chat_messages
                   WHERE id = ? AND role = 'assistant'`)
        .get<{ count: number }>(suspension.canonicalMessage.id)?.count,
      1,
    )
    const parent = projections.get(parentTaskId)
    assert.equal(parent?.waitingFor, 'confirmation')
    assert.equal(
      (parent?.continuationRef as { suspensionRequest?: { requestId?: string } } | null)?.suspensionRequest?.requestId,
      request.requestId,
    )
    const current = repository.currentBrowserPowerConfirmation(parentTaskId)
    assert.ok(current)
    const wakeBase = {
      wakeId: 'wake-power-request-1',
      kind: 'browser_power_confirmation' as const,
      sourceId: request.requestId,
      checkpointId: current.checkpointId,
      issuedAt: '2026-07-22T01:00:01.000Z',
      decision: 'confirmed' as const,
    }
    const sourceDigest = workflowDigest({
      parentTaskId,
      checkpointId: current.checkpointId,
      basisRevision: current.basisRevision,
      kind: wakeBase.kind,
      sourceId: wakeBase.sourceId,
      decision: wakeBase.decision,
      request,
    })
    await assert.rejects(
      repository.resumeSuspendedBrowserWorkflow({
        taskId: parentTaskId,
        newOwnerRunId: 'run-browser-confirmation-stale',
        executionBinding: executionBinding('run-browser-confirmation-stale'),
        wake: { ...wakeBase, basisRevision: current.basisRevision - 1, sourceDigest },
      }),
      /checkpoint_wake_basis_revision_mismatch/,
    )
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM browser_control_receipts
                   WHERE browser_task_id = ? AND kind = 'resume_rejected'`)
        .get<{ count: number }>(route.browserTaskId)?.count,
      1,
    )
    const resumed = await repository.resumeSuspendedBrowserWorkflow({
      taskId: parentTaskId,
      newOwnerRunId: 'run-browser-confirmation-resumed',
      executionBinding: executionBinding('run-browser-confirmation-resumed'),
      wake: { ...wakeBase, basisRevision: current.basisRevision, sourceDigest },
    })
    assert.equal(resumed.browserTaskId, route.browserTaskId)
    assert.equal(resumed.parent.runId, 'run-browser-confirmation-resumed')
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM browser_control_receipts
                   WHERE browser_task_id = ? AND kind = 'task_resume_authorized'
                     AND wake_id = ? AND successor_run_id = ?`)
        .get<{ count: number }>(route.browserTaskId, wakeBase.wakeId, resumed.newOwnerRunId)?.count,
      1,
    )
  } finally {
    db.close()
  }
})

test('browser permission suspension writes its canonical notice in the checkpoint transaction', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-permission-canonical-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const parentTaskId = 'parent-browser-permission'
    const scopeId = 'scope-browser-permission'
    const ownerRunId = 'run-browser-permission'
    const now = '2026-07-22T02:00:00.000Z'
    projections.create({
      taskId: parentTaskId,
      scopeId,
      runId: ownerRunId,
      taskType: 'browser_transaction',
      module: 'browser',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      executionBinding: executionBinding(ownerRunId),
      createdAt: now,
      updatedAt: now,
    })
    runMeta.create({
      runId: ownerRunId,
      taskId: parentTaskId,
      scopeId,
      agentId: 'butler',
      executionBinding: executionBinding(ownerRunId),
      status: 'running',
    }, Date.parse(now))
    db.prepare(`INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
                VALUES (?, 'butler', 'Browser permission', ?, ?)`).run(scopeId, now, now)
    db.prepare(`INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
                VALUES ('source-browser-permission', ?, 'user', 'allow camera', ?, '{}')`).run(scopeId, now)
    const route = await repository.bindBrowserWorkflowRoute({
      parentTaskId,
      ownerRunId,
      sourceMessageId: 'source-browser-permission',
      executionBinding: executionBinding(ownerRunId),
      now,
    })
    const request = {
      version: 1 as const,
      kind: 'browser_permission' as const,
      requestId: 'permission-request-1',
      wakeKind: 'browser_permission' as const,
      toolName: 'browser_permission' as const,
      actionIntent: {
        siteRequestId: 'site-request-1',
        permission: 'camera',
        origin: 'https://example.test',
        decision: 'allow' as const,
        inputHash: 'permission-input-hash',
      },
      target: {
        scopeId,
        ownerRunId,
        browserTaskId: route.browserTaskId,
        tabId: 'tab-permission',
        targetDigest: 'permission-target-digest',
      },
      purpose: 'site_permission_request' as const,
    }
    const sourceItems = [{ role: 'user', content: 'allow camera' } as AgentInputItem]
    const suspension = await repository.writeCleanBoundary({
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      role: 'suspension',
      suspensionReason: 'browser_permission',
      suspensionRequest: request,
      sourceItems,
      sdkSourceItems: sourceItems,
      sdkSourceItemCount: sourceItems.length,
      sdkSourcePrefixDigest: workflowDigest(sourceItems),
      preparedSkill: preparedSkill(),
      activatedCapabilityGroups: ['browser'],
      now,
    })
    assert.ok(suspension.canonicalMessage)
    assert.ok(suspension.canonicalMessageDigest)
    assert.match(suspension.canonicalMessage.content, /等待你的确认/)
    assert.equal(projections.get(parentTaskId)?.waitingFor, 'confirmation')
    assert.equal(runMeta.get(ownerRunId)?.status, 'checkpoint')
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM chat_messages
                             WHERE conversation_id = ? AND role = 'assistant'`)
      .get<{ count: number }>(scopeId)?.count, 1)
  } finally {
    db.close()
  }
})
