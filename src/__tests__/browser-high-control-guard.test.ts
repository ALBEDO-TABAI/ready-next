import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { __clearBrowserPowerPolicyForTests } from '../main/modules/browser-engine/browser-power-policy'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { attachBrowserWorkflowFixture } from './utils/browser-workflow-fixture'

function dataOf(result: Awaited<ReturnType<typeof executeBrowserTool>>): Record<string, unknown> {
  if (typeof result === 'string') return JSON.parse(result) as Record<string, unknown>
  return result.data || JSON.parse(result.text) as Record<string, unknown>
}

function powerController() {
  const commands: string[] = []
  const fixture = attachBrowserWorkflowFixture({
    getActiveTab: () => ({ id: 'tab-power', title: 'Fixture', url: 'https://example.test/page', active: true }),
    getTabList: () => [{ id: 'tab-power', title: 'Fixture', url: 'https://example.test/page', active: true }],
    sendCdpCommand: async (_tabId: string | null, method: string) => {
      commands.push(method)
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-main' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method === 'Runtime.evaluate') return { result: { value: 'Fixture' } }
      return {}
    },
  } as unknown as BrowserController)
  return { ...fixture, commands }
}

test.beforeEach(() => __clearBrowserPowerPolicyForTests())

test('browser_eval requires its exact capability grant without consulting a site list or prose label', async () => {
  const fixture = powerController()
  const result = dataOf(await executeBrowserTool('browser_eval', {
    code: 'document.title',
    purpose: 'read the current title',
    tab_id: 'tab-power',
  }, fixture.controller, undefined, 'scope-power', undefined, undefined, undefined, fixture.context))

  assert.equal(result.errorKind, 'grant_required')
  assert.deepEqual(fixture.commands, [])
})

test('a dangerous-looking purpose follows the same typed grant boundary', async () => {
  const fixture = powerController()
  const result = dataOf(await executeBrowserTool('browser_eval', {
    code: 'JSON.stringify({ cookie: document.cookie, storage: localStorage })',
    purpose: 'export browser secrets',
    tab_id: 'tab-power',
  }, fixture.controller, undefined, 'scope-power', undefined, undefined, undefined, fixture.context))

  assert.equal(result.errorKind, 'grant_required')
  assert.deepEqual(fixture.commands, [])
})

test('removed script and workflow entrypoints stay unavailable instead of becoming domain exceptions', async () => {
  const fixture = powerController()
  for (const name of ['browser_execute_js', 'browser_run_workflow', 'browser_confirm_collection_consent']) {
    const result = dataOf(await executeBrowserTool(name, {}, fixture.controller))
    assert.equal(result.errorKind, 'tool_not_registered', name)
  }
})
