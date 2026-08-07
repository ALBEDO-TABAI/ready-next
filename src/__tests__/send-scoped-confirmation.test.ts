import assert from 'node:assert/strict'
import test from 'node:test'

import type { PersistedIngress } from '../shared/ipc-contracts/agent-runtime'
import {
  CodexProductRunPreparer,
  preparedCodexProductRunMatchesIngress,
} from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { textUserInput } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import {
  IngressPersistenceError,
  resolveAttachmentConfirmation,
  runConfirmedSendScoped,
  type StartIdentityReservationMethods,
  type StartIdentityReservationSet,
} from '../main/modules/agent-control/send-scoped-confirmation'

const existingThreadReservation: StartIdentityReservationSet = {
  reservationSetId: 'reservation-set-1',
  scopeId: 'scope-1',
  existingThread: true,
  members: [{ method: 'turn/start', reservationId: 'turn-reservation-1' }],
  reservationEvidenceDigest: 'reservation-digest-1',
}

const lazyRootReservation: StartIdentityReservationSet = {
  reservationSetId: 'reservation-set-lazy-root',
  scopeId: 'scope-1',
  existingThread: false,
  members: [
    { method: 'thread/start', reservationId: 'thread-reservation-1' },
    { method: 'turn/start', reservationId: 'turn-reservation-2' },
  ],
  reservationEvidenceDigest: 'reservation-digest-lazy-root',
}

const persisted: PersistedIngress = {
  scope: 'pre-existing',
  message: 'persisted',
  attachments: 'metadata_persisted',
  inputAttachments: 'included',
}

const canonicalMessage = {
  id: 'assistant-1',
  conversationId: 'scope-1',
  role: 'assistant' as const,
  content: 'ok',
  timestamp: '2026-08-07T00:00:00.000Z',
  meta: {},
}

