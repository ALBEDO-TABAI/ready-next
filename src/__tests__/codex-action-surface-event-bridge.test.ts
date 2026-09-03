import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseCodexActionSurfaceInvalidation,
  type CodexActionSurfaceInvalidation,
  type CodexActionSurfaceEnvelope,
  type IngressAdmittedEvent,
  type ProductTurnReceipt,
  type SendScopedRequest,
} from '../shared/ipc-contracts/agent-runtime'
import { shouldHydrateCodexActionSurface } from '../renderer/modules/agent/codex-action-surface-invalidation'
import { initAgentListeners, useAgent } from '../renderer/stores/useAgent'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import type { ConversationScope } from '../renderer/modules/agent/types'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import { projectCodexLifecycleOperationV2 } from '../main/modules/agent-control/codex-runtime/codex-lifecycle-action-surface'
import { runConfirmedSendScoped } from '../main/modules/agent-control/send-scoped-confirmation'
import { createEmptyScopeRunState } from '../renderer/modules/agent/scopeRunState'
import { makeProductTurnActionProjection } from './product-turn-action-projection-fixture'
import { useMode } from '../renderer/stores/useMode'
import { productTurnActionProjectionMatchesContext } from '../renderer/modules/agent/productTurnReceipt'
import { createRuntimeDriverCanonicalTerminal } from '../renderer/modules/agent/runtime-driver-canonical-terminal'

const event = parseCodexActionSurfaceInvalidation({
  contract: 'codex_action_surface_invalidation_v1',
  scopeId: 'scope-1',
  scopeEpoch: 2,
  aliasGeneration: 3,
  actionProjectionSequence: 5,
})

test('action-surface invalidation accepts only exact typed committed identity', () => {
  assert.equal(event.scopeId, 'scope-1')
  assert.throws(() => parseCodexActionSurfaceInvalidation({ ...event, extra: true }))
  assert.throws(() => parseCodexActionSurfaceInvalidation({ ...event, actionProjectionSequence: -1 }))
})

test('renderer hydrates only a newer invalidation for the visible scope', () => {
  assert.equal(shouldHydrateCodexActionSurface({
    event,
    currentScopeId: 'scope-1',
    currentVersion: { scopeEpoch: 2, headGeneration: 3, actionProjectionSequence: 4 },
  }), true)
  assert.equal(shouldHydrateCodexActionSurface({
    event,
    currentScopeId: 'scope-1',
    currentVersion: { scopeEpoch: 2, headGeneration: 3, actionProjectionSequence: 5 },
  }), false)
  assert.equal(shouldHydrateCodexActionSurface({
    event,
    currentScopeId: 'other',
    currentVersion: null,
  }), false)
})

const scopeId = 'scope-fork-surface'
const sessionId = 'session-fork-surface'
const draft = '普通 C：继续之前的工作'

function surface(generation: number, sequence = generation, activeRunId: string | null = null, scopeEpoch = 0): CodexActionSurfaceEnvelope {
  const head = projectCodexHeadActionProjection({
    scopeId, scopeEpoch, aliasId: scopeId, aliasGeneration: generation,
    threadBindingId: `binding-${generation}`, headRevision: generation,
    actionProjectionSequence: sequence, materializationKind: 'native_fork',
    materializationState: 'confirmed', codexThreadId: `native-${generation}`,
    continuationBlocked: false, activeProductFence: Boolean(activeRunId),
    manualCompactionState: 'none', hasLegacyPreparedRun: false,
    headRuntimeManifestDigest: 'runtime', headProtocolSchemaDigest: 'protocol',
    currentRuntimeManifestDigest: 'runtime', currentProtocolSchemaDigest: 'protocol',
  })
  return {
    scopeId, scopeEpoch, head,
    lifecycle: projectCodexLifecycleOperationV2({
      base: {
        identity: { aliasId: scopeId, aliasGeneration: generation },
        activeReadyRunId: activeRunId, latestReadyRunId: activeRunId,
        snapshot: activeRunId ? 'product_turn_interruptible' : 'idle_native_thread',
        interruptRequested: false, interruptAcknowledged: false,
        requestedAction: null, evidenceDigest: `native-read-${generation}-${sequence}`,
      },
      head, scopeEpoch, threadBindingId: `binding-${generation}`,
      headRevision: generation, materializationIntentRef: null,
    }),
  }
}

