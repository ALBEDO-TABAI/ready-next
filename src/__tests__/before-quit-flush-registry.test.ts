import assert from 'node:assert/strict'
import test from 'node:test'
import { installBeforeQuitFlushBridge, registerBeforeQuitFlushHandler, resetBeforeQuitFlushRegistryForTests } from '../renderer/modules/app/beforeQuitFlushRegistry'

test('renderer interaction stays frozen after a successful flush until Main closes or cancels it', async () => {
  resetBeforeQuitFlushRegistryForTests()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  registerBeforeQuitFlushHandler('document:dirty-tabs', () => pending)
  let requestHandler: ((requestId: string) => void) | null = null
  let cancelHandler: ((requestId: string) => void) | null = null
  const frozen: boolean[] = []
  let acknowledge!: (outcome: { success: boolean; error?: string }) => void
  const acknowledged = new Promise<{ success: boolean; error?: string }>((resolve) => { acknowledge = resolve })
  const uninstall = installBeforeQuitFlushBridge({
    onBeforeQuitFlush: (handler) => {
      requestHandler = handler
      return () => { requestHandler = null }
    },
    onBeforeQuitFlushCancelled: (handler) => {
      cancelHandler = handler
      return () => { cancelHandler = null }
    },
    ackBeforeQuitFlushed: (_requestId, outcome) => { acknowledge(outcome) },
  }, {
    setInteractionFrozen: (value) => { frozen.push(value) },
  })

  requestHandler?.('flush-freeze')
  assert.deepEqual(frozen, [true])
  release()
  assert.deepEqual(await acknowledged, { success: true })
  assert.deepEqual(frozen, [true])
  cancelHandler?.('flush-freeze')
  assert.deepEqual(frozen, [true, false])

  uninstall()
  resetBeforeQuitFlushRegistryForTests()
})
