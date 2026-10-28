import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveExactRetryEligibility } from '../main/modules/agent-control/codex-runtime/codex-exact-retry-eligibility'
import {
  nativeInheritedContractDigest,
  resolveAcceptedNativePrefixHead,
  resolveFormalNativeInputCoverage,
  resolveLiveUncommittedUserTail,
  resolveExplicitRetryTailPlan,
} from '../main/modules/agent-control/codex-runtime/codex-history-continuity-policy'

const readyFacts = {
  phase: 'projection' as const,
  currentMemoryPayloadEmpty: true,
  sourceRootCompacted: false,
  historyKind: 'diverged' as const,
  effectState: 'none' as const,
  toolCount: 0,
  interactionCount: 0,
  sourceResourceEmpty: true,
  sourceSkillAndExecutionCeilingEmpty: true,
  sourceMemoryPayloadEmpty: true,
  sourceMode: 'browser' as const,
  currentMode: 'browser' as const,
  trustedCurrentMode: 'browser' as const,
  historyMaterialized: true,
  currentSourceEligible: true,
}

test('projection and final Retry admission share one reducer', () => {
  assert.deepEqual(resolveExactRetryEligibility(readyFacts), {
    availability: 'ready', blockers: [],
  })
  assert.deepEqual(resolveExactRetryEligibility({
    ...readyFacts,
    phase: 'pre_persistence',
    currentFacts: {
      resourceEmpty: true,
      skillAndExecutionCeilingValid: true,
      memoryPayloadEmpty: true,
      selectedSeedCount: 1,
    },
  }), { availability: 'ready', blockers: [] })
})

test('final Retry admission cannot inherit a projected ready result after current facts drift', () => {
  assert.deepEqual(resolveExactRetryEligibility({
    ...readyFacts,
    phase: 'pre_persistence',
    currentFacts: {
      resourceEmpty: false,
      skillAndExecutionCeilingValid: false,
      memoryPayloadEmpty: false,
      selectedSeedCount: 0,
    },
  }), {
    availability: 'blocked',
    blockers: [
      'resource_restatement_required',
      'current_skill_context_restatement_required',
      'current_memory_restatement_required',
      'history_materializing',
    ],
  })
})

test('a consumed Retry source is not applicable, while an exact source may still be materializing', () => {
  assert.deepEqual(resolveExactRetryEligibility({ ...readyFacts, currentSourceEligible: false, historyMaterialized: false }), {
    availability: 'not_applicable', blockers: ['retry_source_not_current'],
  })
  assert.deepEqual(resolveExactRetryEligibility({ ...readyFacts, historyMaterialized: false }), {
    availability: 'blocked', blockers: ['history_materializing'],
  })
})

test('accepted prefix distinguishes bilateral first-turn proof from unknown earlier native or product history', () => {
  const first = {
    predatesMaterializationRecords: false, acceptedHead: null, currentRunId: 'run-b', currentNativeTurnId: 'native-b',
    productRunIds: ['run-b'], manualCompactionCount: 0, orderedNativeTurnIds: ['native-b'], nativeCompactionItemCount: 0, uncommittedOriginCount: 1,
  }
  assert.deepEqual(resolveAcceptedNativePrefixHead(first), { kind: 'proven_native_first_turn_no_prefix' })
  for (const patch of [
    { predatesMaterializationRecords: true }, { productRunIds: ['run-a', 'run-b'] },
    { orderedNativeTurnIds: ['unmapped-native-a', 'native-b'] }, { orderedNativeTurnIds: null },
    { manualCompactionCount: 1 }, { nativeCompactionItemCount: 1 },
  ]) assert.deepEqual(resolveAcceptedNativePrefixHead({ ...first, ...patch }), { kind: 'unknown' })
  const head = { acceptedNativeHeadKind: 'turn' as const, acceptedNativeHeadId: 'native-a', acceptedProductReadyRunId: 'run-a',
    coverageReceiptRef: { receiptId: 'coverage-a', digest: 'a'.repeat(64) } }
  assert.deepEqual(resolveAcceptedNativePrefixHead({ ...first, acceptedHead: head, orderedNativeTurnIds: ['native-a', 'native-b'] }),
    { kind: 'accepted', head })
  assert.deepEqual(resolveAcceptedNativePrefixHead({ ...first, acceptedHead: head }), { kind: 'unknown' })
})

