import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createHookRegistry,
  type HookName,
  type HookPayloadFor,
} from '../main/modules/agent-control/hook-registry'

test('register returns unregister function that removes handler', async () => {
  const registry = createHookRegistry()
  let calls = 0

  const unregister = registry.register('stop', {
    name: 'stop-counter',
    fn: () => {
      calls += 1
    },
  })

  await registry.fire('stop', { reason: 'before-unregister' })
  unregister()
  await registry.fire('stop', { reason: 'after-unregister' })

  assert.equal(calls, 1)
})

test('fire awaits handlers in registration order', async () => {
  const registry = createHookRegistry()
  const order: string[] = []

  registry.register('user_prompt_submit', {
    name: 'first',
    fn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('first')
    },
  })
  registry.register('user_prompt_submit', {
    name: 'second',
    fn: () => {
      order.push('second')
    },
  })

  await registry.fire('user_prompt_submit', {
    userText: 'hello',
    sessionId: 'session-1',
    timestamp: 123,
  })

  assert.deepEqual(order, ['first', 'second'])
})

test('handler throw does not abort sibling handlers and emits hook_handler_failed metric', async () => {
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []
  const registry = createHookRegistry({
    emitMetric: (name, payload) => metrics.push({ name, payload }),
  })
  const calls: string[] = []

  registry.register('pre_tool_use', {
    name: 'throws',
    fn: () => {
      calls.push('throws')
      throw new Error('boom')
    },
  })
  registry.register('pre_tool_use', {
    name: 'after',
    fn: () => {
      calls.push('after')
    },
  })

  await registry.fire('pre_tool_use', {
    toolName: 'browser_read_page',
    input: { url: 'https://example.com' },
  })

  assert.deepEqual(calls, ['throws', 'after'])
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0]?.name, 'hook_handler_failed')
  assert.equal(metrics[0]?.payload.hookName, 'pre_tool_use')
  assert.equal(metrics[0]?.payload.handlerName, 'throws')
  assert.match(String(metrics[0]?.payload.error || ''), /boom/)
})

test('handler exceeding timeoutMs emits hook_handler_timeout and continues', async () => {
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []
  const registry = createHookRegistry({
    emitMetric: (name, payload) => metrics.push({ name, payload }),
  })
  const calls: string[] = []

  registry.register('post_tool_use', {
    name: 'slow',
    timeoutMs: 5,
    fn: () => new Promise((resolve) => {
      setTimeout(() => {
        calls.push('slow-finished')
        resolve()
      }, 25)
    }),
  })
  registry.register('post_tool_use', {
    name: 'after',
    fn: () => {
      calls.push('after')
    },
  })

  await registry.fire('post_tool_use', {
    toolName: 'browser_read_page',
    result: { text: 'done' },
    success: true,
  })

  assert.deepEqual(calls, ['after'])
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0]?.name, 'hook_handler_timeout')
  assert.equal(metrics[0]?.payload.hookName, 'post_tool_use')
  assert.equal(metrics[0]?.payload.handlerName, 'slow')
  assert.equal(metrics[0]?.payload.timeoutMs, 5)
})

test('all 4 hook names are usable with typed payloads', async () => {
  const registry = createHookRegistry()
  const seen: HookName[] = []

  const payloads: { [K in HookName]: HookPayloadFor<K> } = {
    pre_tool_use: { toolName: 'skill_get_state', input: { executionId: 'e-12345678' } },
    post_tool_use: { toolName: 'skill_get_state', result: { ok: true }, success: true },
    user_prompt_submit: { userText: 'run it', sessionId: null, timestamp: 456 },
    stop: { reason: 'complete' },
  }

  for (const hookName of Object.keys(payloads) as HookName[]) {
    registry.register(hookName, {
      name: `${hookName}-smoke`,
      fn: () => {
        seen.push(hookName)
      },
    })
    await registry.fire(hookName, payloads[hookName])
  }

  assert.deepEqual(seen, ['pre_tool_use', 'post_tool_use', 'user_prompt_submit', 'stop'])
})