function seedSurface() {
  const initial = surface(1)
  const scope: ConversationScope = {
    id: scopeId, aliasGeneration: 1, messageVisibilityEpoch: 0,
    agent: 'butler', activeAgentId: 'butler', handoffGeneration: 0,
    title: 'Fork continuity', sourceKind: 'local', sourceId: 'app', threadKey: scopeId,
    meta: {}, createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z', lastMessageAt: null,
  }
  const slice = {
    ...makeEmptySessionSlice(scopeId), aliasGeneration: 1, inputValue: draft,
    lifecycleOperationProjection: initial.lifecycle, scopeHeadActionProjection: initial.head,
  }
  useAgent.setState({
    ...slice, currentAgent: 'butler', currentScopeId: scopeId, currentScope: scope,
    scopes: [scope], conversations: [], attachments: [], filePool: [],
    pendingContinuationIntent: null, pendingContinuationDraftAnchor: null,
    scopeLiveMessages: {}, retiredScopeIds: {}, scopeAuthorityRevision: 0,
    scopeListRequestRevision: 0, sessions: { [sessionId]: slice },
    activeSessionId: sessionId, sessionId, sessionOrder: [sessionId], taskDisclosureState: {},
  })
  return initial
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function installSurfaceApi(api: Record<string, unknown>) {
  const previousWindow = globalThis.window
  let onInvalidation!: (value: CodexActionSurfaceInvalidation) => void
  let onAdmitted!: (value: IngressAdmittedEvent) => void
  let onMemoryChanged!: () => void
  const scopeRunListeners = new Set<(event: unknown) => void>()
  const noSubscription = () => () => {}
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { agent: {
      onStream: noSubscription, onStatusChange: noSubscription, onError: noSubscription,
      onToolAction: noSubscription, onToolActionRequest: noSubscription,
      onCancelToolActionRequest: noSubscription, onConversationEvent: noSubscription,
      onCodexActionSurfaceInvalidated: (listener: typeof onInvalidation) => {
        onInvalidation = listener
        return noSubscription()
      },
      onIngressAdmitted: (listener: typeof onAdmitted) => {
        onAdmitted = listener
        return noSubscription()
      },
      onReadyMemoryStateChanged: (listener: typeof onMemoryChanged) => {
        onMemoryChanged = listener
        return noSubscription()
      },
      onScopeRunEvent: (listener: (event: unknown) => void) => {
        scopeRunListeners.add(listener)
        return () => { scopeRunListeners.delete(listener) }
      },
      getConversationScopeMessages: async () => ({ success: true, data: [] }),
      ...api,
    } } },
  })
  const off = initAgentListeners()
  return {
    invalidate(generation: number, sequence = generation, scopeEpoch = 0) {
      onInvalidation(parseCodexActionSurfaceInvalidation({
        contract: 'codex_action_surface_invalidation_v1', scopeId, scopeEpoch,
        aliasGeneration: generation, actionProjectionSequence: sequence,
      }))
    },
    admit(value: IngressAdmittedEvent) { onAdmitted(value) },
    memoryChanged() { onMemoryChanged() },
    terminal(receipt: ProductTurnReceipt) {
      for (const listener of scopeRunListeners) listener({
        type: 'terminal', phase: 'error', agent: 'butler', scopeId,
        aliasGeneration: 1, messageVisibilityEpoch: 0, runId: receipt.readyRunId,
        timestamp: receipt.canonicalMessage.timestamp, productTurnReceipt: receipt,
      })
    },
    restore() {
      off()
      Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
    },
  }
}

test('reset return refreshes the cleared action surface before the next ordinary send', async () => {
  for (const eventReadPending of [false, true]) {
    seedSurface()
    const next = surface(2, 2, null, 1)
    const oldRead = deferred<{ success: true; data: CodexActionSurfaceEnvelope }>()
    let nextReads = 0
    let resetReturned = false
    const sent: SendScopedRequest[] = []
    const api = installSurfaceApi({
      readCodexActionSurface: async ({ aliasGeneration }: { aliasGeneration: number }) => {
        if (aliasGeneration === 1) return { success: true, data: surface(1) }
        nextReads += 1
        return eventReadPending && !resetReturned
          ? oldRead.promise : { success: true, data: next }
      },
      resetSession: async () => {
        api.invalidate(2, 2, 1)
        await flush()
        resetReturned = true
        return { ok: true, action: 'reset', aliasId: scopeId,
          retiredGeneration: 1, newGeneration: 2, transactionDigest: 'reset-committed' }
      },
      sendScoped: async (request: SendScopedRequest) => {
        sent.push(request)
        return { success: false, disposition: 'rejected_before_persistence',
          shouldClearInput: false, preserveInput: true, errorKind: 'host_unavailable' }
      },
    })
    try {
      assert.equal((await useAgent.getState().resetCurrentConversation()).ok, true)
      assert.deepEqual(useAgent.getState().sessions[sessionId].scopeHeadActionProjection, next.head,
        'reset clears old actions, then its return must read the new head again')
      assert.equal(nextReads, 1, 'the reset owner prevents an event read from replacing its pending transition')
      oldRead.resolve({ success: true, data: next })
      await flush()
      await useAgent.getState().sendMessage('重置后的完整新问题')
      assert.equal(sent.length, 1)
      assert.equal(sent[0].expectedAliasGeneration, 2)
      assert.equal(sent[0].expectedMessageVisibilityEpoch, 1)
      assert.deepEqual(sent[0].actionAdmissionRef, {
        headProjectionDigest: next.head.evidenceDigest,
        actionProjectionVersion: next.head.actionProjectionVersion,
        actionHeadIdentity: next.head.actionHeadIdentity,
      })
    } finally {
      oldRead.resolve({ success: true, data: next })
      await flush()
      api.restore()
    }
  }
})

