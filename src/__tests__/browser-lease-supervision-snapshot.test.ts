import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBrowserLeaseSupervisionSnapshot } from '../main/modules/browser-engine/browser-lease-supervision-snapshot'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'

test('browser lease supervision snapshot reports both surfaces when idle', () => {
  const service = new BrowserWriteLeaseService({ now: () => 1_000 })
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service)
  assert.equal(snapshot.activeWriteSurface, null)
  assert.equal(snapshot.surfaces['user-view'].state, 'idle')
  assert.equal(snapshot.surfaces['agent-view'].state, 'idle')
})

test('browser lease supervision snapshot reports user-view holder', () => {
  const service = new BrowserWriteLeaseService({ now: () => 1_000 })
  service.acquire({ surface: 'user-view', taskId: 'task-user', runId: 'run-user', tabId: 'tab-user' })
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service)
  assert.equal(snapshot.activeWriteSurface, 'user-view')
  assert.equal(snapshot.surfaces['user-view'].state, 'held')
  assert.equal(snapshot.surfaces['user-view'].heldBy, 'task-user')
  assert.equal(snapshot.surfaces['user-view'].runId, 'run-user')
  assert.equal(snapshot.surfaces['user-view'].tabId, 'tab-user')
})

test('browser lease supervision snapshot reports agent-view holder', () => {
  const service = new BrowserWriteLeaseService({ now: () => 1_000 })
  service.acquire({ surface: 'agent-view', taskId: 'task-agent', runId: 'run-agent', tabId: 'tab-agent' })
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service)
  assert.equal(snapshot.activeWriteSurface, 'agent-view')
  assert.equal(snapshot.surfaces['agent-view'].state, 'held')
  assert.equal(snapshot.surfaces['agent-view'].heldBy, 'task-agent')
  assert.equal(snapshot.surfaces['agent-view'].tabId, 'tab-agent')
})

test('browser lease supervision snapshot keeps takeover visible after user signal', () => {
  const service = new BrowserWriteLeaseService({ now: () => 1_000 })
  service.acquire({ surface: 'user-view', taskId: 'task-user', runId: 'run-user' })
  assert.equal(service.recordUserSignal({ surface: 'user-view', source: 'explicit-button' }), true)
  const snapshot = buildBrowserLeaseSupervisionSnapshot(service)
  assert.equal(snapshot.activeWriteSurface, null)
  assert.equal(snapshot.surfaces['user-view'].state, 'takeover')
  assert.equal(snapshot.surfaces['user-view'].heldBy, null)
})
