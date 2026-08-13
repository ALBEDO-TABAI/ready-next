import assert from 'node:assert/strict'
import test from 'node:test'

import { persistRunMetaSnapshot } from '../main/modules/agent-control/runtime-core/agent-sdk-turn-closeout'

test('late lifecycle snapshot preserves an atomic checkpoint continuation', async () => {
  const continuationRef = {
    kind: 'browser_checkpoint',
    checkpointId: 'checkpoint-1',
    suspensionReason: 'browser_power_confirmation',
  }
  let update: Record<string, unknown> | null = null
  const repository = {
    get: () => ({
      status: 'checkpoint',
      terminalReason: 'checkpoint_browser_power_confirmation',
      taskType: 'short_task',
      budget: null,
      continuationRef,
    }),
    update: (_runId: string, patch: Record<string, unknown>) => {
      update = patch
      return patch
    },
    create: () => {
      throw new Error('existing checkpoint row must be updated')
    },
  }

  await persistRunMetaSnapshot({
    runtime: {},
    getRunMetaRepositoryForFinalize: () => repository,
  } as never, {
    agentName: 'butler',
    runId: 'run-1',
    taskId: 'task-1',
    scopeId: 'scope-1',
    status: 'checkpoint',
    terminalReason: 'manual_suspend',
    taskBudgetRuntime: null,
    providerDiagnostics: null,
    continuationRef: null,
    usage: null,
    firstMessageText: 'request',
    finalText: 'paused',
  })

  assert.deepEqual(update?.continuationRef, continuationRef)
})
