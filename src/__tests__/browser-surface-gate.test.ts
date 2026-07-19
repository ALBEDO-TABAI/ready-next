import assert from 'node:assert/strict'
import test from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-surface-gate declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-surface-gate transitive sqlite load')
})

function controller(): BrowserController & { goBackCalls: number; readCalls: number } {
  const mock: Partial<BrowserController> & { goBackCalls: number; readCalls: number } = {
    goBackCalls: 0,
    readCalls: 0,
    getActiveTab: () => ({ id: 'tab-1', title: 'T', url: 'https://example.test', active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'T', url: 'https://example.test', active: true }],
    getPageContent: async function () {
      this.readCalls += 1
      return 'page text'
    },
    executeJS: async () => ({ blocked: false, blockerCount: 0, matchedKinds: [] }),
    goBack() {
      this.goBackCalls += 1
      return { success: true }
    },
  }
  return mock as BrowserController & { goBackCalls: number; readCalls: number }
}

function ctx(browserController: BrowserController): ToolContext {
  return {
    browserController,
    allowedToolNames: null,
    sessionId: 'surface-gate-session',
    runId: 'surface-gate-run',
  }
}

function textOf(out: unknown): string {
  const value = out as { text?: unknown; output?: unknown }
  if (typeof value.text === 'string') return value.text
  if (typeof value.output === 'string') return value.output
  return typeof out === 'string' ? out : JSON.stringify(out)
}

test('tool-executor refuses browser writes without a durable workflow route', async () => {
  const c = controller()
  const out = await executeToolCall('browser_navigate', { action: 'back' }, ctx(c))
  assert.match(textOf(out), /browser_workflow_route_required/)
  assert.equal(c.goBackCalls, 0, 'browser write must not dispatch without a workflow route')
})

test('tool-executor refuses browser reads without the same durable workflow route', async () => {
  const c = controller()
  const out = await executeToolCall('browser_read', {}, ctx(c))
  assert.match(textOf(out), /browser_workflow_route_required/)
  assert.equal(c.readCalls, 0, 'browser read must not dispatch without a workflow route')
})
