import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __clearBrowserPowerPolicyForTests,
  browserPowerModeEnabled,
  browserToolEffectProfile,
  inferBrowserPowerEffects,
  registerBrowserPowerGrant,
  resolveBrowserPowerAuthorization,
  setBrowserPowerGlobalModeReader,
} from '../main/modules/browser-engine/browser-power-policy'
import {
  BROWSER_CONTENT_TASK_TOOL_NAMES,
  BROWSER_INTERACTION_TOOL_NAMES,
} from '../main/modules/tools/browser-tool-catalog'

test.beforeEach(() => {
  __clearBrowserPowerPolicyForTests()
})

test('Power mode is enabled by explicit current-user browser resource intent', () => {
  assert.equal(browserPowerModeEnabled('帮我嗅探并下载这个网页里的视频'), true)
  assert.equal(browserPowerModeEnabled('普通闲聊'), false)
})

test('Power mode can be enabled by the global settings reader', () => {
  setBrowserPowerGlobalModeReader(() => true)
  assert.equal(browserPowerModeEnabled('普通闲聊'), true)
})

test('non-destructive Power effects can be allowed by current user text', () => {
  const decision = resolveBrowserPowerAuthorization({
    toolName: 'browser_eval',
    effects: ['observe', 'page_mutation'],
    currentUserText: '用 web-access / Power Browser 帮我看一下这个页面',
  })
  assert.equal(decision.action, 'allow')
  assert.equal(decision.grantId, 'current-user-nondestructive-power')
})

test('destructive Power effects require a matching code-owned grant', () => {
  const denied = resolveBrowserPowerAuthorization({
    toolName: 'browser_eval',
    effects: ['payment'],
    currentUserText: '用 Power Browser 操作这个页面',
  })
  assert.equal(denied.action, 'grant_required')

  const grant = registerBrowserPowerGrant({
    id: 'grant-pay',
    source: 'test',
    effects: ['payment'],
    hostname: 'example.com',
    expiresAt: Date.now() + 60_000,
    remainingCalls: 1,
  })
  const allowed = resolveBrowserPowerAuthorization({
    toolName: 'browser_eval',
    effects: ['payment'],
    grantId: grant.id,
    url: 'https://checkout.example.com/pay',
  })
  assert.equal(allowed.action, 'allow')

  const exhausted = resolveBrowserPowerAuthorization({
    toolName: 'browser_eval',
    effects: ['payment'],
    grantId: grant.id,
    url: 'https://checkout.example.com/pay',
  })
  assert.equal(exhausted.action, 'grant_mismatch')
  assert.equal(exhausted.reason, 'grant_exhausted')
})

test('obfuscated eval and unknown CDP methods fail into an explicitly privileged effect', () => {
  assert.deepEqual(inferBrowserPowerEffects({
    toolName: 'browser_eval',
    args: { code: "globalThis[['f','e','t','c','h'].join('')]('/checkout',{method:'POST'})" },
  }), ['observe', 'access_control_circumvention'])
  assert.deepEqual(inferBrowserPowerEffects({
    toolName: 'browser_cdp',
    args: { method: 'Experimental.doAnything', params: {} },
  }), ['access_control_circumvention'])
})

test('a bound Power grant fails closed when scope, tab, or destination is omitted', () => {
  const grant = registerBrowserPowerGrant({
    id: 'grant-bound',
    source: 'test',
    scopeId: 'scope-1',
    tabId: 'tab-1',
    destination: '/tmp/export.json',
    effects: ['secret_export'],
    expiresAt: Date.now() + 60_000,
    remainingCalls: 1,
  })
  for (const partial of [
    { scopeId: undefined, tabId: 'tab-1', destination: '/tmp/export.json' },
    { scopeId: 'scope-1', tabId: undefined, destination: '/tmp/export.json' },
    { scopeId: 'scope-1', tabId: 'tab-1', destination: undefined },
  ]) {
    const result = resolveBrowserPowerAuthorization({
      toolName: 'browser_eval',
      effects: ['secret_export'],
      grantId: grant.id,
      ...partial,
    })
    assert.equal(result.action, 'grant_mismatch')
  }
})

test('one-shot Power grants bind scope, run, task, tab, document, object, origin, destination, and effects', () => {
  const grant = registerBrowserPowerGrant({
    id: 'grant-exact-object',
    source: 'test',
    scopeId: 'scope-1',
    runId: 'run-1',
    taskId: 'task-1',
    tabId: 'tab-1',
    documentKeyHash: 'document-hash-1',
    objectRef: 'object-hash-1',
    hostname: 'example.com',
    destination: '/safe/export.json',
    effects: ['secret_export'],
    expiresAt: Date.now() + 60_000,
    remainingCalls: 1,
  })
  const exact = {
    toolName: 'browser_eval',
    effects: ['secret_export'] as Array<'secret_export'>,
    grantId: grant.id,
    scopeId: 'scope-1',
    runId: 'run-1',
    taskId: 'task-1',
    tabId: 'tab-1',
    documentKeyHash: 'document-hash-1',
    objectRef: 'object-hash-1',
    url: 'https://example.com/account',
    destination: '/safe/export.json',
  }
  for (const mismatch of [
    { scopeId: 'scope-2' },
    { runId: 'run-2' },
    { taskId: 'task-2' },
    { tabId: 'tab-2' },
    { documentKeyHash: 'document-hash-2' },
    { objectRef: 'object-hash-2' },
    { url: 'https://other.test/account' },
    { destination: '/safe/other.json' },
    { effects: ['payment'] as Array<'payment'> },
  ]) {
    const decision = resolveBrowserPowerAuthorization({ ...exact, ...mismatch })
    assert.equal(decision.action, 'grant_mismatch')
  }
  assert.equal(resolveBrowserPowerAuthorization(exact).action, 'allow')
  assert.equal(resolveBrowserPowerAuthorization(exact).action, 'grant_mismatch')
})

test('every registered browser tool has a Power effect profile', () => {
  for (const name of [...BROWSER_INTERACTION_TOOL_NAMES, ...BROWSER_CONTENT_TASK_TOOL_NAMES]) {
    const profile = browserToolEffectProfile(name)
    assert.ok(profile, `${name} missing browser power effect profile`)
    assert.ok(profile.effects.length > 0, `${name} profile has no effects`)
  }
})
