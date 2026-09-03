import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CodexActionSurfaceEnvelope,
  CodexActionSurfaceInvalidation,
  SendScopedRequest,
} from '../shared/ipc-contracts/agent-runtime'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import { projectCodexLifecycleOperationV2 } from '../main/modules/agent-control/codex-runtime/codex-lifecycle-action-surface'
import { initAgentListeners, useAgent } from '../renderer/stores/useAgent'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import { createEmptyScopeRunState } from '../renderer/modules/agent/scopeRunState'
import type { AgentMessage, ConversationScope } from '../renderer/modules/agent/types'

// Renderer integration only: Main IPC is replaced, not the reset/send owners or projectors.
export const __breaksInvariants = [
  'renderer.agent-store.singleton-seeded-for-reset-handoff',
  'renderer.electron-api-replaced-with-controlled-main-responses',
] as const

const scopeId = 'scope-reset-action-handoff'
const sessionId = 'session-reset-action-handoff'
const oldMessage: AgentMessage = {
  id: 'old-user-C', type: 'user', agent: 'butler', content: 'old epoch C',
  timestamp: new Date('2026-09-03T00:00:00.000Z'),
}

function surface(generation: number, epoch: number, activeRunId: string | null, sequence = generation): CodexActionSurfaceEnvelope {
  const head = projectCodexHeadActionProjection({
    scopeId, scopeEpoch: epoch, aliasId: scopeId, aliasGeneration: generation,
    threadBindingId: `binding-${generation}`, headRevision: generation,
    actionProjectionSequence: sequence, materializationKind: 'fresh_start',
    materializationState: activeRunId ? 'confirmed' : 'pending',
    codexThreadId: activeRunId ? `native-${generation}` : null,
    continuationBlocked: false, activeProductFence: Boolean(activeRunId),
    manualCompactionState: 'none', hasLegacyPreparedRun: false,
    headRuntimeManifestDigest: 'runtime', headProtocolSchemaDigest: 'protocol',
    currentRuntimeManifestDigest: 'runtime', currentProtocolSchemaDigest: 'protocol',
  })
  return {
    scopeId, scopeEpoch: epoch, head,
    lifecycle: projectCodexLifecycleOperationV2({
      base: {
        identity: { aliasId: scopeId, aliasGeneration: generation },
        activeReadyRunId: activeRunId, latestReadyRunId: activeRunId,
        snapshot: activeRunId ? 'product_turn_interruptible' : 'idle_never_started',
        interruptRequested: false, interruptAcknowledged: false, requestedAction: null,
        evidenceDigest: `surface-${generation}-${epoch}`,
      },
      head, scopeEpoch: epoch, threadBindingId: `binding-${generation}`,
      headRevision: generation, materializationIntentRef: null,
    }),
  }
}

function seedStore(activeRunId: string | null) {
  const initial = surface(1, 0, activeRunId)
  const scope: ConversationScope = {
    id: scopeId, aliasGeneration: 1, messageVisibilityEpoch: 0,
    agent: 'butler', activeAgentId: 'butler', handoffGeneration: 0,
    title: 'Reset handoff', sourceKind: 'local', sourceId: 'app', threadKey: scopeId,
    meta: {}, createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z', lastMessageAt: null,
  }
  const run = activeRunId ? createEmptyScopeRunState({
    scopeId, agent: 'butler', requestId: activeRunId, phase: 'responding',
  }) : null
  const slice = {
    ...makeEmptySessionSlice(scopeId), messages: [oldMessage], aliasGeneration: 1,
    scopeRunStates: run ? { [scopeId]: run } : {}, streamingRequestId: activeRunId,
    isStreaming: Boolean(run), foregroundBusy: Boolean(run), composerLocked: Boolean(run),
    scopeHeadActionProjection: initial.head, lifecycleOperationProjection: initial.lifecycle,
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

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const resetResult = { ok: true, action: 'reset', aliasId: scopeId,
  retiredGeneration: 1, newGeneration: 2, transactionDigest: 'reset-committed' } as const

function installApi(api: Record<string, unknown>) {
  const previousWindow = globalThis.window
  let onInvalidation!: (event: CodexActionSurfaceInvalidation) => void
  const noSubscription = () => () => {}
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { agent: {
      onStream: noSubscription, onStatusChange: noSubscription, onError: noSubscription,
      onToolAction: noSubscription, onToolActionRequest: noSubscription,
      onCancelToolActionRequest: noSubscription, onConversationEvent: noSubscription,
      onScopeRunEvent: noSubscription, onIngressAdmitted: noSubscription,
      onCodexActionSurfaceInvalidated: (listener: typeof onInvalidation) => {
        onInvalidation = listener
        return noSubscription()
      },
      readProductTurnPresentations: async () => ({ success: true, data: [] }),
      ...api,
    } } },
  })
  const off = initAgentListeners()
  return {
    invalidate(generation: number, epoch: number, sequence = generation) {
      onInvalidation({ contract: 'codex_action_surface_invalidation_v1', scopeId,
        aliasGeneration: generation, scopeEpoch: epoch, actionProjectionSequence: sequence })
    },
    restore() {
      off()
      Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
    },
  }
}

