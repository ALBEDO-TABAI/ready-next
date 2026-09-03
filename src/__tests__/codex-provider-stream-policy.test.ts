import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexProviderStreamPolicy,
  CodexProviderStreamPolicyError,
  classifyCodexProviderResponseEvent,
} from '../main/modules/agent-control/codex-runtime/codex-provider-stream-policy'

function policy(startedAt = 1_000): CodexProviderStreamPolicy {
  return new CodexProviderStreamPolicy({
    maxWireBytes: 1_000_000,
    maxStructuralEvents: 4_096,
    maxItemHeldBytes: 1_000_000,
    eventIdleMs: 120_000,
  }, startedAt)
}

test('Provider policy uses a positive event registry', () => {
  assert.equal(classifyCodexProviderResponseEvent('response.function_call_arguments.delta'), 'delta')
  assert.equal(classifyCodexProviderResponseEvent('response.output_item.added'), 'structural')
  assert.equal(classifyCodexProviderResponseEvent('response.completed'), 'terminal')
  assert.throws(
    () => classifyCodexProviderResponseEvent('response.future.delta'),
    (error: unknown) => error instanceof CodexProviderStreamPolicyError
      && error.code === 'gateway_response_event_not_allowed',
  )
})

test('5000 function argument deltas do not consume structural capacity', () => {
  const stream = policy()
  stream.acceptValidatedEvent({
    type: 'response.created',
    response: { id: 'response-1' },
  }, 1_001)
  stream.acceptValidatedEvent({
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: 'item-1', type: 'function_call', arguments: '' },
  }, 1_002)
  for (let index = 0; index < 5_000; index += 1) {
    stream.acceptValidatedEvent({
      type: 'response.function_call_arguments.delta',
      item_id: 'item-1',
      output_index: 0,
      delta: 'x',
    }, 1_003 + index)
  }
  assert.equal(stream.snapshot().structuralEvents, 2)
  assert.equal(stream.snapshot().itemHeldBytes['item-1'], 5_000)
})

test('4097 structural events still close the stream', () => {
  const stream = policy()
  for (let index = 0; index < 4_096; index += 1) {
    stream.acceptValidatedEvent({ type: 'response.in_progress' }, 1_000 + index)
  }
  assert.throws(
    () => stream.acceptValidatedEvent({ type: 'response.in_progress' }, 6_000),
    (error: unknown) => error instanceof CodexProviderStreamPolicyError
      && error.code === 'gateway_native_event_limit_exceeded',
  )
})

test('valid progress slides the event idle deadline and terminal rejects later events', () => {
  const stream = policy()
  assert.equal(stream.remainingWaitMs(121_000), 0)
  stream.acceptValidatedEvent({ type: 'response.in_progress' }, 120_999)
  assert.equal(stream.remainingWaitMs(121_001), 119_998)
  stream.acceptValidatedEvent({
    type: 'response.completed',
    response: { id: 'response-1' },
  }, 200_000)
  assert.equal(stream.snapshot().terminal, true)
  assert.throws(
    () => stream.acceptValidatedEvent({ type: 'response.in_progress' }, 200_001),
    /gateway_native_event_after_terminal/,
  )
})

test('wire bytes and held item bytes have independent caps', () => {
  const wire = new CodexProviderStreamPolicy({
    maxWireBytes: 3,
    maxStructuralEvents: 10,
    maxItemHeldBytes: 10,
    eventIdleMs: 10,
  }, 0)
  wire.recordWireBytes(3)
  assert.throws(() => wire.recordWireBytes(1), /gateway_native_stream_too_large/)

  const held = new CodexProviderStreamPolicy({
    maxWireBytes: 100,
    maxStructuralEvents: 10,
    maxItemHeldBytes: 3,
    eventIdleMs: 10,
  }, 0)
  held.acceptValidatedEvent({
    type: 'response.output_text.delta',
    item_id: 'item-1',
    delta: '好',
  }, 1)
  assert.throws(
    () => held.acceptValidatedEvent({
      type: 'response.output_text.delta',
      item_id: 'item-1',
      delta: 'x',
    }, 2),
    /gateway_native_item_too_large/,
  )
})
