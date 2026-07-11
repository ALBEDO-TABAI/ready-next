import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCanonicalDeliveryTaskFacts } from '../main/modules/agent-control/runtime-core/dynamic-delivery/canonical-task-facts'

const baseInput = {
  taskType: 'research' as const,
  intentDomains: ['research'],
  structuredTargetIds: ['resource:a', 'resource:b'],
  contextRefIds: ['resource:a', 'resource:b'],
  signalConflict: false,
}

test('canonical task facts are derived from typed intent and targets, not the exposed tool surface', () => {
  const inputWithIrrelevantToolSurface = {
    ...baseInput,
    toolNames: ['web_search', 'document_write', 'skill_run_shell'],
  }
  const withTools = buildCanonicalDeliveryTaskFacts(inputWithIrrelevantToolSurface)
  const withoutTools = buildCanonicalDeliveryTaskFacts(baseInput)

  assert.deepEqual(withTools, withoutTools)
  assert.equal(withTools.taskType, 'research')
  assert.deepEqual(withTools.intentDomains, ['research'])
  assert.equal(withTools.structuredTargetIds.length, 2)
  assert.equal(withTools.hasUnknownRequiredFact, false)
})

test('conflicting typed sources make canonical facts unknown and cannot be repaired by tool availability', () => {
  const facts = buildCanonicalDeliveryTaskFacts({
    ...baseInput,
    signalConflict: true,
  })

  assert.equal(facts.hasUnknownRequiredFact, true)
})
