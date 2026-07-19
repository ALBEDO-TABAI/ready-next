import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { attachBrowserWorkflowFixture } from './utils/browser-workflow-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-abort-signal declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-abort-signal transitive sqlite load')
})

test('pre-aborted browser write returns a structured cancellation result', async () => {
  const fixture = attachBrowserWorkflowFixture({
    getActiveTab: () => null,
    getTabList: () => [],
  } as unknown as BrowserController)
  const abort = new AbortController()
  abort.abort()

  const output = await executeBrowserTool(
    'browser_navigate',
    { action: 'reload' },
    fixture.controller,
    abort.signal,
    undefined,
    undefined,
    undefined,
    undefined,
    fixture.context,
  )
  assert.equal(typeof output === 'string' ? null : output.data?.errorKind, 'origin_budget_aborted')
})

test('browser tool execution rethrows a mid-execution AbortError instead of formatting fallback text', async () => {
  const abortError = new Error('mid execution abort')
  abortError.name = 'AbortError'
  const fixture = attachBrowserWorkflowFixture({
    getActiveTab: () => ({ id: 'tab-gemini', url: 'https://gemini.google.com', active: true }),
    getTabList: () => [{ id: 'tab-gemini', url: 'https://gemini.google.com', active: true }],
    getPageContent: async () => {
      throw abortError
    },
  } as unknown as BrowserController)

  await assert.rejects(
    () => executeBrowserTool(
      'browser_read',
      { tab_id: 'tab-gemini' },
      fixture.controller,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fixture.context,
    ),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
})
