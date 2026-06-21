import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-abort-signal declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-abort-signal transitive sqlite load')
})

test('browser tool abort signal rethrows instead of returning an error string', async () => {
  const controller = {
    getActiveTab: () => null,
  } as unknown as BrowserController
  const abort = new AbortController()
  abort.abort()

  await assert.rejects(
    () => executeBrowserTool('browser_get_task', { task_id: 'browser-task-1' }, controller, abort.signal),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
})

test('browser_query_gemini rethrows mid-execution abort instead of formatting fallback text', async () => {
  const abortError = new Error('mid execution abort')
  abortError.name = 'AbortError'
  const controller = {
    getActiveTab: () => ({ id: 'tab-gemini', url: 'https://gemini.google.com', active: true }),
    getTabList: () => [{ id: 'tab-gemini', url: 'https://gemini.google.com', active: true }],
    executeJS: async () => {
      throw abortError
    },
  } as unknown as BrowserController

  await assert.rejects(
    () => executeBrowserTool(
      'browser_query_gemini',
      { text: 'hello', tab_id: 'tab-gemini', wait_response_ms: 6000 },
      controller,
    ),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
})
