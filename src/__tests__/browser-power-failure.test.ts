/**
 * P1-A1 (2026-07-03, 7/01 browser reliability contract A1) — Power tool
 * failures return structured JSON that preserves target identity (tabId /
 * currentUrl / origin / frameId) and a class-matched recovery hint, instead
 * of the generic "Error executing browser_power_*" string.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import {
  classifyBrowserPowerFailure,
  browserToolOriginFromUrl,
} from '../main/modules/tools/browser-power-failure'
import { __clearBrowserPowerPolicyForTests } from '../main/modules/browser-engine/browser-power-policy'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

function parseOutput(out: string | ToolExecutionOutput): Record<string, unknown> {
  if (typeof out !== 'string') return (out.data || JSON.parse(out.text)) as Record<string, unknown>
  return JSON.parse(out) as Record<string, unknown>
}

function controller(overrides: Partial<BrowserController> = {}): BrowserController {
  return {
    getActiveTab: () => ({ id: 'tab-1', title: 'XHS', url: 'https://creator.xiaohongshu.com/publish', active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'XHS', url: 'https://creator.xiaohongshu.com/publish', active: true }] as never,
    executeJS: async () => ({ title: 'XHS' }),
    navigate: async () => ({ success: true }) as never,
    ...(overrides || {}),
  } as BrowserController
}

const POWER_TEXT = '用 Power Browser 操作这个页面'

test.beforeEach(() => {
  __clearBrowserPowerPolicyForTests()
})

test('classifyBrowserPowerFailure maps each failure family to a distinct recovery hint', () => {
  assert.equal(classifyBrowserPowerFailure('browser_eval timed out after 8000ms').failureClass, 'timeout')
  assert.equal(classifyBrowserPowerFailure('no active tab for network trace').failureClass, 'target_stale')
  assert.equal(classifyBrowserPowerFailure('Target closed').failureClass, 'target_stale')
  assert.equal(classifyBrowserPowerFailure('browser_power_frame_context_unavailable').failureClass, 'frame_context')
  assert.equal(classifyBrowserPowerFailure('ReferenceError: foo is not defined').failureClass, 'eval_runtime')
  assert.equal(classifyBrowserPowerFailure('something totally unexpected').failureClass, 'unknown')
  // hints are distinct per class
  const hints = new Set([
    classifyBrowserPowerFailure('timed out').nextSuggestedAction,
    classifyBrowserPowerFailure('Target closed').nextSuggestedAction,
    classifyBrowserPowerFailure('isolated world').nextSuggestedAction,
    classifyBrowserPowerFailure('SyntaxError').nextSuggestedAction,
  ])
  assert.equal(hints.size, 4)
})

test('browserToolOriginFromUrl extracts origin and tolerates junk', () => {
  assert.equal(browserToolOriginFromUrl('https://creator.xiaohongshu.com/publish?x=1'), 'https://creator.xiaohongshu.com')
  assert.equal(browserToolOriginFromUrl(''), null)
  assert.equal(browserToolOriginFromUrl('not a url'), null)
})

test('browser_eval failure preserves target identity and a runtime recovery hint', async () => {
  const out = await executeBrowserTool(
    'browser_eval',
    { code: 'boom()', purpose: 'probe editor', world: 'main', tab_id: 'tab-1' },
    controller({ executeJS: async () => { throw new Error('ReferenceError: boom is not defined') } }),
    undefined,
    'session-1',
    undefined,
    POWER_TEXT,
  )
  const parsed = parseOutput(out)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'browser_eval_failed')
  assert.equal(parsed.failureClass, 'eval_runtime')
  assert.equal(parsed.tabId, 'tab-1')
  assert.equal(parsed.currentUrl, 'https://creator.xiaohongshu.com/publish')
  assert.equal(parsed.origin, 'https://creator.xiaohongshu.com')
  assert.match(String(parsed.nextSuggestedAction), /async IIFE|Runtime\.evaluate/)
})

test('browser_cdp failure is structured (no generic thrown string) with frame hint', async () => {
  const out = await executeBrowserTool(
    'browser_cdp',
    { method: 'Runtime.evaluate', purpose: 'probe', params: {}, tab_id: 'tab-1' },
    controller({
      sendCdpCommand: async () => { throw new Error('Cannot find context with specified id') },
    } as Partial<BrowserController>),
    undefined,
    'session-1',
    undefined,
    POWER_TEXT,
  )
  const parsed = parseOutput(out)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'browser_cdp_failed')
  assert.equal(parsed.tabId, 'tab-1')
  assert.equal(parsed.origin, 'https://creator.xiaohongshu.com')
  assert.equal(parsed.method, 'Runtime.evaluate')
  assert.ok(typeof parsed.nextSuggestedAction === 'string' && (parsed.nextSuggestedAction as string).length > 0)
})

test('browser_resources failure is structured, not a thrown string', async () => {
  const out = await executeBrowserTool(
    'browser_resources',
    { include_response_bodies: true, purpose: 'sniff', kinds: ['video'], tab_id: 'tab-1' },
    controller({
      startNetworkObserver: async () => { throw new Error('observer attach timed out') },
      executeJS: async () => { throw new Error('observer attach timed out') },
    } as Partial<BrowserController>),
    undefined,
    'session-1',
    undefined,
    POWER_TEXT,
  )
  const parsed = parseOutput(out)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'browser_resources_failed')
  assert.equal(parsed.tabId, 'tab-1')
  assert.ok(typeof parsed.nextSuggestedAction === 'string')
})
