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
    executionMaterialHash: 'butler-material-hash',
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
    requestOrResourceAnchorDigest: 'request-anchor-digest',
    floors: { toolNames: new Set(), reasons: [] },
    surface: { composition: 'additive', exclusiveScopeRef: null },
  })
}

function k3ProviderData(turn: number) {
  return {
    [KIMI_K3_SESSION_IDENTITY_FIELD]: KIMI_K3_SESSION_IDENTITY,
    anthropicThinkingBlocks: [{
      type: 'thinking',
      thinking: `reasoning-${turn}`,
      signature: `sig-k3-${turn}`,
    }],
  }
}

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

test('verifier rejection facts survive incomplete suspension and reach the resumed owner', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-incomplete-suspension-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const parentTaskId = 'parent-browser-incomplete-suspension'
    const scopeId = 'scope-browser-incomplete-suspension'
    const ownerRunId = 'run-browser-incomplete-suspension'
    const ownerBinding = executionBinding(ownerRunId)
    const now = '2026-07-19T01:30:00.000Z'
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
       VALUES (?, 'butler', 'Browser incomplete suspension', ?, ?)`,
    ).run(scopeId, now, now)
    const sourceMessageId = 'message-browser-incomplete-suspension'
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
       VALUES (?, ?, 'user', '完成多个网页研究目标', ?, '{}')`,
    ).run(sourceMessageId, scopeId, now)
    const route = await repository.bindBrowserWorkflowRoute({
      parentTaskId,
      ownerRunId,
      sourceMessageId,
      executionBinding: ownerBinding,
      now,
    })
    const sourceItems = [{ role: 'user', content: '继续完成剩余研究目标' } as AgentInputItem]
    const runtimeContext = {
      runId: ownerRunId,
      taskId: parentTaskId,
      sourceMessageId,
      executionBinding: ownerBinding,
      browserWorkflowRoute: {
        browserTaskId: route.browserTaskId,
        requestAnchorSnapshotDigest: route.requestAnchorSnapshotDigest,
      },
      browserRequiredOperationIds: [],
      lastEffectiveBrowserActionSeq: 0,
      browserObservationGaps: [],
      browserObservationBarrier: null,
      browserSuspensionRequest: null,
      activatedCapabilityGroups: ['browser'],
      preparedSkillTurn: preparedSkill(),
    } as unknown as ToolBridgeRuntimeContext
    const modelInputController = new AgentSessionInputController(
      repository,
      runtimeContext,
      null,
    )
    await modelInputController.filter(sourceItems, {
      sourceItems,
      compacted: false,
    })
    const verifierRecovery = buildBrowserVerifierRecoveryItem({
      rejectedCandidateDigest: workflowDigest('rejected-browser-candidate'),
      verdict: 'repair',
      summary: 'Two requested targets still lack source-backed details.',
      gaps: [{
        kind: 'text',
        description: 'Collect and cite the missing details for query-b and query-c.',
      }],
    })
    const suspension = createBrowserSuspensionController({
      modelInputController,
      runtimeContext,
      projectionPatches: [],
      getTaskBudgetRuntime: () => createTaskBudgetRuntime('research'),
      setContinuationRef: () => undefined,
      setFinalText: () => undefined,
      emitOutput: () => undefined,
      finalizeCheckpoint: async ({ terminalReason }) => ({
        status: 'checkpoint',
        terminalReason,
      }) as never,
    })
    await suspension.finishIncompleteCheckpoint('', [verifierRecovery])
    const checkpoint = repository.current(parentTaskId, 'suspension')
    assert.ok(checkpoint)
    const recoveryItem = checkpoint.finalInput.find((item) => Boolean(
      (item as { providerData?: Record<string, unknown> }).providerData
        ?.readyBrowserVerifierRecovery,
    )) as { providerData?: { readyBrowserVerifierRecovery?: Record<string, unknown> } } | undefined
    assert.deepEqual(recoveryItem?.providerData?.readyBrowserVerifierRecovery?.gaps, [{
      kind: 'text',
      description: 'Collect and cite the missing details for query-b and query-c.',
    }])
    assert.equal(
      recoveryItem?.providerData?.readyBrowserVerifierRecovery?.candidatePublished,
      false,
    )
    assert.doesNotMatch(JSON.stringify(checkpoint.finalInput), /rejected-browser-candidate/)

    const parent = db.prepare(
      `SELECT status, interaction_state, waiting_for, blocked_reason, continuation_ref_json
         FROM task_projections WHERE task_id = ?`,
    ).get<{
      status: string
      interaction_state: string
      waiting_for: string
      blocked_reason: string
      continuation_ref_json: string | null
    }>(parentTaskId)
    assert.deepEqual(parent && {
      status: parent.status,
      interactionState: parent.interaction_state,
      waitingFor: parent.waiting_for,
      blockedReason: parent.blocked_reason,
    }, {
      status: 'recoverable_paused',
      interactionState: 'suspended',
      waitingFor: 'none',
      blockedReason: 'browser_incomplete_checkpoint',
    })
    const run = db.prepare(
      'SELECT status, terminal_reason, continuation_ref_json FROM run_meta WHERE run_id = ?',
    ).get<{ status: string; terminal_reason: string; continuation_ref_json: string }>(ownerRunId)
    assert.equal(run?.status, 'checkpoint')
    assert.equal(run?.terminal_reason, 'checkpoint_incomplete')
    assert.deepEqual(JSON.parse(run?.continuation_ref_json || '{}'), {
      kind: 'browser_checkpoint',
      checkpointId: checkpoint.checkpointId,
      browserTaskId: route.browserTaskId,
      suspensionReason: 'incomplete',
    })
    assert.equal(parent?.continuation_ref_json, null)
    assert.equal(
      db.prepare('SELECT status FROM browser_tasks WHERE id = ?')
        .get<{ status: string }>(route.browserTaskId)?.status,
      'paused',
    )

    const basisRevision = db.prepare(
      'SELECT revision FROM task_projections WHERE task_id = ?',
    ).get<{ revision: number }>(parentTaskId)?.revision
    assert.ok(Number.isInteger(basisRevision))
    const wakeKind = 'user_continue' as const
    const sourceId = 'continue-browser-after-verifier-rejection'
    const newOwnerRunId = 'run-browser-incomplete-resumed'
    const newOwnerBinding = executionBinding(newOwnerRunId)
    const resumed = await repository.resumeSuspendedBrowserWorkflow({
      taskId: parentTaskId,
      newOwnerRunId,
      executionBinding: newOwnerBinding,
      wake: {
        wakeId: 'wake-browser-after-verifier-rejection',
        checkpointId: checkpoint.checkpointId,
        basisRevision: basisRevision as number,
        kind: wakeKind,
        sourceId,
        sourceDigest: workflowDigest({
          parentTaskId,
          checkpointId: checkpoint.checkpointId,
          basisRevision,
          kind: wakeKind,
          sourceId,
        }),
        issuedAt: '2026-07-19T01:31:00.000Z',
      },
      now: '2026-07-19T01:31:01.000Z',
    })
    assert.equal(resumed.checkpoint.ownerRunId, newOwnerRunId)
    assert.deepEqual(
      resumed.checkpoint.finalInput.find((item) => Boolean(
        (item as { providerData?: Record<string, unknown> }).providerData
          ?.readyBrowserVerifierRecovery,
      )),
      recoveryItem,
    )
    const resumedRuntimeContext = {
      ...runtimeContext,
      runId: newOwnerRunId,
      executionBinding: newOwnerBinding,
    } as ToolBridgeRuntimeContext
    const resumedInputController = new AgentSessionInputController(
      repository,
      resumedRuntimeContext,
      null,
    )
    const resumedProviderInput = await resumedInputController.filter(
      [{ role: 'system', content: 'Compacted browser resume context.' } as AgentInputItem],
      {
        sourceItems: resumed.checkpoint.finalInput,
        compacted: true,
      },
    )
    const resumedRecoveryFacts = resumedProviderInput.filter((item) => Boolean(
      (item as { providerData?: Record<string, unknown> }).providerData
        ?.readyBrowserVerifierRecovery,
    ))
    assert.equal(resumedRecoveryFacts.length, 1)
    assert.deepEqual(resumedRecoveryFacts[0], recoveryItem)
    assert.equal(
      withoutBrowserVerifierRecoveryItems(resumedProviderInput).some((item) => Boolean(
        (item as { providerData?: Record<string, unknown> }).providerData
          ?.readyBrowserVerifierRecovery,
      )),
      false,
    )
  } finally {
    db.close()
  }
})

