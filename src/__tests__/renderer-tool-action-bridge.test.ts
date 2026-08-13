import assert from 'node:assert/strict'
import test from 'node:test'

import { RendererToolActionBridge } from '../main/modules/claude-bridge/ipc/renderer-tool-action-bridge'

function target(id: number) {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    value: {
      id,
      isDestroyed: () => false,
      send: (channel: string, payload: Record<string, unknown>) => {
        sent.push({ channel, payload })
      },
    },
  }
}

function input(abortSignal: AbortSignal) {
  return {
    sessionId: 'scope-1',
    runId: 'run-1',
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    codexCallId: 'call-1',
    readyActionId: 'action-1',
    actionIdentityDigest: 'identity-1',
    tool: 'document.readSection',
    args: { range: 'full' },
    abortSignal,
  }
}

test('renderer tool bridge issues unique requests bound to one renderer and one call identity', async () => {
  const bridge = new RendererToolActionBridge()
  const renderer = target(7)
  bridge.bindTarget(renderer.value)
  const controller = new AbortController()
  const resultPromise = bridge.request(input(controller.signal))
  assert.equal(renderer.sent.length, 1)
  assert.equal(renderer.sent[0]?.channel, 'agent:toolActionRequest')
  const payload = renderer.sent[0]?.payload
  assert.equal(payload?.codexCallId, 'call-1')
  assert.equal(payload?.readyActionId, 'action-1')
  const requestId = String(payload?.requestId)
  const pending = bridge.pendingToolActionRequests.get(requestId)
  assert.equal(pending?.expectedSenderId, 7)
  assert.ok(pending)
  bridge.releasePendingRequest(requestId)
  pending.resolve({ ok: true })
  assert.deepEqual(await resultPromise, { ok: true })
  assert.equal(bridge.pendingToolActionRequests.size, 0)
})

test('abort and renderer replacement release pending requests without accepting late replies', async () => {
  const bridge = new RendererToolActionBridge()
  const first = target(7)
  bridge.bindTarget(first.value)
  const controller = new AbortController()
  const aborted = bridge.request(input(controller.signal))
  controller.abort()
  await assert.rejects(aborted, /renderer_tool_action_aborted/)
  assert.equal(bridge.pendingToolActionRequests.size, 0)
  assert.equal(first.sent.some((entry) => entry.channel === 'agent:cancelToolActionRequest'), true)

  const replacementController = new AbortController()
  const replaced = bridge.request(input(replacementController.signal))
  bridge.bindTarget(target(8).value)
  await assert.rejects(replaced, /renderer_target_replaced/)
  assert.equal(bridge.pendingToolActionRequests.size, 0)
})
