import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyDeliveryCandidate } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-verifier'
import { classifyDeliveryRepair } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-repair-policy'
import { sealDeliveryCandidate } from '../main/modules/agent-control/runtime-core/dynamic-delivery/seal-delivery-candidate'

async function candidate() {
  return sealDeliveryCandidate({
    userRequestVerbatim: 'write the report',
    candidateText: 'candidate',
    hostCriteria: [{ id: 'c1', text: 'deliver report' }],
    modelCriteria: ['include risks'],
    openQuestions: [],
    materializeAndReadBack: async () => ({
      version: 1,
      items: [{
        refId: 'doc:report',
        digest: 'a'.repeat(64),
        provenance: 'document_readback',
        excerpt: 'saved report excerpt',
        kind: 'artifact',
      }],
    }),
  })
}

test('fresh verifier receives the sealed post-readback criteria bundle with no tools', async () => {
  let captured: Record<string, unknown> | null = null
  const result = await verifyDeliveryCandidate({
    candidate: await candidate(),
    runId: 'parent-run',
    taskId: 'parent-task',
    model: 'test',
    provider: {} as never,
    contextWindowTokens: 10_000,
    maxOutputTokens: 1_000,
    signal: new AbortController().signal,
    runAgent: async (params) => {
      captured = params as unknown as Record<string, unknown>
      return {
        finalText: JSON.stringify({ version: 1, verdict: 'accept', gaps: [], summary: 'ok' }),
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }
    },
  })
  assert.equal(result.verdict.verdict, 'accept')
  assert.deepEqual(captured!.tools, [])
  assert.equal(captured!.maxTurns, 1)
  assert.match(String(captured!.input), /document_readback/)
  assert.match(String(captured!.input), /include risks/)
})

test('repair policy never replays external actions and only targets already verified artifacts', async () => {
  assert.equal(classifyDeliveryRepair({
    version: 1,
    verdict: 'repair',
    gaps: [{ kind: 'text', description: 'clarify' }],
    summary: 'fix text',
  }, new Set()), 'text_only')
  assert.equal(classifyDeliveryRepair({
    version: 1,
    verdict: 'repair',
    gaps: [{ kind: 'artifact', description: 'fix document', targetRefId: 'doc:report' }],
    summary: 'fix artifact',
  }, new Set(['doc:report'])), 'artifact_targeted')
  assert.equal(classifyDeliveryRepair({
    version: 1,
    verdict: 'repair',
    gaps: [{ kind: 'external_action', description: 'send again' }],
    summary: 'unsafe',
  }, new Set()), 'non_repairable_action')
})

test('verifier unavailability is an error and cannot fail open', async () => {
  const sealed = await candidate()
  await assert.rejects(() => verifyDeliveryCandidate({
    candidate: sealed,
    runId: 'parent-run',
    taskId: 'parent-task',
    model: 'test',
    provider: {} as never,
    contextWindowTokens: 10_000,
    maxOutputTokens: 1_000,
    signal: new AbortController().signal,
    runAgent: async () => { throw new Error('provider unavailable') },
  }), /provider unavailable/)
})
