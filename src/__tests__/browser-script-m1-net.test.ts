import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  __clearBrowserPowerPolicyForTests,
  inferBrowserPowerEffects,
} from '../main/modules/browser-engine/browser-power-policy'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'

function dataOf(result: Awaited<ReturnType<typeof executeBrowserTool>>): Record<string, unknown> {
  if (typeof result === 'string') return JSON.parse(result) as Record<string, unknown>
  return result.data || JSON.parse(result.text) as Record<string, unknown>
}

function controllerFixture() {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', url: 'https://example.test/form', title: 'Form', active: true }),
    getTabList: () => [{ id: 'tab-1', url: 'https://example.test/form', title: 'Form', active: true }],
    sendCdpCommand: async (_tabId: string | null, method: string, params?: Record<string, unknown>) => {
      commands.push({ method, params })
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (method === 'Runtime.evaluate') return { result: { value: true } }
      return { ok: true }
    },
  } as unknown as BrowserController
  return { controller, commands }
}

test.beforeEach(() => __clearBrowserPowerPolicyForTests())

test('eval and CDP effects are inferred from code and method, not model claims', () => {
  assert.deepEqual(inferBrowserPowerEffects({
    toolName: 'browser_eval',
    args: { code: 'document.querySelector("input").value = "x"', expected_effects: ['observe'] },
  }), ['observe', 'page_mutation'])
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
  }, fixture.controller))
  assert.equal(result.errorKind, 'grant_required')
  assert.equal(fixture.commands.length, 0)
})

test('cookie-reading CDP methods require a grant before the command is sent', async () => {
  const fixture = controllerFixture()
  const result = dataOf(await executeBrowserTool('browser_cdp', {
    method: 'Network.getAllCookies',
    params: {},
    purpose: 'inspect cookies',
  }, fixture.controller))
  assert.equal(result.errorKind, 'grant_required')
  assert.equal(fixture.commands.length, 0)
})

test('ordinary page mutation remains available without a domain blacklist', async () => {
  const fixture = controllerFixture()
  const result = dataOf(await executeBrowserTool('browser_eval', {
    code: 'document.querySelector("input")?.focus()',
    purpose: 'focus the requested field',
  }, fixture.controller))
  assert.equal(result.ok, true)
  assert.ok(fixture.commands.some((entry) => entry.method === 'Runtime.evaluate'))
})
