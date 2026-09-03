import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertCodexHeadActionProjection,
  projectCodexHeadActionProjection,
  type CodexHeadActionFacts,
} from '../main/modules/agent-control/codex-runtime/codex-action-surface'

function facts(overrides: Partial<CodexHeadActionFacts> = {}): CodexHeadActionFacts {
  return {
    scopeId: 'scope-1',
    scopeEpoch: 2,
    aliasId: 'scope-1',
    aliasGeneration: 3,
    threadBindingId: 'binding-3',
    headRevision: 7,
    actionProjectionSequence: 9,
    materializationKind: 'fresh_start',
    materializationState: 'confirmed',
    codexThreadId: 'thread-3',
    continuationBlocked: false,
    activeProductFence: false,
    manualCompactionState: 'none',
    hasLegacyPreparedRun: false,
    headRuntimeManifestDigest: 'runtime',
    headProtocolSchemaDigest: 'protocol',
    currentRuntimeManifestDigest: 'runtime',
    currentProtocolSchemaDigest: 'protocol',
    ...overrides,
  }
}

test('head action projection covers ready, materializing, unknown, busy, legacy, and drift', () => {
  const cases: Array<{
    input: Partial<CodexHeadActionFacts>
    state: ReturnType<typeof projectCodexHeadActionProjection>['historyState']
    availability: 'ready' | 'blocked'
    blocker?: string
  }> = [
    { input: {}, state: 'same_thread_ready', availability: 'ready' },
    {
      input: { materializationKind: 'fresh_start', codexThreadId: null },
      state: 'fresh_root_ready_for_ingress', availability: 'ready',
    },
    {
      input: { materializationKind: 'native_fork', materializationState: 'pending' },
      state: 'materializing', availability: 'blocked', blocker: 'history_materializing',
    },
    {
      input: { materializationKind: 'native_fork', materializationState: 'unknown' },
      state: 'materialization_unknown', availability: 'blocked', blocker: 'history_outcome_unknown',
    },
    {
      input: { continuationBlocked: true },
      state: 'terminal_unknown', availability: 'blocked', blocker: 'terminal_history_unknown',
    },
    {
      input: { materializationKind: 'legacy' },
      state: 'legacy_context_boundary', availability: 'ready',
    },
    {
      input: { activeProductFence: true },
      state: 'same_thread_ready', availability: 'blocked', blocker: 'thread_busy',
    },
    {
      input: { currentProtocolSchemaDigest: 'new-protocol' },
      state: 'same_thread_ready', availability: 'blocked', blocker: 'head_contract_drift',
    },
  ]
  for (const entry of cases) {
    const projection = projectCodexHeadActionProjection(facts(entry.input))
    assertCodexHeadActionProjection(projection)
    assert.equal(projection.historyState, entry.state)
    assert.equal(projection.actions.send_new_message.availability, entry.availability)
    if (entry.blocker) assert.ok(projection.actions.send_new_message.blockers.includes(entry.blocker))
  }
})

test('head blockers and digest are deterministic across fact construction order', () => {
  const first = projectCodexHeadActionProjection(facts({
    activeProductFence: true,
    manualCompactionState: 'unknown',
    continuationBlocked: true,
    currentRuntimeManifestDigest: 'drifted',
  }))
  const second = projectCodexHeadActionProjection({
    ...facts(),
    currentRuntimeManifestDigest: 'drifted',
    continuationBlocked: true,
    manualCompactionState: 'unknown',
    activeProductFence: true,
  })
  assert.deepEqual(first.actions.send_new_message.blockers, [
    'head_contract_drift',
    'terminal_history_unknown',
    'manual_compaction_unknown',
    'thread_busy',
  ])
  assert.equal(first.evidenceDigest, second.evidenceDigest)
})
