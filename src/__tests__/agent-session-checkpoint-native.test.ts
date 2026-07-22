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
    assert.deepEqual(JSON.parse(parent?.continuation_ref_json || '{}'), {
      kind: 'browser_checkpoint',
      checkpointId: checkpoint.checkpointId,
      browserTaskId: route.browserTaskId,
      suspensionReason: 'incomplete',
    })
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
    const claimService = new BrowserTargetClaimService(new BrowserTargetClaimRepository(accessor))
    const heldClaim = claimService.acquire({
      partition: 'persist:browser',
      tabId: 'startup-tab',
      physicalTargetToken: 'boot-startup:startup-tab:1',
      bootIncarnationId: 'boot-startup',
      profileId: null,
      surface: 'agent-view',
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      scopeId,
      sessionId: null,
    })
    if (isAgentBrowserError(heldClaim)) throw new Error(heldClaim.message)

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
    const recoveredClaim = claimService.read(heldClaim.logicalKey)
    assert.equal(recoveredClaim?.state, 'suspended')
    assert.equal(recoveredClaim?.physicalTargetToken, null)
    assert.equal(recoveredClaim?.suspensionCheckpointId, checkpointRefs.suspensionCheckpointId)
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM browser_control_receipts
                   WHERE browser_task_id = ? AND kind = 'claim_suspended'`)
        .get<{ count: number }>(route.browserTaskId)?.count,
      1,
    )
  } finally {
    db.close()
  }
})

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
    const sourceItems = [{ role: 'user', content: '完成网页任务' } as AgentInputItem]
    await repository.writeCleanBoundary({
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
    const claimService = new BrowserTargetClaimService(new BrowserTargetClaimRepository(accessor))
    const claim = claimService.acquire({
      partition: 'persist:browser-profile-default',
      tabId: 'tab-1',
      physicalTargetToken: 'physical-tab-1',
      bootIncarnationId: 'boot-human-takeover',
      profileId: 'default',
      surface: 'user-view',
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      scopeId,
      sessionId: null,
    })
    if (isAgentBrowserError(claim)) throw new Error(claim.message)
    const siblingClaim = claimService.acquire({
      partition: 'persist:browser-profile-default',
      tabId: 'tab-2',
      physicalTargetToken: 'physical-tab-2',
      bootIncarnationId: 'boot-human-takeover',
      profileId: 'default',
      surface: 'agent-view',
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      scopeId,
      sessionId: null,
    })
    if (isAgentBrowserError(siblingClaim)) throw new Error(siblingClaim.message)
    const additionalUserClaim = claimService.acquire({
      partition: 'persist:browser-profile-default',
      tabId: 'tab-3',
      physicalTargetToken: 'physical-tab-3',
      bootIncarnationId: 'boot-human-takeover',
      profileId: 'default',
      surface: 'agent-view',
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      scopeId,
      sessionId: null,
    })
    if (isAgentBrowserError(additionalUserClaim)) throw new Error(additionalUserClaim.message)
    const takeover = await repository.createHumanTakeoverIntent({
      parentTaskId,
      ownerRunId,
      browserTaskId: route.browserTaskId,
      targetClaimId: claim.claimId,
      targetClaimGeneration: claim.generation,
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
    const sharedTakeover = await repository.createHumanTakeoverIntent({
      parentTaskId,
      ownerRunId,
      browserTaskId: route.browserTaskId,
      targetClaimId: additionalUserClaim.claimId,
      targetClaimGeneration: additionalUserClaim.generation,
      physicalTarget: {
        surface: 'agent-view',
        scopeId,
        profileId: 'default',
        sessionId: null,
        tabId: 'tab-3',
        physicalTargetToken: 'physical-tab-3',
        source: 'supervision_button',
      },
      userPrompt,
      now,
    })
    assert.equal(sharedTakeover.takeoverId, takeover.takeoverId)
    const additionalUserOwned = claimService.read(additionalUserClaim.logicalKey)
    assert.equal(additionalUserOwned?.state, 'user_owned')
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
    assert.equal(claimService.read(claim.logicalKey)?.state, 'user_owned')
    assert.equal(claimService.read(siblingClaim.logicalKey)?.state, 'suspended')
    assert.equal(claimService.read(additionalUserClaim.logicalKey)?.state, 'user_owned')
    assert.equal(claimService.read(siblingClaim.logicalKey)?.suspensionCheckpointId, row
      ? JSON.parse(db.prepare('SELECT checkpoint_refs_json FROM task_projections WHERE task_id = ?').get<{ checkpoint_refs_json: string }>(parentTaskId)?.checkpoint_refs_json || '{}').suspensionCheckpointId
      : null)

    const newOwnerRunId = 'run-browser-human-takeover-resumed'
    const firstBeforeResume = claimService.read(claim.logicalKey)
    const additionalBeforeResume = claimService.read(additionalUserClaim.logicalKey)
    assert.ok(firstBeforeResume?.suspensionCheckpointId)
    assert.ok(additionalBeforeResume?.suspensionCheckpointId)
    const concurrentWake = await Promise.allSettled([
      repository.completeHumanTakeover({
      taskId: parentTaskId,
      takeoverId: takeover.takeoverId,
      newOwnerRunId,
      executionBinding: executionBinding(newOwnerRunId),
      wakeId: 'wake-tab-1',
      targetClaim: {
        partition: firstBeforeResume.logicalKey.partition,
        tabId: firstBeforeResume.logicalKey.tabId,
        physicalTargetToken: firstBeforeResume.physicalTargetToken || '',
        claimId: firstBeforeResume.claimId,
        generation: firstBeforeResume.generation,
        suspensionCheckpointId: firstBeforeResume.suspensionCheckpointId,
        browserTaskId: route.browserTaskId,
      },
      now: new Date().toISOString(),
      }),
      repository.completeHumanTakeover({
        taskId: parentTaskId,
        takeoverId: takeover.takeoverId,
        newOwnerRunId: 'run-browser-human-takeover-ignored-racer',
        executionBinding: executionBinding('run-browser-human-takeover-ignored-racer'),
        wakeId: 'wake-tab-3',
        targetClaim: {
          partition: additionalBeforeResume.logicalKey.partition,
          tabId: additionalBeforeResume.logicalKey.tabId,
          physicalTargetToken: additionalBeforeResume.physicalTargetToken || '',
          claimId: additionalBeforeResume.claimId,
          generation: additionalBeforeResume.generation,
          suspensionCheckpointId: additionalBeforeResume.suspensionCheckpointId,
          browserTaskId: route.browserTaskId,
        },
        now: new Date().toISOString(),
      }),
      repository.resumeSuspendedBrowserWorkflow({
        taskId: parentTaskId,
        newOwnerRunId: 'run-browser-human-takeover-task-racer',
        executionBinding: executionBinding('run-browser-human-takeover-task-racer'),
        wake: {
          wakeId: 'wake-task-racer',
          checkpointId: firstBeforeResume.suspensionCheckpointId,
          basisRevision: Number(row ? JSON.parse(row.human_takeover_ref_json).basisRevision : 0),
          kind: 'user_continue',
          sourceId: 'task-racer',
          sourceDigest: 'stale-by-design',
          issuedAt: new Date().toISOString(),
        },
      }),
    ])
    assert.equal(concurrentWake[0].status, 'fulfilled')
    assert.equal(concurrentWake[1].status, 'fulfilled')
    assert.equal(concurrentWake[2].status, 'rejected')
    const successorCount = [concurrentWake[0], concurrentWake[1]].filter((entry) => (
      entry.status === 'fulfilled' && entry.value.createdSuccessor
    )).length
    assert.equal(successorCount, 1)
    const resumed = claimService.read(claim.logicalKey)
    assert.equal(resumed?.state, 'held')
    assert.equal(resumed?.ownerRunId, newOwnerRunId)
    assert.equal(resumed?.generation, claim.generation + 2)
    assert.equal(claimService.read(siblingClaim.logicalKey)?.state, 'suspended')
    const additionalResume = concurrentWake[1]
    assert.equal(additionalResume.status, 'fulfilled')
    const additionalResumed = claimService.read(additionalUserClaim.logicalKey)
    assert.equal(additionalResumed?.state, 'held')
    assert.equal(additionalResumed?.ownerRunId, newOwnerRunId)
    const receiptKinds = db.prepare(
      'SELECT kind FROM browser_control_receipts WHERE browser_task_id = ? ORDER BY sequence',
    ).all<{ kind: string }>(route.browserTaskId).map((entry) => entry.kind)
    assert.deepEqual(receiptKinds.slice(-6), [
      'target_user_owned',
      'claim_suspended',
      'target_resume_authorized',
      'claim_resumed',
      'target_resume_authorized',
      'claim_resumed',
    ])
    const receiptCount = receiptKinds.length
    await assert.rejects(
      repository.completeHumanTakeover({
        taskId: parentTaskId,
        takeoverId: takeover.takeoverId,
        newOwnerRunId: 'run-browser-human-takeover-duplicate',
        executionBinding: executionBinding('run-browser-human-takeover-duplicate'),
        now: new Date().toISOString(),
      }),
      /takeover_receipt_not_pending/,
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM browser_control_receipts WHERE browser_task_id = ?')
        .get<{ count: number }>(route.browserTaskId)?.count,
      receiptCount,
    )
    assert.equal(claimService.read(claim.logicalKey)?.generation, claim.generation + 2)
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
    const claimService = new BrowserTargetClaimService(new BrowserTargetClaimRepository(accessor))
    const heldClaim = claimService.acquire({
      partition: 'persist:browser',
      tabId: 'tab-browser-non-done-closeout',
      physicalTargetToken: 'physical-browser-non-done-closeout',
      bootIncarnationId: 'boot-browser-non-done-closeout',
      profileId: null,
      surface: 'user-view',
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      scopeId,
      sessionId: null,
    })
    if (isAgentBrowserError(heldClaim)) throw new Error(heldClaim.message)
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
    assert.equal(claimService.read(heldClaim.logicalKey)?.state, 'released')
    assert.deepEqual(
      db.prepare(
        `SELECT kind, previous_claim_id, previous_generation, next_generation
           FROM browser_control_receipts
          WHERE browser_task_id = ? AND kind = 'claim_released'`,
      ).get(route.browserTaskId),
      {
        kind: 'claim_released',
        previous_claim_id: heldClaim.claimId,
        previous_generation: heldClaim.generation,
        next_generation: heldClaim.generation + 1,
      },
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

test('bound Browser Parent handoff recovery settlements stay inside the workflow transaction', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-handoff-recovery-settlement-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const repository = new AgentSessionCheckpointRepository(accessor)
    const now = '2026-07-22T06:00:00.000Z'

    const createBoundParent = async (suffix: string) => {
      const parentTaskId = `parent-handoff-recovery-${suffix}`
      const scopeId = `scope-handoff-recovery-${suffix}`
      const ownerRunId = `run-handoff-recovery-${suffix}`
      const binding = executionBinding(ownerRunId)
      projections.create({
        taskId: parentTaskId,
        scopeId,
        runId: ownerRunId,
        taskType: 'research',
        module: 'browser',
        status: 'recoverable_paused',
        interactionState: 'suspended',
        waitingFor: 'background',
        steps: [],
        ownerAgentId: 'collector',
        taskOrigin: 'user_root',
        executionBinding: binding,
        continuationRef: {
          kind: 'handoff_takeover',
          taskId: parentTaskId,
          targetAgentId: 'collector',
          handoffGeneration: 1,
          userRequestVerbatim: '继续原任务',
          consumed: false,
        } as never,
        createdAt: now,
        updatedAt: now,
      })
      db.prepare(
        `INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
         VALUES (?, 'butler', 'Browser handoff recovery', ?, ?)`,
      ).run(scopeId, now, now)
      const sourceMessageId = `message-handoff-recovery-${suffix}`
      db.prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
         VALUES (?, ?, 'user', '继续原任务', ?, '{}')`,
      ).run(sourceMessageId, scopeId, now)
      await repository.bindBrowserWorkflowRoute({
        parentTaskId,
        ownerRunId,
        sourceMessageId,
        executionBinding: binding,
        now,
      })
      return parentTaskId
    }

    const retryTaskId = await createBoundParent('retry')
    assert.throws(
      () => projections.update(retryTaskId, { blockedReason: 'must-not-bypass-workflow' }),
      /bound Browser Parent requires workflow unit-of-work/,
    )
    await repository.settleHandoffTakeoverContinuation({
      parentTaskId: retryTaskId,
      handoffGeneration: 1,
      outcome: 'recovery_failed',
      attempts: 1,
      error: 'core_closeout_owner_mismatch',
      now: '2026-07-22T06:01:00.000Z',
    })
    const retried = projections.get(retryTaskId)
    assert.equal((retried?.continuationRef as Record<string, unknown>).startupRecoveryAttempts, 1)
    assert.equal((retried?.continuationRef as Record<string, unknown>).consumed, false)
    assert.equal(retried?.status, 'recoverable_paused')

    await repository.settleHandoffTakeoverContinuation({
      parentTaskId: retryTaskId,
      handoffGeneration: 1,
      outcome: 'consumed',
      now: '2026-07-22T06:02:00.000Z',
    })
    assert.equal((projections.get(retryTaskId)?.continuationRef as Record<string, unknown>).consumed, true)

    db.prepare(`
      UPDATE task_projections
         SET continuation_ref_json = ?, status = 'recoverable_paused',
             interaction_state = 'suspended', resumable_actions_json = NULL
       WHERE task_id = ?
    `).run(JSON.stringify({
      kind: 'handoff_takeover',
      taskId: retryTaskId,
      targetAgentId: 'collector',
      handoffGeneration: 1,
      userRequestVerbatim: '继续原任务',
      consumed: false,
      startupRecoveryAttempts: 2,
    }), retryTaskId)
    await repository.settleHandoffTakeoverContinuation({
      parentTaskId: retryTaskId,
      handoffGeneration: 1,
      outcome: 'recovery_terminal',
      attempts: 3,
      error: 'core_closeout_owner_mismatch',
      now: '2026-07-22T06:03:00.000Z',
    })
    const terminal = projections.get(retryTaskId)
    const terminalRef = terminal?.continuationRef as Record<string, unknown>
    assert.equal(terminalRef.consumed, true)
    assert.equal(terminalRef.startupRecoveryAttempts, 3)
    assert.equal(terminalRef.startupRecoveryTerminal, true)
    assert.equal(terminal?.status, 'failed')
    assert.equal(terminal?.interactionState, 'suspended')
    assert.deepEqual(terminal?.resumableActions, [])
  } finally {
    db.close()
  }
})
