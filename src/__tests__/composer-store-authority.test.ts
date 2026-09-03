import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveReferencedFilePoolAttachments } from '../renderer/modules/agent/messageComposer'
import type { ChatAttachment, ConversationScope } from '../renderer/modules/agent/types'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import { useAgent } from '../renderer/stores/useAgent'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import { projectCodexLifecycleOperationV2 } from '../main/modules/agent-control/codex-runtime/codex-lifecycle-action-surface'
import { makeScopeHeadActionProjection } from './product-turn-action-projection-fixture'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function makeScope(id: 'a' | 'b', generation = 1, epoch = 0): ConversationScope {
  return {
    id: `scope-${id}`,
    aliasGeneration: generation,
    messageVisibilityEpoch: epoch,
    agent: 'butler',
    activeAgentId: 'butler',
    handoffGeneration: 0,
    title: `Scope ${id.toUpperCase()}`,
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: `scope-${id}`,
    meta: {},
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    lastMessageAt: null,
  }
}

function makeAttachment(id: string, name = `${id}.txt`): ChatAttachment {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    type: 'text',
    size: 10,
    ext: '.txt',
    source: 'file',
  }
}

function seedStore(active: 'a' | 'b' = 'a', revision = 1): void {
  const scopeA = makeScope('a')
  const scopeB = makeScope('b')
  const sliceA = {
    ...makeEmptySessionSlice(scopeA.id),
    aliasGeneration: 1,
    messageVisibilityEpoch: 0,
    scopeHeadActionProjection: makeScopeHeadActionProjection(scopeA.id),
  }
  const sliceB = {
    ...makeEmptySessionSlice(scopeB.id),
    aliasGeneration: 1,
    messageVisibilityEpoch: 0,
    scopeHeadActionProjection: makeScopeHeadActionProjection(scopeB.id),
  }
  const activeScope = active === 'a' ? scopeA : scopeB
  const activeSlice = active === 'a' ? sliceA : sliceB
  useAgent.setState({
    currentAgent: 'butler',
    messages: activeSlice.messages,
    inputValue: '',
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    conversationId: activeScope.id,
    currentScopeId: activeScope.id,
    currentScope: activeScope,
    scopes: [scopeA, scopeB],
    conversations: [],
    scopeLiveMessages: {},
    retiredScopeIds: {},
    scopeAuthorityRevision: 0,
    composerAuthorityRevision: revision,
    scopeListRequestRevision: 0,
    scopeRunStates: {},
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    sessions: { 'session-a': sliceA, 'session-b': sliceB },
    sessionOrder: ['session-a', 'session-b'],
    activeSessionId: `session-${active}`,
    sessionId: `session-${active}`,
    taskDisclosureState: {},
  })
}

function installWindow(electronAPI: Record<string, unknown>): () => void {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    value: { electronAPI },
    configurable: true,
  })
  return () => {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
    } else {
      delete (globalThis as typeof globalThis & { window?: Window }).window
    }
  }
}

const pickedFile = {
  name: 'report.txt',
  path: '/tmp/report.txt',
  type: 'text',
  size: 10,
  ext: '.txt',
}

function modeReceipt(mode: 'ask' | 'auto' | 'full', epoch = 0) {
  return {
    success: true,
    data: {
      scopeId: 'scope-a',
      mode,
      messageVisibilityEpoch: epoch,
    },
  }
}

async function actionSurface(request: { aliasId: string; aliasGeneration: number }) {
  const slice = Object.values(useAgent.getState().sessions)
    .find((candidate) => candidate.conversationId === request.aliasId)
  const scopeEpoch = slice?.messageVisibilityEpoch ?? 0
  const threadBindingId = `binding-${request.aliasId}-${request.aliasGeneration}`
  const head = projectCodexHeadActionProjection({
    scopeId: request.aliasId, scopeEpoch, ...request, threadBindingId,
    headRevision: 1, actionProjectionSequence: 1,
    materializationKind: 'fresh_start', materializationState: 'confirmed',
    codexThreadId: 'native-composer', continuationBlocked: false, activeProductFence: false,
    manualCompactionState: 'none', hasLegacyPreparedRun: false,
    headRuntimeManifestDigest: 'runtime', headProtocolSchemaDigest: 'protocol',
    currentRuntimeManifestDigest: 'runtime', currentProtocolSchemaDigest: 'protocol',
  })
  return {
    success: true,
    data: {
      scopeId: request.aliasId, scopeEpoch, head,
      lifecycle: projectCodexLifecycleOperationV2({
        base: {
          identity: request, activeReadyRunId: null, latestReadyRunId: null,
          snapshot: 'idle_native_thread', interruptRequested: false,
          interruptAcknowledged: false, requestedAction: null, evidenceDigest: 'composer-evidence',
        },
        head, scopeEpoch, threadBindingId, headRevision: 1, materializationIntentRef: null,
      }),
    },
  }
}

