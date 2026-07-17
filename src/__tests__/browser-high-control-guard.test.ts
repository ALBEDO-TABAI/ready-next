import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { __clearBrowserPowerPolicyForTests } from '../main/modules/browser-engine/browser-power-policy'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'

function dataOf(result: Awaited<ReturnType<typeof executeBrowserTool>>): Record<string, unknown> {
  if (typeof result === 'string') return JSON.parse(result) as Record<string, unknown>
  return result.data || JSON.parse(result.text) as Record<string, unknown>
}

function xhsController() {
  const commands: string[] = []
  const controller = {
    getActiveTab: () => ({ id: 'tab-xhs', title: '小红书', url: 'https://www.xiaohongshu.com/explore', active: true }),
    getTabList: () => [{ id: 'tab-xhs', title: '小红书', url: 'https://www.xiaohongshu.com/explore', active: true }],
    sendCdpCommand: async (_tabId: string | null, method: string) => {
      commands.push(method)
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-main' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method === 'Runtime.evaluate') return { result: { value: '小红书' } }
      return {}
    },
  } as unknown as BrowserController
  return { controller, commands }
}

test.beforeEach(() => __clearBrowserPowerPolicyForTests())

test('high-control domains do not disable nondestructive browser_eval', async () => {
  const fixture = xhsController()
  const result = dataOf(await executeBrowserTool('browser_eval', {
    code: 'document.title',
    purpose: 'read the current title',
    tab_id: 'tab-xhs',
  }, fixture.controller, undefined, 'scope-xhs', undefined, '请读取当前页面标题'))

  assert.equal(result.ok, true)
  assert.equal(result.result, '小红书')
  assert.deepEqual(fixture.commands, ['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate'])
})

test('the same domain still requires a grant for secret export', async () => {
  const fixture = xhsController()
  const result = dataOf(await executeBrowserTool('browser_eval', {
    code: 'JSON.stringify({ cookie: document.cookie, storage: localStorage })',
    purpose: 'export browser secrets',
    tab_id: 'tab-xhs',
  }, fixture.controller, undefined, 'scope-xhs', undefined, '导出当前登录秘密'))

  assert.equal(result.errorKind, 'grant_required')
  assert.deepEqual(fixture.commands, [])
})

test('removed script and workflow entrypoints stay unavailable instead of becoming domain exceptions', async () => {
  const fixture = xhsController()
  for (const name of ['browser_execute_js', 'browser_run_workflow', 'browser_confirm_collection_consent']) {
    const result = dataOf(await executeBrowserTool(name, {}, fixture.controller))
    assert.equal(result.errorKind, 'tool_not_registered', name)
  }
})
