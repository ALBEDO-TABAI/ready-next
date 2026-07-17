import assert from 'node:assert/strict'
import test from 'node:test'

import { RSSHubIdleLifecycle } from '../main/modules/rss-engine/rsshub-idle-lifecycle'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await wait(5)
}

test('RSSHub idle lifecycle stops a running worker after the quiet window', async () => {
  let idleCalls = 0
  const lifecycle = new RSSHubIdleLifecycle({
    idleMs: 20,
    onIdle: () => { idleCalls += 1 },
  })

  lifecycle.setRunning(true)
  await waitUntil(() => idleCalls === 1)

  assert.equal(idleCalls, 1)
  lifecycle.dispose()
})

test('RSSHub idle lifecycle never stops while a request lease is active', async () => {
  let idleCalls = 0
  const lifecycle = new RSSHubIdleLifecycle({
    idleMs: 20,
    onIdle: () => { idleCalls += 1 },
  })

  lifecycle.setRunning(true)
  const release = lifecycle.beginRequest()
  await wait(35)
  assert.equal(idleCalls, 0)

  release()
  release()
  await waitUntil(() => idleCalls === 1)
  assert.equal(idleCalls, 1)
  lifecycle.dispose()
})

test('RSSHub idle lifecycle cancels idle shutdown when the worker stops explicitly', async () => {
  let idleCalls = 0
  const lifecycle = new RSSHubIdleLifecycle({
    idleMs: 20,
    onIdle: () => { idleCalls += 1 },
  })

  lifecycle.setRunning(true)
  lifecycle.setRunning(false)
  await wait(35)

  assert.equal(idleCalls, 0)
  lifecycle.dispose()
})
