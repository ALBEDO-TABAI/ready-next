import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __clearBrowserPowerPolicyForTests,
  browserPowerModeEnabled,
  browserToolEffectProfile,
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
    toolName: 'browser_power_eval',
    effects: ['observe', 'page_mutation'],
    currentUserText: '用 web-access / Power Browser 帮我看一下这个页面',
  })
  assert.equal(decision.action, 'allow')
  assert.equal(decision.grantId, 'current-user-nondestructive-power')
})

test('destructive Power effects require a matching code-owned grant', () => {
  const denied = resolveBrowserPowerAuthorization({
    toolName: 'browser_power_eval',
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
    toolName: 'browser_power_eval',
    effects: ['payment'],
    grantId: grant.id,
    url: 'https://checkout.example.com/pay',
  })
  assert.equal(allowed.action, 'allow')

  const exhausted = resolveBrowserPowerAuthorization({
    toolName: 'browser_power_eval',
    effects: ['payment'],
    grantId: grant.id,
    url: 'https://checkout.example.com/pay',
  })
  assert.equal(exhausted.action, 'grant_mismatch')
  assert.equal(exhausted.reason, 'grant_exhausted')
})

test('every registered browser tool has a Power effect profile', () => {
  for (const name of [...BROWSER_INTERACTION_TOOL_NAMES, ...BROWSER_CONTENT_TASK_TOOL_NAMES]) {
    const profile = browserToolEffectProfile(name)
    assert.ok(profile, `${name} missing browser power effect profile`)
    assert.ok(profile.effects.length > 0, `${name} profile has no effects`)
  }
})
