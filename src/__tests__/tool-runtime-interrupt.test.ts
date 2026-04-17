import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolRuntime } from '../main/modules/agent-control/tool-runtime'

test('ToolRuntime notifies interruption hooks when cancellation stops the batch', async () => {
  const runtime = new ToolRuntime({ log: () => {} })
  const controller = new AbortController()
  const interrupted: Array<{ startedIds: string[]; skippedIds: string[] }> = []
  const started: string[] = []

  await assert.rejects(
    () => runtime.executeBatch({
      signal: controller.signal,
      toolCalls: [
        { id: '1', name: 'skill_video_expert_ai_analyze', input: {} },
        { id: '2', name: 'document_update_widget', input: {} },
      ],
      hooks: {
        onBatchInterrupted: ({ startedToolCallIds, skippedToolCalls }) => {
          interrupted.push({
            startedIds: startedToolCallIds,
            skippedIds: skippedToolCalls.map((toolCall) => toolCall.id),
          })
        },
      },
      executeTool: async (toolCall) => {
        started.push(toolCall.id)
        if (toolCall.id === '1') {
          controller.abort()
        }
        return `${toolCall.name}:ok`
      },
    }),
    { name: 'AbortError' },
  )

  assert.deepEqual(started, ['1'])
  assert.deepEqual(interrupted, [
    {
      startedIds: ['1'],
      skippedIds: ['2'],
    },
  ])
})

test('ToolRuntime interruption hook only fires once for a cancelled parallel batch', async () => {
  const runtime = new ToolRuntime({ log: () => {} })
  const controller = new AbortController()
  let interruptCount = 0

  await assert.rejects(
    () => runtime.executeBatch({
      signal: controller.signal,
      toolCalls: [
        { id: '1', name: 'memory_search', input: {} },
        { id: '2', name: 'document_list_widgets', input: {} },
        { id: '3', name: 'browser_click', input: {} },
      ],
      hooks: {
        onBatchInterrupted: () => {
          interruptCount += 1
        },
      },
      executeTool: async (toolCall) => {
        if (toolCall.id === '1') {
          controller.abort()
        }
        return `${toolCall.name}:ok`
      },
    }),
    { name: 'AbortError' },
  )

  assert.equal(interruptCount, 1)
})

test('ToolRuntime drains batch cleanups immediately when cancellation interrupts the default execution path', async () => {
  let cleanupCount = 0
  const registeredCleanups: Array<() => void | Promise<void>> = []
  const controller = new AbortController()
  const runtime = new ToolRuntime({
    log: () => {},
    executeToolCall: async (_toolName: string, _args: Record<string, unknown>, context: {
      registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
    }) => {
      context.registerRunCleanup?.(() => {
        cleanupCount += 1
      })
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 0))
      return 'ok'
    },
  } as any)

  await assert.rejects(
    () => runtime.executeBatch({
      signal: controller.signal,
      context: {
        registerRunCleanup: (cleanup) => {
          registeredCleanups.push(cleanup)
        },
      },
      toolCalls: [
        { id: '1', name: 'browser_click', input: {} },
        { id: '2', name: 'document_update_widget', input: {} },
      ],
    }),
    { name: 'AbortError' },
  )

  assert.equal(cleanupCount, 1)
  assert.equal(registeredCleanups.length, 1)
  await Promise.resolve(registeredCleanups[0]?.())
  assert.equal(cleanupCount, 1)
})
