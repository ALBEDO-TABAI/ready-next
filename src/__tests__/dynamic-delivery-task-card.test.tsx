import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DynamicDeliveryTaskSummary } from '../renderer/components/agent/chat-panel/task/TaskCard'
import { taskProjectionToTaskCardRun } from '../renderer/components/agent/task-card-from-projection'

test('task card renders persisted contributor and settlement truth', () => {
  const binding = {
    schemaVersion: 1 as const, runId: 'child', ownerAgentIdAtStart: 'owner', runOrigin: 'workflow_participant' as const,
    kind: 'registered_agent' as const, requestedAgentId: 'analyst', effectiveAgentId: 'analyst',
    executionMaterialHash: 'hash', ownerAssignmentSource: 'parent_task' as const,
    executionSelectionSource: 'task_owner' as const, resolutionKind: 'direct' as const,
  }
  const run = taskProjectionToTaskCardRun({
    scopeId: 'scope', taskId: 'task', phase: 'tool_running', title: 'Task', updatedAt: '2026-07-11T00:00:00Z', toolTrace: [],
    deliveryState: {
      version: 1, stateRevision: 1, decision: 'support_and_verify', parentGeneration: 0,
      packages: [{ packageId: 'pkg', attempt: 0, childTaskId: 'child', lifecycleId: 'life', binding,
        criticality: 'required', status: 'degraded', adoptedByOwner: false, evidenceHandleIds: [] }],
      verifier: { status: 'pending', repaired: false },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, usageSource: 'missing', providerCallCount: 0, missingCallCount: 0 },
    },
  })
  const html = renderToStaticMarkup(createElement(DynamicDeliveryTaskSummary, { run }))
  assert.match(html, /协作者 analyst/)
  assert.match(html, /已降级/)
})
