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


test('checkpoint rotation keeps 100 turns O(1) rows and losslessly round-trips Kimi multimodal history', async (t) => {
  if (skipIfSqliteUnavailable(t, 'agent-session-checkpoint-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const taskId = 'parent-checkpoint-100-turns'
    const runId = 'run-checkpoint-100-turns'
    const now = '2026-07-19T00:00:00.000Z'
    projections.create({
      taskId,
      scopeId: 'scope-checkpoint-100-turns',
      runId,
      taskType: 'research',
      module: 'browser',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      executionBinding: executionBinding(runId),
      createdAt: now,
      updatedAt: now,
    })
    const sourceItems: AgentInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'inspect this image and continue the browser workflow' },
          { type: 'input_image', image: 'data:image/png;base64,a2ltaS1waXhlbHM=', detail: 'auto' },
        ],
      } as AgentInputItem,
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'I will inspect it.' }],
        providerData: k3ProviderData(0),
      } as AgentInputItem,
      {
        type: 'function_call',
        callId: 'browser-call-1',
        name: 'browser_snapshot',
        arguments: '{}',
        providerData: k3ProviderData(0),
      } as AgentInputItem,
      { type: 'function_call_result', callId: 'browser-call-1', name: 'browser_snapshot', status: 'completed', output: 'snapshot ready' } as AgentInputItem,
    ]

    let lastJsonBytes = 0
    for (let turn = 1; turn <= 100; turn += 1) {
      sourceItems.push(
        { type: 'message', role: 'user', content: `turn-${turn}` } as AgentInputItem,
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: `answer-${turn}` }],
          providerData: k3ProviderData(turn),
        } as AgentInputItem,
      )
      const checkpoint = await repository.writeCleanBoundary({
        parentTaskId: taskId,
        ownerRunId: runId,
        sourceItems,
        sdkSourceItems: sourceItems,
        sdkSourceItemCount: sourceItems.length,
        sdkSourcePrefixDigest: workflowDigest(sourceItems),
        preparedSkill: preparedSkill(),
        activatedCapabilityGroups: ['browser'],
        now: new Date(Date.parse(now) + turn).toISOString(),
      })
      assert.deepEqual(checkpoint.finalInput, sourceItems)
      lastJsonBytes = Buffer.byteLength(JSON.stringify(sourceItems))
    }

    const current = repository.current(taskId, 'clean_base')
    assert.ok(current)
    assert.deepEqual(current.finalInput, sourceItems)
    assert.deepEqual(inspectKimiK3History(current.finalInput), {
      compatible: true,
      reason: 'kimi_k3_history',
    })
    const image = (current.finalInput[0] as { content?: Array<Record<string, unknown>> }).content?.[1]
    assert.deepEqual(image, {
      type: 'input_image',
      image: 'data:image/png;base64,a2ltaS1waXhlbHM=',
      detail: 'auto',
    })
    assert.deepEqual(
      (current.finalInput[1] as { providerData?: unknown }).providerData,
      k3ProviderData(0),
    )
    assert.deepEqual(current.finalInput.slice(2, 4), sourceItems.slice(2, 4))

    const storage = db.prepare(
      `SELECT COUNT(*) AS rowCount,
              COALESCE(SUM(length(final_input_json)), 0) AS totalJsonBytes,
              COALESCE(MAX(length(final_input_json)), 0) AS largestJsonBytes
         FROM agent_session_checkpoints WHERE parent_task_id = ?`,
    ).get<{ rowCount: number; totalJsonBytes: number; largestJsonBytes: number }>(taskId)
    assert.equal(storage?.rowCount, 1)
    assert.equal(storage?.totalJsonBytes, storage?.largestJsonBytes)
    assert.ok(Number(storage?.totalJsonBytes || 0) <= lastJsonBytes * 2)
  } finally {
    db.close()
  }
})