function createHarness(overrides: Partial<{
  scope: Record<string, unknown> | null
  methods: StartIdentityReservationMethods
  reserve: 'ok' | 'capacity' | 'busy'
  reservation: StartIdentityReservationSet
  persistError: IngressPersistenceError | Error
  prepareError: Error
  prepareReject: boolean
  emitError: Error
  scopeReadError: Error
  resolveError: Error
  reserveError: Error
  rawReservationResult: unknown
  rawPrepareResult: unknown
  validateDispatchContext: (value: unknown) => boolean
  prepareFactory: () => unknown
}> = {}) {
  const calls: string[] = []
  const methods = overrides.methods || (['turn/start'] as const)
  return {
    calls,
    send: () => runConfirmedSendScoped({
      scopeId: 'scope-1',
      requestId: 'request-1',
      userMessage: {
        id: 'user-1',
        content: 'hello',
        timestamp: '2026-08-07T00:00:00.000Z',
        meta: {},
        attachmentConfirmation: {
          selectedCount: 0,
          metadataCount: 0,
          inputIncludedCount: 0,
          inputFailedCount: 0,
        },
      },
      getScope: () => {
        if (overrides.scopeReadError) throw overrides.scopeReadError
        return overrides.scope === undefined ? { id: 'scope-1' } : overrides.scope
      },
      resolveStartIdentityMethods: () => {
        calls.push(`resolve:${methods.join('+')}`)
        if (overrides.resolveError) throw overrides.resolveError
        return methods
      },
      reserveStartIdentitySet: async ({ methods: requested }) => {
        calls.push(`reserve:${requested.join('+')}`)
        if (overrides.reserveError) throw overrides.reserveError
        if (overrides.rawReservationResult !== undefined) {
          return overrides.rawReservationResult as never
        }
        if (overrides.reserve === 'capacity') {
          return {
            ok: false as const,
            code: 'start_identity_capacity_exhausted' as const,
            retryableByUser: true,
            error: 'start_identity_capacity_exhausted',
            admissionEvidenceDigest: 'capacity-digest',
          }
        }
        if (overrides.reserve === 'busy') {
          return {
            ok: false as const,
            code: 'thread_busy' as const,
            retryableByUser: false,
            error: 'thread_busy',
            admissionEvidenceDigest: 'busy-digest',
          }
        }
        return {
          ok: true as const,
          reservation: overrides.reservation
            || (methods.length === 2 ? lazyRootReservation : existingThreadReservation),
        }
      },
      reconcileReservationContractFailure: async () => {
        calls.push('reconcile-reservation-contract-failure')
      },
      prepareDispatch: async () => {
        calls.push('prepare-dispatch')
        if (overrides.prepareError) throw overrides.prepareError
        if (overrides.prepareFactory) return overrides.prepareFactory() as never
        if (overrides.rawPrepareResult !== undefined) {
          return overrides.rawPrepareResult as never
        }
        if (overrides.prepareReject) {
          return {
            ok: false as const,
            code: 'host_unavailable' as const,
            retryableByUser: false,
            error: 'invalid_product_ingress',
            admissionEvidenceDigest: 'invalid-product-ingress-digest',
          }
        }
        return {
          ok: true as const,
          dispatchContext: { preparedRunId: 'run-1' },
        }
      },
      validateDispatchContext: (value): value is { preparedRunId: string } => (
        overrides.validateDispatchContext
          ? overrides.validateDispatchContext(value)
          : Boolean(value)
            && typeof value === 'object'
            && (value as { preparedRunId?: unknown }).preparedRunId === 'run-1'
      ),
      persistIngressAtomic: async () => {
        calls.push('persist-ingress')
        if (overrides.persistError) throw overrides.persistError
        return {
          persistence: persisted,
          event: {
            type: 'ingress_admitted',
            requestId: 'request-1',
            scopeId: 'scope-1',
            originUserMessageId: 'user-1',
            ingressAdmittedRevision: 1,
            ingressAdmittedDigest: 'ingress-admitted-digest',
            admittedAt: '2026-08-07T00:00:00.000Z',
          },
        }
      },
      emitIngressAdmitted: () => {
        calls.push('emit-ingress-admitted')
        if (overrides.emitError) throw overrides.emitError
      },
      releaseReservationAfterIngressFailure: async () => {
        calls.push('release-reservation')
      },
      releaseReservationAfterPrePersistenceRejection: async () => {
        calls.push('release-pre-persistence-reservation')
      },
      runConfirmed: async ({ persistence, dispatchContext }) => {
        calls.push('run-native')
        assert.deepEqual(dispatchContext, { preparedRunId: 'run-1' })
        return {
          success: true as const,
          disposition: 'terminal_success' as const,
          ownerRunId: 'run-1',
          shouldClearInput: true as const,
          preserveInput: false as const,
          retryableByUser: false as const,
          persistence,
          responseText: 'ok',
          canonicalMessage,
          canonicalMessageDigest: 'canonical-digest',
        }
      },
    }),
  }
}

test('attachment confirmation separates metadata and model-input state', () => {
  assert.deepEqual(resolveAttachmentConfirmation({
    selectedCount: 2,
    metadataCount: 1,
    inputIncludedCount: 1,
    inputFailedCount: 1,
  }), {
    attachments: 'metadata_partial',
    inputAttachments: 'partial',
  })
})

test('existing thread reserves its complete one-member set before any persistence', async () => {
  const harness = createHarness()
  const result = await harness.send()

  assert.equal(result.disposition, 'terminal_success')
  assert.deepEqual(harness.calls, [
    'resolve:turn/start',
    'reserve:turn/start',
    'prepare-dispatch',
    'persist-ingress',
    'emit-ingress-admitted',
    'run-native',
  ])
})

test('renderer admission delivery failure cannot cancel dispatch after persistence', async () => {
  const harness = createHarness({ emitError: new Error('renderer_gone') })
  const result = await harness.send()

  assert.equal(result.disposition, 'terminal_success')
  assert.deepEqual(harness.calls, [
    'resolve:turn/start',
    'reserve:turn/start',
    'prepare-dispatch',
    'persist-ingress',
    'emit-ingress-admitted',
    'run-native',
  ])
})

test('lazy root requests thread and turn capacity atomically before persistence', async () => {
  const harness = createHarness({ methods: ['thread/start', 'turn/start'] })
  await harness.send()

  assert.deepEqual(harness.calls.slice(0, 2), [
    'resolve:thread/start+turn/start',
    'reserve:thread/start+turn/start',
  ])
  assert.equal(harness.calls.includes('persist-ingress'), true)
})

