/**
 * Stage U PR U2.3 — hook-registry timeout AbortSignal cooperation.
 *
 * Asserts the registry's two timeout behaviors:
 *   1. Cooperative handler (listens for signal.aborted) settles within
 *      the ABORT_GRACE_MS window → only hookHandlerTimeout fires
 *   2. Non-cooperative handler (ignores signal) does NOT settle within
 *      the grace window → both hookHandlerTimeout AND
 *      hookHandlerTimeoutWithUnknownOutcome fire
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// We exercise fireHandler indirectly through createHookRegistry since
// fireHandler isn't exported. The registry's HookRegistryOptions takes
// emitMetric which gives us observability into both metrics.

test('U2.3 cooperative handler that listens for abort settles cleanly', async () => {
  const { createHookRegistry } = await import('../main/modules/agent-control/hook-registry')
  const emitted: { name: string; payload: Record<string, unknown> }[] = []
  const registry = createHookRegistry({
    emitMetric: (name, payload) => emitted.push({ name, payload: payload as Record<string, unknown> }),
  })

  registry.register('PostToolUse', {
    name: 'cooperative-handler-u2.3',
    timeoutMs: 30,
    fn: async (_payload, signal) => {
      // Pretend to do work, but yield to signal as soon as it fires.
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve()
        const checker = setInterval(() => {
          if (signal?.aborted) { clearInterval(checker); resolve() }
        }, 10)
      })
    },
  })

  await registry.fire('PostToolUse', { kind: 'PostToolUse', toolName: 'noop', input: {}, output: {} } as unknown as Parameters<typeof registry.fire>[1])

  // Should see hookHandlerTimeout but NOT hookHandlerTimeoutWithUnknownOutcome
  // (because the cooperative handler settled within ABORT_GRACE_MS after abort).
  const timeoutMetrics = emitted.filter((m) => m.name === 'hook_handler_timeout')
  const unknownOutcomeMetrics = emitted.filter((m) => m.name === 'hook_handler_timeout_with_unknown_outcome')
  assert.equal(timeoutMetrics.length, 1, 'cooperative handler should still emit hook_handler_timeout')
  assert.equal(unknownOutcomeMetrics.length, 0,
    'cooperative handler that settles within grace window should NOT emit hook_handler_timeout_with_unknown_outcome')
})

test('U2.3 non-cooperative handler triggers hook_handler_timeout_with_unknown_outcome', async () => {
  const { createHookRegistry } = await import('../main/modules/agent-control/hook-registry')
  const emitted: { name: string; payload: Record<string, unknown> }[] = []
  const registry = createHookRegistry({
    emitMetric: (name, payload) => emitted.push({ name, payload: payload as Record<string, unknown> }),
  })

  registry.register('PostToolUse', {
    name: 'non-cooperative-handler-u2.3',
    timeoutMs: 30,
    fn: async () => {
      // Ignore signal entirely; sleep longer than timeout + grace window.
      await new Promise((resolve) => setTimeout(resolve, 2500))
    },
  })

  await registry.fire('PostToolUse', { kind: 'PostToolUse', toolName: 'noop', input: {}, output: {} } as unknown as Parameters<typeof registry.fire>[1])

  const timeoutMetrics = emitted.filter((m) => m.name === 'hook_handler_timeout')
  const unknownOutcomeMetrics = emitted.filter((m) => m.name === 'hook_handler_timeout_with_unknown_outcome')
  assert.equal(timeoutMetrics.length, 1)
  assert.equal(unknownOutcomeMetrics.length, 1,
    'non-cooperative handler that ignores abort signal must emit hook_handler_timeout_with_unknown_outcome')
  assert.equal(unknownOutcomeMetrics[0].payload.handlerName, 'non-cooperative-handler-u2.3')
})
