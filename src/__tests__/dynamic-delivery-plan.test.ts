import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileDynamicDeliveryPlan,
  parseDynamicDeliveryPlan,
} from '../main/modules/agent-control/quality/packet-compiler'

const input = {
  mode: 'adaptive' as const,
  userRequestVerbatim: '请比较两个方案并输出结论',
  canonicalContextRefIds: ['doc:a', 'doc:b'],
  profiles: [
    { agentId: 'analyst', name: '智识', collaborationReady: true },
    { agentId: 'disabled', name: '停用', collaborationReady: false },
  ],
}

function validPlan(): string {
  return JSON.stringify({
    version: 1,
    packages: [
      {
        packageId: 'facts',
        title: '事实核对',
        objective: '核对两份资料',
        deliverable: '一份差异表',
        expectedOutputs: ['差异表'],
        proposedCriteria: ['覆盖两份资料'],
        contextRefIds: ['doc:a', 'doc:b'],
        executorHint: { kind: 'registered_agent', agentId: 'analyst' },
        criticality: 'required',
      },
    ],
  })
}

test('bounded planner is fresh, no-tools, one-turn and returns a validated plan', async () => {
  let call: unknown = null
  const plan = await compileDynamicDeliveryPlan(input, async (received) => {
    call = received
    return `\`\`\`json\n${validPlan()}\n\`\`\``
  })
  assert.equal(plan.packages[0]?.executorHint.kind, 'registered_agent')
  assert.deepEqual((call as { tools: unknown[] }).tools, [])
  assert.equal((call as { maxTurns: number }).maxTurns, 1)
})

test('plan rejects non-canonical refs and agents that are not collaboration ready', () => {
  const foreignRef = JSON.parse(validPlan())
  foreignRef.packages[0].contextRefIds = ['doc:foreign']
  assert.throws(() => parseDynamicDeliveryPlan(JSON.stringify(foreignRef), input), /non-canonical/)

  const disabledAgent = JSON.parse(validPlan())
  disabledAgent.packages[0].executorHint.agentId = 'disabled'
  assert.throws(() => parseDynamicDeliveryPlan(JSON.stringify(disabledAgent), input), /unavailable/)
})

test('adaptive caps packages at two and ephemeral roles are a closed set', () => {
  const tooMany = JSON.parse(validPlan())
  tooMany.packages = [0, 1, 2].map((index) => ({ ...tooMany.packages[0], packageId: `p${index}` }))
  assert.throws(() => parseDynamicDeliveryPlan(JSON.stringify(tooMany), input), /1\.\.2/)

  const unsafeRole = JSON.parse(validPlan())
  unsafeRole.packages[0].executorHint = { kind: 'ephemeral', role: 'admin' }
  assert.throws(() => parseDynamicDeliveryPlan(JSON.stringify(unsafeRole), input), /closed role/)
})
