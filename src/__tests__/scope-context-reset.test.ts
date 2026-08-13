import assert from 'node:assert/strict'
import test from 'node:test'

import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import type { LifecycleResult } from '../shared/ipc-contracts/agent-runtime'
import {
  commitSuccessfulScopeContextClose,
  commitSuccessfulScopeContextReset,
  settleScopeContextCloseLifecycleResult,
  settleScopeContextResetLifecycleResult,
  type ScopeContextResetCommitDeps,
} from '../main/modules/agent-control/runtime-core/scope-context-reset'
import { InteractionLifecycleRegistry } from '../main/modules/agent-control/runtime-core/interaction-lifecycle-registry'
import { BrowserTargetClaimService, MemoryBrowserTargetClaimRepository } from '../main/modules/browser-engine/browser-target-claims'
import { acquireTarget, identityOf } from './utils/browser-target-claim-fixture'

const result = {
  ok: true as const,
  action: 'reset' as const,
  aliasId: 'scope-reset',
  retiredGeneration: 4,
  newGeneration: 5,
  transactionDigest: 'reset-digest',
}

const scope: ConversationScope = {
  id: 'scope-reset',
  aliasGeneration: 5,
  messageVisibilityEpoch: 9,
  agent: 'butler',
  activeAgentId: 'researcher',
  handoffGeneration: 2,
  title: 'Reset scope',
  sourceKind: 'local',
  sourceId: 'scope-reset',
  threadKey: 'scope-reset',
  meta: {},
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:01.000Z',
}

const stepNames = [
  'execution_context',
  'remote_inbound',
  'browser_target_claims',
  'active_skill',
  'continuity',
  'authorization_facts',
  'negations',
  'lark_auth',
  'reference_hint',
  'skill_projection',
  'interaction_lifecycle',
  'ephemeral_interactions',
  'ask_user_interactions',
  'ask_user_cards',
  'session_snapshot:butler',
  'session_snapshot:researcher',
  'run_summary',
] as const

function createDeps(input: {
  calls: string[]
  failStep?: string
  registry?: InteractionLifecycleRegistry
}): ScopeContextResetCommitDeps {
  const run = (step: string) => {
    input.calls.push(step)
    if (input.failStep === step) throw new Error(`failed:${step}`)
  }
  return {
    resetExecutionContext: (scopeId, agents) => {
      assert.equal(scopeId, scope.id)
      assert.deepEqual(agents, ['butler', 'researcher'])
      run('execution_context')
    },
    discardPendingRemoteInbound: () => run('remote_inbound'),
    closeBrowserTargetClaims: () => run('browser_target_claims'),
    clearActiveSkillContext: () => run('active_skill'),
    forgetContinuity: () => run('continuity'),
    clearAuthorizationFacts: () => run('authorization_facts'),
    clearNegations: () => run('negations'),
    clearLarkAuthFlows: () => run('lark_auth'),
    clearReferenceHint: () => run('reference_hint'),
    clearSkillProjection: () => run('skill_projection'),
    cancelInteractionLifecycle: (scopeId) => {
      run('interaction_lifecycle')
      input.registry?.cancelScope(scopeId)
    },
    rejectEphemeralInteractions: () => run('ephemeral_interactions'),
    rejectAskUserInteractions: () => run('ask_user_interactions'),
    sweepPendingAskUserCards: () => run('ask_user_cards'),
    clearSessionSnapshot: (name) => run(`session_snapshot:${name.split('::', 1)[0]}`),
    clearRunSummary: () => run('run_summary'),
    reportCleanupFailure: (step, error) => {
      input.calls.push(`reported:${step}:${error instanceof Error ? error.message : String(error)}`)
    },
  }
}

test('durable reset synchronously clears every exact-scope context before returning its identity', () => {
  const calls: string[] = []
  const committed = commitSuccessfulScopeContextReset({
    requestAliasId: scope.id,
    result,
    scope,
    deps: createDeps({ calls }),
  })

  assert.equal(committed, result)
  assert.deepEqual(calls, stepNames)
})