test('gen1 → gen2 invalidation reads Main atomically and ordinary C sends that exact admission reference', async () => {
  seedSurface()
  const next = surface(2)
  const pending = deferred<{ success: true; data: CodexActionSurfaceEnvelope }>()
  const reads: unknown[] = []
  const calls: string[] = []
  const seen: number[][] = []
  const unsubscribe = useAgent.subscribe((state) => {
    const slice = state.sessions[sessionId]
    seen.push([
      state.currentScope?.aliasGeneration || 0,
      state.scopes.find((candidate) => candidate.id === scopeId)?.aliasGeneration || 0,
      slice.aliasGeneration || 0,
      slice.lifecycleOperationProjection?.identity.aliasGeneration || 0,
      slice.scopeHeadActionProjection?.actionProjectionVersion.headGeneration || 0,
    ])
  })
  const api = installSurfaceApi({
    readCodexActionSurface: async (request: unknown) => { reads.push(request); return pending.promise },
    sendScoped: async (payload: SendScopedRequest) => {
      assert.equal(payload.expectedAliasGeneration, 2)
      assert.deepEqual(payload.actionAdmissionRef, {
        headProjectionDigest: next.head.evidenceDigest,
        actionProjectionVersion: next.head.actionProjectionVersion,
        actionHeadIdentity: next.head.actionHeadIdentity,
      })
      return runConfirmedSendScoped({
        scopeId, requestId: payload.requestId!, userMessage: payload.userMessage!,
        getScope: () => ({ id: scopeId, aliasGeneration: 2 }),
        resolveStartIdentityMethods: () => ['turn/start'],
        reserveStartIdentitySet: async ({ methods }) => {
          calls.push(`reserve:${methods.join(',')}`)
          return { ok: true, reservation: {
            reservationSetId: 'set-C', scopeId, existingThread: true,
            members: [{ method: 'turn/start', reservationId: 'start-C' }],
            reservationEvidenceDigest: 'reservation-C',
          } }
        },
        reconcileReservationContractFailure: async () => { assert.fail('reservation conflict') },
        prepareDispatch: async () => ({ ok: true, dispatchContext: { nativeThreadId: 'native-2' } }),
        validateDispatchContext: (value): value is { nativeThreadId: string } => (
          (value as { nativeThreadId?: string }).nativeThreadId === 'native-2'
        ),
        persistIngressAtomic: async () => {
          calls.push('persist-C')
          return {
            persistence: { scope: 'pre-existing', message: 'persisted', attachments: 'none', inputAttachments: 'none' },
            event: {
              type: 'ingress_admitted', requestId: payload.requestId!, scopeId,
              originUserMessageId: payload.userMessage!.id, aliasGeneration: 2,
              messageVisibilityEpoch: 0, ingressAdmittedRevision: 1,
              ingressAdmittedDigest: 'admitted-C', admittedAt: '2026-09-03T00:00:00.000Z',
            },
          }
        },
        emitIngressAdmitted: (admitted) => { calls.push('admit-C'); api.admit(admitted) },
        releaseReservationAfterIngressFailure: async () => { assert.fail('persistence failure') },
        releaseReservationAfterPrePersistenceRejection: async () => { assert.fail('admission rejection') },
        runConfirmed: async ({ persistence }) => ({
          success: true, disposition: 'terminal_success', ownerRunId: payload.requestId!,
          shouldClearInput: true, preserveInput: false, persistence,
          responseText: 'C completed', productOutcomeDigest: 'outcome-C',
          canonicalMessageDigest: 'canonical-C', canonicalMessage: {
            id: 'assistant-C', conversationId: scopeId, role: 'assistant', content: 'C completed',
            timestamp: '2026-09-03T00:00:01.000Z', meta: { runId: payload.requestId! },
          },
        }),
      })
    },
  })
  try {
    api.invalidate(2)
    await flush()
    assert.deepEqual(reads, [{ aliasId: scopeId, aliasGeneration: 2 }])
    assert.equal(useAgent.getState().sessions[sessionId].aliasGeneration, 1,
      'the notification is only a read target, not authority to advance the renderer')
    assert.equal(useAgent.getState().inputValue, draft)
    pending.resolve({ success: true, data: next })
    await flush()
    assert.deepEqual(seen, [[2, 2, 2, 2, 2]], 'all five consumers change in one store publication')
    unsubscribe()
    assert.equal(useAgent.getState().inputValue, draft)
    const result = await useAgent.getState().sendMessage(draft)
    assert.equal(result.disposition, 'terminal_success')
    assert.deepEqual(calls, ['reserve:turn/start', 'persist-C', 'admit-C'])
    assert.equal(useAgent.getState().inputValue, '')
  } finally {
    unsubscribe()
    api.restore()
  }
})

test('late gen1 success or failure cannot overwrite the gen2 atomic surface', async () => {
  for (const oldResult of [{ success: true, data: surface(1) }, { success: false }] as const) {
    seedSurface()
    const pendingOld = deferred<typeof oldResult>()
    const next = surface(2)
    const reads: number[] = []
    const api = installSurfaceApi({
      readCodexActionSurface: async (request: { aliasGeneration: number }) => {
        reads.push(request.aliasGeneration)
        return request.aliasGeneration === 1 ? pendingOld.promise : { success: true, data: next }
      },
    })
    try {
      const oldLoad = useAgent.getState().loadScope(scopeId)
      await flush()
      api.invalidate(2)
      await flush()
      pendingOld.resolve(oldResult)
      await oldLoad
      const state = useAgent.getState()
      assert.deepEqual(reads, [1, 2])
      assert.equal(state.currentScope?.aliasGeneration, 2)
      assert.equal(state.sessions[sessionId].aliasGeneration, 2)
      assert.deepEqual(state.sessions[sessionId].scopeHeadActionProjection, next.head)
      assert.deepEqual(state.sessions[sessionId].lifecycleOperationProjection, next.lifecycle)
      assert.equal(state.inputValue, draft)
    } finally { api.restore() }
  }
})

