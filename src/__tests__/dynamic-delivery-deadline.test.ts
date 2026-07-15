import assert from 'node:assert/strict'
import test from 'node:test'

import {
  armDynamicDeliveryDeadline,
  resolveDynamicDeliveryWallClockMs,
} from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-deadline'

test('delivery wall-clock budgets are explicit and stay below the hard cap', () => {
  assert.equal(resolveDynamicDeliveryWallClockMs('standard'), null)
  assert.equal(resolveDynamicDeliveryWallClockMs('adaptive'), 120_000)
  assert.equal(resolveDynamicDeliveryWallClockMs('adaptive', 'tag_forge_folder_batch'), 240_000)
  assert.equal(resolveDynamicDeliveryWallClockMs('thorough'), 240_000)
})

test('delivery deadline is a rolling no-progress window and successful progress refreshes it', async () => {
  const abortController = new AbortController()
  const runHandle = { abortInitiator: null } as Parameters<typeof armDynamicDeliveryDeadline>[0]['runHandle']
  const deadline = armDynamicDeliveryDeadline({
    mode: 'thorough',
    runId: 'run-deadline',
    abortController,
    runHandle,
    timeoutMsForTest: 30,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  deadline.noteProgress('tool_result')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(abortController.signal.aborted, false, 'the stale first timer must not abort after progress')
  await new Promise<void>((resolve) => abortController.signal.addEventListener('abort', () => resolve(), { once: true }))
  deadline.dispose()

  assert.equal(runHandle.abortInitiator, 'timeout')
  assert.equal((abortController.signal.reason as Error).name, 'AbortError')
  assert.equal((abortController.signal.reason as Error).message, 'delivery_wall_clock_exceeded')
})

test('delivery deadline stays suspended while the run is awaiting user input', async () => {
  const abortController = new AbortController()
  const runHandle = { abortInitiator: null } as Parameters<typeof armDynamicDeliveryDeadline>[0]['runHandle']
  let awaiting = true
  const deadline = armDynamicDeliveryDeadline({
    mode: 'adaptive',
    runId: 'run-awaiting-user',
    abortController,
    runHandle,
    timeoutMsForTest: 20,
    isAwaitingUserInput: () => awaiting,
  })
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.equal(abortController.signal.aborted, false)
  awaiting = false
  await new Promise<void>((resolve) => abortController.signal.addEventListener('abort', () => resolve(), { once: true }))
  deadline.dispose()
  assert.equal((abortController.signal.reason as Error).message, 'delivery_wall_clock_exceeded')
})