test('a post-commit cleanup failure is retried, reported, and cannot skip later cleanup or falsify reset success', () => {
  for (const failStep of stepNames) {
    const calls: string[] = []
    const committed = commitSuccessfulScopeContextReset({
      requestAliasId: scope.id,
      result,
      scope,
      deps: createDeps({ calls, failStep }),
    })

    assert.equal(committed, result, failStep)
    assert.equal(calls.filter((step) => step === failStep).length, 2, failStep)
    assert.ok(calls.includes(`reported:${failStep}:failed:${failStep}`), failStep)
    for (const step of stepNames) assert.ok(calls.includes(step), `${failStep} skipped ${step}`)
  }
})

test('identity mismatch fails closed before any in-process cleanup', () => {
  const calls: string[] = []
  assert.throws(() => commitSuccessfulScopeContextReset({
    requestAliasId: scope.id,
    result,
    scope: { ...scope, aliasGeneration: result.retiredGeneration },
    deps: createDeps({ calls }),
  }), /scope_context_reset_commit_identity_mismatch/)
  assert.deepEqual(calls, [])
})

test('central reset cancels stale takeover lifecycle without touching another scope', () => {
  const registry = new InteractionLifecycleRegistry()
  const oldRun = { runId: 'run-old', agentId: 'butler', scopeId: scope.id }
  const otherRun = { runId: 'run-other', agentId: 'butler', scopeId: 'scope-other' }
  registry.register({ ...oldRun, interactionId: 'takeover-old', type: 'human_takeover' })
  registry.register({ ...otherRun, interactionId: 'takeover-other', type: 'human_takeover' })

  commitSuccessfulScopeContextReset({
    requestAliasId: scope.id,
    result,
    scope,
    deps: createDeps({ calls: [], registry }),
  })

  assert.equal(registry.hasPending(oldRun), false)
  assert.equal(registry.hasPending(otherRun), true)
  registry.clear()
})

test('failed reset and same-epoch stop return unchanged without reading or clearing context', () => {
  const lifecycleResults = [{
    ok: false as const,
    action: 'reset' as const,
    errorKind: 'persistence_failed' as const,
    message: 'reset failed',
    evidenceDigest: 'failure-digest',
  }, {
    ok: true as const,
    action: 'stop' as const,
    aliasId: scope.id,
    codexThreadId: 'thread-current',
    codexTurnId: 'turn-current',
    terminal: 'interrupted' as const,
    closeoutDigest: 'stop-digest',
    fenceReleaseRevision: 7,
  }]
  for (const lifecycleResult of lifecycleResults) {
    const calls: string[] = []
    let scopeReads = 0
    const settled = settleScopeContextResetLifecycleResult({
      requestAliasId: scope.id,
      result: lifecycleResult,
      readScope: () => {
        scopeReads += 1
        return scope
      },
      deps: createDeps({ calls }),
    })
    assert.equal(settled, lifecycleResult)
    assert.equal(scopeReads, 0)
    assert.deepEqual(calls, [])
  }
})

const successfulCloseResults: Array<Extract<LifecycleResult, { ok: true; action: 'close' }>> = [{
  ok: true,
  action: 'close',
  closeoutDisposition: 'never_started',
  aliasId: scope.id,
  retiredGeneration: scope.aliasGeneration,
  retirementTransactionDigest: 'close-never-started',
  archiveDisposition: 'not_required',
  scopeClosureEvidenceDigest: 'close-never-started',
}, {
  ok: true,
  action: 'close',
  closeoutDisposition: 'ready_terminal_no_native_thread',
  aliasId: scope.id,
  retiredGeneration: scope.aliasGeneration,
  lastCommittedReadyTerminalTransactionDigest: 'ready-terminal',
  retirementTransactionDigest: 'close-ready-terminal',
  archiveDisposition: 'not_required',
  scopeClosureEvidenceDigest: 'close-ready-terminal',
}, {
  ok: true,
  action: 'close',
  closeoutDisposition: 'native_thread_idle',
  aliasId: scope.id,
  retiredGeneration: scope.aliasGeneration,
  idleThreadReadDigest: 'idle-read',
  lastCommittedProductTerminalDigest: 'product-terminal',
  retirementTransactionDigest: 'close-idle-thread',
  archiveDisposition: 'durable_cleanup_pending',
  archiveIntentDigest: 'archive-idle-thread',
  scopeClosureEvidenceDigest: 'close-idle-thread',
}, {
  ok: true,
  action: 'close',
  closeoutDisposition: 'completed_active_product_turn',
  aliasId: scope.id,
  retiredGeneration: scope.aliasGeneration,
  codexThreadId: 'thread-active',
  codexTurnId: 'turn-active',
  terminal: 'completed',
  closeoutDigest: 'active-closeout',
  retirementTransactionDigest: 'close-active-turn',
  archiveDisposition: 'durable_cleanup_pending',
  archiveIntentDigest: 'archive-active-turn',
  scopeClosureEvidenceDigest: 'close-active-turn',
}]

