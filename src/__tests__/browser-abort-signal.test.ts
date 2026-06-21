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
