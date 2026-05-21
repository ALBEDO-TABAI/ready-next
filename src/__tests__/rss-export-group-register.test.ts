// Stage V V2.2f — behavior test for `exportGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// Mirror of the V2.2a–e group registration tests. The V5 IPC contract gate
// proves the channel literals stay reachable from the renderer preload;
// this test pins the two pieces of the GROUP MECHANISM the gate cannot
// prove on its own:
//
//   1. `register` registers EXACTLY the 2 channel names the group owns
//      (`rss:exportOpml`, `rss:exportFeed`) — no extras, no missing
//      ones.
//   2. The returned dispose handle calls `removeHandler` for each of
//      those same 2 channels — so dev-reload re-registration does not
//      leak listeners.
//
// We don't exercise the handler bodies here (the artifact-bundle generator
// and the artifacts directory path probes are covered by their own
// targeted tests + the verify chain). The point of this file is
// registration + dispose contract.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  exportGroup,
  _exportGroupChannelsForTest,
  type ExportGroupDeps,
} from '../main/modules/rss-engine/ipc/export-group'

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

function createMockDeps(): ExportGroupDeps {
  // The behaviour test does not invoke any handler bodies, so the deps
  // just need to satisfy the type. Each method throws so an accidental
  // call is visible in test output rather than silently returning
  // undefined.
  const fail = (label: string) => () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    useMock: false,
    ensureArtifactFiles: fail('ensureArtifactFiles') as ExportGroupDeps['ensureArtifactFiles'],
    getArtifactsRootDir: fail('getArtifactsRootDir') as ExportGroupDeps['getArtifactsRootDir'],
    joinPath: fail('joinPath') as ExportGroupDeps['joinPath'],
  }
}

test('exportGroup.register wires the 2 documented channels exactly once each', () => {
  const { ipc, handleCalls } = createMockIpc()
  exportGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._exportGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 2 export channels',
  )
  assert.equal(handleCalls.length, 2, 'each channel must be registered exactly once')

  // Spot-check the exact channel names per the plan (V2.2f, §3 V2.2) so
  // accidental renames trip this test even if the channel count happens
  // to still be 2.
  for (const required of [
    'rss:exportOpml',
    'rss:exportFeed',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('exportGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // Mirror of the prior five groups' namespace pins. The host
  // (`ipc-handler.ts`) may later sort dispose calls or log by namespace;
  // renaming would silently break that ordering.
  assert.equal(exportGroup.namespace, 'rss:export')
})

test('IpcDisposeHandle.dispose removes the same 2 channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = exportGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._exportGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and removes nothing the second time beyond electron no-op', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = exportGroup.register(ipc, createMockDeps())

  handle.dispose()
  const afterFirst = removeHandlerCalls.length
  // Electron's `removeHandler` is itself a no-op on missing channels; the
  // group's dispose loop wraps each call in try/catch, so a second
  // invocation must NOT throw. We allow the call to issue removeHandler
  // again — what we care about is no exception, no listener leak.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same 2 removeHandler calls; total count grows
  // by exactly the channel count, never more.
  assert.equal(
    removeHandlerCalls.length - afterFirst,
    _exportGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