test('every successful close disposition synchronously clears the exact scope', () => {
  for (const closeResult of successfulCloseResults) {
    const calls: string[] = []
    const settled = settleScopeContextCloseLifecycleResult({
      requestAliasId: scope.id,
      result: closeResult,
      readClosedScopeIdentity: () => ({
        scopeId: scope.id,
        agents: [scope.agent, scope.activeAgentId],
      }),
      deps: createDeps({ calls }),
    })
    assert.equal(settled, closeResult, closeResult.closeoutDisposition)
    assert.deepEqual(calls, stepNames, closeResult.closeoutDisposition)
  }
})

test('successful close settles old Browser ownership and interaction lifecycle without touching another scope', () => {
  const registry = new InteractionLifecycleRegistry()
  const oldRun = { runId: 'run-close-old', agentId: 'butler', scopeId: scope.id }
  const otherRun = { runId: 'run-close-other', agentId: 'butler', scopeId: 'scope-other' }
  registry.register({ ...oldRun, interactionId: 'takeover-close-old', type: 'human_takeover' })
  registry.register({ ...otherRun, interactionId: 'takeover-close-other', type: 'human_takeover' })
  const claims = new BrowserTargetClaimService(new MemoryBrowserTargetClaimRepository())
  const oldClaim = acquireTarget(claims, { scopeId: scope.id, sessionId: scope.id })
  const otherClaim = acquireTarget(claims, {
    tabId: 'tab-close-other',
    physicalTargetToken: 'boot-test:tab-close-other:1',
    scopeId: otherRun.scopeId,
    sessionId: otherRun.scopeId,
    ownerRunId: otherRun.runId,
  })
  const calls: string[] = []
  const deps = createDeps({ calls, registry })
  deps.closeBrowserTargetClaims = (scopeId) => {
    calls.push('browser_target_claims')
    claims.closeScopeContext(scopeId)
  }

  commitSuccessfulScopeContextClose({
    requestAliasId: scope.id,
    result: successfulCloseResults[0]!,
    identity: { scopeId: scope.id, agents: [scope.agent, scope.activeAgentId] },
    deps,
  })

  assert.equal(registry.hasPending(oldRun), false)
  assert.equal(registry.hasPending(otherRun), true)
  assert.equal(claims.checkWrite(identityOf(oldClaim))?.errorCode, 'lease_required')
  assert.equal(claims.checkWrite(identityOf(otherClaim)), null)
  registry.clear()
})

test('failed close and same-epoch stop perform no close cleanup', () => {
  const lifecycleResults: LifecycleResult[] = [{
    ok: false,
    action: 'close',
    errorKind: 'persistence_failed',
    message: 'close failed',
    evidenceDigest: 'close-failure-digest',
  }, {
    ok: true,
    action: 'stop',
    aliasId: scope.id,
    codexThreadId: 'thread-current',
    codexTurnId: 'turn-current',
    terminal: 'interrupted',
    closeoutDigest: 'stop-current',
    fenceReleaseRevision: 8,
  }]
  for (const lifecycleResult of lifecycleResults) {
    const calls: string[] = []
    let identityReads = 0
    const settled = settleScopeContextCloseLifecycleResult({
      requestAliasId: scope.id,
      result: lifecycleResult,
      readClosedScopeIdentity: () => {
        identityReads += 1
        return { scopeId: scope.id, agents: [scope.agent] }
      },
      deps: createDeps({ calls }),
    })
    assert.equal(settled, lifecycleResult)
    assert.equal(identityReads, 0)
    assert.deepEqual(calls, [])
  }
})