test('late file picker result is rejected after A to B to A round-trip', async () => {
  seedStore('a', 10)
  const picked = deferred<{ success: boolean; data: typeof pickedFile[] }>()
  const restore = installWindow({ chat: { pickFiles: () => picked.promise } })
  try {
    const picking = useAgent.getState().pickFiles()
    useAgent.getState().setActiveSessionId('session-b')
    useAgent.getState().setActiveSessionId('session-a')
    picked.resolve({ success: true, data: [pickedFile] })
    await picking

    const state = useAgent.getState()
    assert.equal(state.composerAuthorityRevision, 12)
    assert.deepEqual(state.attachments, [])
    assert.deepEqual(state.filePool, [])
  } finally {
    restore()
  }
})

test('send preparation cannot dispatch after A to B to A round-trip', async () => {
  seedStore('a', 15)
  let dispatches = 0
  const restore = installWindow({
    agent: {
      sendScoped: async () => {
        dispatches += 1
        throw new Error('stale_send_dispatched')
      },
    },
  })
  try {
    const sending = useAgent.getState().sendMessage('A only')
    useAgent.getState().setActiveSessionId('session-b')
    useAgent.getState().setActiveSessionId('session-a')
    const result = await sending

    assert.equal(result.errorKind, 'conversation_reset_required')
    assert.equal(dispatches, 0)
    assert.deepEqual(useAgent.getState().messages, [])
  } finally {
    restore()
  }
})

test('file picker result attaches normally while the same composer remains active', async () => {
  seedStore('a', 20)
  const picked = deferred<{ success: boolean; data: typeof pickedFile[] }>()
  const restore = installWindow({ chat: { pickFiles: () => picked.promise } })
  try {
    const picking = useAgent.getState().pickFiles()
    picked.resolve({ success: true, data: [pickedFile] })
    await picking

    const state = useAgent.getState()
    assert.equal(state.composerAuthorityRevision, 20)
    assert.equal(state.attachments.length, 1)
    assert.equal(state.filePool.length, 1)
    assert.equal(state.attachments[0]?.name, pickedFile.name)
  } finally {
    restore()
  }
})

test('reset invalidates a pending file picker without reopening old resources', async () => {
  seedStore('a', 30)
  const picked = deferred<{ success: boolean; data: typeof pickedFile[] }>()
  const restore = installWindow({
    chat: { pickFiles: () => picked.promise },
    agent: {
      readCodexActionSurface: actionSurface,
      resetSession: async () => ({
        ok: true,
        action: 'reset',
        aliasId: 'scope-a',
        retiredGeneration: 1,
        newGeneration: 2,
        transactionDigest: 'a'.repeat(64),
      }),
    },
  })
  try {
    const picking = useAgent.getState().pickFiles()
    const reset = await useAgent.getState().resetCurrentConversation()
    assert.equal(reset.ok, true)
    picked.resolve({ success: true, data: [pickedFile] })
    await picking

    const state = useAgent.getState()
    assert.equal(state.composerAuthorityRevision, 31)
    assert.equal(state.sessions['session-a']?.aliasGeneration, 2)
    assert.equal(state.sessions['session-a']?.messageVisibilityEpoch, 1)
    assert.deepEqual(state.attachments, [])
    assert.deepEqual(state.filePool, [])
  } finally {
    restore()
  }
})

test('switching composers clears the old file pool so the same name cannot resolve in B', () => {
  seedStore('a', 40)
  useAgent.getState().addAttachments([makeAttachment('report-a', 'report.txt')])
  assert.equal(resolveReferencedFilePoolAttachments('@[report.txt]', useAgent.getState().filePool).length, 1)

  useAgent.getState().setActiveSessionId('session-b')

  const state = useAgent.getState()
  assert.deepEqual(state.attachments, [])
  assert.deepEqual(state.filePool, [])
  assert.deepEqual(resolveReferencedFilePoolAttachments('@[report.txt]', state.filePool), [])
})

