import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { readBrowserSessionStatus } from '../main/modules/browser-engine/browser-session-status'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { browserInvocationArgsDigest } from '../main/modules/tools/browser-task-envelope-binding'
import { browserSnapshotService } from '../main/modules/browser-engine/browser-snapshot-service'
import type { BrowserOperationId, BrowserPublicToolName } from '../shared/browser-capability-registry'
import type { BrowserTaskEnvelope } from '../shared/browser-task-envelope'
import type { BrowserPermissionSuspensionRequest } from '../shared/browser-workflow-control'

function dataOf(result: Awaited<ReturnType<typeof executeBrowserTool>>): Record<string, unknown> {
  if (typeof result === 'string') return JSON.parse(result) as Record<string, unknown>
  return result.data || JSON.parse(result.text) as Record<string, unknown>
}

function taskContext(params: {
  toolName: BrowserPublicToolName
  operationId: BrowserOperationId
  args: Record<string, unknown>
  tabId?: string
  origin?: string
  requestPowerConfirmation?: (details: Record<string, unknown>) => Promise<boolean>
  confirmedBrowserPermissionRequest?: BrowserPermissionSuspensionRequest | null
}) {
  const taskEnvelope: BrowserTaskEnvelope = {
    version: 3,
    scopeId: 'scope-1',
    runId: 'run-1',
    parentTaskId: 'parent-task-1',
    browserTaskId: 'browser-child-1',
    agentId: 'ready',
    toolName: params.toolName,
    operationId: params.operationId,
    argsDigest: browserInvocationArgsDigest(params.toolName, params.operationId, params.args),
    tabId: params.tabId || 'tab-1',
    origin: params.origin || 'https://example.test',
    createdAt: Date.now(),
  }
  return {
    ownerRunId: 'run-1',
    parentTaskId: 'parent-task-1',
    browserTaskId: 'browser-child-1',
    taskEnvelope,
    requestPowerConfirmation: params.requestPowerConfirmation,
    confirmedBrowserPermissionRequest: params.confirmedBrowserPermissionRequest,
  }
}

function pendingPermissionReadback(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'site-request-1',
    state: 'pending',
    applied: false,
    decision: null,
    permission: 'geolocation',
    origin: 'https://example.test',
    requestingUrl: 'https://example.test/page',
    createdAt: '2026-07-19T00:00:00.000Z',
    appliedAt: null,
    target: {
      partition: 'persist:browser',
      parentTaskId: 'parent-task-1',
      ownerRunId: 'previous-owner-run',
      browserTaskId: 'browser-child-1',
      surface: 'user-view',
      scopeId: 'scope-1',
      profileId: null,
      sessionId: null,
      tabId: 'tab-1',
      physicalTargetToken: 'physical-tab-1',
    },
    ...overrides,
  }
}

