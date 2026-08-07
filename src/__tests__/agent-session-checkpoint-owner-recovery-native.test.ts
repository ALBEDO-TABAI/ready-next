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

test('non-done core closeout terminates all browser ledgers without requiring a success seal', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-non-done-closeout-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    let closeoutParticipantInput: {
      readyRunId: string
      productTerminalDigest: string
      closeoutAt: string
    } | null = null
    const repository = new AgentSessionCheckpointRepository(accessor, {
      complete(input) {
        assert.equal(db.inTransaction, true)
        closeoutParticipantInput = input
      },
    })
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
    assert.equal(closeoutParticipantInput?.readyRunId, ownerRunId)
    assert.equal(closeoutParticipantInput?.closeoutAt, now)
    assert.equal(closeoutParticipantInput?.productTerminalDigest, closeout.value.canonicalMessageDigest)
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
