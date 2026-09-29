// Stage V V2.1e — behavior test for `conversationGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// V2.1e extracts the 8 conversation-scope + attachment channels from
// claude-bridge's `setupAgentIPC`:
//
//   agent:listConversationScopes        (list scopes, optionally per-agent)
//   agent:listScopeRuns                 (list active/completed scope-runs)
//   agent:readCodexLifecycleSnapshot    (durable Codex operation projection)
//   agent:getConversationScopeMessages  (full chat_messages stream)
//   agent:listScopeAttachments          (filesystem-verified attachments)
//   agent:getScopeAttachment            (one attachment by id)
//   agent:clearRemoteAttachmentCache    (wipe cache subtree)
//   agent:getRemoteAttachmentCacheStats (cache size + per-channel counts)
//
// The V5 IPC contract gate proves the channel literals still exist on the
// renderer side, but it cannot prove:
//
//   1. `register` wires EXACTLY the 7 channel names the group owns via
//      `ipcMain.handle` (no extras, no missing ones — all 7 are invoke /
//      Promise or sync-return so they all live on the handle slot).
//   2. The returned dispose handle calls `removeHandler` for each of those
//      same 8 channels — so dev-reload re-registration and
//      `cleanupAgentRuntime` shutdown don't leak handler slots.
//
// Handler bodies are NOT exercised here — those are covered by pre-existing
// runtime tests and the V5 gate ensures the channel literal stays correct.
// The point of this file is the GROUP MECHANISM (register routing + dispose
// symmetry), not handler semantics.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  conversationGroup,
  _conversationGroupChannelsForTest,
  type ConversationGroupDeps,
} from '../main/modules/claude-bridge/ipc/conversation-group'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

interface MockIpc {
  ipc: IpcMain
  handleCalls: Array<{ channel: string; handler: HandlerFn }>
  removeHandlerCalls: string[]
}

function createMockIpc(): MockIpc {
  const handleCalls: Array<{ channel: string; handler: HandlerFn }> = []
  const removeHandlerCalls: string[] = []
  // Mock just the two ipcMain methods the group touches; cast to IpcMain so
  // the group's call signatures still type-check. If the group grows a new
  // ipc surface (e.g. `ipcMain.on`) without updating this mock, the test
  // fails loudly via the missing-method TypeError — exactly the assertion
  // we want.
  const ipc = {
    handle(channel: string, handler: HandlerFn) {
      handleCalls.push({ channel, handler })
    },
    removeHandler(channel: string) {
      removeHandlerCalls.push(channel)
    },
  } as unknown as IpcMain
  return { ipc, handleCalls, removeHandlerCalls }
}

function createMockDeps(): ConversationGroupDeps {
  // Behaviour test does not invoke handler bodies, so deps just need to
  // satisfy the type. Each function throws so an accidental call surfaces in
  // test output rather than silently returning undefined.
  const fail = (label: string) => () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    listConversationScopes: fail('listConversationScopes') as ConversationGroupDeps['listConversationScopes'],
    listScopeRuns: fail('listScopeRuns') as ConversationGroupDeps['listScopeRuns'],
    readCodexLifecycleSnapshot: fail('readCodexLifecycleSnapshot') as ConversationGroupDeps['readCodexLifecycleSnapshot'],
    getConversationScopeMessages: fail('getConversationScopeMessages') as ConversationGroupDeps['getConversationScopeMessages'],
    setProjectDirectory: fail('setProjectDirectory') as ConversationGroupDeps['setProjectDirectory'],
    setActionAuthorizationMode: fail('setActionAuthorizationMode') as ConversationGroupDeps['setActionAuthorizationMode'],
    listScopeAttachments: fail('listScopeAttachments') as ConversationGroupDeps['listScopeAttachments'],
    getScopeAttachment: fail('getScopeAttachment') as ConversationGroupDeps['getScopeAttachment'],
    clearRemoteAttachmentCache: fail('clearRemoteAttachmentCache') as ConversationGroupDeps['clearRemoteAttachmentCache'],
    getRemoteAttachmentCacheStats: fail('getRemoteAttachmentCacheStats') as ConversationGroupDeps['getRemoteAttachmentCacheStats'],
    log: () => {
      /* no-op — log appender is benign so we let it succeed silently */
    },
  }
}

