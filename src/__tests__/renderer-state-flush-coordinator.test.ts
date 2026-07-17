import assert from 'node:assert/strict'
import test from 'node:test'

import { RendererStateFlushCoordinator } from '../main/modules/process-cleanup/renderer-state-flush-coordinator'

test('renderer flush waits only for the selected main renderer acknowledgement', async () => {
  let requestId = ''
  const coordinator = new RendererStateFlushCoordinator({ createRequestId: () => 'flush-1' })
  let settled = false
  const pending = coordinator.request({
    id: 41,
    send: (nextRequestId) => { requestId = nextRequestId },
  }, 1_000).then(() => { settled = true })

  coordinator.acknowledge(requestId, 99)
  await Promise.resolve()
  assert.equal(settled, false)

  coordinator.acknowledge(requestId, 41)
  await pending
  assert.equal(settled, true)
})

test('renderer flush resolves immediately with no main renderer or a failed send', async () => {
  const coordinator = new RendererStateFlushCoordinator({ createRequestId: () => 'flush-2' })
  await coordinator.request(null, 1_000)
  await coordinator.request({
    id: 41,
    send: () => { throw new Error('renderer closed') },
  }, 1_000)
})