test('one origin fold distinguishes native delivery from fork handoff and preserves supersession', () => {
  const b = { originUserMessageId: 'b', input: [{ type: 'text' as const, text: 'b', text_elements: [] }], inputDigest: 'b'.repeat(64), policy: 'resource_restatement_required' as const }
  const c = { originUserMessageId: 'c', input: [{ type: 'text' as const, text: 'c', text_elements: [] }], inputDigest: 'c'.repeat(64), policy: 'untrusted_text_history' as const }
  assert.deepEqual(resolveLiveUncommittedUserTail({
    origins: [b, c], covered: new Map(), retainedInCurrentNative: new Map([['c', c.inputDigest]]),
    superseded: [{ originUserMessageId: b.originUserMessageId, inputDigest: b.inputDigest, policy: b.policy }],
  }), { handoffTail: [c], currentDeliveryTail: [] })
  assert.deepEqual(resolveLiveUncommittedUserTail({ origins: [c], covered: new Map([['c', c.inputDigest]]),
    retainedInCurrentNative: new Map(), superseded: [] }), { handoffTail: [], currentDeliveryTail: [] })
  assert.throws(() => resolveLiveUncommittedUserTail({ origins: [c], covered: new Map([['c', 'a'.repeat(64)]]),
    retainedInCurrentNative: new Map(), superseded: [] }), /resolution_conflict/)
})

test('formal native coverage permits a proven inherited prefix but not unmapped turns', () => {
  const turns = [{ nativeTurnId: 'parent', origins: null }, { nativeTurnId: 'child', origins: [{ messageId: 'b', digest: 'b'.repeat(64) }] }]
  assert.deepEqual(resolveFormalNativeInputCoverage({ turns, provenPrefixTurnIds: new Set() }), { kind: 'unknown' })
  assert.deepEqual(resolveFormalNativeInputCoverage({ turns, provenPrefixTurnIds: new Set(['parent']) }),
    { kind: 'complete', items: turns[1].origins })
})

test('inherited contract pins every native thread-scoped field including context window', () => {
  const base = { runtimeManifestDigest: 'runtime', protocolSchemaDigest: 'protocol', toolSurfaceSnapshotDigest: 'tools',
    instructionContractDigest: 'instructions', model: 'model', threadConfig: { model_context_window: 272000 } }
  const digest = nativeInheritedContractDigest(base)
  assert.equal(nativeInheritedContractDigest({ ...base }), digest)
  for (const patch of [
    { runtimeManifestDigest: 'runtime-2' }, { protocolSchemaDigest: 'protocol-2' }, { toolSurfaceSnapshotDigest: 'tools-2' },
    { instructionContractDigest: 'instructions-2' }, { model: 'model-2' }, { threadConfig: { model_context_window: 500000 } },
  ]) assert.notEqual(nativeInheritedContractDigest({ ...base, ...patch }), digest)
})

test('Retry selects one latest origin while earlier pure-text origins are delivered exactly once', () => {
  const tail = ['b', 'c'].map((id) => ({ originUserMessageId: id,
    input: [{ type: 'text' as const, text: id, text_elements: [] }], inputDigest: id.repeat(64), policy: 'untrusted_text_history' as const }))
  const selected = { originUserMessageId: 'c', inputDigest: 'c'.repeat(64) }
  const plan = resolveExplicitRetryTailPlan(tail, selected)
  assert.equal(plan.kind, 'eligible')
  if (plan.kind !== 'eligible') throw new Error('expected eligible')
  assert.deepEqual(plan.assignments.map((item) => item.plan), ['deliver_untrusted_history', 'replace_with_explicit_retry'])
  assert.deepEqual(resolveExplicitRetryTailPlan(tail, { originUserMessageId: 'b', inputDigest: 'b'.repeat(64) }), { kind: 'ineligible' })
  assert.deepEqual(resolveExplicitRetryTailPlan([{ ...tail[0], policy: 'task_restatement_required' }, tail[1]], selected), { kind: 'ineligible' })
  assert.deepEqual(resolveExplicitRetryTailPlan([...tail, tail[1]], selected), { kind: 'ineligible' })
})


test('missing final current facts cannot be inferred from a ready projection', () => {
  const result = resolveExactRetryEligibility({ ...readyFacts, phase: 'pre_persistence' } as never)
  assert.notEqual(result.availability, 'ready')
  assert.ok(result.blockers.includes('current_facts_unavailable'))
})

test('native retained failure and covered failure have distinct retry explanations', () => {
  for (const sourceRootCompacted of [false, true]) {
    assert.deepEqual(resolveExactRetryEligibility({
      ...readyFacts, historyKind: 'continuation_safe', sourceRootCompacted,
    }), {
      availability: 'not_applicable',
      blockers: [sourceRootCompacted
        ? 'compacted_failed_turn_restatement_required'
        : 'same_thread_failed_turn_restatement_required'],
    })
  }
})
