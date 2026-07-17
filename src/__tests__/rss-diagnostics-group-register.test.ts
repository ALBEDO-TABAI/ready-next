// Stage V V2.2e — behavior test for `diagnosticsGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// Mirror of the V2.2a–d group registration tests. The V5 IPC contract gate
// proves the channel literals stay reachable from the renderer preload;
// this test pins the two pieces of the GROUP MECHANISM the gate cannot
// prove on its own:
//
//   1. `register` registers EXACTLY the 2 channel names the group owns
//      (`rss:repairRuntime`, `rss:diagnostics`) — no extras, no missing
//      ones.
//   2. The returned dispose handle calls `removeHandler` for each of
//      those same 2 channels — so dev-reload re-registration does not
//      leak listeners.
//
// We don't exercise the handler bodies here (the rsshub manager, update
// lock, diagnostics helpers, fetch-invocation snapshot loader, benchmark
// snapshot loader, and artifacts-directory probe are covered by their
// own targeted tests + the verify chain). The point of this file is
// registration + dispose contract.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  diagnosticsGroup,
  _diagnosticsGroupChannelsForTest,
  type DiagnosticsGroupDeps,
} from '../main/modules/rss-engine/ipc/diagnostics-group'

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

function createMockDeps(): DiagnosticsGroupDeps {
  // The behaviour test does not invoke any handler bodies, so the deps
  // just need to satisfy the type. Each method throws so an accidental
  // call is visible in test output rather than silently returning
  // undefined.
  const fail = (label: string) => () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    useMock: false,
    getRSSSources: fail('getRSSSources') as DiagnosticsGroupDeps['getRSSSources'],
    rssUpdateLock: {
      getStatus: fail('rssUpdateLock.getStatus'),
      run: fail('rssUpdateLock.run'),
      isRunning: fail('rssUpdateLock.isRunning'),
    } as unknown as DiagnosticsGroupDeps['rssUpdateLock'],
    rsshubStop: fail('rsshubStop') as DiagnosticsGroupDeps['rsshubStop'],
    rsshubEnsureHealthy: fail('rsshubEnsureHealthy') as DiagnosticsGroupDeps['rsshubEnsureHealthy'],
    describeRsshubStatus: fail('describeRsshubStatus') as DiagnosticsGroupDeps['describeRsshubStatus'],
    isEmbeddedRSSHubRequiredForDiagnostics: fail('isEmbeddedRSSHubRequiredForDiagnostics') as DiagnosticsGroupDeps['isEmbeddedRSSHubRequiredForDiagnostics'],
    buildSourceDiagnostics: fail('buildSourceDiagnostics') as DiagnosticsGroupDeps['buildSourceDiagnostics'],
    getRouteCapabilityMatrix: fail('getRouteCapabilityMatrix') as DiagnosticsGroupDeps['getRouteCapabilityMatrix'],
    loadFetchInvocationSnapshot: fail('loadFetchInvocationSnapshot') as DiagnosticsGroupDeps['loadFetchInvocationSnapshot'],
    loadLatestBenchmarkSnapshot: fail('loadLatestBenchmarkSnapshot') as DiagnosticsGroupDeps['loadLatestBenchmarkSnapshot'],
    getArtifactsRootDir: fail('getArtifactsRootDir') as DiagnosticsGroupDeps['getArtifactsRootDir'],
    readFileUtf8: fail('readFileUtf8') as DiagnosticsGroupDeps['readFileUtf8'],
    joinPath: fail('joinPath') as DiagnosticsGroupDeps['joinPath'],
  }
}

test('diagnosticsGroup.register wires the 2 documented channels exactly once each', () => {
  const { ipc, handleCalls } = createMockIpc()
  diagnosticsGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._diagnosticsGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 2 diagnostics channels',
  )
  assert.equal(handleCalls.length, 2, 'each channel must be registered exactly once')

  // Spot-check the exact channel names per the plan (V2.2e, §3 V2.2) so
  // accidental renames trip this test even if the channel count happens
  // to still be 2.
  for (const required of [
    'rss:repairRuntime',
    'rss:diagnostics',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('diagnosticsGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // Mirror of the prior four groups' namespace pins. The host
  // (`ipc-handler.ts`) may later sort dispose calls or log by namespace;
  // renaming would silently break that ordering.
  assert.equal(diagnosticsGroup.namespace, 'rss:diagnostics')
})

test('IpcDisposeHandle.dispose removes the same 2 channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = diagnosticsGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._diagnosticsGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and removes nothing the second time beyond electron no-op', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = diagnosticsGroup.register(ipc, createMockDeps())

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
    _diagnosticsGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