test('reselecting the active session is a no-op for resources and authority', () => {
  seedStore('a', 50)
  const attachment = makeAttachment('same-session')
  useAgent.getState().addAttachments([attachment])

  useAgent.getState().setActiveSessionId('session-a')

  const state = useAgent.getState()
  assert.equal(state.composerAuthorityRevision, 50)
  assert.deepEqual(state.attachments, [attachment])
  assert.deepEqual(state.filePool, [attachment])
})

test('closing a background session preserves the active composer authority and resources', async () => {
  seedStore('b', 60)
  const attachment = makeAttachment('scope-b-file')
  useAgent.getState().addAttachments([attachment])
  const restore = installWindow({
    agent: {
      readCodexActionSurface: actionSurface,
      closeSession: async () => ({
        ok: true,
        action: 'close',
        closeoutDisposition: 'never_started',
        aliasId: 'scope-a',
        retiredGeneration: 1,
        retirementTransactionDigest: 'a'.repeat(64),
        archiveDisposition: 'not_required',
        scopeClosureEvidenceDigest: 'b'.repeat(64),
      }),
    },
  })
  try {
    const result = await useAgent.getState().closeSession('session-a')
    assert.equal(result.ok, true)

    const state = useAgent.getState()
    assert.equal(state.activeSessionId, 'session-b')
    assert.equal(state.composerAuthorityRevision, 60)
    assert.deepEqual(state.attachments, [attachment])
    assert.deepEqual(state.filePool, [attachment])
  } finally {
    restore()
  }
})

test('same-scope message refresh preserves resources but a scope switch clears them', async () => {
  seedStore('a', 70)
  const attachment = makeAttachment('refresh-file')
  useAgent.getState().addAttachments([attachment])
  const restore = installWindow({
    agent: {
      getConversationScopeMessages: async () => ({ success: true, data: [] }),
    },
  })
  try {
    await useAgent.getState().loadScope('scope-a')
    let state = useAgent.getState()
    assert.equal(state.composerAuthorityRevision, 70)
    assert.deepEqual(state.attachments, [attachment])
    assert.deepEqual(state.filePool, [attachment])

    await useAgent.getState().loadScope('scope-b')
    state = useAgent.getState()
    assert.equal(state.composerAuthorityRevision, 71)
    assert.equal(state.activeSessionId, 'session-b')
    assert.deepEqual(state.attachments, [])
    assert.deepEqual(state.filePool, [])
  } finally {
    restore()
  }
})

test('committed action mode survives a reset before its response without rolling identity back', async () => {
  seedStore('a', 80)
  const response = deferred<ReturnType<typeof modeReceipt>>()
  const restore = installWindow({
    agent: { setActionAuthorizationMode: () => response.promise },
  })
  try {
    const saving = useAgent.getState().setActionAuthorizationMode('auto')
    useAgent.setState((state) => {
      const scopes = state.scopes.map((scope) => scope.id === 'scope-a'
        ? {
            ...scope,
            aliasGeneration: 2,
            messageVisibilityEpoch: 1,
            meta: { adjacent: 'after-reset' },
          }
        : scope)
      return {
        scopes,
        currentScope: scopes.find((scope) => scope.id === 'scope-a') || null,
        sessions: {
          ...state.sessions,
          'session-a': {
            ...state.sessions['session-a'],
            aliasGeneration: 2,
            messageVisibilityEpoch: 1,
          },
        },
        composerAuthorityRevision: state.composerAuthorityRevision + 1,
      }
    })
    response.resolve(modeReceipt('auto', 0))
    await saving

    const state = useAgent.getState()
    assert.equal(state.currentScope?.aliasGeneration, 2)
    assert.equal(state.currentScope?.messageVisibilityEpoch, 1)
    assert.equal(state.currentScope?.meta.adjacent, 'after-reset')
    assert.equal(state.currentScope?.meta.actionAuthorizationMode, 'auto')
    assert.equal(state.sessions['session-a']?.aliasGeneration, 2)
    assert.equal(state.sessions['session-a']?.messageVisibilityEpoch, 1)
  } finally {
    restore()
  }
})

