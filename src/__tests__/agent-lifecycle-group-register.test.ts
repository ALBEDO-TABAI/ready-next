import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  agentLifecycleGroup,
  _agentLifecycleGroupChannelsForTest,
  type AgentLifecycleGroupDeps,
} from '../main/modules/claude-bridge/ipc/agent-lifecycle-group'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function createMockIpc() {
  const handleCalls: Array<{ channel: string; handler: HandlerFn }> = []
  const removeHandlerCalls: string[] = []
  const ipc = {
    handle(channel: string, handler: HandlerFn) { handleCalls.push({ channel, handler }) },
    removeHandler(channel: string) { removeHandlerCalls.push(channel) },
  } as unknown as IpcMain
  return { ipc, handleCalls, removeHandlerCalls }
}

function createMockDeps(): AgentLifecycleGroupDeps {
  const fail = (label: string) => async () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    getBrowserTaskAttention: () => null,
    actOnBrowserTaskAttention: fail('actOnBrowserTaskAttention'),
    sendScoped: fail('sendScoped') as AgentLifecycleGroupDeps['sendScoped'],
    createSession: fail('createSession') as AgentLifecycleGroupDeps['createSession'],
    resetSession: fail('resetSession') as AgentLifecycleGroupDeps['resetSession'],
    stopSession: fail('stopSession') as AgentLifecycleGroupDeps['stopSession'],
    closeSession: fail('closeSession') as AgentLifecycleGroupDeps['closeSession'],
    compactSession: fail('compactSession') as AgentLifecycleGroupDeps['compactSession'],
    log: () => {},
  }
}

test('lifecycle group registers the exact Codex-facing channels including user attention', () => {
  const { ipc, handleCalls } = createMockIpc()
  agentLifecycleGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  assert.deepEqual(registered, [..._agentLifecycleGroupChannelsForTest].sort())
  assert.deepEqual(registered, [
    'agent:actOnBrowserTaskAttention',
    'agent:beginNewContext',
    'agent:closeSession',
    'agent:compactSession',
    'agent:createSession',
    'agent:getBrowserTaskAttention',
    'agent:kill',
    'agent:resetSession',
    'agent:sendScoped',
  ])
  assert.equal(registered.includes('agent:newSession'), false)
  assert.equal(registered.includes('agent:send'), false)
})

test('lifecycle handlers await the exact adapter result and pass immutable alias identity', async () => {
  const { ipc, handleCalls } = createMockIpc()
  const deps = createMockDeps()
  const calls: Array<{ aliasId: string; aliasGeneration: number }> = []
  deps.compactSession = async (request) => {
    calls.push(request)
    return {
      ok: true,
      action: 'manual_compact',
      aliasId: request.aliasId,
      manualCompactionId: 'manual-1',
      contextCompactionItemId: 'item-1',
      codexTurnId: 'turn-1',
      threadReadDigest: 'read-digest',
    }
  }
  agentLifecycleGroup.register(ipc, deps)

  const handler = handleCalls.find((entry) => entry.channel === 'agent:compactSession')?.handler
  assert.ok(handler)
  const result = await handler(
    {} as IpcMainInvokeEvent,
    { aliasId: 'alias-1', aliasGeneration: 3 },
  )

  assert.deepEqual(calls, [{ aliasId: 'alias-1', aliasGeneration: 3 }])
  assert.deepEqual(result, {
    ok: true,
    action: 'manual_compact',
    aliasId: 'alias-1',
    manualCompactionId: 'manual-1',
    contextCompactionItemId: 'item-1',
    codexTurnId: 'turn-1',
    threadReadDigest: 'read-digest',
  })
})

test('create handler accepts only an empty request and lets Main own the Ready identity', async () => {
  const { ipc, handleCalls } = createMockIpc()
  const deps = createMockDeps()
  const calls: unknown[] = []
  deps.createSession = async (request) => {
    calls.push(request)
    return {
      ok: true,
      action: 'create',
      aliasId: 'alias-created',
      aliasGeneration: 1,
      persistedAt: '2026-08-07T00:00:00.000Z',
    }
  }
  agentLifecycleGroup.register(ipc, deps)
  const handler = handleCalls.find((entry) => entry.channel === 'agent:createSession')?.handler
  assert.ok(handler)
  assert.equal((await handler({} as IpcMainInvokeEvent, {}) as { ok: boolean }).ok, true)
  assert.deepEqual(calls, [{}])
  await assert.rejects(
    () => handler({} as IpcMainInvokeEvent, { agentId: 'butler' }),
  )
})

