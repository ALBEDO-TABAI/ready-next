import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import {
  isUserViewKeyboardTakeoverInput,
  recordUserViewTakeoverSignal,
  shouldRecordUserViewTabSwitch,
} from '../main/modules/browser-engine/user-view-takeover-bridge'

test('user-view takeover bridge accepts only unambiguous keyboard input events', () => {
  assert.equal(isUserViewKeyboardTakeoverInput({ type: 'keyDown' }), true)
  assert.equal(isUserViewKeyboardTakeoverInput({ type: 'char' }), true)
  assert.equal(isUserViewKeyboardTakeoverInput({ type: 'keyUp' }), false)
  assert.equal(isUserViewKeyboardTakeoverInput({ type: 'mouseDown' }), false)
})

test('user-view keyboard signal flips a held visible-surface lease to takeover', () => {
  const service = new BrowserWriteLeaseService({ now: () => 1_000 })
  const lease = service.acquire({ surface: 'user-view', taskId: 'task-1', runId: 'run-1', tabId: 'tab-user' })
  assert.equal(typeof lease, 'object')
  const took = recordUserViewTakeoverSignal({
    service,
    activeTabId: 'tab-user',
    signalTabId: 'tab-user',
    source: 'keyboard',
  })
  assert.equal(took, true)
  assert.equal(service.getState('user-view'), 'takeover')
  assert.equal(service.checkWrite({ surface: 'user-view', leaseId: 'lease-1' })?.errorCode, 'lease_takeover')
})

test('user-view keyboard signal ignores inactive tabs and agent-view surface', () => {
  const service = new BrowserWriteLeaseService({ now: () => 1_000 })
  service.acquire({ surface: 'user-view', taskId: 'task-1', runId: 'run-1', tabId: 'tab-user' })
  assert.equal(recordUserViewTakeoverSignal({
    service,
    activeTabId: 'tab-other',
    signalTabId: 'tab-user',
    source: 'keyboard',
  }), false)
  assert.equal(recordUserViewTakeoverSignal({
    service,
    activeTabId: 'tab-user',
    signalTabId: 'tab-user',
    source: 'keyboard',
    surface: 'agent-view',
  }), false)
  assert.equal(service.getState('user-view'), 'held')
})

test('tab-switch takeover is only eligible when leaving the concrete leased tab', () => {
  assert.equal(shouldRecordUserViewTabSwitch({
    previousActiveTabId: 'tab-user',
    nextActiveTabId: 'tab-other',
    leaseTabId: 'tab-user',
  }), true)
  assert.equal(shouldRecordUserViewTabSwitch({
    previousActiveTabId: 'tab-other',
    nextActiveTabId: 'tab-user',
    leaseTabId: 'tab-user',
  }), false)
  assert.equal(shouldRecordUserViewTabSwitch({
    previousActiveTabId: 'tab-user',
    nextActiveTabId: 'tab-other',
    leaseTabId: null,
  }), false)
})

test('tab-switch signal flips the visible user-view lease to takeover when leaving the leased tab', () => {
  const service = new BrowserWriteLeaseService({ now: () => 1_000 })
  service.acquire({ surface: 'user-view', taskId: 'task-1', runId: 'run-1', tabId: 'tab-user' })
  assert.equal(shouldRecordUserViewTabSwitch({
    previousActiveTabId: 'tab-user',
    nextActiveTabId: 'tab-other',
    leaseTabId: service.getLease('user-view')?.tabId ?? null,
  }), true)

  const took = recordUserViewTakeoverSignal({
    service,
    activeTabId: 'tab-other',
    signalTabId: 'tab-other',
    source: 'tab-switch',
  })
  assert.equal(took, true)
  assert.equal(service.getState('user-view'), 'takeover')
  assert.equal(service.checkWrite({ surface: 'user-view', leaseId: 'lease-1' })?.errorCode, 'lease_takeover')
})