test('failed gen2 read keeps the draft and does not advance identity from the notification', async () => {
  seedSurface()
  const api = installSurfaceApi({ readCodexActionSurface: async () => ({ success: false }) })
  try {
    api.invalidate(2)
    await flush()
    const state = useAgent.getState()
    assert.equal(state.currentScope?.aliasGeneration, 1)
    assert.equal(state.sessions[sessionId].aliasGeneration, 1)
    assert.equal(state.inputValue, draft)
    assert.equal(state.sessions[sessionId].scopeHeadActionProjection, null)
    assert.equal(state.sessions[sessionId].lifecycleOperationProjection, null)
  } finally { api.restore() }
})

test('a superseded read cannot publish even when it finishes before the newer read', async () => {
  const initial = seedSurface()
  const old = deferred<{ success: true; data: CodexActionSurfaceEnvelope }>()
  const next = deferred<{ success: true; data: CodexActionSurfaceEnvelope }>()
  const api = installSurfaceApi({
    readCodexActionSurface: (request: { aliasGeneration: number }) => (
      request.aliasGeneration === 1 ? old.promise : next.promise
    ),
  })
  try {
    const loading = useAgent.getState().loadScope(scopeId)
    await flush()
    api.invalidate(2)
    old.resolve({ success: true, data: surface(1, 2) })
    await loading
    assert.deepEqual(useAgent.getState().sessions[sessionId].scopeHeadActionProjection, initial.head)
    next.resolve({ success: true, data: surface(2) })
    await flush()
    assert.equal(useAgent.getState().sessions[sessionId].aliasGeneration, 2)
  } finally { api.restore() }
})

test('same-generation invalidations cannot replace an in-flight newer action version with an older one', async () => {
  seedSurface()
  const pending = deferred<{ success: true; data: CodexActionSurfaceEnvelope }>()
  const reads: unknown[] = []
  const api = installSurfaceApi({
    readCodexActionSurface: (request: unknown) => { reads.push(request); return pending.promise },
  })
  try {
    api.invalidate(1, 4)
    api.invalidate(1, 3)
    assert.equal(reads.length, 1)
    pending.resolve({ success: true, data: surface(1, 4) })
    await flush()
    assert.equal(useAgent.getState().sessions[sessionId]
      .scopeHeadActionProjection?.actionProjectionVersion.actionProjectionSequence, 4)
  } finally { api.restore() }
})

test('late history loading keeps the committed gen2 surface and rehydrates only its current generation', async () => {
  seedSurface()
  const history = deferred<{ success: true; data: [] }>()
  const next = surface(2)
  const reads: number[] = []
  const api = installSurfaceApi({
    getConversationScopeMessages: () => history.promise,
    readCodexActionSurface: async (request: { aliasGeneration: number }) => {
      reads.push(request.aliasGeneration)
      return { success: true, data: next }
    },
  })
  try {
    const loading = useAgent.getState().loadScope(scopeId)
    api.invalidate(2)
    await flush()
    const observedHeads: unknown[] = []
    const unsubscribe = useAgent.subscribe((state) => {
      observedHeads.push(state.sessions[sessionId].scopeHeadActionProjection)
    })
    try {
      history.resolve({ success: true, data: [] })
      await loading
      assert.deepEqual(reads, [2, 2])
      assert.ok(observedHeads.length > 0)
      assert.ok(observedHeads.every((head) => head === next.head))
      assert.equal(useAgent.getState().currentScope?.aliasGeneration, 2)
      assert.equal(useAgent.getState().inputValue, draft)
    } finally { unsubscribe() }
  } finally { api.restore() }
})

test('a stale gen1 streaming request does not veto the confirmed gen2 idle surface', async () => {
  seedSurface()
  useAgent.setState((state) => ({
    streamingRequestId: 'old-generation-run', isStreaming: true, foregroundBusy: true,
    composerLocked: true,
    sessions: { ...state.sessions, [sessionId]: {
      ...state.sessions[sessionId], streamingRequestId: 'old-generation-run', isStreaming: true,
      foregroundBusy: true, composerLocked: true,
    } },
  }))
  const api = installSurfaceApi({ readCodexActionSurface: async () => ({ success: true, data: surface(2) }) })
  try {
    api.invalidate(2)
    await flush()
    const state = useAgent.getState()
    assert.equal(state.sessions[sessionId].aliasGeneration, 2)
    assert.equal(state.isStreaming, false)
    assert.equal(state.foregroundBusy, false)
    assert.equal(state.composerLocked, false)
    assert.equal(state.streamingRequestId, null)
    assert.equal(state.inputValue, draft)
  } finally { api.restore() }
})

test('scope-list generation advance never compares the new action sequence against the retired generation', async () => {
  seedSurface()
  const old = surface(1, 20)
  useAgent.setState((state) => ({ sessions: { ...state.sessions, [sessionId]: {
    ...state.sessions[sessionId], scopeHeadActionProjection: old.head,
    lifecycleOperationProjection: old.lifecycle,
  } } }))
  const next = surface(2, 1)
  const scope = useAgent.getState().currentScope!
  const api = installSurfaceApi({
    listConversationScopes: async () => ({ success: true, data: [{ ...scope, aliasGeneration: 2 }] }),
    readCodexActionSurface: async () => ({ success: true, data: next }),
  })
  try {
    assert.equal(await useAgent.getState().loadScopes(), true)
    const state = useAgent.getState()
    assert.equal(state.currentScope?.aliasGeneration, 2)
    assert.deepEqual(state.sessions[sessionId].scopeHeadActionProjection, next.head)
    assert.deepEqual(state.sessions[sessionId].lifecycleOperationProjection, next.lifecycle)
  } finally { api.restore() }
})

