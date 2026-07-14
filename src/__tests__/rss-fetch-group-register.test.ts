// Stage V V2.2d — behavior test for `fetchGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// Mirror of the V2.2a SourceGroup, V2.2b ItemGroup, and V2.2c
// AnalysisGroup registration tests. The V5 IPC contract gate proves
// the channel literals stay reachable from the renderer preload; this
// test pins the two pieces of the GROUP MECHANISM the gate cannot
// prove on its own:
//
//   1. `register` registers EXACTLY the 5 channel names the group owns
//      (`rss:fetchAll`, `rss:refreshSource`, `rss:benchmarkSources`,
//      `rss:status`, `rss:stats`) — no extras, no missing ones.
//   2. The returned dispose handle calls `removeHandler` for each of
//      those same 5 channels — so dev-reload re-registration does not
//      leak listeners.
//
// We don't exercise the handler bodies here (the fetch pipeline,
// update lock, route diagnostics, artifact generators, and digest
// snapshot are covered by their own targeted tests + the verify chain).
// The point of this file is registration + dispose contract.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  fetchGroup,
  _fetchGroupChannelsForTest,
  type FetchGroupDeps,
} from '../main/modules/rss-engine/ipc/fetch-group'
import { RSSUpdateLock } from '../main/modules/rss-engine/update-lock'

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

function createMockDeps(): FetchGroupDeps {
  // The behaviour test does not invoke any handler bodies, so the deps
  // just need to satisfy the type. Each method throws so an accidental
  // call is visible in test output rather than silently returning
  // undefined.
  const fail = (label: string) => () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    useMock: false,
    mockSources: [],
    mockItems: [],
    getRSSSources: fail('getRSSSources') as FetchGroupDeps['getRSSSources'],
    getRSSItemsByIds: fail('getRSSItemsByIds') as FetchGroupDeps['getRSSItemsByIds'],
    upsertRSSItems: fail('upsertRSSItems') as FetchGroupDeps['upsertRSSItems'],
    updateRSSSourceLastFetched: fail('updateRSSSourceLastFetched') as FetchGroupDeps['updateRSSSourceLastFetched'],
    updateRSSSourcePlatform: fail('updateRSSSourcePlatform') as FetchGroupDeps['updateRSSSourcePlatform'],
    setRSSSourceDraftSeeded: fail('setRSSSourceDraftSeeded') as FetchGroupDeps['setRSSSourceDraftSeeded'],
    getAllRSSItems: fail('getAllRSSItems') as FetchGroupDeps['getAllRSSItems'],
    getLatestPerSource: fail('getLatestPerSource') as FetchGroupDeps['getLatestPerSource'],
    getRSSStats: fail('getRSSStats') as FetchGroupDeps['getRSSStats'],
    rssUpdateLock: {
      getStatus: fail('rssUpdateLock.getStatus'),
      run: fail('rssUpdateLock.run'),
      isRunning: fail('rssUpdateLock.isRunning'),
    } as unknown as FetchGroupDeps['rssUpdateLock'],
    describeRsshubStatus: fail('describeRsshubStatus') as FetchGroupDeps['describeRsshubStatus'],
    warmEmbeddedRSSHubForDiagnostics: fail('warmEmbeddedRSSHubForDiagnostics') as FetchGroupDeps['warmEmbeddedRSSHubForDiagnostics'],
    getArtifactsRootDir: fail('getArtifactsRootDir') as FetchGroupDeps['getArtifactsRootDir'],
    fetchSourceWithCurrentStack: fail('fetchSourceWithCurrentStack') as FetchGroupDeps['fetchSourceWithCurrentStack'],
    resolveRSSHubBase: fail('resolveRSSHubBase') as FetchGroupDeps['resolveRSSHubBase'],
    requiresRSSHubWarmup: fail('requiresRSSHubWarmup') as FetchGroupDeps['requiresRSSHubWarmup'],
    requiresStrictRSSHubAvailability: fail('requiresStrictRSSHubAvailability') as FetchGroupDeps['requiresStrictRSSHubAvailability'],
    recordSourceRouteAttempt: fail('recordSourceRouteAttempt') as FetchGroupDeps['recordSourceRouteAttempt'],
    persistRouteDiagnosticsSnapshot: fail('persistRouteDiagnosticsSnapshot') as FetchGroupDeps['persistRouteDiagnosticsSnapshot'],
    resolveSourceBackend: fail('resolveSourceBackend') as FetchGroupDeps['resolveSourceBackend'],
    buildSourceDiagnostics: fail('buildSourceDiagnostics') as FetchGroupDeps['buildSourceDiagnostics'],
    buildBrowserActionFromSource: fail('buildBrowserActionFromSource') as FetchGroupDeps['buildBrowserActionFromSource'],
    buildBenchmarkSummary: fail('buildBenchmarkSummary') as FetchGroupDeps['buildBenchmarkSummary'],
    getRouteCapabilityMatrix: fail('getRouteCapabilityMatrix') as FetchGroupDeps['getRouteCapabilityMatrix'],
    generateRSSArtifacts: fail('generateRSSArtifacts') as FetchGroupDeps['generateRSSArtifacts'],
    generateRSSBenchmarkArtifacts: fail('generateRSSBenchmarkArtifacts') as FetchGroupDeps['generateRSSBenchmarkArtifacts'],
    classifyItem: fail('classifyItem') as FetchGroupDeps['classifyItem'],
    detectPlatform: fail('detectPlatform') as FetchGroupDeps['detectPlatform'],
    normalizeSourcePlatform: fail('normalizeSourcePlatform') as FetchGroupDeps['normalizeSourcePlatform'],
    classifyBackend: fail('classifyBackend') as FetchGroupDeps['classifyBackend'],
    resolveRSSItemGuid: fail('resolveRSSItemGuid') as FetchGroupDeps['resolveRSSItemGuid'],
    filterSelectedSources: fail('filterSelectedSources') as FetchGroupDeps['filterSelectedSources'],
    normalizeFetchOptions: fail('normalizeFetchOptions') as FetchGroupDeps['normalizeFetchOptions'],
    persistFetchInvocation: fail('persistFetchInvocation') as FetchGroupDeps['persistFetchInvocation'],
    recordFetchAllCompletedAt: fail('recordFetchAllCompletedAt') as FetchGroupDeps['recordFetchAllCompletedAt'],
    loadDigestSnapshot: fail('loadDigestSnapshot') as FetchGroupDeps['loadDigestSnapshot'],
    saveDigestSnapshot: fail('saveDigestSnapshot') as FetchGroupDeps['saveDigestSnapshot'],
    limitConcurrency: fail('limitConcurrency') as FetchGroupDeps['limitConcurrency'],
    sourceRefreshInFlight: new Set<string>(),
  }
}

