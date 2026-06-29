import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __browserPowerAuditEventsForTests,
  __clearBrowserPowerPolicyForTests,
  registerBrowserPowerGrant,
} from '../main/modules/browser-engine/browser-power-policy'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { BrowserNetworkEventRecord } from '../main/modules/browser-engine/network-observer-service'
import type { ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function parseOutput(out: string | ToolExecutionOutput): Record<string, unknown> {
  if (typeof out !== 'string') return (out.data || JSON.parse(out.text)) as Record<string, unknown>
  return JSON.parse(out) as Record<string, unknown>
}

function controller(overrides: Partial<BrowserController> = {}): BrowserController {
  return {
    getActiveTab: () => ({ id: 'tab-1', title: 'Example', url: 'https://example.com/page', active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'Example', url: 'https://example.com/page', active: true }] as never,
    executeJS: async () => ({ title: 'Example' }),
    navigate: async () => ({ success: true }) as never,
    startNetworkObserver: async () => ({
      events: () => [],
      getResponseBody: async () => ({ body: '', base64Encoded: false }),
      stop: async () => undefined,
    }) as never,
    ...(overrides || {}),
  } as BrowserController
}

test.beforeEach(() => {
  __clearBrowserPowerPolicyForTests()
})

test('browser_power_eval needs Power authorization and audits successful execution', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-power-tools transitive sqlite load')) return
  const denied = await executeBrowserTool(
    'browser_power_eval',
    { code: 'document.title', purpose: 'read title' },
    controller(),
  )
  assert.equal(parseOutput(denied).errorKind, 'grant_required')

  let ranCode = ''
  const allowed = await executeBrowserTool(
    'browser_power_eval',
    { code: 'document.title', purpose: 'read title' },
    controller({
      executeJS: async (_tabId, code) => {
        ranCode = code
        return 'Example Title'
      },
    }),
    undefined,
    'session-1',
    undefined,
    '用 Power Browser 看一下这个网页',
  )
  const parsed = parseOutput(allowed)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.result, 'Example Title')
  assert.equal(ranCode, 'document.title')
  assert.equal(__browserPowerAuditEventsForTests().length, 1)
})

test('legacy browser_execute_js stays Safe Mode denied unless Power is enabled by user text', async () => {
  const safe = await executeBrowserTool(
    'browser_execute_js',
    { code: 'document.title' },
    controller(),
  )
  assert.equal(parseOutput(safe).errorKind, 'freeform_script_denied')

  const powered = await executeBrowserTool(
    'browser_execute_js',
    { code: 'document.title' },
    controller({ executeJS: async () => 'Powered Title' }),
    undefined,
    'session-1',
    undefined,
    '请用 web-access 的方式嗅探这个网页',
  )
  const parsed = parseOutput(powered)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.tool, 'browser_power_eval')
  assert.equal(parsed.result, 'Powered Title')
})

test('destructive power eval requires an explicit matching grant', async () => {
  const noGrant = await executeBrowserTool(
    'browser_power_eval',
    { code: 'fetch("/pay")', purpose: 'pay', expected_effects: ['payment'] },
    controller(),
    undefined,
    'session-1',
    undefined,
    '用 Power Browser 操作页面',
  )
  assert.equal(parseOutput(noGrant).errorKind, 'grant_required')

  const grant = registerBrowserPowerGrant({
    id: 'grant-payment',
    source: 'test',
    scopeId: 'session-1',
    effects: ['payment'],
    hostname: 'example.com',
    expiresAt: Date.now() + 60_000,
    remainingCalls: 1,
  })
  const allowed = await executeBrowserTool(
    'browser_power_eval',
    { code: '42', purpose: 'pay', expected_effects: ['payment'], grant_id: grant.id },
    controller({ executeJS: async () => 42 }),
    undefined,
    'session-1',
    undefined,
    '用 Power Browser 操作页面',
  )
  assert.equal(parseOutput(allowed).ok, true)
})

test('browser_power_network_trace records bounded events and redacts sensitive headers', async () => {
  const events: BrowserNetworkEventRecord[] = [{
    requestId: 'r1',
    url: 'https://cdn.example.com/video.mp4',
    method: 'GET',
    status: 200,
    mimeType: 'video/mp4',
    resourceType: 'Media',
    responseHeaders: { Cookie: 'secret', 'Content-Type': 'video/mp4' },
  }]
  const out = await executeBrowserTool(
    'browser_power_network_trace',
    { duration_ms: 1, include_response_bodies: true },
    controller({
      startNetworkObserver: async () => ({
        events: () => events,
        getResponseBody: async () => ({ body: 'body', base64Encoded: false }),
        stop: async () => undefined,
      }) as never,
    }),
    undefined,
    'session-1',
    undefined,
    '请监听网络并嗅探视频资源',
  )
  const parsed = parseOutput(out)
  const first = (parsed.events as Array<Record<string, unknown>>)[0]
  assert.equal(parsed.ok, true)
  assert.equal((first.responseHeaders as Record<string, string>).Cookie, '[redacted]')
  assert.equal((parsed.bodies as unknown[]).length, 1)
})
