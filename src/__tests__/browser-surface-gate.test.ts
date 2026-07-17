import assert from 'node:assert/strict'
import test from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-surface-gate declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-surface-gate transitive sqlite load')
})

function controller(): BrowserController & { goBackCalls: number } {
  const mock: Partial<BrowserController> & { goBackCalls: number } = {
    goBackCalls: 0,
    getActiveTab: () => ({ id: 'tab-1', title: 'T', url: 'https://example.test', active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'T', url: 'https://example.test', active: true }],
    getPageContent: async () => 'page text',
    goBack() {
      this.goBackCalls += 1
      return { success: true }
    },
  }
  return mock as BrowserController & { goBackCalls: number }
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

test('tool-executor refuses browser writes without a code-derived turn surface', async () => {
  const c = controller()
  const out = await executeToolCall('browser_navigate', { action: 'back' }, ctx(c))
  assert.match(textOf(out), /browser_surface_undeclared/)
  assert.equal(c.goBackCalls, 0, 'browser write must not dispatch without a surface binding')
})

test('tool-executor allows browser reads without a write surface', async () => {
  const out = await executeToolCall('browser_read', {}, ctx(controller()))
  assert.match(textOf(out), /page text/)
})