test('startup recovery converts a stale Browser owner with a clean checkpoint into a resumable pause', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-owner-startup-recovery-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const parentTaskId = 'parent-browser-startup-recovery'
    const scopeId = 'scope-browser-startup-recovery'
    const ownerRunId = 'run-browser-startup-recovery'
    const ownerBinding = executionBinding(ownerRunId)
    const now = '2026-07-19T01:45:00.000Z'
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
       VALUES (?, 'butler', 'Browser startup recovery', ?, ?)`,
    ).run(scopeId, now, now)
    const sourceMessageId = 'message-browser-startup-recovery'
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
       VALUES (?, ?, 'user', '完成多个网页研究目标', ?, '{}')`,
    ).run(sourceMessageId, scopeId, now)
    const route = await repository.bindBrowserWorkflowRoute({
      parentTaskId,
      ownerRunId,
      sourceMessageId,
      executionBinding: ownerBinding,
      now,
    })
    const sourceItems = [{ role: 'user', content: '完成多个网页研究目标' } as AgentInputItem]
    const clean = await repository.writeCleanBoundary({
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      sourceItems,
      sdkSourceItems: sourceItems,
      sdkSourceItemCount: sourceItems.length,
      sdkSourcePrefixDigest: workflowDigest(sourceItems),
      preparedSkill: preparedSkill(),
      activatedCapabilityGroups: ['browser'],
      now,
    })

    const result = await reconcileStartupRunsOnStartup({
      db,
      now: new Date('2026-07-19T01:46:00.000Z'),
      agentSessionCheckpointRepository: repository,
      logMetric: () => undefined,
    })
    assert.deepEqual(result.reconcileCount, {
      runMeta: 1,
      taskProjections: 1,
      browserTasks: 1,
      skillRuns: 0,
    })
    const parent = db.prepare(
      `SELECT status, interaction_state, waiting_for, blocked_reason, checkpoint_refs_json
         FROM task_projections WHERE task_id = ?`,
    ).get<{
      status: string
      interaction_state: string
      waiting_for: string
      blocked_reason: string
      checkpoint_refs_json: string
    }>(parentTaskId)
    assert.equal(parent?.status, 'recoverable_paused')
    assert.equal(parent?.interaction_state, 'suspended')
    assert.equal(parent?.waiting_for, 'none')
    assert.equal(parent?.blocked_reason, 'browser_owner_crash_checkpoint')
    const checkpointRefs = JSON.parse(parent?.checkpoint_refs_json || '{}')
    assert.equal(checkpointRefs.cleanBaseCheckpointId, null)
    assert.ok(checkpointRefs.suspensionCheckpointId)
    assert.notEqual(checkpointRefs.suspensionCheckpointId, clean.checkpointId)
    const run = db.prepare(
      'SELECT status, terminal_reason, continuation_ref_json FROM run_meta WHERE run_id = ?',
    ).get<{ status: string; terminal_reason: string; continuation_ref_json: string }>(ownerRunId)
    assert.equal(run?.status, 'interrupted')
    assert.equal(run?.terminal_reason, 'main_process_restarted')
    assert.equal(JSON.parse(run?.continuation_ref_json || '{}').suspensionReason, 'owner_crash')
    assert.equal(
      db.prepare('SELECT status FROM browser_tasks WHERE id = ?')
        .get<{ status: string }>(route.browserTaskId)?.status,
      'paused',
    )
    assert.ok(repository.currentOwnerCrashRecovery(parentTaskId))
  } finally {
    db.close()
  }
})

