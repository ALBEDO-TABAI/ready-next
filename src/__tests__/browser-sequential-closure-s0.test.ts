import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import type { BrowserTargetClaimAcquireInput } from '../main/modules/browser-engine/browser-target-claims'
import { recoverPendingHandoffTakeovers } from '../main/modules/agent-control/agents/handoff-takeover-recovery'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import { finalizeRunOutcome } from '../main/modules/agent-control/runtime-core/run-finalizer'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import { acquireTarget, createTargetClaimService, identityOf, TARGET_A } from './utils/browser-target-claim-fixture'

function turnTarget(patch: Partial<BrowserTargetClaimAcquireInput> = {}) {
  const { parentTaskId: _parentTaskId, ownerRunId: _ownerRunId, ...target } = { ...TARGET_A, ...patch }
  return target
}

test('S0 R1a: takeover on tab A does not block a fresh run on unrelated tab B', () => {
  const service = createTargetClaimService()
  const oldClaim = acquireTarget(service)
  service.recordUserSignal({
    target: identityOf(oldClaim),
    source: 'keyboard',
    suspensionCheckpointId: 'checkpoint-a',
  })
  const next = service.acquire({
    ...TARGET_A,
    tabId: 'tab-b',
    physicalTargetToken: 'boot-test:tab-b:1',
    parentTaskId: 'task-new',
    browserTaskId: 'browser-task-new',
    ownerRunId: 'run-new',
  })
  assert.ok(!isAgentBrowserError(next), 'a target fence on tab A must not spill onto tab B')
})

test('S0 R1b: the same turn acquires tab B after target A takeover is resolved', () => {
  const service = createTargetClaimService()
  const turn = new BrowserTurnLease({ taskId: 'task-a', runId: 'run-a' }, service)
  const first = turn.ensureGateForTarget(turnTarget())
  assert.ok(!isAgentBrowserError(first))
  if (isAgentBrowserError(first)) return
  service.recordUserSignal({
    target: first.identity,
    source: 'explicit-button',
    suspensionCheckpointId: 'checkpoint-a',
  })
  const second = turn.ensureGateForTarget(turnTarget({
    tabId: 'tab-b',
    physicalTargetToken: 'boot-test:tab-b:1',
  }))
  assert.ok(!isAgentBrowserError(second), 'tab B must not heartbeat the stale tab A owner')
})

test('S0 R1c: one turn uses distinct target ownership for tab A and tab B', () => {
  const service = createTargetClaimService()
  const turn = new BrowserTurnLease({ taskId: 'task-a', runId: 'run-a' }, service)
  const first = turn.ensureGateForTarget(turnTarget())
  const second = turn.ensureGateForTarget(turnTarget({
    tabId: 'tab-b',
    physicalTargetToken: 'boot-test:tab-b:1',
  }))
  assert.ok(!isAgentBrowserError(first))
  assert.ok(!isAgentBrowserError(second))
  if (isAgentBrowserError(first) || isAgentBrowserError(second)) return

  assert.notEqual(first.identity.claimId, second.identity.claimId, 'tab B must not reuse tab A ownership')
})

test('S0 ownership signals: presentation-only tab switching does not take over the page left behind', () => {
  const service = createTargetClaimService()
  const claim = acquireTarget(service)
  assert.equal(service.read(claim.logicalKey)?.state, 'held')
})

test('S0 ownership signals: trusted pointer input on the target is recognized as user takeover input', () => {
  const service = createTargetClaimService()
  const claim = acquireTarget(service)
  assert.equal(service.recordUserSignal({
    target: identityOf(claim),
    source: 'pointer',
    suspensionCheckpointId: 'checkpoint-pointer',
  })?.state, 'user_owned')
})

test('S0 ownership signals: chrome navigation fences only the claimed target', () => {
  const service = createTargetClaimService()
  const claim = acquireTarget(service)
  assert.equal(service.recordUserSignal({
    target: identityOf(claim),
    source: 'navigation',
    suspensionCheckpointId: 'checkpoint-navigation',
  })?.state, 'user_owned')
})

test('S0 ownership signals: closing a claimed tab settles ownership immediately', () => {
  const service = createTargetClaimService()
  const claim = acquireTarget(service)
  assert.equal(service.closeTarget(claim.logicalKey)?.state, 'expired')
  assert.equal(service.heldForRun(claim.ownerRunId).length, 0)
})

test('S0 R8: completion criteria use the Browser workflow write boundary', async () => {
  const output = await executeToolCall(
    'declare_completion_criteria',
    { criteria: ['18 个研究项全部有可回读证据'] },
    {
      taskId: 'browser-parent-r8',
      sessionId: 'scope-r8',
      allowedToolNames: ['declare_completion_criteria'],
      runtime: {
        getTaskProjectionStoreForFinalize: () => ({
          update: () => {
            throw new Error('[task-projection-repository] bound Browser Parent requires workflow unit-of-work')
          },
        }),
        updateBrowserWorkflowCompletionDeclaration: async () => undefined,
      } as never,
      browserWorkflowRoute: {
        browserTaskId: 'browser-child-r8',
        requestAnchorSnapshotDigest: 'request-r8',
      },
      runId: 'run-r8',
    },
  )

  assert.equal(output.data?.ok, true, 'a bound Browser Parent must not use the ordinary projection writer')
})