function failedB(atSurface: CodexActionSurfaceEnvelope, busy = false): ProductTurnReceipt {
  const action = makeProductTurnActionProjection({ readyRunId: 'run-B', retryAvailability: 'ready' })
  assert.equal(action.retryEvidenceKind, 'complete')
  if (action.retryEvidenceKind !== 'complete') throw new Error('complete_fixture_required')
  return {
    contract: 'ready_product_turn_receipt_v3', readyRunId: 'run-B', readyTaskId: 'task-B',
    readyScopeId: scopeId, messageVisibilityEpoch: 0, ownerAliasGeneration: 1,
    revision: 1, terminal: 'error', canonicalMessage: {
      id: 'assistant-B', conversationId: scopeId, role: 'assistant', content: 'B 未完成',
      timestamp: '2026-09-03T00:00:00.000Z', meta: { runId: 'run-B' },
    },
    canonicalMessageDigest: 'canonical-B', tools: [], artifacts: [], memory: null,
    failure: { kind: 'transport', effectState: 'none', evidenceRefs: [] },
    publicationSealDigest: null, presentationDigest: 'presentation-B',
    actionProjection: {
      ...action,
      headProjectionRef: { version: atSurface.head.actionProjectionVersion, digest: atSurface.head.evidenceDigest },
      productTurnActionProjectionVersion: {
        ...action.productTurnActionProjectionVersion,
        headProjectionVersion: atSurface.head.actionProjectionVersion,
      },
      retry_failed_task: busy
        ? { availability: 'blocked', blockers: ['thread_busy'], consequence: null }
        : action.retry_failed_task,
      evidenceDigest: `B-at-${atSurface.head.evidenceDigest}`,
    },
  }
}

function seedFailedB() {
  const initial = seedSurface()
  const receipt = failedB(initial)
  const message = {
    id: 'assistant-B', agent: 'butler', type: 'agent' as const, content: 'B 未完成',
    timestamp: new Date(receipt.canonicalMessage.timestamp), meta: { runId: 'run-B' },
  }
  useAgent.setState((state) => ({ messages: [message], sessions: { ...state.sessions, [sessionId]: {
    ...state.sessions[sessionId], messages: [message],
    productTurnActionProjectionByRunId: { 'run-B': receipt.actionProjection },
  } } }))
  return receipt
}

test('failed send return and new successor hydration preserve canonical C across all read handoff orders', async () => {
  for (const order of ['old-finishes-after', 'old-finishes-during', 'new-starts-during'] as const) {
    seedFailedB()
    const next = surface(2, 2)
    const pending = deferred<{ success: true; data: ProductTurnReceipt[] }>()
    let receipt: ProductTurnReceipt
    let receiptReads = 0
    let sends = 0
    let secondPayload: SendScopedRequest | null = null
    const readGenerations: number[] = []
    const api = installSurfaceApi({
      readCodexActionSurface: async (request: { aliasGeneration: number }) => {
        readGenerations.push(request.aliasGeneration)
        return request.aliasGeneration === 2 ? { success: true, data: next } : { success: false }
      },
      readProductTurnPresentations: async () => {
        receiptReads += 1
        return receiptReads === 1 && order !== 'new-starts-during'
          ? pending.promise : { success: true, data: [receipt] }
      },
      getConversationScopeMessages: async () => {
        if (order === 'new-starts-during') {
          api.invalidate(2, 2)
          await flush()
        } else if (order === 'old-finishes-during') {
          pending.resolve({ success: true, data: [receipt] })
          await flush()
        }
        return { success: true, data: [receipt.canonicalMessage] }
      },
      sendScoped: async (payload: SendScopedRequest) => {
        sends += 1
        if (sends === 2) {
          secondPayload = payload
          return { success: false, disposition: 'rejected_before_persistence', errorKind: 'thread_busy' }
        }
        const base = failedB(next)
        receipt = {
          ...base, readyRunId: payload.requestId!,
          canonicalMessage: { ...base.canonicalMessage, id: 'assistant-C',
            meta: { runId: payload.requestId!, terminalReason: 'blocked_external' } },
          actionProjection: { ...base.actionProjection, ownerRunId: payload.requestId! },
        }
        api.admit({
          type: 'ingress_admitted', requestId: payload.requestId!, scopeId,
          originUserMessageId: payload.userMessage!.id, aliasGeneration: 1,
          messageVisibilityEpoch: 0, ingressAdmittedRevision: 1,
          ingressAdmittedDigest: 'admitted-C', admittedAt: receipt.canonicalMessage.timestamp,
        })
        if (order !== 'new-starts-during') {
          api.invalidate(2, 2)
          await flush()
          assert.equal(receiptReads, 1)
        }
        return {
          success: false, disposition: 'terminal_failure_after_persistence', aliasGeneration: 1,
          ownerRunId: payload.requestId, errorKind: 'unknown', error: 'intentional failure',
          shouldClearInput: true, preserveInput: false, productTurnReceipt: receipt,
          canonicalMessage: receipt.canonicalMessage, canonicalMessageDigest: receipt.canonicalMessageDigest,
        }
      },
      readProductTurnPresentation: async () => ({ success: true, data: receipt }),
    })
    try {
      const result = await useAgent.getState().sendMessage('当前 C')
      assert.equal(result.disposition, 'terminal_failure_after_persistence')
      assert.equal(useAgent.getState().sessions[sessionId].aliasGeneration, 2)
      assert.deepEqual(readGenerations, [2, 2], 'send-return must read its formal successor, never stale scope generation')
      assert.deepEqual(useAgent.getState().sessions[sessionId].scopeHeadActionProjection, next.head)
      assert.equal(useAgent.getState().sessions[sessionId].messages.find((message) => message.id === 'assistant-C')
        ?.meta?.terminalReason, 'blocked_external', 'idle successor cannot discard source C during canonical readback')
      pending.resolve({ success: true, data: [receipt!] })
      await flush()
      await useAgent.getState().sendMessage(order === 'new-starts-during' ? '再试一次' : '下一条普通消息')
      assert.equal(sends, 2)
      assert.equal(secondPayload!.expectedAliasGeneration, 2)
      if (order === 'new-starts-during') assert.equal(secondPayload!.explicitRetry?.predecessorRunId, receipt!.readyRunId)
      else assert.equal(secondPayload!.actionAdmissionRef?.headProjectionDigest, next.head.evidenceDigest)
    } finally {
      pending.resolve({ success: true, data: [] })
      await flush()
      api.restore()
    }
  }
})

