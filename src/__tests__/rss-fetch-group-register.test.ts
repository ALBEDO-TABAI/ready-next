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
    isEmbeddedRSSHubRequiredForDiagnostics: fail('isEmbeddedRSSHubRequiredForDiagnostics') as FetchGroupDeps['isEmbeddedRSSHubRequiredForDiagnostics'],
    getArtifactsRootDir: fail('getArtifactsRootDir') as FetchGroupDeps['getArtifactsRootDir'],
    fetchSourceWithCurrentStack: fail('fetchSourceWithCurrentStack') as FetchGroupDeps['fetchSourceWithCurrentStack'],
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
    yieldToEventLoop: fail('yieldToEventLoop') as FetchGroupDeps['yieldToEventLoop'],
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
    normalizeFetchOptions: () => ({ digest: false, trigger: 'manual-all' }),
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
    normalizeFetchOptions: () => ({ digest: false, trigger: 'manual-all' }),
    persistFetchInvocation: () => undefined,
    recordFetchAllCompletedAt: (value) => completedAt.push(value),
    rssUpdateLock: new RSSUpdateLock(),
  })

  const result = await handle.fetchAll()

  assert.equal(result.success, false)
  assert.equal(result.error, 'database unavailable')
  assert.equal(completedAt.length, 1)
})

