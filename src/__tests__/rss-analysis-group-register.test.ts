// Stage V V2.2c — behavior test for `analysisGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// Mirror of the V2.2a SourceGroup + V2.2b ItemGroup registration tests.
// The V5 IPC contract gate proves the channel literals stay reachable
// from the renderer preload; this test pins the two pieces of the GROUP
// MECHANISM the gate cannot prove on its own:
//
//   1. `register` registers EXACTLY the 6 channel names the group owns
//      (no extras, no missing ones).
//   2. The returned dispose handle calls `removeHandler` for each of
//      those same 6 channels — so dev-reload re-registration does not
//      leak listeners.
//
// We don't exercise the handler bodies here (handler semantics are
// covered by item-analysis-manager unit + integration tests). The point
// of this file is registration + dispose contract.
//
// `rss:startItemAnalysis` in particular: the host's V5 regex previously
// missed this multi-line `ipcMain.handle(\n  'rss:startItemAnalysis',\n
// async (…)` registration. The ts-compiler-API V5 gate now catches it,
// AND this test pins the channel name in the group's CHANNELS literal
// so a future drop-by-mistake during further refactors still trips.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  analysisGroup,
  _analysisGroupChannelsForTest,
  type AnalysisGroupDeps,
} from '../main/modules/rss-engine/ipc/analysis-group'

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

function createMockDeps(): AnalysisGroupDeps {
  // The behaviour test does not invoke any handler bodies, so the deps
  // just need to satisfy the type. Each method throws so an accidental
  // call is visible in test output rather than silently returning
  // undefined.
  const fail = (label: string) => () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    useMock: false,
    getAnalysisManager: fail('getAnalysisManager') as AnalysisGroupDeps['getAnalysisManager'],
    mapAnalysisJob: fail('mapAnalysisJob') as AnalysisGroupDeps['mapAnalysisJob'],
  }
}

test('analysisGroup.register wires the 6 documented channels exactly once each', () => {
  const { ipc, handleCalls } = createMockIpc()
  analysisGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._analysisGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 6 analysis channels',
  )
  assert.equal(handleCalls.length, 6, 'each channel must be registered exactly once')

  // Spot-check the exact channel names per the plan (V2.2c, §3 V2.2) so
  // accidental renames trip this test even if the channel count happens
  // to still be 6. `rss:startItemAnalysis` in particular is the
  // multi-line registration the V5 regex previously missed — pinning the
  // literal here protects against re-introducing that miss.
  for (const required of [
    'rss:startItemAnalysis',
    'rss:getItemAnalysisProgress',
    'rss:listItemAnalysisJobs',
    'rss:pauseAnalysisJob',
    'rss:resumeAnalysisJob',
    'rss:deleteAnalysisJob',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('analysisGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // Mirror of the SourceGroup / ItemGroup namespace pins. The host
  // (`ipc-handler.ts`) may later sort dispose calls or log by namespace;
  // renaming would silently break that ordering.
  assert.equal(analysisGroup.namespace, 'rss:analysis')
})

test('IpcDisposeHandle.dispose removes the same 6 channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = analysisGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._analysisGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and removes nothing the second time beyond electron no-op', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = analysisGroup.register(ipc, createMockDeps())

  handle.dispose()
  const afterFirst = removeHandlerCalls.length
  // Electron's `removeHandler` is itself a no-op on missing channels; the
  // group's dispose loop wraps each call in try/catch, so a second
  // invocation must NOT throw. We allow the call to issue removeHandler
  // again — what we care about is no exception, no listener leak.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same 6 removeHandler calls; total count grows
  // by exactly the channel count, never more.
  assert.equal(
    removeHandlerCalls.length - afterFirst,
    _analysisGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