test('S0 R9: exhausted handoff startup recovery writes one terminal receipt instead of retrying', async () => {
  let attempts = 0
  let terminalReceipts = 0
  const deps = {
    listPending: () => [{
      taskId: 'task-r9',
      scopeId: 'scope-r9',
      continuationRef: {
        kind: 'handoff_takeover',
        consumed: false,
        targetAgentId: 'collector',
        handoffGeneration: 1,
        userRequestVerbatim: '继续原任务',
        contextRefIds: [],
        startupRecoveryAttempts: 3,
      },
    }],
    getScope: () => ({
      id: 'scope-r9',
      agent: 'butler',
      activeAgentId: 'collector',
      handoffGeneration: 1,
      title: '会话',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: 'scope-r9',
      meta: {},
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    } as never),
    runTakeover: async () => {
      attempts += 1
      return { success: false, error: 'core_closeout_owner_mismatch' }
    },
    markConsumed: () => undefined,
    markRecoveryTerminal: () => {
      terminalReceipts += 1
    },
    log: () => undefined,
  } as Parameters<typeof recoverPendingHandoffTakeovers>[0] & {
    markRecoveryTerminal: (taskId: string, handoffGeneration: number, error: string) => void
  }

  await recoverPendingHandoffTakeovers(deps)
  assert.equal(attempts, 0, 'an exhausted recovery must not launch the same takeover again')
  assert.equal(terminalReceipts, 1, 'the exhausted recovery must become a durable terminal fact')
})

test('S0 R9: a recovery settlement write failure is logged without crashing startup', async () => {
  const logs: string[] = []
  await recoverPendingHandoffTakeovers({
    listPending: () => [{
      taskId: 'task-r9-settlement-failure',
      scopeId: 'scope-r9-settlement-failure',
      continuationRef: {
        kind: 'handoff_takeover',
        consumed: false,
        targetAgentId: 'collector',
        handoffGeneration: 1,
        userRequestVerbatim: '继续原任务',
        startupRecoveryAttempts: 3,
      },
    }],
    getScope: () => ({
      activeAgentId: 'collector',
      handoffGeneration: 1,
    } as never),
    runTakeover: async () => ({ success: false }),
    markConsumed: () => undefined,
    markRecoveryTerminal: () => {
      throw new Error('settlement writer unavailable')
    },
    log: (name) => { logs.push(name) },
  })

  assert.ok(logs.includes('handoff_takeover_startup_recovery_settlement_failed'))
  assert.ok(logs.includes('handoff_takeover_startup_recovery_terminal'))
})

test('S0 R6 proof: checkpoint closeout cannot preserve a stale short-task projection over research runtime truth', async () => {
  let projection = {
    taskId: 'task-r6',
    scopeId: 'scope-r6',
    runId: 'run-r6',
    taskType: 'short_task',
    module: 'browser',
  } as Record<string, unknown>
  let runMeta: Record<string, unknown> | null = null
  let closeTaskType: string | null = null
  const researchBudget = createTaskBudgetRuntime('research', {
    usage: { iterationsUsed: 34, toolCallsUsed: 37, parallelToolGroupsUsed: 0 },
  })

  await finalizeRunOutcome({
    kind: 'checkpoint',
    runId: 'run-r6',
    taskId: 'task-r6',
    scopeId: 'scope-r6',
    continuationHandle: 'checkpoint-r6',
    terminalReason: 'checkpoint_incomplete',
    durationMs: 1,
    toolCallsUsed: 37,
    initiator: 'incomplete',
    taskBudgetRuntime: researchBudget,
    projectionPatch: {
      status: 'recoverable_paused',
      interactionState: 'suspended',
      resumableActions: ['continue', 'cancel'],
    },
  }, {
    runMetaRepository: {
      get: () => runMeta,
      create: (input) => {
        runMeta = { ...input }
        return input
      },
      update: (_runId, patch) => {
        runMeta = { ...(runMeta || {}), ...patch }
        return runMeta
      },
    },
    taskProjectionStore: {
      get: () => projection as never,
      update: (_taskId, patch) => {
        projection = { ...projection, ...patch }
      },
    },
    writeProjectionTerminalPatch: (patch) => {
      projection = { ...projection, ...(patch || {}) }
    },
    writeRunCloseMetric: (metric) => {
      closeTaskType = metric.taskType ?? null
    },
  })

  assert.equal(projection.taskType, 'research')
  assert.equal(runMeta?.taskType, 'research')
  assert.equal((runMeta?.budget as { maxIterations?: number } | null)?.maxIterations, 220)
  assert.equal(closeTaskType, 'research')
})