function workflowJournalFixture() {
  let actionSeq = 0
  return {
    beginBrowserWorkflowAction: (input: Record<string, unknown>) => ({
      actionId: `action-${++actionSeq}`,
      actionSeq,
      identity: input.identity,
    }),
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: unknown) => ({
      receiptId: `receipt-${actionId}`,
      outcome,
    }),
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
    ...workflowJournalFixture(),
    getActiveTab: () => ({ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }],
    getPhysicalTargetToken: () => 'physical-tab-1',
    executeJS: async () => ({
      url: 'https://example.test',
      title: 'Fixture',
      timeOrigin: 1234,
      mutationRevision: 0,
      frameDocumentToken: 'document-1',
    }),
    startNetworkObserver: async () => ({
      id: 'trace-1',
      events: () => events,
      stop: async () => { stopped += 1 },
    }),
  } as unknown as BrowserController

  await browserSnapshotService.capture(controller, 'tab-1', 10_000, async () => ({ targets: [] }), { force: true })
  const startArgs = { action: 'start' }
  const started = dataOf(await executeBrowserTool(
    'browser_network',
    startArgs,
    controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    taskContext({ toolName: 'browser_network', operationId: 'network_start', args: startArgs }),
  ))
  assert.equal(started.ok, true)
  assert.equal(started.traceId, 'trace-1')

  const listed = dataOf(await executeBrowserTool('browser_network', { action: 'list' }, controller))
  const listedEvents = listed.events as Array<Record<string, unknown>>
  assert.equal(listed.eventCount, 1)
  assert.equal((listedEvents[0].responseHeaders as Record<string, unknown>).Authorization, '[redacted]')
  assert.equal((listedEvents[0].responseHeaders as Record<string, unknown>)['Content-Type'], 'application/json')

  const details = dataOf(await executeBrowserTool('browser_network', { action: 'details', request_id: 'req-1' }, controller))
  assert.equal((details.event as Record<string, unknown>).requestId, 'req-1')

  const stopArgs = { action: 'stop' }
  const stoppedResult = dataOf(await executeBrowserTool(
    'browser_network',
    stopArgs,
    controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    taskContext({ toolName: 'browser_network', operationId: 'network_stop', args: stopArgs }),
  ))
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
    ...workflowJournalFixture(),
    getActiveTab: () => ({ id: 'tab-1', title: 'Account', url: 'https://example.test/account', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Account', url: 'https://example.test/account', active: true }],
    createTab: async (url: string, options: Record<string, unknown>) => {
      createArgs = { url, ...options }
      return { success: true, tabId: 'tab-work' }
    },
  } as unknown as BrowserController

  const args = {
    action: 'switch_profile',
    profile: 'work',
  }
  const switched = dataOf(await executeBrowserTool('browser_session', args, controller, undefined, undefined, undefined, undefined, undefined, taskContext({
    toolName: 'browser_session',
    operationId: 'session_switch_profile',
    args,
    requestPowerConfirmation: async () => true,
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
      ...workflowJournalFixture(),
      getActiveTab: () => ({ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }),
      getTabList: () => [{ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }],
      getPhysicalTargetToken: () => 'physical-tab-1',
      executeJS: async () => ({
        url: 'https://example.test',
        title: 'Fixture',
        timeOrigin: 1234,
        mutationRevision: 0,
        frameDocumentToken: 'document-1',
      }),
      archivePage: async (tabId: string | null, path: string, format: string) => {
        archived = { tabId, path, format }
        return { success: true, path, format }
      },
    } as unknown as BrowserController
    const path = join(root, 'page.mhtml')
    const args = { format: 'mhtml', path, tab_id: 'tab-1' }
    await browserSnapshotService.capture(controller, 'tab-1', 10_000, async () => ({ targets: [] }), { force: true })
    const result = dataOf(await executeBrowserTool(
      'browser_archive',
      args,
      controller,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ...taskContext({ toolName: 'browser_archive', operationId: 'archive', args }),
        workspaceRoots: [root],
      },
    ))
    assert.equal(result.ok, true)
    assert.deepEqual(archived, { tabId: 'tab-1', path, format: 'mhtml' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser_permission allow suspends for the exact request and applies only with its exact confirmation', async () => {
  let writes = 0
  const pending = pendingPermissionReadback()
  const controller = {
    ...workflowJournalFixture(),
    getActiveTab: () => ({ id: 'tab-1', title: 'Fixture', url: 'https://example.test/page', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Fixture', url: 'https://example.test/page', active: true }],
    getPhysicalTargetToken: () => 'physical-tab-1',
    getBrowserPermission: (requestId: string) => requestId === 'site-request-1'
      ? pending
      : pendingPermissionReadback({ requestId, state: 'expired', target: null }),
    setBrowserPermission: (requestId: string, decision: string) => {
      writes += 1
      return {
        ...pending,
        requestId,
        state: 'applied',
        applied: true,
        decision,
        appliedAt: '2026-07-19T00:01:00.000Z',
      }
    },
  } as unknown as BrowserController

  const allowedArgs = {
    action: 'set',
    site_request_id: 'site-request-1',
    permission: 'geolocation',
    decision: 'allow',
  }
  const awaiting = dataOf(await executeBrowserTool('browser_permission', allowedArgs, controller, undefined, undefined, undefined, undefined, undefined, taskContext({
    toolName: 'browser_permission',
    operationId: 'permission_set',
    args: allowedArgs,
  })))
  assert.equal(awaiting.ok, false)
  assert.equal(awaiting.errorKind, 'browser_permission_confirmation_required')
  assert.equal(writes, 0)
  const confirmation = awaiting.browserSuspensionRequest as BrowserPermissionSuspensionRequest
  assert.equal(confirmation.actionIntent.siteRequestId, 'site-request-1')
  assert.equal(confirmation.target.ownerRunId, 'previous-owner-run')

  const applied = dataOf(await executeBrowserTool('browser_permission', allowedArgs, controller, undefined, undefined, undefined, undefined, undefined, taskContext({
    toolName: 'browser_permission',
    operationId: 'permission_set',
    args: allowedArgs,
    confirmedBrowserPermissionRequest: confirmation,
  })))
  assert.equal(applied.ok, true)
  assert.equal(applied.state, 'applied')
  assert.equal(applied.requestId, 'site-request-1')
  assert.equal(writes, 1)
})

test('browser task envelope blocks a model-expanded permission mutation', async () => {
  let writes = 0
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'One', url: 'https://one.test/page', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'One', url: 'https://one.test/page', active: true }],
    setBrowserPermission: () => { writes += 1; return {} },
  } as unknown as BrowserController
  const actualArgs = { action: 'set', site_request_id: 'site-request-1', decision: 'allow', tab_id: 'tab-1' }
  const admittedArgs = { action: 'status', site_request_id: 'site-request-1', tab_id: 'tab-1' }
  const denied = dataOf(await executeBrowserTool(
    'browser_permission',
    actualArgs,
    controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    taskContext({
      toolName: 'browser_permission',
      operationId: 'permission_status',
      args: admittedArgs,
      tabId: 'tab-1',
      origin: 'https://one.test',
      requestPowerConfirmation: async () => true,
    }),
  ))
  assert.equal(denied.errorKind, 'browser_task_invocation_mismatch')
  assert.equal(writes, 0)
})

test('browser_permission status requires an exact live request bound to the same task and tab', async () => {
  const reads: string[] = []
  const pending = pendingPermissionReadback({
    target: {
      ...(pendingPermissionReadback().target as Record<string, unknown>),
      tabId: 'tab-2',
      physicalTargetToken: 'physical-tab-2',
    },
  })
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'One', url: 'https://one.test/page', active: true }),
    getTabList: () => [
      { id: 'tab-1', title: 'One', url: 'https://one.test/page', active: true },
      { id: 'tab-2', title: 'Two', url: 'https://two.test/settings', active: false },
    ],
    getPhysicalTargetToken: (tabId: string) => tabId === 'tab-2' ? 'physical-tab-2' : 'physical-tab-1',
    getBrowserPermission: (requestId: string) => { reads.push(requestId); return pending },
  } as unknown as BrowserController
  const statusArgs = { action: 'status', site_request_id: 'site-request-1', tab_id: 'tab-2' }
  const status = dataOf(await executeBrowserTool(
    'browser_permission',
    statusArgs,
    controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    taskContext({
      toolName: 'browser_permission',
      operationId: 'permission_status',
      args: statusArgs,
      tabId: 'tab-2',
      origin: 'https://two.test',
    }),
  ))
  assert.equal(status.ok, true)
  assert.equal(status.requestId, 'site-request-1')
  assert.equal(reads[0], 'site-request-1')

  const deniedArgs = { action: 'status', site_request_id: 'site-request-1', tab_id: 'tab-1' }
  const denied = dataOf(await executeBrowserTool(
    'browser_permission',
    deniedArgs,
    controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    taskContext({
      toolName: 'browser_permission',
      operationId: 'permission_status',
      args: deniedArgs,
      tabId: 'tab-1',
      origin: 'https://one.test',
    }),
  ))
  assert.equal(denied.errorKind, 'browser_permission_request_target_mismatch')
})

test('browser_permission reports a missing live callback as expired and never writes it', async () => {
  let writes = 0
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Fixture', url: 'https://example.test/page', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Fixture', url: 'https://example.test/page', active: true }],
    getPhysicalTargetToken: () => 'physical-tab-1',
    getBrowserPermission: (requestId: string) => pendingPermissionReadback({
      requestId,
      state: 'expired',
      target: null,
    }),
    setBrowserPermission: () => { writes += 1; return pendingPermissionReadback() },
  } as unknown as BrowserController
  const args = { action: 'set', site_request_id: 'old-request', decision: 'deny', tab_id: 'tab-1' }
  const expired = dataOf(await executeBrowserTool(
    'browser_permission',
    args,
    controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    taskContext({ toolName: 'browser_permission', operationId: 'permission_set', args }),
  ))
  assert.equal(expired.ok, false)
  assert.equal(expired.errorKind, 'browser_permission_request_expired')
  assert.equal(expired.applied, false)
  assert.equal(writes, 0)
})