test('reset-before-commit rejection leaves the new history mode untouched', async () => {
  seedStore('a', 90)
  const response = deferred<{ success: false; error: string }>()
  const restore = installWindow({
    agent: { setActionAuthorizationMode: () => response.promise },
  })
  try {
    const saving = useAgent.getState().setActionAuthorizationMode('full')
    useAgent.setState((state) => {
      const scopes = state.scopes.map((scope) => scope.id === 'scope-a'
        ? { ...scope, aliasGeneration: 2, messageVisibilityEpoch: 1 }
        : scope)
      return {
        scopes,
        currentScope: scopes.find((scope) => scope.id === 'scope-a') || null,
        sessions: {
          ...state.sessions,
          'session-a': {
            ...state.sessions['session-a'],
            aliasGeneration: 2,
            messageVisibilityEpoch: 1,
          },
        },
      }
    })
    response.resolve({
      success: false,
      error: 'action_authorization_scope_identity_changed',
    })
    await assert.rejects(saving, /action_authorization_scope_identity_changed/)

    assert.equal(useAgent.getState().currentScope?.meta.actionAuthorizationMode, undefined)
    assert.equal(useAgent.getState().currentScope?.messageVisibilityEpoch, 1)
  } finally {
    restore()
  }
})

test('late committed action mode cannot recreate a closed scope', async () => {
  seedStore('a', 100)
  const response = deferred<ReturnType<typeof modeReceipt>>()
  const restore = installWindow({
    agent: { setActionAuthorizationMode: () => response.promise },
  })
  try {
    const saving = useAgent.getState().setActionAuthorizationMode('auto')
    useAgent.setState((state) => ({
      scopes: state.scopes.filter((scope) => scope.id !== 'scope-a'),
      sessions: Object.fromEntries(
        Object.entries(state.sessions).filter(([sessionId]) => sessionId !== 'session-a'),
      ),
      sessionOrder: state.sessionOrder.filter((sessionId) => sessionId !== 'session-a'),
      activeSessionId: null,
      currentScopeId: null,
      currentScope: null,
      conversationId: null,
      retiredScopeIds: { ...state.retiredScopeIds, 'scope-a': true },
    }))
    response.resolve(modeReceipt('auto', 0))
    await saving

    const state = useAgent.getState()
    assert.equal(state.scopes.some((scope) => scope.id === 'scope-a'), false)
    assert.equal(state.sessions['session-a'], undefined)
    assert.equal(state.currentScope, null)
  } finally {
    restore()
  }
})

test('same-history alias rollover keeps the committed mode without rolling generation back', async () => {
  seedStore('a', 110)
  const response = deferred<ReturnType<typeof modeReceipt>>()
  const restore = installWindow({
    agent: { setActionAuthorizationMode: () => response.promise },
  })
  try {
    const saving = useAgent.getState().setActionAuthorizationMode('full')
    useAgent.setState((state) => {
      const scopes = state.scopes.map((scope) => scope.id === 'scope-a'
        ? { ...scope, aliasGeneration: 2, meta: { adjacent: 'keep' } }
        : scope)
      return {
        scopes,
        currentScope: scopes.find((scope) => scope.id === 'scope-a') || null,
        sessions: {
          ...state.sessions,
          'session-a': { ...state.sessions['session-a'], aliasGeneration: 2 },
        },
      }
    })
    response.resolve(modeReceipt('full', 0))
    await saving

    const state = useAgent.getState()
    assert.equal(state.currentScope?.aliasGeneration, 2)
    assert.equal(state.currentScope?.messageVisibilityEpoch, 0)
    assert.equal(state.currentScope?.meta.adjacent, 'keep')
    assert.equal(state.currentScope?.meta.actionAuthorizationMode, 'full')
  } finally {
    restore()
  }
})

test('background action-mode success updates A only and its next send uses the committed mode', async () => {
  seedStore('a', 120)
  const response = deferred<ReturnType<typeof modeReceipt>>()
  let sentPayload: Record<string, any> | null = null
  const agentApi = {
    setActionAuthorizationMode: () => response.promise,
    sendScoped: async (payload: Record<string, any>) => {
      sentPayload = payload
      return {
        success: false,
        disposition: 'rejected_before_persistence',
        ownerRunId: null,
        shouldClearInput: false,
        preserveInput: true,
        retryableByUser: false,
        persistence: {
          scope: 'none',
          message: 'none',
          attachments: 'none',
          inputAttachments: 'none',
        },
        error: 'thread_busy',
        errorKind: 'thread_busy',
        admissionEvidenceDigest: 'background-mode-send',
      }
    },
  }
  const restore = installWindow({ agent: agentApi })
  try {
    const saving = useAgent.getState().setActionAuthorizationMode('auto')
    useAgent.getState().setActiveSessionId('session-b')
    response.resolve(modeReceipt('auto', 0))
    await saving

    let state = useAgent.getState()
    assert.equal(state.currentScopeId, 'scope-b')
    assert.equal(state.currentScope?.meta.actionAuthorizationMode, undefined)
    assert.equal(
      state.scopes.find((scope) => scope.id === 'scope-a')?.meta.actionAuthorizationMode,
      'auto',
    )

    useAgent.getState().setActiveSessionId('session-a')
    await useAgent.getState().sendMessage('use committed mode')
    state = useAgent.getState()
    assert.equal(state.currentScope?.meta.actionAuthorizationMode, 'auto')
    assert.equal(sentPayload?.userMessage.meta.actionAuthorizationMode, 'auto')
  } finally {
    restore()
  }
})

