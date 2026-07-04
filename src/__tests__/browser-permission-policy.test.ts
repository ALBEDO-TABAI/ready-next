import assert from 'node:assert/strict'
import test from 'node:test'

import {
  consumePendingBrowserSitePermissionNotices,
  recordAgentAutoDeniedSitePermission,
  resolveBrowserPermissionPath,
} from '../main/modules/browser-engine/browser-permission-policy'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-permission-policy declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-permission-policy transitive sqlite load')
})

// 真机第十二轮实锚（XHS 发布页定位请求）：站点权限 modal sheet 在无人值守
// run 里既挂住站点回调也挡住整个 Ready 窗口。合同：agent 持浏览器写租约
// 期间，需人工批准的权限请求自动拒绝（不弹窗、不缓存判决、留注记），用户
// 在场的既有判决优先于 agent 自动拒绝。

const URL_XHS = 'https://creator.xiaohongshu.com/publish/publish'

test('agent driving + approval-required permission → agent_auto_deny', () => {
  assert.strictEqual(
    resolveBrowserPermissionPath({
      permission: 'geolocation',
      requestingUrl: URL_XHS,
      cachedDecision: undefined,
      agentDriveActive: true,
    }),
    'agent_auto_deny',
  )
})

test('attended (no agent drive) approval-required permission → prompt', () => {
  assert.strictEqual(
    resolveBrowserPermissionPath({
      permission: 'geolocation',
      requestingUrl: URL_XHS,
      cachedDecision: undefined,
      agentDriveActive: false,
    }),
    'prompt',
  )
})

test('a runtime decision made by the user wins over agent auto-deny', () => {
  assert.strictEqual(
    resolveBrowserPermissionPath({
      permission: 'geolocation',
      requestingUrl: URL_XHS,
      cachedDecision: true,
      agentDriveActive: true,
    }),
    'cached_allow',
  )
  assert.strictEqual(
    resolveBrowserPermissionPath({
      permission: 'geolocation',
      requestingUrl: URL_XHS,
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
      requestingUrl: URL_XHS,
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
      requestingUrl: URL_XHS,
      cachedDecision: undefined,
      agentDriveActive: true,
    }),
    'auto_allow',
  )
})

test('auto-denied notices queue, drain once, and cap at 8', () => {
  consumePendingBrowserSitePermissionNotices()
  recordAgentAutoDeniedSitePermission('geolocation', 'creator.xiaohongshu.com')
  const drained = consumePendingBrowserSitePermissionNotices()
  assert.strictEqual(drained.length, 1)
  assert.strictEqual(drained[0]?.kind, 'site_permission_auto_denied')
  assert.strictEqual(drained[0]?.permission, 'geolocation')
  assert.strictEqual(drained[0]?.origin, 'creator.xiaohongshu.com')
  assert.ok(drained[0]?.guidance.includes('自动拒绝'))
  assert.deepStrictEqual(consumePendingBrowserSitePermissionNotices(), [])

  for (let i = 0; i < 12; i += 1) {
    recordAgentAutoDeniedSitePermission('notifications', `origin-${i}`)
  }
  const capped = consumePendingBrowserSitePermissionNotices()
  assert.strictEqual(capped.length, 8)
  assert.strictEqual(capped[0]?.origin, 'origin-4')
  assert.strictEqual(capped[7]?.origin, 'origin-11')
})
