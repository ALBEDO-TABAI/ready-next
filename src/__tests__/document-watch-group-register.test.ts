// Stage V V2.3f — behavior test for `watchGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// Mirrors `document-parser-group-register.test.ts` (V2.3e). The watch
// group owns ONE request channel (`document:watchDirectories`) plus its
// paired `document:directoryChanged` push; this file pins the two pieces
// of the group contract that the V5 IPC contract gate cannot prove on its
// own:
//
//   1. `register` registers EXACTLY the 1 request channel name the group
//      owns (no extras, no missing ones). The push channel is NOT
//      registered via `ipcMain.handle` — it is emitted via
//      `sender.send(…)` from within the request handler — so it does NOT
//      appear in `handleCalls`.
//   2. The returned dispose handle calls `removeHandler` for the same
//      request channel — so dev-reload re-registration does not leak
//      listeners.
//
// Handler bodies are NOT exercised here (real `fs.watch` behavior depends
// on the host filesystem and the renderer-side push consumer; the V5 gate
// confirms the channel literals exist on both sides of the IPC boundary).
// The point of this file is the GROUP MECHANISM, not handler semantics.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  watchGroup,
  _watchGroupChannelsForTest,
  type WatchGroupDeps,
} from '../main/modules/document-engine/ipc/watch-group'

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

function createMockDeps(): WatchGroupDeps {
  // The handler body short-circuits on `useMock` so we never touch real
  // `fs.watch` / `sender.send`. The 0ms debounce is harmless because no
  // watcher ever fires in mock mode.
  return { useMock: true, debounceMs: 0 }
}

test('watchGroup.register wires the 1 documented request channel exactly once', () => {
  const { ipc, handleCalls } = createMockIpc()
  watchGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._watchGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 1 document watch request channel',
  )
  assert.equal(handleCalls.length, 1, 'the request channel must be registered exactly once')

  // Spot-check the exact channel name per the plan (V2.3f, §3 V2.3) so
  // accidental renames trip this test even if the channel count happens
  // to still be 1. The V5 IPC contract gate catches the renderer side and
  // the paired `document:directoryChanged` push literal; this pins the
  // main-side request literal.
  assert.ok(
    registered.includes('document:watchDirectories'),
    'expected channel "document:watchDirectories" to be registered',
  )
})

test('watchGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // The plan's V2.3 skeleton documents the namespace as a human label. We
  // pin it because the host (`ipc-handler.ts`) may later sort dispose calls
  // or log by namespace; renaming would silently break that ordering.
  assert.equal(watchGroup.namespace, 'document:watch')
})

test('IpcDisposeHandle.dispose removes the same request channel that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = watchGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._watchGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and removes nothing the second time beyond electron no-op', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = watchGroup.register(ipc, createMockDeps())

  handle.dispose()
  const afterFirst = removeHandlerCalls.length
  // Electron's `removeHandler` is itself a no-op on missing channels; the
  // group's dispose loop wraps each call in try/catch, so a second
  // invocation must NOT throw. We allow the call to issue removeHandler
  // again — what we care about is no exception, no listener leak.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same removeHandler call(s); total count grows
  // by exactly the channel count, never more.
  assert.equal(
    removeHandlerCalls.length - afterFirst,
    _watchGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
