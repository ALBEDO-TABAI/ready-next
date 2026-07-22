import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBrowserLeaseSupervisionSnapshot } from '../main/modules/browser-engine/browser-lease-supervision-snapshot'
import { acquireTarget, createTargetClaimService, setTargetUserOwnedForTest } from './utils/browser-target-claim-fixture'

test('browser lease supervision snapshot reports both surfaces when idle', () => {
  const service = createTargetClaimService({ now: () => 1_000 })
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service)
  assert.equal(snapshot.activeWriteSurface, null)
  assert.equal(snapshot.surfaces['user-view'].state, 'idle')
  assert.equal(snapshot.surfaces['agent-view'].state, 'idle')
})

test('browser lease supervision snapshot reports user-view holder', () => {
  const service = createTargetClaimService({ now: () => 1_000 })
  acquireTarget(service, { parentTaskId: 'task-user', ownerRunId: 'run-user', tabId: 'tab-user' })
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service)
  assert.equal(snapshot.activeWriteSurface, 'user-view')
  assert.equal(snapshot.surfaces['user-view'].state, 'held')
  assert.equal(snapshot.surfaces['user-view'].heldBy, 'task-user')
  assert.equal(snapshot.surfaces['user-view'].runId, 'run-user')
  assert.equal(snapshot.surfaces['user-view'].tabId, 'tab-user')
})

test('browser lease supervision snapshot reports agent-view holder', () => {
  const service = createTargetClaimService({ now: () => 1_000 })
  acquireTarget(service, { surface: 'agent-view', parentTaskId: 'task-agent', ownerRunId: 'run-agent', tabId: 'tab-agent' })
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service)
  assert.equal(snapshot.activeWriteSurface, 'agent-view')
  assert.equal(snapshot.surfaces['agent-view'].state, 'held')
  assert.equal(snapshot.surfaces['agent-view'].heldBy, 'task-agent')
  assert.equal(snapshot.surfaces['agent-view'].tabId, 'tab-agent')
})

test('browser lease supervision snapshot keeps takeover visible after user signal', () => {
  const service = createTargetClaimService({ now: () => 1_000 })
  const claim = acquireTarget(service, { parentTaskId: 'task-user', ownerRunId: 'run-user' })
  assert.equal(setTargetUserOwnedForTest(service, claim, 'checkpoint-user').state, 'user_owned')
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service)
  assert.equal(snapshot.activeWriteSurface, null)
  assert.equal(snapshot.surfaces['user-view'].state, 'takeover')
  assert.equal(snapshot.surfaces['user-view'].heldBy, 'task-user')
})