test('idle hydration clears terminal state on reset epoch or a different latest owner, not an empty successor', async () => {
  for (const [scopeEpoch, latestReadyRunId, preserves] of [[0, null, true], [1, null, false], [0, 'run-D', false]] as const) {
    seedSurface()
    const run = { ...createEmptyScopeRunState({ scopeId, agent: 'butler', requestId: 'run-C' }),
      phase: 'error' as const, terminalReason: 'blocked_external' as const }
    useAgent.setState((state) => ({ sessions: { ...state.sessions, [sessionId]: {
      ...state.sessions[sessionId], scopeRunStates: { [scopeId]: run },
    } }, scopeRunStates: { [scopeId]: run } }))
    const next = surface(2, 2, null, scopeEpoch)
    next.lifecycle.latestReadyRunId = latestReadyRunId
    const api = installSurfaceApi({ readCodexActionSurface: async () => ({ success: true, data: next }) })
    try {
      api.invalidate(2, 2, scopeEpoch)
      await flush()
      assert.equal(Boolean(useAgent.getState().sessions[sessionId].scopeRunStates[scopeId]), preserves)
    } finally { api.restore() }
  }
})

test('gen2 hydration refreshes loaded failure B and C becoming active does not delete its Main projection', async () => {
  seedFailedB()
  let current = surface(2)
  let receipt = failedB(current)
  const receiptReads: string[][] = []
  const firstReceipts = deferred<{ success: true; data: ProductTurnReceipt[] }>()
  const activeReceipts = deferred<{ success: true; data: ProductTurnReceipt[] }>()
  const api = installSurfaceApi({
    readCodexActionSurface: async () => ({ success: true, data: current }),
    readProductTurnPresentations: async (runIds: string[]) => {
      receiptReads.push(runIds)
      return receiptReads.length === 1 ? firstReceipts.promise : activeReceipts.promise
    },
  })
  try {
    api.invalidate(2)
    await flush()
    assert.equal(useAgent.getState().sessions[sessionId].aliasGeneration, 1,
      'the common publication waits for the loaded-run receipt read')
    firstReceipts.resolve({ success: true, data: [receipt] })
    await flush()
    let state = useAgent.getState()
    assert.deepEqual(receiptReads, [['run-B']])
    assert.equal(state.currentScope?.aliasGeneration, 2)
    assert.deepEqual(state.sessions[sessionId].productTurnActionProjectionByRunId['run-B'], receipt.actionProjection)
    assert.equal(state.sessions[sessionId].productTurnActionProjectionByRunId['run-B']
      .retry_failed_task.availability, 'ready')

    const runC = createEmptyScopeRunState({ scopeId, agent: 'butler', requestId: 'run-C', phase: 'responding' })
    useAgent.setState((previous) => ({
      scopeRunStates: { [scopeId]: runC }, streamingRequestId: 'run-C', isStreaming: true,
      sessions: { ...previous.sessions, [sessionId]: { ...previous.sessions[sessionId],
        scopeRunStates: { [scopeId]: runC }, streamingRequestId: 'run-C', isStreaming: true,
      } },
    }))
    current = surface(2, 3, 'run-C')
    receipt = failedB(current, true)
    api.invalidate(2, 3)
    await flush()
    useAgent.setState((previous) => ({ sessions: { ...previous.sessions, [sessionId]: {
      ...previous.sessions[sessionId], scopeRunStates: { [scopeId]: {
        ...runC, responseBuffer: 'C is still streaming', updatedAt: '2026-09-03T00:00:03.000Z',
      } },
    } } }))
    activeReceipts.resolve({ success: true, data: [receipt] })
    await flush()
    state = useAgent.getState()
    assert.deepEqual(receiptReads, [['run-B'], ['run-B']])
    assert.equal(state.streamingRequestId, 'run-C')
    assert.equal(state.scopeRunStates[scopeId]?.responseBuffer, 'C is still streaming')
    assert.deepEqual(state.sessions[sessionId].productTurnActionProjectionByRunId['run-B'], receipt.actionProjection)
    assert.deepEqual(state.sessions[sessionId].productTurnActionProjectionByRunId['run-B']
      .retry_failed_task.blockers, ['thread_busy'])
  } finally { api.restore() }
})