test('fetchGroup.register wires the 5 documented channels exactly once each', () => {
  const { ipc, handleCalls } = createMockIpc()
  fetchGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._fetchGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 5 fetch channels',
  )
  assert.equal(handleCalls.length, 5, 'each channel must be registered exactly once')

  // Spot-check the exact channel names per the plan (V2.2d, §3 V2.2) so
  // accidental renames trip this test even if the channel count happens
  // to still be 5.
  for (const required of [
    'rss:fetchAll',
    'rss:refreshSource',
    'rss:benchmarkSources',
    'rss:status',
    'rss:stats',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('fetchGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // Mirror of the prior three groups' namespace pins. The host
  // (`ipc-handler.ts`) may later sort dispose calls or log by namespace;
  // renaming would silently break that ordering.
  assert.equal(fetchGroup.namespace, 'rss:fetch')
})

test('the callable fetchAll handle and IPC channel execute the same business entry', async () => {
  const { ipc, handleCalls } = createMockIpc()
  const handle = fetchGroup.register(ipc, { ...createMockDeps(), useMock: true })
  const ipcHandler = handleCalls.find((entry) => entry.channel === 'rss:fetchAll')?.handler
  assert.ok(ipcHandler)

  const directResult = await handle.fetchAll()
  const ipcResult = await ipcHandler({} as IpcMainInvokeEvent)

  assert.deepEqual(directResult, ipcResult)
  assert.equal((directResult as { success?: boolean }).success, true)
})

test('completed fetchAll records durable completion after passing through RSSUpdateLock', async () => {
  const { ipc } = createMockIpc()
  const completedAt: string[] = []
  const handle = fetchGroup.register(ipc, {
    ...createMockDeps(),
    getRSSSources: () => [],
    filterSelectedSources: (sources) => sources,
    normalizeFetchOptions: () => ({ digest: false, classification: 'simple' }),
    persistFetchInvocation: () => undefined,
    recordFetchAllCompletedAt: (value) => completedAt.push(value),
    rssUpdateLock: new RSSUpdateLock(),
  })

  const result = await handle.fetchAll()

  assert.equal(result.success, true)
  assert.equal(result.data?.message, 'No RSS sources configured')
  assert.equal(completedAt.length, 1)
  assert.ok(Number.isFinite(Date.parse(completedAt[0])))
})

test('failed fetchAll also records completion so cold start does not retry in a tight loop', async () => {
  const { ipc } = createMockIpc()
  const completedAt: string[] = []
  const handle = fetchGroup.register(ipc, {
    ...createMockDeps(),
    getRSSSources: () => {
      throw new Error('database unavailable')
    },
    normalizeFetchOptions: () => ({ digest: false, classification: 'simple' }),
    persistFetchInvocation: () => undefined,
    recordFetchAllCompletedAt: (value) => completedAt.push(value),
    rssUpdateLock: new RSSUpdateLock(),
  })

  const result = await handle.fetchAll()

  assert.equal(result.success, false)
  assert.equal(result.error, 'database unavailable')
  assert.equal(completedAt.length, 1)
})

test('IpcDisposeHandle.dispose removes the same 5 channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = fetchGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._fetchGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and removes nothing the second time beyond electron no-op', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = fetchGroup.register(ipc, createMockDeps())

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
    _fetchGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
