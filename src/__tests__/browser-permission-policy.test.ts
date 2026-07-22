import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BrowserSitePermissionRequestStore,
  resolveAgentPermissionRequestBinding,
  resolveBrowserPermissionPath,
  type BrowserPermissionRequestBinding,
} from '../main/modules/browser-engine/browser-permission-policy'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-permission-policy declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-permission-policy transitive sqlite load')
})

const TEST_URL = 'https://example.test/workflow'

test('agent driving + approval-required permission → exact typed suspension', () => {
  assert.strictEqual(
    resolveBrowserPermissionPath({
      permission: 'geolocation',
      requestingUrl: TEST_URL,
      cachedDecision: undefined,
      agentDriveActive: true,
    }),
    'agent_suspend',
  )
})

test('attended (no agent drive) approval-required permission → prompt', () => {
  assert.strictEqual(
    resolveBrowserPermissionPath({
      permission: 'geolocation',
      requestingUrl: TEST_URL,
      cachedDecision: undefined,
      agentDriveActive: false,
    }),
    'prompt',
  )
})

test('a runtime decision made by the user wins over a new suspension', () => {
  assert.strictEqual(
    resolveBrowserPermissionPath({
      permission: 'geolocation',
      requestingUrl: TEST_URL,
      cachedDecision: true,
      agentDriveActive: true,
    }),
    'cached_allow',
  )
  assert.strictEqual(
    resolveBrowserPermissionPath({
      permission: 'geolocation',
      requestingUrl: TEST_URL,
      cachedDecision: false,
      agentDriveActive: true,
    }),
    'cached_deny',
  )
})

test('unsupported permission is denied regardless of agent state', () => {
  assert.strictEqual(
    resolveBrowserPermissionPath({
      permission: 'usb',
      requestingUrl: TEST_URL,
      cachedDecision: undefined,
      agentDriveActive: true,
    }),
    'unsupported_deny',
  )
})

test('auto-grant class (fullscreen) stays allowed while agent drives', () => {
  assert.strictEqual(
    resolveBrowserPermissionPath({
      permission: 'fullscreen',
      requestingUrl: TEST_URL,
      cachedDecision: undefined,
      agentDriveActive: true,
    }),
    'auto_allow',
  )
})

function binding(overrides: Partial<BrowserPermissionRequestBinding> = {}): BrowserPermissionRequestBinding {
  return {
    partition: 'persist:browser',
    parentTaskId: 'parent-1',
    ownerRunId: 'run-1',
    browserTaskId: 'browser-task-1',
    surface: 'user-view',
    scopeId: 'scope-1',
    profileId: null,
    sessionId: null,
    tabId: 'tab-1',
    physicalTargetToken: 'physical-1',
    bootIncarnationId: 'boot-1',
    claimId: 'claim-1',
    generation: 1,
    ...overrides,
  }
}

test('agent suspension requires the claim for the exact bound physical tab and owner', () => {
  const target = binding()
  const exact = resolveAgentPermissionRequestBinding({
    partition: target.partition,
    tabId: target.tabId,
    physicalTargetToken: target.physicalTargetToken,
    workflowTarget: target,
    admittedTarget: target,
  })
  assert.deepEqual(exact, target)
  assert.equal(resolveAgentPermissionRequestBinding({
    partition: target.partition,
    tabId: target.tabId,
    physicalTargetToken: target.physicalTargetToken,
    workflowTarget: target,
    admittedTarget: binding({ tabId: 'tab-2' }),
  }), null, 'a claim on another tab must not suspend this tab permission request')
  assert.equal(resolveAgentPermissionRequestBinding({
    partition: target.partition,
    tabId: target.tabId,
    physicalTargetToken: target.physicalTargetToken,
    workflowTarget: target,
    admittedTarget: binding({ ownerRunId: 'another-owner-run' }),
  }), null, 'a claim held by another owner must not suspend this request')
})

test('pending requests and notices stay partition/tab/workflow scoped', () => {
  const ids = ['request-a', 'request-b']
  const store = new BrowserSitePermissionRequestStore({ generateId: () => ids.shift()! })
  const firstTarget = binding()
  const secondTarget = binding({
    partition: 'persist:browser-profile-work',
    tabId: 'tab-2',
    physicalTargetToken: 'physical-2',
    parentTaskId: 'parent-2',
    ownerRunId: 'run-2',
    browserTaskId: 'browser-task-2',
    scopeId: 'scope-2',
  })
  store.queue({
    permission: 'geolocation',
    origin: 'https://example.test',
    requestingUrl: TEST_URL,
    target: firstTarget,
    callback: () => {},
  })
  store.queue({
    permission: 'geolocation',
    origin: 'https://example.test',
    requestingUrl: TEST_URL,
    target: secondTarget,
    callback: () => {},
  })
  const firstNotices = store.consumeNotices(firstTarget, () => true)
  assert.deepEqual(firstNotices.map((notice) => notice.requestId), ['request-a'])
  assert.deepEqual(store.consumeNotices(firstTarget, () => true), [])
  assert.deepEqual(store.consumeNotices(secondTarget, () => true).map((notice) => notice.requestId), ['request-b'])
})

test('exact request apply has an exact readback while a restarted store reports expired', () => {
  let callbackValue: boolean | null = null
  const target = binding()
  const store = new BrowserSitePermissionRequestStore({ generateId: () => 'request-live' })
  store.queue({
    permission: 'geolocation',
    origin: 'https://example.test',
    requestingUrl: TEST_URL,
    target,
    callback: (allowed) => { callbackValue = allowed },
  })
  const applied = store.apply('request-live', 'allow', () => true)
  assert.equal(callbackValue, true)
  assert.equal(applied.state, 'applied')
  assert.equal(applied.applied, true)
  assert.equal(applied.decision, 'allow')
  assert.deepEqual(applied.target, target)
  assert.deepEqual(store.read('request-live', () => true), applied)

  const restarted = new BrowserSitePermissionRequestStore()
  const expired = restarted.read('request-live', () => true)
  assert.equal(expired.state, 'expired')
  assert.equal(expired.applied, false)
  assert.equal(expired.target, null)
})