test('concurrent action-mode responses are latest-wins in renderer state', async () => {
  seedStore('a', 130)
  const first = deferred<ReturnType<typeof modeReceipt>>()
  const second = deferred<ReturnType<typeof modeReceipt>>()
  let calls = 0
  const restore = installWindow({
    agent: {
      setActionAuthorizationMode: () => (++calls === 1 ? first.promise : second.promise),
    },
  })
  try {
    const savingFirst = useAgent.getState().setActionAuthorizationMode('auto')
    const savingSecond = useAgent.getState().setActionAuthorizationMode('full')
    second.resolve(modeReceipt('full', 0))
    await savingSecond
    first.resolve(modeReceipt('auto', 0))
    await savingFirst

    assert.equal(useAgent.getState().currentScope?.meta.actionAuthorizationMode, 'full')
  } finally {
    restore()
  }
})

test('late session creation merges its durable tab without stealing a newer composer', async () => {
  seedStore('a', 140)
  const created = deferred<any>()
  const restore = installWindow({
    agent: { createSession: () => created.promise },
  })
  try {
    const creating = useAgent.getState().createNewSession()
    useAgent.getState().setActiveSessionId('session-b')
    useAgent.getState().setInputValue('B draft stays')
    const attachment = makeAttachment('b-pending-create')
    useAgent.getState().addAttachments([attachment])

    created.resolve({
      ok: true,
      action: 'create',
      aliasId: 'scope-created-late',
      aliasGeneration: 1,
      persistedAt: '2026-08-12T01:00:00.000Z',
    })
    await creating

    const state = useAgent.getState()
    assert.equal(state.activeSessionId, 'session-b')
    assert.equal(state.currentScopeId, 'scope-b')
    assert.equal(state.inputValue, 'B draft stays')
    assert.deepEqual(state.attachments, [attachment])
    assert.equal(state.scopes.some((scope) => scope.id === 'scope-created-late'), true)
    assert.equal(Object.values(state.sessions)
      .some((slice) => slice.conversationId === 'scope-created-late'), true)
  } finally {
    restore()
  }
})

test('out-of-order session creation responses only let the latest create intent activate', async () => {
  seedStore('a', 150)
  const first = deferred<any>()
  const second = deferred<any>()
  let calls = 0
  const restore = installWindow({
    agent: { createSession: () => (++calls === 1 ? first.promise : second.promise) },
  })
  try {
    const creatingFirst = useAgent.getState().createNewSession()
    const creatingSecond = useAgent.getState().createNewSession()
    second.resolve({
      ok: true,
      action: 'create',
      aliasId: 'scope-create-latest',
      aliasGeneration: 1,
      persistedAt: '2026-08-12T02:00:00.000Z',
    })
    await creatingSecond
    first.resolve({
      ok: true,
      action: 'create',
      aliasId: 'scope-create-older',
      aliasGeneration: 1,
      persistedAt: '2026-08-12T01:59:00.000Z',
    })
    await creatingFirst

    const state = useAgent.getState()
    assert.equal(state.currentScopeId, 'scope-create-latest')
    assert.equal(state.scopes.some((scope) => scope.id === 'scope-create-latest'), true)
    assert.equal(state.scopes.some((scope) => scope.id === 'scope-create-older'), true)
    assert.equal(Object.values(state.sessions)
      .filter((slice) => slice.conversationId === 'scope-create-latest').length, 1)
    assert.equal(Object.values(state.sessions)
      .filter((slice) => slice.conversationId === 'scope-create-older').length, 1)
  } finally {
    restore()
  }
})
