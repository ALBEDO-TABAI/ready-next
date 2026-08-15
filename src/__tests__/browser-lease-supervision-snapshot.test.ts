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

test('browser lease supervision snapshot prefers the current tab takeover among multiple live records', () => {
  const service = createTargetClaimService({ now: () => 1_000 })
  const older = acquireTarget(service, {
    parentTaskId: 'task-old',
    ownerRunId: 'run-old',
    tabId: 'tab-old',
    physicalTargetToken: 'boot-test:tab-old:1',
  })
  const current = acquireTarget(service, {
    parentTaskId: 'task-current',
    ownerRunId: 'run-current',
    tabId: 'tab-current',
    physicalTargetToken: 'boot-test:tab-current:1',
  })
  assert.equal(setTargetUserOwnedForTest(service, older, 'checkpoint-old').state, 'user_owned')
  assert.equal(setTargetUserOwnedForTest(service, current, 'checkpoint-current').state, 'user_owned')
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service, 'tab-current')
  assert.equal(snapshot.surfaces['user-view'].state, 'takeover')
  assert.equal(snapshot.surfaces['user-view'].tabId, 'tab-current')
  assert.equal(snapshot.surfaces['user-view'].heldBy, 'task-current')
  assert.equal(snapshot.claims.filter((item) => item.state === 'user_owned').length, 2)
})

test('browser lease supervision snapshot keeps a same-surface held claim after current-tab takeover', () => {
  const service = createTargetClaimService({ now: () => 1_000 })
  const current = acquireTarget(service, {
    parentTaskId: 'task-current',
    ownerRunId: 'run-current',
    tabId: 'tab-current',
    physicalTargetToken: 'boot-test:tab-current:1',
  })
  acquireTarget(service, {
    parentTaskId: 'task-other',
    ownerRunId: 'run-other',
    tabId: 'tab-other',
    physicalTargetToken: 'boot-test:tab-other:1',
  })
  assert.equal(setTargetUserOwnedForTest(service, current, 'checkpoint-current').state, 'user_owned')
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service, 'tab-current')
  assert.equal(snapshot.surfaces['user-view'].state, 'takeover')
  assert.equal(snapshot.surfaces['user-view'].tabId, 'tab-current')
  assert.equal(snapshot.activeWriteSurface, 'user-view')
  assert.ok(snapshot.claims.some((item) => item.tabId === 'tab-current' && item.state === 'user_owned'))
  assert.ok(snapshot.claims.some((item) => item.tabId === 'tab-other' && item.state === 'held'))
})

test('browser lease supervision snapshot keeps background agent occupancy when the current tab is idle', () => {
  const service = createTargetClaimService({ now: () => 1_000 })
  acquireTarget(service, {
    surface: 'agent-view',
    parentTaskId: 'task-agent',
    ownerRunId: 'run-agent',
    tabId: 'tab-agent',
  })
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service, 'tab-user')
  assert.equal(snapshot.activeWriteSurface, 'agent-view')
  assert.equal(snapshot.surfaces['agent-view'].state, 'held')
  assert.equal(snapshot.surfaces['agent-view'].tabId, 'tab-agent')
  assert.equal(snapshot.surfaces['agent-view'].heldBy, 'task-agent')
  assert.equal(snapshot.surfaces['user-view'].state, 'idle')
  assert.ok(snapshot.claims.some((item) => item.tabId === 'tab-agent' && item.state === 'held'))
})

test('browser lease supervision snapshot ignores leftover user_owned claims without a live target', () => {
  const service = createTargetClaimService({ now: () => 1_000 })
  const claim = acquireTarget(service, { parentTaskId: 'task-old', ownerRunId: 'run-old' })
  const owned = setTargetUserOwnedForTest(service, claim, 'checkpoint-old')
  service.replacePhysicalTarget({
    partition: owned.logicalKey.partition,
    tabId: owned.logicalKey.tabId,
    physicalTargetToken: 'boot-test:tab-a:replaced',
    bootIncarnationId: 'boot-test',
  })
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service)
  assert.equal(snapshot.surfaces['user-view'].state, 'idle')
  assert.equal(snapshot.claims.some((item) => item.state === 'user_owned'), false)
})