test('lifecycle result runtime schema rejects weak free-form handler output', async () => {
  const { ipc, handleCalls } = createMockIpc()
  const deps = createMockDeps()
  deps.stopSession = async () => ({ success: false, error: 'busy' }) as never
  agentLifecycleGroup.register(ipc, deps)

  const handler = handleCalls.find((entry) => entry.channel === 'agent:kill')?.handler
  assert.ok(handler)
  await assert.rejects(
    () => Promise.resolve(handler(
      {} as IpcMainInvokeEvent,
      { aliasId: 'alias-1', aliasGeneration: 1, readyRunId: 'run-1' },
    )),
  )
})

test('stop handler records whether the click reached Main and how it finished', async () => {
  const { ipc, handleCalls } = createMockIpc()
  const deps = createMockDeps()
  const logs: string[] = []
  deps.log = (message) => { logs.push(message) }
  deps.stopSession = async (request) => ({
    ok: true,
    action: 'stop',
    aliasId: request.aliasId,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    terminal: 'interrupted',
    closeoutDigest: 'stop-closeout-digest',
    fenceReleaseRevision: 2,
  })
  agentLifecycleGroup.register(ipc, deps)

  const handler = handleCalls.find((entry) => entry.channel === 'agent:kill')?.handler
  assert.ok(handler)
  await handler(
    {} as IpcMainInvokeEvent,
    { aliasId: 'alias-1', aliasGeneration: 4, readyRunId: 'run-4' },
  )

  assert.deepEqual(logs, [
    '[ipc] agent:kill start aliasId=alias-1 aliasGeneration=4 readyRunId=run-4',
    '[ipc] agent:kill done aliasId=alias-1 aliasGeneration=4 readyRunId=run-4 ok=true action=stop terminal=interrupted',
  ])
})

test('lifecycle request runtime schema rejects missing, stale-shaped, and extended bindings', async () => {
  const { ipc, handleCalls } = createMockIpc()
  const deps = createMockDeps()
  let calls = 0
  const received: unknown[] = []
  deps.resetSession = async (request) => {
    calls += 1
    received.push(request)
    return {
      ok: false,
      action: 'reset',
      code: 'thread_busy',
      preserveUi: true,
      aliasId: request.aliasId,
      aliasGeneration: request.aliasGeneration,
      evidenceDigest: 'busy-evidence',
    }
  }
  agentLifecycleGroup.register(ipc, deps)
  const handler = handleCalls.find((entry) => entry.channel === 'agent:resetSession')?.handler
  assert.ok(handler)

  for (const payload of [
    { aliasId: 'alias-1' },
    { aliasId: 'alias-1', aliasGeneration: 0 },
    { aliasId: 'alias-1', aliasGeneration: '1' },
    { aliasId: 'alias-1', aliasGeneration: 1, readyRunId: 1 },
    { aliasId: 'alias-1', aliasGeneration: 1, readyRunId: null, sessionId: 'legacy' },
  ]) {
    await assert.rejects(() => Promise.resolve(handler({} as IpcMainInvokeEvent, payload)))
  }
  assert.equal(calls, 0)
  await handler(
    {} as IpcMainInvokeEvent,
    { aliasId: 'alias-1', aliasGeneration: 1, readyRunId: null },
  )
  await handler(
    {} as IpcMainInvokeEvent,
    { aliasId: 'alias-1', aliasGeneration: 1, readyRunId: 'run-1' },
  )
  assert.equal(calls, 2)
  assert.deepEqual(received, [
    { aliasId: 'alias-1', aliasGeneration: 1, readyRunId: null },
    { aliasId: 'alias-1', aliasGeneration: 1, readyRunId: 'run-1' },
  ])
})