test('conversationGroup.register wires its channels exactly once each via ipcMain.handle', () => {
  const { ipc, handleCalls } = createMockIpc()
  conversationGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._conversationGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the conversation-scope channels',
  )
  assert.equal(handleCalls.length, _conversationGroupChannelsForTest.length, 'each channel must be registered exactly once')

  // Spot-check the exact channel literals per the plan (V2.1e, §3 V2.1) so
  // accidental renames trip this test even if the channel count happens to
  // still be 8. The V5 IPC contract gate catches the renderer side; this
  // pins the main-side literals.
  for (const required of [
    'agent:listConversationScopes',
    'agent:listScopeRuns',
    'agent:readCodexLifecycleSnapshot',
    'agent:getConversationScopeMessages',
    'agent:setActionAuthorizationMode',
    'agent:setProjectDirectory',
    'agent:listScopeAttachments',
    'agent:getScopeAttachment',
    'agent:clearRemoteAttachmentCache',
    'agent:getRemoteAttachmentCacheStats',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('conversationGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // The plan's V2.0 skeleton documents the namespace as a human label. We pin
  // it because the host (`ipc-handler.ts`) may later sort dispose calls or
  // log by namespace; renaming would silently break that ordering.
  assert.equal(conversationGroup.namespace, 'agent:conversation')
})

test('action authorization handler validates the closed mode union before persistence', () => {
  const { ipc, handleCalls } = createMockIpc()
  const writes: Array<{ scopeId: string; mode: string; epoch: number }> = []
  conversationGroup.register(ipc, {
    ...createMockDeps(),
    setActionAuthorizationMode(scopeId, mode, expectedMessageVisibilityEpoch) {
      writes.push({ scopeId, mode, epoch: expectedMessageVisibilityEpoch })
      return { id: scopeId, meta: { actionAuthorizationMode: mode } } as never
    },
  })
  const handler = handleCalls.find((entry) => entry.channel === 'agent:setActionAuthorizationMode')?.handler
  assert.ok(handler)
  const invalid = handler({} as IpcMainInvokeEvent, { scopeId: 'scope-1', mode: 'always' }) as {
    success: boolean
    error?: string
  }
  assert.deepEqual(invalid, { success: false, error: 'action_authorization_mode_invalid' })
  assert.deepEqual(writes, [])

  const missingIdentity = handler(
    {} as IpcMainInvokeEvent,
    { scopeId: 'scope-1', mode: 'full' },
  ) as { success: boolean; error?: string }
  assert.deepEqual(missingIdentity, {
    success: false,
    error: 'action_authorization_scope_identity_invalid',
  })
  assert.deepEqual(writes, [])

  const valid = handler({} as IpcMainInvokeEvent, {
    scopeId: 'scope-1',
    mode: 'full',
    expectedMessageVisibilityEpoch: 3,
  }) as {
    success: boolean
    data?: { scopeId: string; mode: string; messageVisibilityEpoch: number }
  }
  assert.equal(valid.success, true)
  assert.deepEqual(valid.data, {
    scopeId: 'scope-1',
    mode: 'full',
    messageVisibilityEpoch: 3,
  })
  assert.deepEqual(writes, [{ scopeId: 'scope-1', mode: 'full', epoch: 3 }])
})

test('lifecycle snapshot handler validates identity and returns the exact durable projection', () => {
  const { ipc, handleCalls } = createMockIpc()
  const reads: unknown[] = []
  conversationGroup.register(ipc, {
    ...createMockDeps(),
    readCodexLifecycleSnapshot(request) {
      reads.push(request)
      return {
        identity: request,
        activeReadyRunId: 'run-1',
        latestReadyRunId: 'run-1',
        snapshot: 'product_turn_interruptible',
        interruptRequested: false,
        interruptAcknowledged: false,
        evidenceDigest: 'readback-digest',
      }
    },
  })
  const handler = handleCalls.find(
    (entry) => entry.channel === 'agent:readCodexLifecycleSnapshot',
  )?.handler
  assert.ok(handler)
  assert.equal((handler({} as IpcMainInvokeEvent, {
    aliasId: 'scope-1', aliasGeneration: 0,
  }) as { success: boolean }).success, false)
  assert.deepEqual(reads, [])
  assert.deepEqual(handler({} as IpcMainInvokeEvent, {
    aliasId: 'scope-1', aliasGeneration: 3,
  }), {
    success: true,
    data: {
      identity: { aliasId: 'scope-1', aliasGeneration: 3 },
      activeReadyRunId: 'run-1',
      latestReadyRunId: 'run-1',
      snapshot: 'product_turn_interruptible',
      interruptRequested: false,
      interruptAcknowledged: false,
      evidenceDigest: 'readback-digest',
    },
  })
  assert.deepEqual(reads, [{ aliasId: 'scope-1', aliasGeneration: 3 }])
})

test('IpcDisposeHandle.dispose removes the same channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = conversationGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._conversationGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and stays bounded', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = conversationGroup.register(ipc, createMockDeps())

  handle.dispose()
  const afterFirst = removeHandlerCalls.length
  // Electron's `removeHandler` is itself a no-op on missing channels; the
  // group's dispose loop wraps each call in try/catch, so a second
  // invocation must NOT throw. We allow the call to issue removeHandler
  // again — what we care about is no exception, no handler-slot leak.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same 8 removeHandler calls; total count grows by
  // exactly the channel count, never more.
  assert.equal(
    removeHandlerCalls.length - afterFirst,
    _conversationGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