for (const timing of ['event-lost', 'event-starts-during-reset', 'old-read-finishes-during-reset'] as const) {
  test(`real reset reacquires send authority without losing cleanup: ${timing}`, async (t) => {
    const previousState = useAgent.getState()
    const initial = seedStore(timing === 'event-starts-during-reset' ? 'run-C' : null)
    const next = surface(2, 1, null)
    const oldSurface = surface(1, 0, null, 2)
    const oldRead = deferred<{ success: true; data: CodexActionSurfaceEnvelope }>()
    const readGenerations: number[] = []
    const sent: SendScopedRequest[] = []
    let duringReset: { pending: string | null; generation: number | null; messages: number } | null = null
    const api = installApi({
      readCodexActionSurface: async (request: { aliasGeneration: number }) => {
        readGenerations.push(request.aliasGeneration)
        if (timing === 'old-read-finishes-during-reset' && readGenerations.length === 1) return oldRead.promise
        return { success: true, data: request.aliasGeneration === 1 ? initial : next }
      },
      resetSession: async () => {
        if (timing === 'event-starts-during-reset') api.invalidate(2, 1)
        if (timing === 'old-read-finishes-during-reset') oldRead.resolve({ success: true, data: oldSurface })
        await flush()
        const slice = useAgent.getState().sessions[sessionId]
        duringReset = { pending: slice.lifecyclePendingAction,
          generation: slice.aliasGeneration, messages: slice.messages.length }
        return resetResult
      },
      sendScoped: async (payload: SendScopedRequest) => {
        sent.push(payload)
        return { success: false, disposition: 'rejected_before_persistence', errorKind: 'thread_busy' }
      },
    })
    t.after(() => {
      oldRead.resolve({ success: true, data: oldSurface })
      api.restore()
      useAgent.setState(previousState, true)
    })
    if (timing === 'old-read-finishes-during-reset') {
      api.invalidate(1, 0, 2)
      await flush()
    }
    const result = await useAgent.getState().resetCurrentConversation()
    assert.equal(result.ok, true)
    assert.deepEqual(duringReset, { pending: 'resetting', generation: 1, messages: 1 })
    const slice = useAgent.getState().sessions[sessionId]
    assert.equal(slice.aliasGeneration, 2)
    assert.equal(slice.messageVisibilityEpoch, 1)
    assert.deepEqual(slice.messages, [])
    assert.deepEqual(slice.scopeRunStates, {})
    assert.deepEqual(slice.scopeHeadActionProjection, next.head)
    assert.deepEqual(slice.lifecycleOperationProjection, next.lifecycle)
    assert.deepEqual(readGenerations, timing === 'old-read-finishes-during-reset' ? [1, 1, 2] : [1, 2])
    await useAgent.getState().sendMessage('new epoch followup')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].expectedAliasGeneration, 2)
    assert.equal(sent[0].expectedMessageVisibilityEpoch, 1)
    assert.deepEqual(sent[0].actionAdmissionRef, {
      headProjectionDigest: next.head.evidenceDigest,
      actionProjectionVersion: next.head.actionProjectionVersion,
      actionHeadIdentity: next.head.actionHeadIdentity,
    })
  })
}

test('late reset response neither clears a new run nor starts a hydration for it', async (t) => {
  const previousState = useAgent.getState()
  const initial = seedStore('run-C')
  const pending = deferred<typeof resetResult>()
  const readGenerations: number[] = []
  const api = installApi({
    readCodexActionSurface: async (request: { aliasGeneration: number }) => {
      readGenerations.push(request.aliasGeneration)
      return { success: true, data: initial }
    },
    resetSession: () => pending.promise,
  })
  t.after(() => { api.restore(); useAgent.setState(previousState, true) })
  const resetting = useAgent.getState().resetCurrentConversation()
  await flush()
  const runD = { ...createEmptyScopeRunState({ scopeId, agent: 'butler', requestId: 'run-D', phase: 'responding' }),
    responseBuffer: 'new run D is streaming' }
  useAgent.setState((state) => {
    const runtime = { lifecyclePendingAction: null, streamingRequestId: 'run-D',
      scopeRunStates: { [scopeId]: runD }, inputValue: 'new D draft' }
    return { ...runtime, sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], ...runtime } } }
  })
  pending.resolve(resetResult)
  assert.equal((await resetting).ok, true)
  const slice = useAgent.getState().sessions[sessionId]
  assert.equal(slice.aliasGeneration, 1)
  assert.equal(slice.messageVisibilityEpoch, 0)
  assert.deepEqual(slice.messages, [oldMessage])
  assert.equal(slice.streamingRequestId, 'run-D')
  assert.equal(slice.scopeRunStates[scopeId].responseBuffer, 'new run D is streaming')
  assert.equal(slice.inputValue, 'new D draft')
  assert.deepEqual(readGenerations, [1])
})