test('late gen1 run receipts cannot replace B after the gen2 head and run projection were committed', async () => {
  const oldReceipt = seedFailedB()
  const old = deferred<{ success: true; data: ProductTurnReceipt[] }>()
  const next = surface(2)
  const nextReceipt = failedB(next)
  let reads = 0
  const api = installSurfaceApi({
    getConversationScopeMessages: async () => ({ success: true, data: [oldReceipt.canonicalMessage] }),
    readCodexActionSurface: async (request: { aliasGeneration: number }) => ({
      success: true, data: request.aliasGeneration === 1 ? surface(1) : next,
    }),
    readProductTurnPresentations: async () => {
      reads += 1
      return reads === 1 ? old.promise : { success: true, data: [nextReceipt] }
    },
  })
  try {
    const loading = useAgent.getState().loadScope(scopeId)
    await flush()
    api.invalidate(2)
    await flush()
    old.resolve({ success: true, data: [oldReceipt] })
    await loading
    const slice = useAgent.getState().sessions[sessionId]
    assert.equal(reads, 2)
    assert.equal(slice.aliasGeneration, 2)
    assert.deepEqual(slice.scopeHeadActionProjection, next.head)
    assert.deepEqual(slice.productTurnActionProjectionByRunId['run-B'], nextReceipt.actionProjection)
  } finally { api.restore() }
})

test('memory invalidation starts a fresh same-head read and a late ready receipt cannot undo the newer blocked receipt', async () => {
  const oldReceipt = seedFailedB()
  const oldProjection = oldReceipt.actionProjection
  assert.equal(oldProjection.retryEvidenceKind, 'complete')
  if (oldProjection.retryEvidenceKind !== 'complete') throw new Error('complete_fixture_required')
  const newerReceipt: ProductTurnReceipt = {
    ...oldReceipt,
    actionProjection: {
      ...oldProjection,
      currentReadyMemoryRef: {
        ...oldProjection.currentReadyMemoryRef,
        stateRevision: 2,
        modelVisiblePayloadEmpty: false,
        eligibilityDigest: 'memory-revision-2',
      },
      productTurnActionProjectionVersion: {
        ...oldProjection.productTurnActionProjectionVersion,
        readyMemoryStateRevision: 2,
      },
      retry_failed_task: {
        availability: 'blocked', blockers: ['current_memory_restatement_required'], consequence: null,
      },
      evidenceDigest: 'B-memory-revision-2',
    },
  }
  const oldRead = deferred<{ success: true; data: ProductTurnReceipt[] }>()
  let receiptReads = 0
  const api = installSurfaceApi({
    getConversationScopeMessages: async () => ({ success: true, data: [oldReceipt.canonicalMessage] }),
    readCodexActionSurface: async () => ({ success: true, data: surface(1) }),
    readProductTurnPresentations: async (runIds: string[]) => {
      assert.deepEqual(runIds, ['run-B'])
      receiptReads += 1
      return receiptReads === 1 ? oldRead.promise : { success: true, data: [newerReceipt] }
    },
  })
  try {
    const loading = useAgent.getState().loadScope(scopeId)
    await flush()
    assert.equal(receiptReads, 1)
    api.memoryChanged()
    await flush()
    assert.equal(receiptReads, 2, 'a memory notification must not reuse a pre-notification receipt read')
    assert.deepEqual(useAgent.getState().sessions[sessionId]
      .productTurnActionProjectionByRunId['run-B'], newerReceipt.actionProjection)
    oldRead.resolve({ success: true, data: [oldReceipt] })
    await loading
    const state = useAgent.getState()
    assert.deepEqual(state.sessions[sessionId].productTurnActionProjectionByRunId['run-B'], newerReceipt.actionProjection)
    api.terminal(oldReceipt)
    assert.deepEqual(useAgent.getState().sessions[sessionId]
      .productTurnActionProjectionByRunId['run-B'], newerReceipt.actionProjection,
    'the actual terminal listener cannot overwrite the newer memory projection')
    assert.equal(state.inputValue, draft)
  } finally { api.restore() }
})

test('mode changes preserve the newest in-flight generation and sequence read target', async () => {
  for (const [generation, sequence] of [[2, 2], [1, 8]]) {
    useMode.setState({ workbenchMode: 'browser' })
    seedSurface()
    const oldRead = deferred<{ success: true; data: CodexActionSurfaceEnvelope }>()
    const targets: number[] = []
    const next = surface(generation, sequence)
    const api = installSurfaceApi({
      readCodexActionSurface: async (request: { aliasGeneration: number }) => {
        targets.push(request.aliasGeneration)
        return targets.length === 1 ? oldRead.promise : { success: true, data: next }
      },
    })
    try {
      api.invalidate(generation, sequence)
      await flush()
      useMode.setState({ workbenchMode: 'document' })
      await flush()
      assert.deepEqual(targets, [generation, generation])
      assert.deepEqual(useAgent.getState().sessions[sessionId].scopeHeadActionProjection, next.head)
      oldRead.resolve({ success: true, data: next })
      await flush()
      assert.deepEqual(useAgent.getState().sessions[sessionId].scopeHeadActionProjection, next.head)
    } finally {
      api.restore()
      useMode.setState({ workbenchMode: 'browser' })
    }
  }
})