test('product dispatch preparation is proven before the ingress transaction begins', async () => {
  for (const overrides of [
    { prepareReject: true },
    { prepareError: new Error('preparer_crashed') },
  ]) {
    const harness = createHarness(overrides)
    const result = await harness.send()

    assert.equal(result.disposition, 'rejected_before_persistence')
    assert.equal(result.errorKind, 'host_unavailable')
    assert.equal(harness.calls.includes('persist-ingress'), false)
    assert.equal(harness.calls.includes('emit-ingress-admitted'), false)
    assert.equal(harness.calls.includes('run-native'), false)
    assert.deepEqual(harness.calls, [
      'resolve:turn/start',
      'reserve:turn/start',
      'prepare-dispatch',
      'release-pre-persistence-reservation',
    ])
  }
})

test('malformed preparation results release capacity and cannot cross persistence', async () => {
  for (const rawPrepareResult of [
    null,
    { ok: true },
    { ok: true, dispatchContext: { preparedRunId: 'forged-run' } },
    {
      ok: false,
      code: 'forged_error_kind',
      retryableByUser: true,
      error: 'forged',
      admissionEvidenceDigest: 'forged-digest',
    },
  ]) {
    const harness = createHarness({ rawPrepareResult })
    const result = await harness.send()

    assert.equal(result.disposition, 'rejected_before_persistence')
    if (result.disposition !== 'rejected_before_persistence') continue
    assert.equal(result.errorKind, 'host_unavailable')
    assert.equal(result.error, 'dispatch_preparation_contract_invalid')
    assert.deepEqual(harness.calls, [
      'resolve:turn/start',
      'reserve:turn/start',
      'prepare-dispatch',
      'release-pre-persistence-reservation',
    ])
  }
})

test('a well-shaped prepared run for another scope is rejected before persistence', async () => {
  const preparation = new CodexProductRunPreparer().prepare({
    taskId: 'task-1',
    runId: 'run-1',
    requestId: 'request-1',
    scopeId: 'scope-other',
    aliasId: 'scope-other',
    aliasGeneration: 1,
    taskOrigin: 'user_root',
    runOrigin: 'initial',
    originUserMessageId: 'user-1',
    reservationSetId: existingThreadReservation.reservationSetId,
    reservationEvidenceDigest: existingThreadReservation.reservationEvidenceDigest,
    currentInput: [textUserInput('hello')],
    explicitResourceEnvelope: { input: [], resourceRefs: [] },
    resourceAdditionalContext: [],
    readyToolSurface: {
      surfaceId: 'surface-1',
      toolSurfaceDigest: 'surface-digest',
      toolNames: ['ready_read'],
    },
    readyTurnToolAuthorization: {
      authorizationId: 'authorization-1',
      authorizationDigest: 'authorization-digest',
    },
    authorizationOwnerId: 'authorization-owner-1',
    resourceOwnerId: 'resource-owner-1',
    productBudgetSeed: {
      maxIterations: 8,
      maxToolCalls: 4,
      maxParallelToolGroups: 1,
    },
  })
  assert.equal(preparation.ok, true)
  if (!preparation.ok) return

  const harness = createHarness({
    rawPrepareResult: { ok: true, dispatchContext: preparation.prepared },
    validateDispatchContext: (value) => preparedCodexProductRunMatchesIngress(value, {
      scopeId: 'scope-1',
      aliasId: 'scope-1',
      aliasGeneration: 1,
      requestId: 'request-1',
      originUserMessageId: 'user-1',
      reservationSetId: existingThreadReservation.reservationSetId,
      reservationEvidenceDigest: existingThreadReservation.reservationEvidenceDigest,
    }),
  })
  const result = await harness.send()

  assert.equal(result.disposition, 'rejected_before_persistence')
  assert.equal(harness.calls.includes('persist-ingress'), false)
  assert.equal(harness.calls.includes('emit-ingress-admitted'), false)
  assert.equal(harness.calls.includes('run-native'), false)
  assert.equal(harness.calls.includes('release-pre-persistence-reservation'), true)
})

