import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInputItem } from '@openai/agents'

import {
  buildTypedResumeCheckpointInput,
  consumeTypedResumeRecoveryMarkers,
  typedResumeRecoveryId,
} from '../main/modules/repositories/typed-resume-checkpoint'

test('typed resume gives identical recovery occurrences distinct durable identities', () => {
  const base = { role: 'user', content: 'base' } as AgentInputItem
  const repeated = { role: 'system', content: 'same recovery fact' } as AgentInputItem
  const resumed = buildTypedResumeCheckpointInput({
    suspensionInput: [base, repeated, structuredClone(repeated) as AgentInputItem],
    previousCleanInput: [base],
    wakeId: 'wake-multiplicity',
  })

  const ids = resumed.slice(1).map(typedResumeRecoveryId)
  assert.equal(ids.length, 2)
  assert.ok(ids.every(Boolean))
  assert.notEqual(ids[0], ids[1], 'equal content still represents two recovery occurrences')
  assert.deepEqual(
    resumed.slice(1).map((entry) => (
      entry as { providerData?: { readyTypedResumeRecovery?: { recoveryOrdinal?: number } } }
    ).providerData?.readyTypedResumeRecovery?.recoveryOrdinal),
    [0, 1],
  )
  assert.deepEqual(consumeTypedResumeRecoveryMarkers(resumed), [base, repeated, repeated])
})

test('typed resume rejects a marker whose content no longer matches its digest', () => {
  const marked = buildTypedResumeCheckpointInput({
    suspensionInput: [{ role: 'system', content: 'original' } as AgentInputItem],
    previousCleanInput: null,
    wakeId: 'wake-tamper',
  })
  ;(marked[0] as { content?: string }).content = 'tampered'
  assert.equal(typedResumeRecoveryId(marked[0]), null)
  assert.throws(() => consumeTypedResumeRecoveryMarkers(marked), /typed_resume_recovery_marker_invalid/)
})