test('mode changes hide old actions immediately and reject a late response from the previous mode', async () => {
  useMode.setState({ workbenchMode: 'browser' })
  const receipt = seedFailedB()
  const first = deferred<{ success: true; data: ProductTurnReceipt[] }>()
  const modes: string[] = []
  const api = installSurfaceApi({
    getConversationScopeMessages: async () => ({ success: true, data: [receipt.canonicalMessage] }),
    readCodexActionSurface: async () => ({ success: true, data: surface(1) }),
    readProductTurnPresentations: async (_ids: string[], mode: string) => {
      modes.push(mode)
      return mode === 'browser' ? first.promise : { success: true, data: [] }
    },
  })
  try {
    const loading = useAgent.getState().loadScope(scopeId)
    await flush()
    useMode.setState({ workbenchMode: 'document' })
    assert.equal(productTurnActionProjectionMatchesContext(
      receipt.actionProjection, surface(1).head, useMode.getState().workbenchMode,
    ), false)
    await flush()
    assert.deepEqual(modes, ['browser', 'document'])
    first.resolve({ success: true, data: [receipt] })
    await loading
    api.terminal(receipt)
    const cached = useAgent.getState().sessions[sessionId].productTurnActionProjectionByRunId['run-B']
    assert.equal(productTurnActionProjectionMatchesContext(cached, surface(1).head, 'document'), false)
    assert.equal(useAgent.getState().inputValue, draft)
  } finally {
    api.restore()
    useMode.setState({ workbenchMode: 'browser' })
  }
})

test('mode roundtrip preserves the known memory revision against a late old terminal event', async () => {
  useMode.setState({ workbenchMode: 'browser' })
  seedFailedB()
  const currentSurface = surface(2)
  const old = failedB(currentSurface)
  const failedRun = createEmptyScopeRunState({ scopeId, agent: 'butler', requestId: 'run-B', phase: 'error' })
  useAgent.setState((state) => ({
    scopes: state.scopes.map((scope) => ({ ...scope, aliasGeneration: 2 })),
    currentScope: { ...state.currentScope!, aliasGeneration: 2 },
    scopeRunStates: { [scopeId]: failedRun },
    sessions: { ...state.sessions, [sessionId]: {
      ...state.sessions[sessionId], aliasGeneration: 2,
      scopeHeadActionProjection: currentSurface.head, lifecycleOperationProjection: currentSurface.lifecycle,
      productTurnActionProjectionByRunId: { 'run-B': old.actionProjection },
      scopeRunStates: { [scopeId]: failedRun },
    } },
  }))
  const newer = (mode: 'browser' | 'document'): ProductTurnReceipt => {
    const receipt = structuredClone(old)
    const projection = receipt.actionProjection
    if (projection.retryEvidenceKind !== 'complete') throw new Error('complete_fixture_required')
    projection.currentReadyMemoryRef.stateRevision = 2
    projection.currentReadyMemoryRef.modelVisiblePayloadEmpty = false
    projection.currentReadyMemoryRef.eligibilityDigest = 'memory-revision-2'
    projection.productTurnActionProjectionVersion.readyMemoryStateRevision = 2
    projection.currentTrustedEnvironmentRef = {
      requestedWorkbenchMode: mode, trustedWorkbenchMode: mode, modeDigest: `mode-${mode}`,
    }
    projection.productTurnActionProjectionVersion.trustedModeDigest = `mode-${mode}`
    projection.retry_failed_task = {
      availability: 'not_applicable', blockers: ['current_memory_restatement_required'], consequence: null,
    }
    projection.evidenceDigest = `memory-2-${mode}`
    return receipt
  }
  const pending = deferred<{ success: true; data: ProductTurnReceipt[] }>()
  let reads = 0
  const api = installSurfaceApi({
    getConversationScopeMessages: async () => ({ success: true, data: [old.canonicalMessage] }),
    readCodexActionSurface: async () => ({ success: true, data: currentSurface }),
    readProductTurnPresentations: async (_ids: string[], mode: 'browser' | 'document') => {
      reads += 1
      return reads === 3 ? pending.promise : { success: true, data: [newer(mode)] }
    },
  })
  try {
    await useAgent.getState().loadScope(scopeId)
    useMode.setState({ workbenchMode: 'document' })
    await flush()
    useMode.setState({ workbenchMode: 'browser' })
    await flush()
    assert.equal(reads, 3)
    const canonical = createRuntimeDriverCanonicalTerminal({
      store: useAgent,
      clearInfrastructureWatchdog() {},
      getScopeRunStateFromState: (state) => state.sessions[sessionId].scopeRunStates[scopeId],
      findScopeIdByRunId: () => scopeId,
      finalizeDoneRunState: (previous) => previous,
    })
    await canonical.completeScopeRunAfterSendSuccess(scopeId, 'run-B', {
      canonicalMessage: old.canonicalMessage, canonicalMessageDigest: old.canonicalMessageDigest,
      productTurnReceipt: old,
    })
    const cached = useAgent.getState().sessions[sessionId].productTurnActionProjectionByRunId['run-B']
    assert.equal(cached.retryEvidenceKind === 'complete' && cached.currentReadyMemoryRef.stateRevision, 2)
    assert.equal(cached.retry_failed_task.availability, 'not_applicable')
    // The production send-return wrapper refreshes after its canonical writer.
    // Keep that owner handoff; do not weaken the run fingerprint to accept the old read.
    const refreshAfterReturn = useAgent.getState().loadScope(scopeId)
    pending.resolve({ success: true, data: [newer('browser')] })
    await refreshAfterReturn
    assert.equal(reads, 4)
    assert.deepEqual(useAgent.getState().sessions[sessionId].productTurnActionProjectionByRunId['run-B'],
      newer('browser').actionProjection)
  } finally {
    api.restore()
    useMode.setState({ workbenchMode: 'browser' })
  }
})
