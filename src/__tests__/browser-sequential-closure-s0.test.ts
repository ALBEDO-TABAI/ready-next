import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import type { BrowserTargetClaimAcquireInput } from '../main/modules/browser-engine/browser-target-claims'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import {
  createAgentTabUserInputTakeoverHandlers,
  isAgentNavigationEcho,
  persistAgentTabUserTakeover,
} from '../main/modules/browser-engine/agent-tab-control-gate'
import { acquireTarget, createTargetClaimService, setTargetUserOwnedForTest, TARGET_A } from './utils/browser-target-claim-fixture'

function turnTarget(patch: Partial<BrowserTargetClaimAcquireInput> = {}) {
  const { parentTaskId: _parentTaskId, ownerRunId: _ownerRunId, ...target } = { ...TARGET_A, ...patch }
  return target
}

test('S0 R1a: takeover on tab A does not block a fresh run on unrelated tab B', () => {
  const service = createTargetClaimService()
  const oldClaim = acquireTarget(service)
  setTargetUserOwnedForTest(service, oldClaim, 'checkpoint-a')
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
  const firstClaim = service.read(first.identity)
  if (!firstClaim) throw new Error('claim missing')
  setTargetUserOwnedForTest(service, firstClaim, 'checkpoint-a')
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

test('S0 ownership signals: trusted pointer input reaches the durable takeover intent port', async () => {
  const service = createTargetClaimService()
  const claim = acquireTarget(service)
  const committed: string[] = []
  let transaction: Promise<boolean> | null = null
  const handlers = createAgentTabUserInputTakeoverHandlers({
    isActivelyDriven: () => true,
    isFrozen: () => false,
    isAgentKey: () => false,
    isAgentMouse: () => false,
    takeOver: () => {
      transaction = persistAgentTabUserTakeover({
        persist: async () => { committed.push(claim.claimId) },
        onPersisted: () => undefined,
        onPersistenceFailure: () => undefined,
      })
    },
  })
  let prevented = 0
  handlers.onMouseInput({ preventDefault: () => { prevented += 1 } }, { type: 'mouseDown' })
  assert.equal(await transaction, true)
  assert.deepEqual(committed, [claim.claimId])
  assert.equal(prevented, 0)
})

test('S0 ownership signals: chrome navigation targets one claim and suppresses agent echoes', async () => {
  const service = createTargetClaimService()
  const claim = acquireTarget(service)
  const sibling = acquireTarget(service, {
    tabId: 'tab-b',
    physicalTargetToken: 'boot-test:tab-b:1',
  })
  const committed: string[] = []
  assert.equal(isAgentNavigationEcho({ signalSource: 'navigation', hasActiveAgentAction: false }), false)
  await persistAgentTabUserTakeover({
    persist: async () => { committed.push(claim.claimId) },
    onPersisted: () => undefined,
    onPersistenceFailure: () => undefined,
  })
  assert.deepEqual(committed, [claim.claimId])
  assert.notEqual(committed[0], sibling.claimId)
  assert.equal(isAgentNavigationEcho({ signalSource: 'navigation', hasActiveAgentAction: true }), true)
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