test('human takeover keeps its exact user instruction in the durable suspension projection', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-human-takeover-prompt-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const parentTaskId = 'parent-browser-human-takeover'
    const scopeId = 'scope-browser-human-takeover'
    const ownerRunId = 'run-browser-human-takeover'
    const ownerBinding = executionBinding(ownerRunId)
    const now = '2026-07-20T00:00:00.000Z'
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
       VALUES (?, 'butler', 'Browser human takeover', ?, ?)`,
    ).run(scopeId, now, now)
    const sourceMessageId = 'message-browser-human-takeover'
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
       VALUES (?, ?, 'user', '完成网页任务', ?, '{}')`,
    ).run(sourceMessageId, scopeId, now)
    const route = await repository.bindBrowserWorkflowRoute({
      parentTaskId,
      ownerRunId,
      sourceMessageId,
      executionBinding: ownerBinding,
      now,
    })
    const userPrompt = {
      callToAction: '请完成页面验证',
      details: '验证完成后继续当前任务',
      timeoutSec: 90,
    }
    const takeover = await repository.createHumanTakeoverIntent({
      parentTaskId,
      ownerRunId,
      browserTaskId: route.browserTaskId,
      physicalTarget: {
        surface: 'user-view',
        scopeId,
        profileId: 'default',
        sessionId: null,
        tabId: 'tab-1',
        physicalTargetToken: 'physical-tab-1',
        source: 'supervision_button',
      },
      userPrompt,
      now,
    })
    const sourceItems = [{ role: 'user', content: '完成网页任务' } as AgentInputItem]
    await repository.writeCleanBoundary({
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      role: 'suspension',
      takeoverId: takeover.takeoverId,
      suspensionReason: 'human_takeover',
      sourceItems,
      sdkSourceItems: sourceItems,
      sdkSourceItemCount: sourceItems.length,
      sdkSourcePrefixDigest: workflowDigest(sourceItems),
      preparedSkill: preparedSkill(),
      activatedCapabilityGroups: ['browser'],
      now,
    })

    const row = db.prepare(
      `SELECT interaction_state, waiting_for, blocked_reason, human_takeover_ref_json
         FROM task_projections WHERE task_id = ?`,
    ).get<{
      interaction_state: string
      waiting_for: string
      blocked_reason: string
      human_takeover_ref_json: string
    }>(parentTaskId)
    assert.equal(row?.interaction_state, 'human_takeover')
    assert.equal(row?.waiting_for, 'confirmation')
    assert.equal(row?.blocked_reason, '请完成页面验证 · 验证完成后继续当前任务')
    assert.deepEqual(JSON.parse(row?.human_takeover_ref_json || '{}').userPrompt, userPrompt)
  } finally {
    db.close()
  }
})

