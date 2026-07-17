import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserLockOverlayVisibilityState } from '../main/modules/browser-engine/browser-lock-overlay-visibility'
import type { BrowserLockOverlaySnapshot } from '../shared/browser-lock-overlay'

function snapshot(identity: string, kind: BrowserLockOverlaySnapshot['kind'] = 'agent-current'): BrowserLockOverlaySnapshot {
  return {
    identity,
    kind,
    label: 'Agent 正在控制',
    detail: identity,
    tone: kind === 'takeover' ? 'warning' : 'agent',
    bounds: { left: 0, top: 0, width: 800, height: 600 },
  }
}

test('manual dismissal stays hidden for the same task and clears for a new task identity', () => {
  const state = new BrowserLockOverlayVisibilityState()
  assert.equal(state.observe(snapshot('task-1')), true)
  state.dismissCurrent()
  assert.equal(state.beginAction(), false)
  assert.equal(state.observe(snapshot('task-1')), false)
  assert.equal(state.observe(snapshot('task-2')), true)
})

test('terminal auto-hide lasts until the next action while takeover identity can surface immediately', () => {
  const state = new BrowserLockOverlayVisibilityState()
  assert.equal(state.observe(snapshot('task-1')), true)
  state.finishAction()
  assert.equal(state.observe(snapshot('task-1')), false)
  assert.equal(state.beginAction(), true)
  state.finishAction()
  assert.equal(state.observe(snapshot('takeover-1', 'takeover')), true)
})
