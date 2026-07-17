import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { readBrowserSessionStatus } from '../main/modules/browser-engine/browser-session-status'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type {
  BrowserSensitiveOperation,
  BrowserTaskEnvelope,
} from '../shared/browser-task-envelope'

function dataOf(result: Awaited<ReturnType<typeof executeBrowserTool>>): Record<string, unknown> {
  if (typeof result === 'string') return JSON.parse(result) as Record<string, unknown>
  return result.data || JSON.parse(result.text) as Record<string, unknown>
}

function taskContext(params: {
  instruction: string
  tabId?: string
  origin?: string
  operations?: BrowserSensitiveOperation[]
}) {
  const taskEnvelope: BrowserTaskEnvelope = {
    version: 1,
    scopeId: 'scope-1',
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'ready',
    primaryInstruction: params.instruction,
    allowedToolNames: ['browser_session', 'browser_permission'],
    allowedEffects: ['observe'],
    allowedSensitiveOperations: params.operations || [],
    tabId: params.tabId || 'tab-1',
    origin: params.origin || 'https://example.test',
    destination: null,
    workspaceRoots: [],
    createdAt: Date.now(),
  }
  return {
    ownerRunId: 'run-1',
    parentTaskId: 'task-1',
    taskEnvelope,
  }
}

test('browser_network keeps one trace across start, list, details and stop with secret redaction', async () => {
  let stopped = 0
  const events = [{
    requestId: 'req-1',
    url: 'https://example.test/api',
    method: 'GET',
    status: 200,
    responseHeaders: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
  }]
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }],
    startNetworkObserver: async () => ({
      id: 'trace-1',
      events: () => events,
      stop: async () => { stopped += 1 },
    }),
  } as unknown as BrowserController

  const started = dataOf(await executeBrowserTool('browser_network', { action: 'start' }, controller))
  assert.equal(started.ok, true)
  assert.equal(started.traceId, 'trace-1')

  const listed = dataOf(await executeBrowserTool('browser_network', { action: 'list' }, controller))
  const listedEvents = listed.events as Array<Record<string, unknown>>
  assert.equal(listed.eventCount, 1)
  assert.equal((listedEvents[0].responseHeaders as Record<string, unknown>).Authorization, '[redacted]')
  assert.equal((listedEvents[0].responseHeaders as Record<string, unknown>)['Content-Type'], 'application/json')

  const details = dataOf(await executeBrowserTool('browser_network', { action: 'details', request_id: 'req-1' }, controller))
  assert.equal((details.event as Record<string, unknown>).requestId, 'req-1')

  const stoppedResult = dataOf(await executeBrowserTool('browser_network', { action: 'stop' }, controller))
  assert.equal(stoppedResult.running, false)
  assert.equal(stopped, 1)

  const afterStop = dataOf(await executeBrowserTool('browser_network', { action: 'list' }, controller))
  assert.equal(afterStop.errorKind, 'network_trace_not_started')
})

test('browser_session status reports login/profile counts without exposing cookie values', async () => {
  const cookies = [
    { name: 'session', value: 'super-secret-token' },
    { name: 'prefs', value: 'private-value' },
  ]
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Account', url: 'https://example.test/account', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Account', url: 'https://example.test/account', active: true }],
    getBrowserSessionStatus: (_tabId: string | null, requestedOrigin?: string) => readBrowserSessionStatus({
      tabId: 'tab-1',
      profile: 'work',
      currentUrl: 'https://example.test/account',
      requestedOrigin,
      getCookieCount: async () => cookies.length,
      readStorageCounts: async () => ({ localStorageKeys: 3, sessionStorageKeys: 1, hasIndexedDb: true }),
    }),
  } as unknown as BrowserController

  const status = dataOf(await executeBrowserTool('browser_session', { action: 'status' }, controller))
  assert.equal(status.ok, true)
  assert.equal(status.profile, 'work')
  assert.equal(status.profileScope, 'isolated_named_profile')
  assert.equal(status.cookieCount, 2)
  assert.equal(status.authenticatedLikely, true)
  assert.equal(status.rawSecretsExposed, false)
  assert.doesNotMatch(JSON.stringify(status), /super-secret-token|private-value/)
})

test('browser_session switches to an isolated named profile while preserving opener binding', async () => {
  let createArgs: Record<string, unknown> | null = null
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Account', url: 'https://example.test/account', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Account', url: 'https://example.test/account', active: true }],
    createTab: async (url: string, options: Record<string, unknown>) => {
      createArgs = { url, ...options }
      return { success: true, tabId: 'tab-work' }
    },
  } as unknown as BrowserController

  const switched = dataOf(await executeBrowserTool('browser_session', {
    action: 'switch_profile',
    profile: 'work',
  }, controller, undefined, undefined, undefined, '切换到 work 浏览器 profile', undefined, taskContext({
    instruction: '切换到 work 浏览器 profile',
    operations: ['session.switch_profile'],
  })))
  assert.equal(switched.ok, true)
  assert.equal(switched.profile, 'work')
  assert.deepEqual(createArgs, {
    url: 'https://example.test/account',
    profile: 'work',
    openerTabId: 'tab-1',
  })
})

