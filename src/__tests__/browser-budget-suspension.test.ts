import assert from 'node:assert/strict'
import test from 'node:test'

import { createBrowserSuspensionController } from '../main/modules/agent-control/runtime-core/agent-sdk-browser-suspension'

test('budget exhaustion restores a durable browser route instead of falling back to a generic checkpoint', async () => {
  const route = {
    browserTaskId: 'browser-task-budget',
    requestAnchorSnapshotDigest: 'anchor-budget',
  }
  const runtimeContext = { browserWorkflowRoute: null } as {
    browserWorkflowRoute: typeof route | null
  }
  let persistedReason: string | null = null
  const projectionPatches: Record<string, unknown>[] = []
  const suspension = createBrowserSuspensionController({
    modelInputController: {
      restoreBrowserWorkflowRoute: () => {
        runtimeContext.browserWorkflowRoute = route
        return route
      },
      persistSuspension: async (reason: string) => {
        persistedReason = reason
        return {
          checkpointId: 'checkpoint-budget',
          browserTaskId: route.browserTaskId,
          canonicalMessage: { id: 'checkpoint-message' },
          canonicalMessageDigest: 'checkpoint-message-digest',
        }
      },
    } as never,
    runtimeContext,
    projectionPatches,
    getTaskBudgetRuntime: () => null,
    setContinuationRef: () => undefined,
    setProviderDiagnostics: () => undefined,
    setFinalText: () => undefined,
    emitOutput: () => undefined,
    finalizeCheckpoint: async (params) => ({
      success: true,
      status: 'checkpoint',
      usedTools: [],
      finalText: params.finalText,
      terminalReason: params.terminalReason,
    }),
  })

  const result = await suspension.finishSuspension({
    reason: 'budget',
    terminalReason: 'checkpoint_budget',
    message: '已保存浏览器现场',
  })

  assert.equal(persistedReason, 'budget')
  assert.equal(result?.terminalReason, 'checkpoint_budget')
  assert.deepEqual(projectionPatches[0], {
    status: 'recoverable_paused',
    interactionState: 'suspended',
    waitingFor: 'none',
    blockedReason: 'browser_budget_checkpoint',
    resumableActions: ['continue', 'cancel'],
    canResume: true,
    continuationRef: {
      kind: 'browser_checkpoint',
      checkpointId: 'checkpoint-budget',
      browserTaskId: 'browser-task-budget',
      suspensionReason: 'budget',
    },
    budgetWarningLevel: 'exhausted',
  })
})
