// Stage V V2.4b — behavior test for `searchQueryGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// Mirrors `search-source-index-group-register.test.ts` (V2.4a). Pins the
// group-mechanism contract the V5 IPC contract gate cannot prove on its own:
//
//   1. `register` registers EXACTLY the 3 channel names the group owns
//      (`document:searchIndex` / `document:getBacklinks` / `document:getGraph`).
//   2. The returned dispose handle calls `removeHandler` for each of those
//      same 3 channels — so dev-reload re-registration does not leak
//      listeners.
//   3. `namespace` stays at the documented `document:query` label so the
//      host can rely on it for future dispose-ordering / logging.
//   4. `dispose()` is idempotent (second call must not throw).
//
// Handler bodies are covered by the existing search-engine tests + the V5
// IPC contract gate; this file is the GROUP MECHANISM contract.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  searchQueryGroup,
  _searchQueryGroupChannelsForTest,
  type SearchQueryGroupDeps,
} from '../main/modules/search-engine/ipc/query-group'

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

function createMockDeps(): SearchQueryGroupDeps {
  // The behaviour test does not invoke any handler bodies, so the deps just
  // need to satisfy the type. Every callable throws so an accidental
  // invocation surfaces in test output rather than silently returning
  // undefined.
  const throwOnCall = (label: string) => () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    getSearchEngine: throwOnCall('getSearchEngine') as SearchQueryGroupDeps['getSearchEngine'],
    getWorkerBridge: throwOnCall('getWorkerBridge') as SearchQueryGroupDeps['getWorkerBridge'],
    validateWorkspaceRoot: throwOnCall('validateWorkspaceRoot') as SearchQueryGroupDeps['validateWorkspaceRoot'],
    recordSearchWorkerFallback: throwOnCall('recordSearchWorkerFallback') as SearchQueryGroupDeps['recordSearchWorkerFallback'],
    noteSearchWorkerSuccess: throwOnCall('noteSearchWorkerSuccess') as SearchQueryGroupDeps['noteSearchWorkerSuccess'],
  }
}

test('searchQueryGroup.register wires the 3 documented channels exactly once each', () => {
  const { ipc, handleCalls } = createMockIpc()
  searchQueryGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._searchQueryGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 3 search-query channels',
  )
  assert.equal(handleCalls.length, 3, 'each channel must be registered exactly once')

  // Spot-check the exact channel names per the plan (V2.4b, §3 V2.4) so
  // accidental renames trip this test even if the channel count happens
  // to still be 3. The V5 IPC contract gate catches the renderer side;
  // this pins the main-side literals.
  for (const required of [
    'document:searchIndex',
    'document:getBacklinks',
    'document:getGraph',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('searchQueryGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // The plan's V2.4 skeleton documents the namespace as a human label. We
  // pin it because the host (`ipc-handler.ts`) may later sort dispose calls
  // or log by namespace; renaming would silently break that ordering.
  assert.equal(searchQueryGroup.namespace, 'document:query')
})

test('IpcDisposeHandle.dispose removes the same 3 channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = searchQueryGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._searchQueryGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and removes nothing beyond electron no-op', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = searchQueryGroup.register(ipc, createMockDeps())

  handle.dispose()
  const afterFirst = removeHandlerCalls.length
  // Electron's `removeHandler` is itself a no-op on missing channels; the
  // group's dispose loop wraps each call in try/catch, so a second
  // invocation must NOT throw.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same 3 removeHandler calls; total count grows
  // by exactly the channel count, never more.
  assert.equal(
    removeHandlerCalls.length - afterFirst,
    _searchQueryGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
