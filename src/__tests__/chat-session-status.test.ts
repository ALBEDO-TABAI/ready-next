import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SESSION_DOT_COLOR,
  resolveSessionDotStatus,
} from '../renderer/components/agent/chat-panel/helpers/session-status'

test('resolveSessionDotStatus: in-flight phases read working (orange)', () => {
  for (const phase of [
    'queued',
    'planning',
    'tool_running',
    'checkpoint',
    'takeover',
    'resuming',
    'responding',
  ] as const) {
    assert.equal(resolveSessionDotStatus(phase), 'working', `${phase} should be working`)
  }
})

test('resolveSessionDotStatus: done reads active (just-completed, green)', () => {
  assert.equal(resolveSessionDotStatus('done'), 'active')
  // Even a background (non-active) scope that just finished lights green.
  assert.equal(resolveSessionDotStatus('done', { isActive: false }), 'active')
})

test('resolveSessionDotStatus: error reads error (red)', () => {
  assert.equal(resolveSessionDotStatus('error'), 'error')
  // error wins over isActive (a failed foreground run is still red).
  assert.equal(resolveSessionDotStatus('error', { isActive: true }), 'error')
})

test('resolveSessionDotStatus: idle/cancelled/absent are off unless the scope is active', () => {
  assert.equal(resolveSessionDotStatus('idle'), 'off')
  assert.equal(resolveSessionDotStatus('cancelled'), 'off')
  assert.equal(resolveSessionDotStatus(null), 'off')
  assert.equal(resolveSessionDotStatus(undefined), 'off')
  // The foreground scope reads green (激活) when nothing is running.
  assert.equal(resolveSessionDotStatus('idle', { isActive: true }), 'active')
  assert.equal(resolveSessionDotStatus(undefined, { isActive: true }), 'active')
  assert.equal(resolveSessionDotStatus('cancelled', { isActive: true }), 'active')
})

test('resolveSessionDotStatus: streaming overrides phase to working', () => {
  // A streaming active scope is working (orange), not green, even when idle.
  assert.equal(resolveSessionDotStatus('idle', { isActive: true, isStreaming: true }), 'working')
  // Streaming wins over a stale done phase too.
  assert.equal(resolveSessionDotStatus('done', { isStreaming: true }), 'working')
})

test('SESSION_DOT_COLOR maps every status to a distinct color', () => {
  const colors = Object.values(SESSION_DOT_COLOR)
  assert.equal(new Set(colors).size, colors.length)
  assert.equal(SESSION_DOT_COLOR.active, '#22c55e')
  assert.equal(SESSION_DOT_COLOR.working, '#f97316')
  assert.equal(SESSION_DOT_COLOR.error, '#ef4444')
  assert.equal(SESSION_DOT_COLOR.off, '#d1d5db')
})