test('resource version conflict from the real preparer cannot begin ingress persistence', async () => {
  const currentResource = {
    logicalResourceId: 'document-1',
    currentVersion: 'v2',
    currentDigest: 'digest-v2',
    supersedesVersion: 'v1',
    policyEpoch: 2,
  }
  const harness = createHarness({
    prepareFactory: () => {
      const preparation = new CodexProductRunPreparer().prepare({
        taskId: 'task-1',
        runId: 'run-1',
        requestId: 'request-1',
        scopeId: 'scope-1',
        aliasId: 'scope-1',
        aliasGeneration: 1,
        taskOrigin: 'user_root',
        runOrigin: 'initial',
        originUserMessageId: 'user-1',
        reservationSetId: existingThreadReservation.reservationSetId,
        reservationEvidenceDigest: existingThreadReservation.reservationEvidenceDigest,
        currentInput: [textUserInput('hello')],
        explicitResourceEnvelope: { input: [], resourceRefs: [currentResource] },
        resourceAdditionalContext: [{ ...currentResource, currentDigest: 'conflicting-digest-v2' }],
        readyToolSurface: {
          surfaceId: 'surface-1',
          toolSurfaceDigest: 'surface-digest',
          toolNames: ['ready_read'],
        },
        readyTurnToolAuthorization: {
          authorizationId: 'authorization-1',
          authorizationDigest: 'authorization-digest',
        },
        authorizationOwnerId: 'authorization-owner-1',
        resourceOwnerId: 'resource-owner-1',
        productBudgetSeed: {
          maxIterations: 8,
          maxToolCalls: 4,
          maxParallelToolGroups: 1,
        },
      })
      assert.deepEqual(preparation, { ok: false, code: 'invalid_product_ingress' })
      return {
        ok: false,
        code: 'host_unavailable',
        retryableByUser: false,
        error: preparation.code,
        admissionEvidenceDigest: 'resource-reference-conflict',
      }
    },
  })
  const result = await harness.send()

  assert.equal(result.disposition, 'rejected_before_persistence')
  assert.deepEqual(harness.calls, [
    'resolve:turn/start',
    'reserve:turn/start',
    'prepare-dispatch',
    'release-pre-persistence-reservation',
  ])
})

test('reservation identity must exactly match the requested scope and method set', async () => {
  for (const reservation of [
    existingThreadReservation,
    { ...lazyRootReservation, scopeId: 'scope-other' },
    {
      ...lazyRootReservation,
      members: [
        lazyRootReservation.members[0],
        { method: 'turn/start' as const, reservationId: lazyRootReservation.members[0].reservationId },
      ] as const,
    },
  ]) {
    const harness = createHarness({
      methods: ['thread/start', 'turn/start'],
      reservation: reservation as StartIdentityReservationSet,
    })
    const result = await harness.send()
    assert.equal(result.disposition, 'rejected_before_persistence')
    assert.equal(result.errorKind, 'host_unavailable')
    assert.equal(harness.calls.includes('persist-ingress'), false)
    assert.equal(harness.calls.includes('run-native'), false)
    assert.equal(harness.calls.includes('release-reservation'), false)
    assert.equal(harness.calls.includes('reconcile-reservation-contract-failure'), true)
  }
})

test('missing scope is rejected without lazy creation or reservation', async () => {
  const harness = createHarness({ scope: null })
  const result = await harness.send()

  assert.deepEqual(result, {
    success: false,
    disposition: 'rejected_before_persistence',
    shouldClearInput: false,
    preserveInput: true,
    retryableByUser: false,
    persistence: {
      scope: 'failed',
      message: 'skipped',
      attachments: 'none',
      inputAttachments: 'none',
    },
    error: 'Conversation scope not found: scope-1',
    errorKind: 'scope_missing',
    admissionEvidenceDigest: 'scope_missing:scope-1',
  })
  assert.deepEqual(harness.calls, [])
})

test('capacity and busy rejection have zero product persistence and zero native dispatch', async () => {
  for (const reserve of ['capacity', 'busy'] as const) {
    const harness = createHarness({ reserve })
    const result = await harness.send()

    assert.equal(result.disposition, 'rejected_before_persistence')
    assert.equal(result.shouldClearInput, false)
    assert.deepEqual(harness.calls, [
      'resolve:turn/start',
      'reserve:turn/start',
    ])
  }
})

