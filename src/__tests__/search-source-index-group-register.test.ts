// Stage V V2.4a — behavior test for `sourceIndexGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// Mirrors `document-mark-group-register.test.ts` (V2.3a) and
// `rss-source-group-register.test.ts` (V2.2a). Stage V's search-engine
// extraction follows the same pattern: each channel cluster becomes an
// `IpcChannelGroup<Deps>` with its own per-group deps. This file pins the
// two pieces of the group contract that the V5 IPC contract gate cannot
// prove on its own:
//
//   1. `register` registers EXACTLY the 4 channel names the group owns
//      (no extras, no missing ones)
//   2. The returned dispose handle calls `removeHandler` for each of those
//      same 4 channels — so dev-reload re-registration does not leak
//      listeners.
//
// We don't exercise the handler bodies here (those are covered by
// existing search-engine tests + the V5 gate confirms the channel literals
// still exist). The point of this file is the GROUP MECHANISM, not handler
// semantics.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  sourceIndexGroup,
  _sourceIndexGroupChannelsForTest,
  type SourceIndexGroupDeps,
} from '../main/modules/search-engine/ipc/source-index-group'

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
  // the group's call signatures still type-check. Anything else would throw,
  // which is exactly the assertion we want — the test fails loudly if the
  // group grows a new ipc surface without updating this mock.
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

function createMockDeps(): SourceIndexGroupDeps {
  // The behaviour test does not invoke any handler bodies, so the deps just
  // need to satisfy the type. Every callable throws so an accidental
  // invocation surfaces in test output rather than silently returning
  // undefined.
  const throwOnCall = (label: string) => () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    getSearchEngine: throwOnCall('getSearchEngine') as SourceIndexGroupDeps['getSearchEngine'],
    getWorkerBridge: throwOnCall('getWorkerBridge') as SourceIndexGroupDeps['getWorkerBridge'],
    validateWorkspaceRoot: throwOnCall('validateWorkspaceRoot') as SourceIndexGroupDeps['validateWorkspaceRoot'],
    recordSearchWorkerFallback: throwOnCall('recordSearchWorkerFallback') as SourceIndexGroupDeps['recordSearchWorkerFallback'],
    noteSearchWorkerSuccess: throwOnCall('noteSearchWorkerSuccess') as SourceIndexGroupDeps['noteSearchWorkerSuccess'],
  }
}

test('sourceIndexGroup.register wires the 4 documented channels exactly once each', () => {
  const { ipc, handleCalls } = createMockIpc()
  sourceIndexGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._sourceIndexGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 4 source-index channels',
  )
  assert.equal(handleCalls.length, 4, 'each channel must be registered exactly once')

  // Spot-check the exact channel names per the plan (V2.4a, §3 V2.4) so
  // accidental renames trip this test even if the channel count happens
  // to still be 4. The V5 IPC contract gate catches the renderer side;
  // this pins the main-side literals.
  for (const required of [
    'document:listSources',
    'document:indexDocument',
    'document:reindexAllSources',
    'document:reindexWorkspace',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('sourceIndexGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // The plan's V2.4 skeleton documents the namespace as a human label. We
  // pin it because the host (`ipc-handler.ts`) may later sort dispose calls
  // or log by namespace; renaming would silently break that ordering.
  assert.equal(sourceIndexGroup.namespace, 'document:sourceIndex')
})

test('IpcDisposeHandle.dispose removes the same 4 channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = sourceIndexGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._sourceIndexGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and removes nothing the second time beyond electron no-op', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = sourceIndexGroup.register(ipc, createMockDeps())

  handle.dispose()
  const afterFirst = removeHandlerCalls.length
  // Electron's `removeHandler` is itself a no-op on missing channels; the
  // group's dispose loop wraps each call in try/catch, so a second
  // invocation must NOT throw. We allow the call to issue removeHandler
  // again — what we care about is no exception, no listener leak.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same 5 removeHandler calls; total count grows
  // by exactly the channel count, never more.
  assert.equal(
    removeHandlerCalls.length - afterFirst,
    _sourceIndexGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
