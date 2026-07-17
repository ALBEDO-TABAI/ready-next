import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserEventRateCounter } from '../main/modules/browser-engine/browser-event-rate-counter'
import { BrowserTabUpdateBatcher } from '../main/modules/browser-engine/tab-update-batcher'
import { resolveBrowserTabErrorUpdate } from '../renderer/modules/browser/browserTabUpdatePatch'

test('a noisy navigation sequence becomes one composite renderer patch', () => {
  const output: Array<Record<string, unknown>> = []
  const counter = new BrowserEventRateCounter()
  const batcher = new BrowserTabUpdateBatcher({ emit: (patch) => output.push(patch), counter })
  batcher.enqueue({ type: 'loading', tabId: 'tab-1', loading: true })
  batcher.enqueue({ type: 'navigate', tabId: 'tab-1', url: 'https://example.com', canGoBack: false })
  batcher.enqueue({ type: 'title', tabId: 'tab-1', title: 'First' })
  batcher.enqueue({ type: 'title', tabId: 'tab-1', title: 'Final' })
  batcher.enqueue({ type: 'meta', tabId: 'tab-1', favicon: 'icon.png', owner: 'manual' })
  batcher.enqueue({ type: 'loading', tabId: 'tab-1', loading: false })
  batcher.flush()

  assert.deepEqual(output, [{
    type: 'patch',
    tabId: 'tab-1',
    loading: false,
    url: 'https://example.com',
    canGoBack: false,
    title: 'Final',
    favicon: 'icon.png',
    owner: 'manual',
  }])
  assert.equal(counter.snapshot()['tabUpdate:output:patch'], 1)
})

test('closed updates flush pending state first and bypass the batching delay', () => {
  const output: Array<Record<string, unknown>> = []
  const batcher = new BrowserTabUpdateBatcher({ emit: (patch) => output.push(patch) })
  batcher.enqueue({ type: 'title', tabId: 'tab-1', title: 'Final' })
  batcher.enqueue({ type: 'closed', tabId: 'tab-1', activeTabId: 'tab-2' })
  assert.deepEqual(output.map((item) => item.type), ['patch', 'closed'])
})

test('an explicit null error clears stale renderer failure state', () => {
  assert.deepEqual(resolveBrowserTabErrorUpdate(null), { error: undefined })
  assert.deepEqual(resolveBrowserTabErrorUpdate('net::ERR_FAILED'), {
    loading: false,
    error: 'net::ERR_FAILED',
  })
  assert.deepEqual(resolveBrowserTabErrorUpdate(undefined), {})
})