test('lifecycle validation compares parsed action refs by value and preserves stop refs', async () => {
  const runRef = {
    ownerKind: 'run_owner' as const,
    action: 'reset' as const,
    aliasId: 'alias-1',
    scopeId: 'alias-1',
    scopeEpoch: 0,
    aliasGeneration: 1,
    lifecycleEvidenceDigest: 'lifecycle-digest',
    headProjectionDigest: 'head-digest',
    targetReadyRunId: 'run-1',
    digest: 'request-digest',
  }
  const { ipc, handleCalls } = createMockIpc()
  const deps = createMockDeps()
  const received: unknown[] = []
  deps.readLifecycleSnapshot = () => ({
    identity: { aliasId: 'alias-1', aliasGeneration: 1 },
    activeReadyRunId: 'run-1',
    latestReadyRunId: 'run-1',
    snapshot: 'product_turn_interruptible',
    interruptRequested: false,
    interruptAcknowledged: false,
    requestedAction: null,
    contractVersion: 'ready_lifecycle_operation_projection_v2',
    scopeId: 'alias-1',
    scopeEpoch: 0,
    headProjectionRef: {
      version: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: 0 },
      digest: 'head-digest',
    },
    actions: {
      stop: { availability: 'ready', blockers: [], requestRef: { ...runRef, action: 'stop' } },
      reset: { availability: 'ready', blockers: [], requestRef: runRef },
      close: { availability: 'ready', blockers: [], requestRef: { ...runRef, action: 'close' } },
      manual_compact: {
        availability: 'blocked', blockers: ['thread_busy'], requestRef: null,
      },
    },
    evidenceDigest: 'projection-digest',
  })
  deps.resetSession = async (request) => {
    received.push(request)
    return {
      ok: false,
      action: 'reset',
      code: 'thread_busy',
      preserveUi: true,
      aliasId: request.aliasId,
      aliasGeneration: request.aliasGeneration,
      evidenceDigest: 'adapter-evidence',
    }
  }
  deps.stopSession = async (request) => {
    received.push(request)
    return {
      ok: false,
      action: 'stop',
      code: 'thread_busy',
      preserveUi: true,
      aliasId: request.aliasId,
      aliasGeneration: request.aliasGeneration,
      evidenceDigest: 'adapter-evidence',
    }
  }
  agentLifecycleGroup.register(ipc, deps)

  const resetHandler = handleCalls.find((entry) => entry.channel === 'agent:resetSession')?.handler
  const stopHandler = handleCalls.find((entry) => entry.channel === 'agent:kill')?.handler
  assert.ok(resetHandler)
  assert.ok(stopHandler)
  await resetHandler({} as IpcMainInvokeEvent, {
    aliasId: 'alias-1', aliasGeneration: 1, readyRunId: 'run-1', actionRequestRef: runRef,
  })
  await stopHandler({} as IpcMainInvokeEvent, {
    aliasId: 'alias-1', aliasGeneration: 1, readyRunId: 'run-1',
    actionRequestRef: { ...runRef, action: 'stop' },
  })
  assert.equal(received.length, 2)
  assert.deepEqual((received[0] as { actionRequestRef: unknown }).actionRequestRef, runRef)
  assert.deepEqual(
    (received[1] as { actionRequestRef: unknown }).actionRequestRef,
    { ...runRef, action: 'stop' },
  )
})

test('send handler accepts only the shared exact request and rejects retired workflow fields before dispatch', async () => {
  const { ipc, handleCalls } = createMockIpc()
  const deps = createMockDeps()
  const received: unknown[] = []
  deps.sendScoped = async (payload) => {
    received.push(payload)
    return {
      success: false,
      disposition: 'rejected_before_persistence',
      retryableByUser: true,
      persistence: {
        scope: 'pre-existing',
        message: 'skipped',
        attachments: 'none',
        inputAttachments: 'none',
      },
      error: 'busy',
      errorKind: 'thread_busy',
      admissionEvidenceDigest: 'busy-evidence',
    }
  }
  agentLifecycleGroup.register(ipc, deps)
  const handler = handleCalls.find((entry) => entry.channel === 'agent:sendScoped')?.handler
  assert.ok(handler)
  const exactRequest = {
    scopeId: 'alias-1',
    expectedAliasGeneration: 1,
    expectedMessageVisibilityEpoch: 0,
    requestId: 'request-1',
    message: 'hello',
    userMessage: {
      id: 'message-1',
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
  }

  await handler({} as IpcMainInvokeEvent, exactRequest)
  assert.deepEqual(received, [exactRequest])

  for (const retiredField of ['agent', 'deliveryMode', 'continuationIntent', 'workspaceRoots']) {
    await assert.rejects(() => Promise.resolve(handler(
      {} as IpcMainInvokeEvent,
      { ...exactRequest, [retiredField]: retiredField === 'workspaceRoots' ? [] : 'retired' },
    )))
  }
  assert.equal(received.length, 1)
})

test('dispose removes the same channels and remains idempotent', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = agentLifecycleGroup.register(ipc, createMockDeps())
  const baseline = removeHandlerCalls.length

  handle.dispose()
  assert.deepEqual(
    removeHandlerCalls.slice(baseline).sort(),
    [..._agentLifecycleGroupChannelsForTest].sort(),
  )
  assert.doesNotThrow(() => handle.dispose())
  assert.equal(
    removeHandlerCalls.length - baseline,
    _agentLifecycleGroupChannelsForTest.length * 2,
  )
  assert.equal(agentLifecycleGroup.namespace, 'agent:lifecycle')
})
