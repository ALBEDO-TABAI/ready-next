import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BrowserWorkflowSessionStore } from '../main/modules/browser-engine/browser-workflow-session'

describe('BrowserWorkflowSessionStore', () => {
  it('records a foreground agent-view workflow bound tab', () => {
    const store = new BrowserWorkflowSessionStore()
    const started = store.startForeground({
      runId: 'run-1',
      taskId: 'task-1',
      lane: 'agent-view',
      boundTabId: 'agent-tab-1',
      sourceUserTabId: 'user-tab-1',
      frameUrl: 'https://example.com/form',
    })
    assert.equal(started.ok, true)
    if (!started.ok) return
    assert.equal(started.session.boundTabId, 'agent-tab-1')
    assert.equal(started.session.sourceUserTabId, 'user-tab-1')
    assert.equal(store.getActiveForeground()?.runId, 'run-1')
  })

  it('rejects a second foreground workflow while the first one is running', () => {
    const store = new BrowserWorkflowSessionStore()
    assert.equal(store.startForeground({
      runId: 'run-1',
      taskId: 'task-1',
      lane: 'agent-view',
      boundTabId: 'agent-tab-1',
    }).ok, true)

    const second = store.startForeground({
      runId: 'run-2',
      taskId: 'task-2',
      lane: 'agent-view',
      boundTabId: 'agent-tab-2',
    })
    assert.equal(second.ok, false)
    if (second.ok) return
    assert.equal(second.error.errorCode, 'lease_held')
    assert.equal(second.error.detail?.tabId, 'agent-tab-1')
  })

  it('updates popup-followed bound tab without changing the user source tab', () => {
    const store = new BrowserWorkflowSessionStore()
    const started = store.startForeground({
      runId: 'run-1',
      taskId: 'task-1',
      lane: 'agent-view',
      boundTabId: 'agent-tab-1',
      sourceUserTabId: 'user-tab-1',
    })
    assert.equal(started.ok, true)
    const updated = store.updateBoundTab('run-1', 'agent-tab-popup', 'popup')
    assert.equal(updated?.boundTabId, 'agent-tab-popup')
    assert.equal(updated?.sourceUserTabId, 'user-tab-1')
    assert.equal(store.getActiveForeground()?.boundTabId, 'agent-tab-popup')
  })

  it('releases the foreground slot when the session finishes', () => {
    const store = new BrowserWorkflowSessionStore()
    assert.equal(store.startForeground({
      runId: 'run-1',
      taskId: 'task-1',
      lane: 'agent-view',
      boundTabId: 'agent-tab-1',
    }).ok, true)
    store.close('run-1', 'done')
    assert.equal(store.getActiveForeground(), null)
    assert.equal(store.get('run-1')?.status, 'closed')
    assert.equal(store.get('run-1')?.closeReason, 'done')

    const next = store.startForeground({
      runId: 'run-2',
      taskId: 'task-2',
      lane: 'agent-view',
      boundTabId: 'agent-tab-1',
    })
    assert.equal(next.ok, true)
  })
})
