import assert from 'node:assert/strict'
import test from 'node:test'

import { throwIfAbortSignalAborted } from '../main/modules/agent-control/runtime-core/agent-sdk-execution-utils'

test('a provider that settles after abort cannot be reported as a normal completion', () => {
  const abortController = new AbortController()
  abortController.abort(new Error('delivery_wall_clock_exceeded'))
  assert.throws(
    () => throwIfAbortSignalAborted(abortController.signal),
    (error: unknown) => error instanceof Error
      && error.name === 'AbortError'
      && error.message === 'delivery_wall_clock_exceeded',
  )
})