test('browser_console normalizes and filters requested levels', async () => {
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }],
    collectConsoleMessages: async () => [
      { method: 'Runtime.consoleAPICalled', params: { type: 'log' } },
      { method: 'Log.entryAdded', params: { entry: { level: 'warning' } } },
      { method: 'Runtime.exceptionThrown', params: { exceptionDetails: {} } },
    ],
  } as unknown as BrowserController

  const result = dataOf(await executeBrowserTool('browser_console', {
    action: 'list',
    levels: ['warning', 'error'],
  }, controller))
  assert.equal(result.ok, true)
  assert.deepEqual((result.messages as Array<Record<string, unknown>>).map((item) => item.level), ['warning', 'error'])
})

test('browser_archive only writes through an authorized task root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-browser-archive-'))
  try {
    let archived: Record<string, unknown> | null = null
    const controller = {
      getActiveTab: () => ({ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }),
      getTabList: () => [{ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }],
      archivePage: async (tabId: string | null, path: string, format: string) => {
        archived = { tabId, path, format }
        return { success: true, path, format }
      },
    } as unknown as BrowserController
    const path = join(root, 'page.mhtml')
    const result = dataOf(await executeBrowserTool(
      'browser_archive',
      { format: 'mhtml', path, tab_id: 'tab-1' },
      controller,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { workspaceRoots: [root] },
    ))
    assert.equal(result.ok, true)
    assert.deepEqual(archived, { tabId: 'tab-1', path, format: 'mhtml' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser_permission changes ordinary origin permissions but requires takeover for media allow', async () => {
  const decisions: Array<Record<string, unknown>> = []
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Fixture', url: 'https://example.test/page', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Fixture', url: 'https://example.test/page', active: true }],
    getBrowserPermission: (origin: string, permission: string) => ({ origin, permission, decision: 'ask' }),
    setBrowserPermission: (origin: string, permission: string, decision: string) => {
      decisions.push({ origin, permission, decision })
      return { origin, permission, decision }
    },
  } as unknown as BrowserController

  const allowed = dataOf(await executeBrowserTool('browser_permission', {
    action: 'set',
    permission: 'geolocation',
    decision: 'allow',
  }, controller, undefined, undefined, undefined, '允许当前网站使用定位权限', undefined, taskContext({
    instruction: '允许当前网站使用定位权限',
    operations: ['permission.set'],
  })))
  assert.equal(allowed.ok, true)
  assert.deepEqual(decisions, [{ origin: 'https://example.test', permission: 'geolocation', decision: 'allow' }])

  const media = dataOf(await executeBrowserTool('browser_permission', {
    action: 'set',
    permission: 'media',
    decision: 'allow',
  }, controller, undefined, undefined, undefined, '允许当前网站使用摄像头和麦克风权限', undefined, taskContext({
    instruction: '允许当前网站使用摄像头和麦克风权限',
    operations: ['permission.set'],
  })))
  assert.equal(media.ok, false)
  assert.equal(media.errorKind, 'human_takeover_required')
  assert.equal(decisions.length, 1)
})

test('browser task envelope blocks a model-expanded permission mutation', async () => {
  let writes = 0
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'One', url: 'https://one.test/page', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'One', url: 'https://one.test/page', active: true }],
    setBrowserPermission: () => { writes += 1; return {} },
  } as unknown as BrowserController
  const denied = dataOf(await executeBrowserTool(
    'browser_permission',
    { action: 'set', permission: 'geolocation', decision: 'allow', tab_id: 'tab-1' },
    controller,
    undefined,
    undefined,
    undefined,
    '查看当前网站的定位权限',
    undefined,
    taskContext({ instruction: '查看当前网站的定位权限', tabId: 'tab-1', origin: 'https://one.test' }),
  ))
  assert.equal(denied.errorKind, 'browser_task_intent_mismatch')
  assert.equal(writes, 0)
})

test('browser_permission resolves the explicitly bound tab and rejects a different origin', async () => {
  const reads: string[] = []
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'One', url: 'https://one.test/page', active: true }),
    getTabList: () => [
      { id: 'tab-1', title: 'One', url: 'https://one.test/page', active: true },
      { id: 'tab-2', title: 'Two', url: 'https://two.test/settings', active: false },
    ],
    getBrowserPermission: (origin: string) => { reads.push(origin); return { origin, decision: 'ask' } },
    setBrowserPermission: () => ({ decision: 'allow' }),
  } as unknown as BrowserController
  const status = dataOf(await executeBrowserTool('browser_permission', {
    action: 'status', permission: 'geolocation', tab_id: 'tab-2',
  }, controller))
  assert.equal(status.ok, true)
  assert.equal(reads[0], 'https://two.test')

  const denied = dataOf(await executeBrowserTool(
    'browser_permission',
    { action: 'set', permission: 'geolocation', decision: 'allow', tab_id: 'tab-2', origin: 'https://one.test' },
    controller,
    undefined,
    undefined,
    undefined,
    '允许 two.test 使用定位权限',
    undefined,
    taskContext({
      instruction: '允许 two.test 使用定位权限',
      tabId: 'tab-2',
      origin: 'https://two.test',
      operations: ['permission.set'],
    }),
  ))
  assert.equal(denied.errorKind, 'browser_task_origin_mismatch')
})