test('non-done core closeout terminates all browser ledgers without requiring a success seal', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-non-done-closeout-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const parentTaskId = 'parent-browser-non-done-closeout'
    const scopeId = 'scope-browser-non-done-closeout'
    const ownerRunId = 'run-browser-non-done-closeout'
    const ownerBinding = executionBinding(ownerRunId)
    const now = '2026-07-19T02:00:00.000Z'
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
      taskType: 'short_task',
      budget: {
        maxIterations: 24,
        maxToolCalls: 24,
        maxParallelToolGroups: 5,
      },
      continuationRef: {
        taskId: parentTaskId,
        resumeKind: 'snapshot',
        runStatePath: '/tmp/stale-browser-closeout-snapshot.json',
      },
    }, Date.parse(now))
    db.prepare(
      `INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
       VALUES (?, 'butler', 'Browser non-done closeout', ?, ?)`,
    ).run(scopeId, now, now)
    const sourceMessageId = 'message-browser-non-done-closeout'
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
       VALUES (?, ?, 'user', '在页面上执行动作', ?, '{}')`,
    ).run(sourceMessageId, scopeId, now)
    const route = await repository.bindBrowserWorkflowRoute({
      parentTaskId,
      ownerRunId,
      sourceMessageId,
      executionBinding: ownerBinding,
      now,
    })
    db.prepare(
      'UPDATE task_projections SET continuation_ref_json = ? WHERE task_id = ?',
    ).run(JSON.stringify({
      taskId: parentTaskId,
      resumeKind: 'snapshot',
      runStatePath: '/tmp/stale-browser-closeout-snapshot.json',
    }), parentTaskId)
    const actionIdentity = {
      documentState: 'document' as const,
      tabId: 'tab-browser-non-done-closeout',
      physicalTargetToken: 'physical-browser-non-done-closeout',
      frameId: '0',
      frameDocumentToken: 'document-browser-non-done-closeout',
      targetRef: 'target-browser-non-done-closeout',
    }
    const active = repository.beginBrowserWorkflowAction({
      taskId: route.browserTaskId,
      operationId: 'click_target',
      ownerRunId,
      argsDigest: 'click-non-done-closeout',
      identity: actionIdentity,
    })
    repository.settleBrowserWorkflowAction(route.browserTaskId, active.actionId, {
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
      identity: actionIdentity,
      successorIdentity: { ...actionIdentity, targetRef: null },
    })
    assert.equal(repository.inspectWorkflowCloseout(parentTaskId).state, 'observation_required')

    const closeout = await repository.commitCanonicalCoreCloseout({
      parentTaskId,
      ownerRunId,
      browserTaskId: route.browserTaskId,
      status: 'error',
      terminalReason: 'blocked_tool_error',
      initiator: 'error',
      durationMs: 1,
      finalText: '页面状态未完成观察，本轮已停止。',
      conversationId: scopeId,
      taskType: 'research',
      module: 'browser',
      budget: {
        taskType: 'research',
        maxIterations: 220,
        maxToolCalls: 220,
        maxParallelToolGroups: 5,
        reservedToolCalls: 0,
        iterationsUsed: 12,
        toolCallsUsed: 9,
        parallelToolGroupsUsed: 0,
        stepBudget: null,
        frozen: false,
        bootstrapBudget: false,
      },
      budgetUsagePercent: 5,
      budgetWarningLevel: 'none',
      terminalQualityPatch: {
        proofRefs: [{ kind: 'tool_result', ref: 'partial-browser-evidence' }],
        checkins: [{ verdict: 'blocked', blockers: ['research_incomplete'] }],
        criteria: { template: 'research/browser', items: [] },
      },
      now,
    })
    assert.equal(closeout.value.browserTaskId, route.browserTaskId)
    const terminalBudget = {
      taskType: 'research',
      maxIterations: 220,
      maxToolCalls: 220,
      maxParallelToolGroups: 5,
      reservedToolCalls: 0,
      iterationsUsed: 12,
      toolCallsUsed: 9,
      parallelToolGroupsUsed: 0,
      stepBudget: null,
      frozen: false,
      bootstrapBudget: false,
    }
    assert.deepEqual(
      db.prepare(
        'SELECT status, task_type, budget_json, continuation_ref_json FROM run_meta WHERE run_id = ?',
      ).get(ownerRunId),
      {
        status: 'error',
        task_type: 'research',
        budget_json: JSON.stringify(terminalBudget),
        continuation_ref_json: null,
      },
    )
    assert.deepEqual(
      db.prepare(
        `SELECT status, task_type, module, budget_json, budget_usage_percent,
                budget_warning_level, continuation_ref_json
           FROM task_projections WHERE task_id = ?`,
      ).get(parentTaskId),
      {
        status: 'failed',
        task_type: 'research',
        module: 'browser',
        budget_json: JSON.stringify(terminalBudget),
        budget_usage_percent: 5,
        budget_warning_level: 'none',
        continuation_ref_json: null,
      },
    )
    assert.deepEqual(
      db.prepare('SELECT status FROM browser_tasks WHERE id = ?').get(route.browserTaskId),
      { status: 'failed' },
    )
    const quality = db.prepare(
      'SELECT proof_refs_json, checkins_json, criteria_json FROM task_projections WHERE task_id = ?',
    ).get<{ proof_refs_json: string; checkins_json: string; criteria_json: string }>(parentTaskId)
    assert.deepEqual(JSON.parse(quality?.proof_refs_json || '[]'), [
      { kind: 'tool_result', ref: 'partial-browser-evidence' },
    ])
    assert.deepEqual(JSON.parse(quality?.checkins_json || '[]'), [
      { verdict: 'blocked', blockers: ['research_incomplete'] },
    ])
    assert.deepEqual(JSON.parse(quality?.criteria_json || '{}'), {
      template: 'research/browser',
      items: [],
    })
  } finally {
    db.close()
  }
})