test('scope, identity resolution, and reservation throws are exact pre-persistence rejections', async () => {
  const cases = [
    {
      overrides: { scopeReadError: new Error('scope_database_unavailable') },
      expectedCalls: [] as string[],
      expectedScope: 'failed',
      expectedDigest: 'scope_read_failed:scope-1',
    },
    {
      overrides: { resolveError: new Error('identity_resolution_unavailable') },
      expectedCalls: ['resolve:turn/start'],
      expectedScope: 'pre-existing',
      expectedDigest: 'start_identity_resolution_failed:scope-1',
    },
    {
      overrides: { reserveError: new Error('reservation_database_unavailable') },
      expectedCalls: ['resolve:turn/start', 'reserve:turn/start'],
      expectedScope: 'pre-existing',
      expectedDigest: 'start_identity_reservation_failed:scope-1',
    },
  ] as const

  for (const entry of cases) {
    const harness = createHarness(entry.overrides)
    const result = await harness.send()

    assert.equal(result.disposition, 'rejected_before_persistence')
    if (result.disposition !== 'rejected_before_persistence') continue
    assert.equal(result.errorKind, 'host_unavailable')
    assert.equal(result.retryableByUser, false)
    assert.equal(result.shouldClearInput, false)
    assert.equal(result.preserveInput, true)
    assert.equal(result.persistence.scope, entry.expectedScope)
    assert.equal(result.admissionEvidenceDigest, entry.expectedDigest)
    assert.deepEqual(harness.calls, entry.expectedCalls)
    assert.equal(harness.calls.includes('prepare-dispatch'), false)
    assert.equal(harness.calls.includes('persist-ingress'), false)
    assert.equal(harness.calls.includes('emit-ingress-admitted'), false)
    assert.equal(harness.calls.includes('run-native'), false)
  }
})

test('malformed reservation port results fail closed and enter reconciliation', async () => {
  const malformedResults = [
    null,
    { ok: false, code: 'future_error' },
    {
      ok: false,
      code: 'thread_busy',
      retryableByUser: false,
      error: 'thread_busy',
      admissionEvidenceDigest: 'busy-digest',
      reservation: existingThreadReservation,
    },
    {
      ok: true,
      reservation: {
        ...existingThreadReservation,
        reservationSetId: 7,
      },
    },
    {
      ok: true,
      reservation: {
        ...existingThreadReservation,
        members: [{ method: 'turn/start', reservationId: '' }],
      },
    },
  ]

  for (const rawReservationResult of malformedResults) {
    const harness = createHarness({ rawReservationResult })
    const result = await harness.send()

    assert.equal(result.disposition, 'rejected_before_persistence')
    if (result.disposition !== 'rejected_before_persistence') continue
    assert.equal(result.errorKind, 'host_unavailable')
    assert.equal(result.error, 'start_identity_reservation_contract_invalid')
    assert.equal(result.admissionEvidenceDigest, 'start_identity_reservation_contract_invalid:scope-1')
    assert.deepEqual(harness.calls, [
      'resolve:turn/start',
      'reserve:turn/start',
      'reconcile-reservation-contract-failure',
    ])
  }
})

test('atomic ingress failure releases the full reservation and preserves the composer', async () => {
  const harness = createHarness({
    persistError: new IngressPersistenceError(
      'ingress_message_persist_failed',
      'ingress-failure-digest',
      'message transaction failed',
    ),
  })
  const result = await harness.send()

  assert.deepEqual(result, {
    success: false,
    disposition: 'ingress_persistence_failed',
    shouldClearInput: false,
    preserveInput: true,
    retryableByUser: true,
    persistence: {
      scope: 'pre-existing',
      message: 'failed',
      attachments: 'none',
      inputAttachments: 'none',
    },
    error: 'message transaction failed',
    errorKind: 'ingress_message_persist_failed',
    evidenceDigest: 'ingress-failure-digest',
  })
  assert.deepEqual(harness.calls, [
    'resolve:turn/start',
    'reserve:turn/start',
    'prepare-dispatch',
    'persist-ingress',
    'release-reservation',
  ])
})
