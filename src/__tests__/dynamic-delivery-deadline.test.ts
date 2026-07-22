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
  const deadline = armDynamicDeliveryDeadline({
    mode: 'adaptive',
    runId: 'run-awaiting-user',
    abortController,
    runHandle,
    timeoutMsForTest: 20,
  })
  deadline.suspend('ask-1')
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.equal(abortController.signal.aborted, false)
  deadline.resume('ask-1')
  await new Promise<void>((resolve) => abortController.signal.addEventListener('abort', () => resolve(), { once: true }))
  deadline.dispose()
  assert.equal((abortController.signal.reason as Error).message, 'delivery_wall_clock_exceeded')
})

test('S0 R2: resolving user input grants a complete new no-progress window', () => {
  const scheduled: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout

  globalThis.setTimeout = ((callback: () => void, delayMs?: number) => {
    const timer = {
      callback,
      delayMs: Number(delayMs || 0),
      cleared: false,
      unref: () => timer,
    }
    scheduled.push(timer)
    return timer
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer: { cleared?: boolean }) => {
    timer.cleared = true
  }) as typeof clearTimeout

  try {
    const abortController = new AbortController()
    const runHandle = { abortInitiator: null } as Parameters<typeof armDynamicDeliveryDeadline>[0]['runHandle']
    const deadline = armDynamicDeliveryDeadline({
      mode: 'adaptive',
      runId: 'run-resolved-user-input',
      abortController,
      runHandle,
    })

    assert.equal(scheduled[0]?.delayMs, 120_000)
    deadline.suspend('ask-r2')
    assert.equal(scheduled[0]?.cleared, true)
    assert.equal(scheduled.length, 1, 'pending input must not run a one-second polling timer')
    deadline.resume('ask-r2')

    assert.equal(
      abortController.signal.aborted,
      false,
      'resolving the blocker is progress and must not reuse the one-second poll as a deadline',
    )
    assert.equal(scheduled.at(-1)?.delayMs, 120_000)
    deadline.dispose()
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})
