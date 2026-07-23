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