test('single-source refresh yields the main event loop before completing', async () => {
  const { ipc, handleCalls } = createMockIpc()
  let yields = 0
  fetchGroup.register(ipc, {
    ...createMockDeps(),
    getRSSSources: () => [],
    persistFetchInvocation: () => undefined,
    yieldToEventLoop: async () => { yields += 1 },
  })
  const handler = handleCalls.find((entry) => entry.channel === 'rss:refreshSource')?.handler
  assert.ok(handler)

  const result = await handler({} as IpcMainInvokeEvent, { sourceId: 'missing' }) as { success: boolean }

  assert.equal(result.success, false)
  assert.equal(yields, 1)
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

// ---------------------------------------------------------------------------
// Session sources whose page was not opened this round (contract S8 of
// docs/superpowers/plans/2026-11-17-ready-next-rss-session-acquisition-implementation.md)
// ---------------------------------------------------------------------------

interface AttemptRecord { sourceId: string; success: boolean; itemCount: number; error?: string | null }

function createFetchDeps(overrides: Partial<FetchGroupDeps> & {
  fetchSourceWithCurrentStack: FetchGroupDeps['fetchSourceWithCurrentStack']
}) {
  const attempts: AttemptRecord[] = []
  const lastFetched: string[] = []
  const sources = [
    { id: 'native-1', name: 'Hacker News', url: 'https://news.ycombinator.com/rss', group_name: 'default', icon: null, last_fetched: null, enabled: 1, created_at: 1, platform: 'rss' },
    { id: 'xhs-1', name: '广州潮会吃', url: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06', group_name: 'default', icon: null, last_fetched: null, enabled: 1, created_at: 2, platform: 'xiaohongshu' },
  ]
  const deps: FetchGroupDeps = {
    ...createMockDeps(),
    getRSSSources: () => sources,
    filterSelectedSources: (all) => all,
    detectPlatform: (url) => (url.includes('xiaohongshu.com') ? 'xiaohongshu' : 'rss'),
    normalizeSourcePlatform: (source) => (source.url.includes('xiaohongshu.com') ? 'xiaohongshu' : 'rss'),
    resolveSourceBackend: (platform) => (platform === 'xiaohongshu' ? 'browser' : 'native'),
    resolveRSSItemGuid: (item) => item.link,
    getRSSItemsByIds: () => [],
    getAllRSSItems: () => [],
    upsertRSSItems: (items) => items.length,
    updateRSSSourceLastFetched: (id) => { lastFetched.push(id) },
    setRSSSourceDraftSeeded: () => undefined,
    updateRSSSourcePlatform: () => undefined,
    recordSourceRouteAttempt: (entry) => { attempts.push(entry) },
    persistRouteDiagnosticsSnapshot: () => undefined,
    generateRSSArtifacts: async () => ({}),
    persistFetchInvocation: () => undefined,
    recordFetchAllCompletedAt: () => undefined,
    buildBrowserActionFromSource: () => ({ type: 'open_in_browser', label: '去浏览器继续验证', url: sources[1].url, platform: 'xiaohongshu', reason: 'verify' }),
    limitConcurrency: async (tasks) => Promise.allSettled(tasks.map((task) => task())),
    yieldToEventLoop: async () => undefined,
    rssUpdateLock: new RSSUpdateLock(),
    ...overrides,
  }
  return { deps, attempts, lastFetched }
}

const nativeItem = { itemId: 'rss_1', title: 'A story', description: '', link: 'https://example.com/a', pubDate: '', author: '', coverImage: null, metadata: {} }

test('an automatic fetchAll passes its trigger on and leaves a session source that is not due untouched', async () => {
  const { ipc } = createMockIpc()
  const seen: Array<{ platform: string; trigger: string }> = []
  const { deps, attempts, lastFetched } = createFetchDeps({
    normalizeFetchOptions: (options) => ({ digest: false, trigger: options?.trigger === 'auto' ? 'auto' : 'manual-all' }),
    fetchSourceWithCurrentStack: async (_source, platform, options) => {
      seen.push({ platform, trigger: options.trigger })
      if (platform === 'xiaohongshu') {
        return {
          result: { items: [], feedTitle: '', platform, error: '小红书 的这个订阅还没到刷新时间。' },
          backendUsed: 'browser',
          deferred: { reason: 'not_due' },
        }
      }
      return { result: { items: [nativeItem], feedTitle: 'HN', platform }, backendUsed: 'native' }
    },
  })
  const handle = fetchGroup.register(ipc, deps)

  const result = await handle.fetchAll({ trigger: 'auto' })

  assert.deepEqual(seen.sort((a, b) => a.platform.localeCompare(b.platform)), [
    { platform: 'rss', trigger: 'auto' },
    { platform: 'xiaohongshu', trigger: 'auto' },
  ])
  assert.equal(result.success, true)
  assert.equal(result.data?.errors, undefined, 'a source waiting for its turn is not an error')
  assert.equal(result.data?.message, 'Fetched 1 sources, 1 new items, 1 waiting for their next turn')
  assert.deepEqual(attempts.map((entry) => entry.sourceId), ['native-1'], 'no attempt is recorded for a page that was not opened')
  assert.deepEqual(lastFetched, ['native-1'])
})

test('a fetchAll the person asked for is a manual refresh', async () => {
  const { ipc } = createMockIpc()
  const triggers: string[] = []
  const { deps } = createFetchDeps({
    normalizeFetchOptions: (options) => ({ digest: false, trigger: options?.trigger === 'auto' ? 'auto' : 'manual-all' }),
    fetchSourceWithCurrentStack: async (_source, platform, options) => {
      triggers.push(options.trigger)
      return { result: { items: [nativeItem], feedTitle: 'x', platform }, backendUsed: 'native' }
    },
  })
  const handle = fetchGroup.register(ipc, deps)

  const result = await handle.fetchAll()

  assert.deepEqual(triggers, ['manual-all', 'manual-all'])
  assert.equal(result.data?.message, 'Fetched 2 sources, 2 new items', 'no waiting note when every source was read')
})

test('refreshing one paused session source explains the pause, offers the browser, and records nothing', async () => {
  const { ipc, handleCalls } = createMockIpc()
  const triggers: string[] = []
  const { deps, attempts, lastFetched } = createFetchDeps({
    fetchSourceWithCurrentStack: async (_source, platform, options) => {
      triggers.push(options.trigger)
      return {
        result: { items: [], feedTitle: '', platform, error: '小红书 最近遇到了登录页或验证页，自动刷新已暂停。请先在 Ready 浏览器中打开该主页处理好，再刷新。' },
        backendUsed: 'browser',
        deferred: { reason: 'platform_paused' },
      }
    },
  })
  fetchGroup.register(ipc, deps)
  const handler = handleCalls.find((entry) => entry.channel === 'rss:refreshSource')?.handler
  assert.ok(handler)

  const result = await handler({} as IpcMainInvokeEvent, { sourceId: 'xhs-1' }) as {
    success: boolean
    error?: string
    data?: { browserAction?: { label: string }; fetched: number }
  }

  assert.deepEqual(triggers, ['manual-source'])
  assert.equal(result.success, false)
  assert.match(result.error || '', /广州潮会吃.*自动刷新已暂停/)
  assert.equal(result.data?.browserAction?.label, '去浏览器继续验证')
  assert.deepEqual(attempts, [])
  assert.deepEqual(lastFetched, [])
})

test('ordinary feeds are fetched before sources that take turns in the browser session', async () => {
  const { ipc } = createMockIpc()
  const order: string[] = []
  const { deps } = createFetchDeps({
    // The session source comes first in the list, as a newly added source does.
    getRSSSources: () => [
      { id: 'xhs-1', name: '广州潮会吃', url: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06', group_name: 'default', icon: null, last_fetched: null, enabled: 1, created_at: 3, platform: 'xiaohongshu' },
      { id: 'native-1', name: 'Hacker News', url: 'https://news.ycombinator.com/rss', group_name: 'default', icon: null, last_fetched: null, enabled: 1, created_at: 2, platform: 'rss' },
      { id: 'native-2', name: 'Another feed', url: 'https://example.com/feed.xml', group_name: 'default', icon: null, last_fetched: null, enabled: 1, created_at: 1, platform: 'rss' },
    ],
    normalizeFetchOptions: () => ({ digest: false, trigger: 'manual-all' }),
    limitConcurrency: async (tasks) => {
      const settled: PromiseSettledResult<Awaited<ReturnType<(typeof tasks)[number]>>>[] = []
      for (const task of tasks) settled.push({ status: 'fulfilled', value: await task() })
      return settled
    },
    fetchSourceWithCurrentStack: async (source, platform) => {
      order.push(source.id)
      return { result: { items: [], feedTitle: 'x', platform }, backendUsed: platform === 'xiaohongshu' ? 'browser' : 'native' }
    },
  })
  const handle = fetchGroup.register(ipc, deps)

  await handle.fetchAll()

  assert.deepEqual(order, ['native-1', 'native-2', 'xhs-1'])
})
