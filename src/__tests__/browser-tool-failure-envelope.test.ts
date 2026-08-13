import assert from 'node:assert/strict'
import test from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { createBrowserStructuredOutput } from '../main/modules/tools/browser-failure-output'
import { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import type { BrowserTargetClaimService } from '../main/modules/browser-engine/browser-target-claims'
import { browserSnapshotService } from '../main/modules/browser-engine/browser-snapshot-service'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { attachBrowserWorkflowFixture } from './utils/browser-workflow-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { acquireTarget, createTargetClaimService } from './utils/browser-target-claim-fixture'

test('browser-tool-failure-envelope declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-tool-failure-envelope transitive sqlite load')
})

function makeController(overrides: Partial<BrowserController> = {}): BrowserController {
  return {
    getActiveTab: () => ({ id: 'tab-1', title: 'Example', url: 'https://example.com/', active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'Example', url: 'https://example.com/', active: true }] as never,
    executeJS: async () => null,
    getPageContent: async () => '',
    getTask: async () => null,
    getTaskPayload: () => null,
    startTask: async () => ({ taskId: 'task-1', status: 'queued' }) as never,
    startNoteCollection: async () => ({ ok: true, taskId: 'note-1' }) as never,
    recordBrowserPowerPreflightAudit: () => undefined,
    consumeBrowserSiteNotices: () => [],
    ...overrides,
  } as BrowserController
}

function writeContext(controller: BrowserController): ToolContext {
  const service = createTargetClaimService()
  return writeContextWithLease(controller, service)
}

function writeContextWithLease(controller: BrowserController, service: BrowserTargetClaimService): ToolContext {
  const fixture = attachBrowserWorkflowFixture(controller)
  return {
    invoker: 'host',
    browserController: fixture.controller,
    browserLease: new BrowserTurnLease({ taskId: 'parent-task-test', runId: 'run-test' }, service),
    allowedToolNames: null,
    sessionId: 'browser-failure-envelope-test',
    scopeId: 'browser-failure-envelope-test',
    runId: 'run-test',
    taskId: 'parent-task-test',
    browserWorkflowRoute: {
      browserTaskId: fixture.context.browserTaskId,
      requestAnchorSnapshotDigest: 'request-anchor-browser-failure-envelope-test',
    },
  } as ToolContext
}

function noLeaseContext(controller: BrowserController): ToolContext {
  const fixture = attachBrowserWorkflowFixture(controller)
  return {
    invoker: 'host',
    browserController: fixture.controller,
    allowedToolNames: null,
    sessionId: 'browser-failure-envelope-test',
    scopeId: 'browser-failure-envelope-test',
    runId: 'run-test',
    taskId: 'parent-task-test',
    browserWorkflowRoute: {
      browserTaskId: fixture.context.browserTaskId,
      requestAnchorSnapshotDigest: 'request-anchor-browser-failure-envelope-test',
    },
  } as ToolContext
}

async function primeSnapshot(context: ToolContext): Promise<void> {
  await browserSnapshotService.capture(
    context.browserController!,
    'tab-1',
    10_000,
    async () => ({ pageMap: { targets: [] } }),
    { force: true },
  )
}

test('retired browser power confirmation remains fail-closed before execution', async () => {
  const context = writeContext(makeController({
    sendCdpCommand: async (_tabId, method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      throw new Error('debugger unavailable')
    },
  }))
  await primeSnapshot(context)
  const pending = await executeToolCall(
    'browser_eval',
    { code: 'document.title', purpose: 'read title' },
    context,
  )
  assert.equal(pending.data?.errorKind, 'grant_required')
  assert.equal(pending.data?.browserSuspensionRequest, undefined)
  assert.equal(pending.envelope?.ok, false)
  assert.equal(pending.envelope?.kind, 'denied_by_policy')
})

test('browser structured output keeps errorKind as a bounded token', () => {
  const output = createBrowserStructuredOutput({
    ok: false,
    reason: '附件文件不存在: /Users/example/private.png',
  })

  assert.equal(output.data?.errorKind, 'browser_tool_failed')
  assert.equal(output.data?.reason, '附件文件不存在: /Users/example/private.png')
})

test('browser write without surface binding returns structured browser failure data', async () => {
  const output = await executeToolCall(
    'browser_click',
    { selector: '#submit' },
    noLeaseContext(makeController()),
  )

  assert.equal(output.data?.ok, false)
  assert.equal(output.data?.errorKind, 'browser_surface_undeclared')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'internal_error')
})

test('browser write with a target held by another run returns structured browser failure data', async () => {
  const service = createTargetClaimService()
  acquireTarget(service, {
    partition: 'persist:browser',
    tabId: 'tab-1',
    physicalTargetToken: 'physical-tab-1',
    bootIncarnationId: 'physical-tab-1',
    parentTaskId: 'other-task',
    browserTaskId: 'other-browser-task',
    ownerRunId: 'other-run',
  })
  const output = await executeToolCall(
    'browser_click',
    { selector: '#submit' },
    writeContextWithLease(makeController(), service),
  )

  assert.equal(output.data?.ok, false)
  assert.equal(output.data?.errorKind, 'lease_held')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'internal_error')
})

test('navigation Error string returns are structured at dispatcher exit', async () => {
  const context = writeContext(makeController({
    goBack: () => ({ success: false, error: 'cannot go back' }),
  }))
  await primeSnapshot(context)
  const output = await executeToolCall(
    'browser_navigate',
    { action: 'back' },
    context,
  )

  assert.equal(output.data?.ok, false)
  assert.equal(output.data?.errorKind, 'browser_operation_failed')
  assert.equal(output.data?.message, 'cannot go back')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'internal_error')
})

test('wrong browser task id results are structured failures', async () => {
  const output = await executeToolCall(
    'browser_task',
    { action: 'get', task_id: 'task-not-a-browser-task' },
    writeContext(makeController({
      getTask: async () => null,
    })),
  )

  assert.equal(output.data?.ok, false)
  assert.equal(output.data?.errorKind, 'wrong_browser_task_id_type')
  assert.equal(output.data?.status, 'wrong_id_type')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'internal_error')
})

test('browser_click target failure returns an error envelope, not ok text', async () => {
  const context = writeContext(makeController({
    executeJS: async (_tabId, code) => {
      if (code.includes('__READY_DESTRUCTIVE_TARGET_CHECK__')) return 'Element not found: #missing'
      if (code.includes('document.readyState')) return { readyState: 'complete', bodyTextLen: 20, matched: false }
      return null
    },
  }))
  await primeSnapshot(context)
  const output = await executeToolCall(
    'browser_click',
    { selector: '#missing' },
    context,
  )

  assert.equal(output.data?.ok, false)
  assert.equal(output.data?.errorKind, 'target_not_found')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'arg_error')
})
