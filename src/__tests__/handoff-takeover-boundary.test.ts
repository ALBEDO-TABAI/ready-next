import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverPendingHandoffTakeovers } from '../main/modules/agent-control/agents/handoff-takeover-recovery'
import { commitSameSessionHandoff } from '../main/modules/agent-control/agents/handoff-adoption-transaction'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import { finalizeRunOutcome } from '../main/modules/agent-control/runtime-core/run-finalizer'
import { hasAdvancedPastHandoffContinuation, runWithHandoffToolGate } from '../main/modules/agent-control/agents/handoff-control'

const original = '  原始请求，逐字保留。\n第二行  '
const contextRefs = ['card:xhs', '/tmp/source.md']

test('cleared continuation is already consumed only after a bound takeover advanced the projection', () => {
  assert.equal(hasAdvancedPastHandoffContinuation({
    ownerAgentId: 'copywriter',
    continuationRef: null,
    executionBinding: {
      schemaVersion: 1, runId: 'run-new', ownerAgentIdAtStart: 'copywriter', runOrigin: 'handoff_takeover',
      kind: 'registered_agent', requestedAgentId: 'copywriter', effectiveAgentId: 'copywriter',
      executionMaterialHash: 'hash', ownerAssignmentSource: 'handoff', executionSelectionSource: 'task_owner',
      resolutionKind: 'direct',
    },
  }), true)
  assert.equal(hasAdvancedPastHandoffContinuation({
    ownerAgentId: 'copywriter', continuationRef: null, executionBinding: null,
  }), false)
})

function scope(activeAgentId = 'butler', handoffGeneration = 0): ConversationScope {
  return {
    id: 'scope-1', agent: 'butler', activeAgentId, handoffGeneration,
    title: '会话', sourceKind: 'local', sourceId: 'app', threadKey: 'scope-1', meta: {},
    createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
  }
}

test('same-session adoption rolls back both owner writes and never interrupts when the transaction fails', () => {
  const calls: string[] = []
  assert.throws(() => commitSameSessionHandoff({
    getTask: () => ({ scopeId: 'scope-1', runId: 'run-old' }),
    getConversation: () => ({ agent: 'butler', handoffGeneration: 3 }),
    begin: () => { calls.push('begin') },
    commit: () => { calls.push('commit') },
    rollback: () => { calls.push('rollback') },
    updateTask: () => { calls.push('task') },
    updateConversation: () => { calls.push('conversation'); throw new Error('write failed') },
    onCommitted: () => { calls.push('interrupt') },
  }, {
    taskId: 'task-1', scopeId: 'scope-1', targetAgentId: 'collector',
    userRequestVerbatim: original, contextRefs,
  }), /write failed/)
  assert.deepEqual(calls, ['begin', 'task', 'conversation', 'rollback'])
})

test('startup recovery retries an unconsumed handoff and does not consume failures or mismatched generations', async () => {
  const logs: string[] = []
  let attempts = 0
  let consumed = 0
  const pending = (generation: number, target = 'collector') => ({
    taskId: `task-${generation}`,
    scopeId: 'scope-1',
    continuationRef: {
      kind: 'handoff_takeover', consumed: false, targetAgentId: target,
      handoffGeneration: generation, userRequestVerbatim: original, contextRefIds: contextRefs,
    },
  })
  await recoverPendingHandoffTakeovers({
    listPending: () => [pending(1), pending(2)],
    getScope: () => scope('collector', 1),
    runTakeover: async (input) => {
      attempts += 1
      assert.equal(input.userRequestVerbatim, original)
      assert.deepEqual(input.contextRefIds, contextRefs)
      return { success: false, error: 'provider unavailable' }
    },
    markConsumed: () => { consumed += 1 },
    log: (name) => { logs.push(name) },
  })
  assert.equal(attempts, 1, 'only the matching durable generation is retried')
  assert.equal(consumed, 0, 'a failed retry remains durable for the next restart')
  assert.ok(logs.includes('handoff_takeover_startup_recovery_failed'))
  assert.ok(logs.includes('handoff_takeover_startup_recovery_rejected'))
})

test('request envelope carries handoff refs separately without changing the verbatim user text', async () => {
  const { buildRequestEnvelope } = await import('../main/modules/agent-control/contracts/request-envelope')
  const envelope = buildRequestEnvelope({ userText: original, contextRefIds: contextRefs })
  assert.equal(envelope.rawUserText, original)
  assert.equal(envelope.pureUserText, original.trim())
  assert.deepEqual(envelope.referencedResources, [
    { kind: 'mention', value: 'card:xhs' },
    { kind: 'path', value: '/tmp/source.md' },
  ])
})

test('the old run finalizer closes its own ledger but cannot mutate a takeover projection', async () => {
  let projectionWrites = 0
  let runWrites = 0
  const result = await finalizeRunOutcome({
    kind: 'checkpoint', runId: 'run-old', taskId: 'task-1', scopeId: 'scope-1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'manual_suspend', terminalReason: 'manual_suspend',
    continuationHandle: null, projectionPatch: { status: 'blocked', blockedReason: 'stale old run' },
  }, {
    runMetaRepository: {
      get: () => ({ runId: 'run-old' }),
      create: () => { runWrites += 1 },
      update: () => { runWrites += 1 },
    },
    taskProjectionStore: {
      get: () => ({
        taskId: 'task-1', scopeId: 'scope-1', runId: 'run-old', taskOrigin: 'user_root',
        taskType: 'multi_step_task', module: 'system', status: 'recoverable_paused',
        interactionState: 'suspended', steps: [], ownerAgentId: 'collector',
        continuationRef: { kind: 'handoff_takeover', priorRunId: 'run-old', handoffGeneration: 1 },
        createdAt: 'now', updatedAt: 'now',
      } as never),
      update: () => { projectionWrites += 1 },
    },
    writeProjectionTerminalPatch: () => { projectionWrites += 1 },
    writeRunCloseMetric: () => {},
  })
  assert.deepEqual(result, { status: 'checkpoint', terminalReason: 'manual_suspend' })
  assert.equal(runWrites, 1)
  assert.equal(projectionWrites, 0)
})

test('parallel tool callbacks serialize and all callbacks after takeover are skipped', async () => {
  const state: { hostControl?: 'handoff_takeover' | null; toolExecutionChain?: Promise<void> } = {}
  const executed: string[] = []
  let releaseFirst!: () => void
  const firstBarrier = new Promise<void>((resolve) => { releaseFirst = resolve })
  const first = runWithHandoffToolGate(state, async () => {
    executed.push('handoff')
    await firstBarrier
    state.hostControl = 'handoff_takeover'
    return 'adopted'
  }, () => 'skipped')
  const second = runWithHandoffToolGate(state, async () => {
    executed.push('dangerous-followup')
    return 'executed'
  }, () => 'skipped')
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second]), ['adopted', 'skipped'])
  assert.deepEqual(executed, ['handoff'])
})