test('browser journal writes are owner-bound atomic transactions and corrupt observations write nothing', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-journal-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const parentTaskId = 'parent-browser-journal-native'
    const scopeId = 'scope-browser-journal-native'
    const ownerRunId = 'run-browser-journal-old'
    const ownerBinding = executionBinding(ownerRunId)
    const now = '2026-07-19T01:00:00.000Z'
    projections.create({
      taskId: parentTaskId,
      scopeId,
      runId: ownerRunId,
      taskType: 'research',
      module: 'browser',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      executionBinding: ownerBinding,
      createdAt: now,
      updatedAt: now,
    })
    runMeta.create({
      runId: ownerRunId,
      taskId: parentTaskId,
      scopeId,
      agentId: 'butler',
      executionBinding: ownerBinding,
      status: 'running',
    }, Date.parse(now))
    db.prepare(
      `INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
       VALUES (?, 'butler', 'Browser journal native', ?, ?)`,
    ).run(scopeId, now, now)
    const sourceMessageId = 'message-browser-journal-native'
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
       VALUES (?, ?, 'user', '读取当前页面并点击目标', ?, '{}')`,
    ).run(sourceMessageId, scopeId, now)
    const route = await repository.bindBrowserWorkflowRoute({
      parentTaskId,
      ownerRunId,
      sourceMessageId,
      executionBinding: ownerBinding,
      now,
    })
    const identity = {
      documentState: 'document' as const,
      tabId: 'tab-journal-native',
      physicalTargetToken: 'physical-journal-native',
      frameId: '0',
      frameDocumentToken: 'document-journal-native',
      targetRef: 'target-journal-native',
    }
    const beforeCorrupt = db.prepare(
      'SELECT payload_json, revision FROM browser_tasks WHERE id = ?',
    ).get<{ payload_json: string; revision: number }>(route.browserTaskId)
    assert.ok(beforeCorrupt)

    assert.throws(() => repository.recordBrowserWorkflowObservation({
      taskId: route.browserTaskId,
      operationId: 'snapshot',
      ownerRunId,
      identity,
      resultDigest: 'forged-result-digest',
      resourceContent: JSON.stringify({ operationId: 'snapshot', result: { text: 'page' } }),
      resourceTruncated: false,
    }), /browser_observation_result_digest_mismatch/)
    assert.throws(() => repository.recordBrowserWorkflowObservation({
      taskId: route.browserTaskId,
      operationId: 'snapshot',
      ownerRunId,
      identity,
      resultDigest: browserWorkflowStableDigest({ operationId: 'read', result: { text: 'page' } }),
      resourceContent: JSON.stringify({ operationId: 'read', result: { text: 'page' } }),
      resourceTruncated: false,
    }), /browser_observation_resource_operation_mismatch/)
    const afterCorrupt = db.prepare(
      'SELECT payload_json, revision FROM browser_tasks WHERE id = ?',
    ).get<{ payload_json: string; revision: number }>(route.browserTaskId)
    assert.deepEqual(afterCorrupt, beforeCorrupt)

    const active = repository.beginBrowserWorkflowAction({
      taskId: route.browserTaskId,
      operationId: 'click_target',
      ownerRunId,
      argsDigest: 'click-args-digest',
      identity,
    })
    const successorIdentity = { ...identity, targetRef: null }
    const newOwnerRunId = 'run-browser-journal-new'
    const newOwnerBinding = executionBinding(newOwnerRunId)
    runMeta.create({
      runId: newOwnerRunId,
      taskId: parentTaskId,
      scopeId,
      agentId: 'butler',
      executionBinding: newOwnerBinding,
      status: 'running',
    }, Date.parse(now) + 1)
    runMeta.update(ownerRunId, { status: 'interrupted' }, Date.parse(now) + 2)
    db.prepare(
      `UPDATE task_projections
          SET run_id = ?, execution_binding_json = ?, revision = revision + 1
        WHERE task_id = ?`,
    ).run(newOwnerRunId, JSON.stringify(newOwnerBinding), parentTaskId)
    db.prepare(
      `UPDATE browser_tasks
          SET status = 'paused', active_execution_binding_json = ?, revision = revision + 1
        WHERE id = ?`,
    ).run(JSON.stringify(newOwnerBinding), route.browserTaskId)

    const settled = repository.settleBrowserWorkflowAction(
      route.browserTaskId,
      active.actionId,
      {
        actionId: active.actionId,
        actionSeq: active.actionSeq,
        taskId: route.browserTaskId,
        ownerRunId,
        operationId: 'click_target',
        mode: 'mutate',
        dispatch: 'accepted',
        delivery: 'delivered',
        effect: 'unknown',
        needsObservation: true,
        mayHaveCommitted: true,
        identity,
        successorIdentity,
      },
    )
    assert.equal(settled.actionSeq, 1)
    assert.equal(repository.inspectWorkflowCloseout(parentTaskId).state, 'observation_required')
    const recoveryItems = [
      { role: 'user', content: '继续当前浏览器任务' } as AgentInputItem,
    ]
    await repository.writeCleanBoundary({
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId: newOwnerRunId,
      sourceItems: recoveryItems,
      sdkSourceItems: recoveryItems,
      sdkSourceItemCount: recoveryItems.length,
      sdkSourcePrefixDigest: workflowDigest(recoveryItems),
      lastEffectiveBrowserActionSeq: 1,
      requiredOperationIds: ['click_target'],
      preparedSkill: preparedSkill(),
      activatedCapabilityGroups: ['browser'],
      now,
    })
    assert.deepEqual(
      repository.readBrowserObservationGaps(parentTaskId).map((gap) => gap.actionSeq),
      [1],
      'an unresolved action remains visible even when the checkpoint cursor already includes it',
    )
    const afterLateSettle = db.prepare(
      'SELECT status, active_execution_binding_json FROM browser_tasks WHERE id = ?',
    ).get<{ status: string; active_execution_binding_json: string }>(route.browserTaskId)
    assert.equal(afterLateSettle?.status, 'paused')
    assert.deepEqual(JSON.parse(afterLateSettle?.active_execution_binding_json || '{}'), newOwnerBinding)

    db.prepare(
      `UPDATE browser_tasks SET status = 'running', revision = revision + 1 WHERE id = ?`,
    ).run(route.browserTaskId)
    const observationValue = { operationId: 'snapshot', result: { text: 'fresh page after click' } }
    const observation = repository.recordBrowserWorkflowObservation({
      taskId: route.browserTaskId,
      operationId: 'snapshot',
      ownerRunId: newOwnerRunId,
      identity: successorIdentity,
      resultDigest: browserWorkflowStableDigest(observationValue),
      resourceContent: JSON.stringify(observationValue),
      resourceTruncated: false,
    })
    assert.equal(observation.observedAfterActionSeq, 1)
    assert.deepEqual(observation.causalActions.map((item) => item.actionId), [active.actionId])
    const payload = JSON.parse(db.prepare(
      'SELECT payload_json FROM browser_tasks WHERE id = ?',
    ).get<{ payload_json: string }>(route.browserTaskId)?.payload_json || '{}') as Record<string, unknown>
    const journal = payload.browserWorkflowActionJournal as {
      activeAction: unknown
      settledOutcomes: unknown[]
      observationReceipts: unknown[]
    }
    assert.equal(journal.activeAction, null)
    assert.equal(journal.settledOutcomes.length, 1)
    assert.equal(journal.observationReceipts.length, 1)
    assert.equal((payload.browserWorkflowObservationResources as unknown[]).length, 1)

    assert.throws(
      () => repository.upsertBrowserResearchWorkItems(
        route.browserTaskId,
        ownerRunId,
        [{ workItemId: 'research-work-native', requirement: 'verify a second fact' }],
      ),
      /browser_workflow_journal_authority_denied/,
    )
    const incompleteResearch = repository.upsertBrowserResearchWorkItems(
      route.browserTaskId,
      newOwnerRunId,
      [{ workItemId: 'research-work-native', requirement: 'verify a second fact' }],
    )
    assert.equal(incompleteResearch.satisfied, false)
    assert.deepEqual(incompleteResearch.missingWorkItemIds, ['research-work-native'])
    assert.equal(repository.inspectWorkflowCloseout(parentTaskId).state, 'research_incomplete')
    const completeResearch = repository.bindBrowserResearchEvidence(
      route.browserTaskId,
      newOwnerRunId,
      [{
        workItemId: 'research-work-native',
        observationReceiptId: observation.receiptId,
        actionReceiptId: settled.receiptId,
      }],
    )
    assert.equal(completeResearch.satisfied, true)
    assert.equal(completeResearch.evidenceRefs.length, 1)
    const progress = db.prepare(
      'SELECT progress_total, progress_completed FROM browser_tasks WHERE id = ?',
    ).get<{ progress_total: number; progress_completed: number }>(route.browserTaskId)
    assert.deepEqual(progress, { progress_total: 1, progress_completed: 1 })
    assert.equal(repository.inspectWorkflowCloseout(parentTaskId).state, 'sealable')
  } finally {
    db.close()
  }
})

