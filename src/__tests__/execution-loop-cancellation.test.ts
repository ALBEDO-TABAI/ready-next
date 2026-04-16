import assert from 'node:assert/strict'
import test from 'node:test'

import { ExecutionLoopOrchestrator } from '../main/modules/agent-control/execution-loop-orchestrator'
import {
  consumeIterationBudget,
  createRunBudgetSeed,
  createStepBudgetState,
  createTaskBudgetRuntime,
} from '../main/modules/agent-control/run-budget-policy'

test('ExecutionLoopOrchestrator stops before starting the next serial tool after cancellation', async () => {
  const orchestrator = new ExecutionLoopOrchestrator({ log: () => {} })
  const controller = new AbortController()
  const started: string[] = []

  await assert.rejects(
    () => orchestrator.executeToolCalls({
      signal: controller.signal,
      toolCalls: [
        { id: '1', name: 'browser_click', input: {} },
        { id: '2', name: 'document_update_widget', input: {} },
      ],
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
})

test('ExecutionLoopOrchestrator does not start a new batch after a parallel batch is cancelled', async () => {
  const orchestrator = new ExecutionLoopOrchestrator({ log: () => {} })
  const controller = new AbortController()
  const started: string[] = []

  await assert.rejects(
    () => orchestrator.executeToolCalls({
      signal: controller.signal,
      toolCalls: [
        { id: '1', name: 'memory_search', input: {} },
        { id: '2', name: 'document_list_widgets', input: {} },
        { id: '3', name: 'browser_click', input: {} },
      ],
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

  assert.deepEqual(started, ['1', '2'])
})

test('frozen task budget runtimes do not consume iteration budget', () => {
  const runtime = createTaskBudgetRuntime('short_task', {
    budget: createRunBudgetSeed('short_task'),
    stepBudget: createStepBudgetState({
      stepId: 'step-1',
      totalIterations: 24,
      suggestedMaxIterations: 6,
    }),
    frozen: true,
  })

  const next = consumeIterationBudget(runtime)

  assert.equal(next.usage.iterationsUsed, 0)
  assert.equal(next.stepBudget?.remainingIterations, 6)
  assert.equal(next.frozen, true)
})
