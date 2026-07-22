import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBrowserActTool } from '../main/modules/tools/browser-act-tools'

test('research tab actions use the task-owned background tab without presenting it', async () => {
  const calls: string[] = []
  const controller = {
    ensureAgentWorkTab: async (browserTaskId: string, url: string) => {
      calls.push(`ensure:${browserTaskId}:${url}`)
      return { success: true, tabId: 'agent-work-tab' }
    },
    createTab: async () => {
      calls.push('create-user-tab')
      return { success: true, tabId: 'user-tab' }
    },
    getAgentWorkTab: (browserTaskId: string) => browserTaskId === 'browser-task-1' ? 'agent-work-tab' : null,
    switchTab: (tabId: string) => {
      calls.push(`present:${tabId}`)
      return { success: true, tabId }
    },
  }
  const context = {
    controller,
    mutationBoundary: {},
    agentOwnedWorkTab: { browserTaskId: 'browser-task-1' },
    attachBrowserToolOutput: (output: unknown) => output,
  } as unknown as Parameters<typeof executeBrowserActTool>[2]

  const opened = await executeBrowserActTool('tabs_open', { url: 'https://example.test/work' }, context)
  assert.match(String(opened), /agent-work-tab/)
  const switched = await executeBrowserActTool('tabs_switch', { tab_id: 'agent-work-tab' }, context)
  assert.match(String(switched), /"presented": false/)
  assert.deepEqual(calls, ['ensure:browser-task-1:https://example.test/work'])
})
