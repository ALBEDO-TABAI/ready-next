import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  __clearBrowserPowerPolicyForTests,
  inferBrowserPowerEffects,
} from '../main/modules/browser-engine/browser-power-policy'
import { browserSnapshotService } from '../main/modules/browser-engine/browser-snapshot-service'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { attachBrowserWorkflowFixture } from './utils/browser-workflow-fixture'

function dataOf(result: Awaited<ReturnType<typeof executeBrowserTool>>): Record<string, unknown> {
  if (typeof result === 'string') return JSON.parse(result) as Record<string, unknown>
  return result.data || JSON.parse(result.text) as Record<string, unknown>
}

function controllerFixture() {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  let backCalls = 0
  const fixture = attachBrowserWorkflowFixture({
    getActiveTab: () => ({ id: 'tab-1', url: 'https://example.test/form', title: 'Form', active: true }),
    getTabList: () => [{ id: 'tab-1', url: 'https://example.test/form', title: 'Form', active: true }],
    sendCdpCommand: async (_tabId: string | null, method: string, params?: Record<string, unknown>) => {
      commands.push({ method, params })
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (method === 'Runtime.evaluate') return { result: { value: true } }
      return { ok: true }
    },
    goBack: () => {
      backCalls += 1
      return { success: true }
    },
  } as unknown as BrowserController)
  return { ...fixture, commands, getBackCalls: () => backCalls }
}

test.beforeEach(() => __clearBrowserPowerPolicyForTests())

test('eval and CDP effects are inferred from code and method, not model claims', () => {
  assert.deepEqual(inferBrowserPowerEffects({
    toolName: 'browser_eval',
    args: { code: 'document.querySelector("input").value = "x"', expected_effects: ['observe'] },
  }), ['observe', 'page_mutation', 'access_control_circumvention'])
  assert.deepEqual(inferBrowserPowerEffects({
    toolName: 'browser_cdp',
    args: { method: 'Network.getAllCookies', expected_effects: ['observe'] },
  }), ['observe', 'secret_export'])
})

test('model-claimed observe-only effects cannot unlock secret export', async () => {
  const fixture = controllerFixture()
  const result = dataOf(await executeBrowserTool('browser_eval', {
    code: 'JSON.stringify(document.cookie)',
    purpose: 'read cookies',
    expected_effects: ['observe'],
  }, fixture.controller, undefined, undefined, undefined, undefined, undefined, fixture.context))
  assert.equal(result.errorKind, 'grant_required')
  assert.equal(fixture.commands.length, 0)
})

test('cookie-reading CDP methods require a grant before the command is sent', async () => {
  const fixture = controllerFixture()
  const result = dataOf(await executeBrowserTool('browser_cdp', {
    method: 'Network.getAllCookies',
    params: {},
    purpose: 'inspect cookies',
  }, fixture.controller, undefined, undefined, undefined, undefined, undefined, fixture.context))
  assert.equal(result.errorKind, 'grant_required')
  assert.equal(fixture.commands.length, 0)
})

test('ordinary page mutation remains available without a domain blacklist', async () => {
  const fixture = controllerFixture()
  await browserSnapshotService.capture(
    fixture.controller,
    'tab-1',
    10_000,
    async () => ({ pageMap: { targets: [] } }),
    { force: true },
  )
  const result = dataOf(await executeBrowserTool(
    'browser_navigate',
    { action: 'back', tab_id: 'tab-1' },
    fixture.controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fixture.context,
  ))
  assert.equal(result.errorKind, undefined, JSON.stringify(result))
  assert.equal(fixture.getBackCalls(), 1)
  assert.equal(fixture.commands.length, 0)
})
