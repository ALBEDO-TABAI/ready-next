import assert from 'node:assert/strict'
import test from 'node:test'

import { dispatchDynamicDeliveryPackage } from '../main/modules/agent-control/quality/packet-dispatch'
import type { TaskExecutionBinding } from '../shared/agent-execution-profile'
import type { WorkPackage } from '../shared/dynamic-delivery'

const workPackage: WorkPackage = {
  packageId: 'facts', title: 'facts', objective: 'check facts', deliverable: 'report',
  expectedOutputs: ['report'], proposedCriteria: [], contextRefIds: ['ref-1'],
  executorHint: { kind: 'ephemeral', role: 'researcher' }, criticality: 'required',
}
const binding: TaskExecutionBinding = {
  schemaVersion: 1, runId: 'child-run', ownerAgentIdAtStart: 'owner', runOrigin: 'workflow_participant',
  kind: 'ephemeral', ephemeralRole: 'researcher', executionMaterialHash: 'ephemeral:researcher:v1',
  ownerAssignmentSource: 'parent_task', executionSelectionSource: 'ephemeral_role', resolutionKind: 'direct',
}

test('live packet dispatch has exactly one no-tools model-subagent channel', async () => {
  let calls = 0
  const result = await dispatchDynamicDeliveryPackage({
    workPackage, binding, userRequestVerbatim: '  original words  ', contextRefIds: ['ref-1'],
    executeModelSubagent: async (validated) => {
      calls += 1
      assert.equal(validated.userRequestVerbatim, '  original words  ')
      return 'ok'
    },
  })
  assert.deepEqual(result, { channel: 'model_subagent', result: 'ok' })
  assert.equal(calls, 1)
})

test('background/browser/skill-style unvalidated dispatch cannot enter the closed channel', async () => {
  await assert.rejects(dispatchDynamicDeliveryPackage({
    workPackage, binding, userRequestVerbatim: 'x', contextRefIds: ['unknown-ref'],
    executeModelSubagent: async () => 'nope',
  }), /context_ref_denied/)
  await assert.rejects(dispatchDynamicDeliveryPackage({
    workPackage, binding, userRequestVerbatim: '', contextRefIds: [],
    executeModelSubagent: async () => 'nope',
  }), /verbatim_required/)
})
