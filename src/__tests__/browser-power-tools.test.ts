import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __browserPowerAuditEventsForTests,
  __clearBrowserPowerPolicyForTests,
  setBrowserPowerGlobalModeReader,
} from '../main/modules/browser-engine/browser-power-policy'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { browserInvocationArgsDigest } from '../main/modules/tools/browser-task-envelope-binding'
import { browserSnapshotService } from '../main/modules/browser-engine/browser-snapshot-service'
import type { BrowserOperationId, BrowserPublicToolName } from '../shared/browser-capability-registry'
import type { BrowserTaskEnvelope } from '../shared/browser-task-envelope'

function parseOutput(out: string | ToolExecutionOutput): Record<string, unknown> {
  if (typeof out !== 'string') return (out.data || JSON.parse(out.text)) as Record<string, unknown>
  return JSON.parse(out) as Record<string, unknown>
}

function controllerFixture(result: unknown = 'Example Title') {
  const calls: string[] = []
  const preflights: Array<Record<string, unknown>> = []
  let actionSeq = 0
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Example', url: 'https://example.com/page', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Example', url: 'https://example.com/page', active: true }],
    executeJS: async () => ({
      url: 'https://example.com/page',
      title: 'Example',
      timeOrigin: 1234,
      mutationRevision: 0,
      frameDocumentToken: 'document-1',
    }),
    getPhysicalTargetToken: () => 'physical-tab-1',
    beginBrowserWorkflowAction: (input: Record<string, unknown>) => ({
      actionId: `action-${++actionSeq}`,
      actionSeq,
      identity: input.identity,
      ...(input.searchActionId ? { searchActionId: input.searchActionId } : {}),
    }),
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: unknown) => ({
      receiptId: `receipt-${actionId}`,
      outcome,
    }),
    recordBrowserPowerPreflightAudit: (record: Record<string, unknown>) => {
      calls.push('persist-preflight')
      preflights.push(record)
    },
    sendCdpCommand: async (_tabId: string | null, method: string) => {
      calls.push(method)
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (method === 'Runtime.evaluate') return { result: { value: result } }
      return {}
    },
  } as unknown as BrowserController
  return { controller, calls, preflights }
}

function powerTaskContext(
  toolName: BrowserPublicToolName,
  operationId: BrowserOperationId,
  args: Record<string, unknown>,
) {
  const taskEnvelope: BrowserTaskEnvelope = {
    version: 3,
    scopeId: 'session-1',
    runId: 'run-1',
    parentTaskId: 'parent-task-1',
    browserTaskId: 'browser-child-1',
    agentId: 'ready',
    toolName,
    operationId,
    argsDigest: browserInvocationArgsDigest(toolName, operationId, args),
    tabId: 'tab-1',
    origin: 'https://example.com',
    createdAt: Date.now(),
  }
  return {
    ownerRunId: 'run-1',
    parentTaskId: 'parent-task-1',
    browserTaskId: 'browser-child-1',
    taskEnvelope,
  }
}

test.beforeEach(() => {
  __clearBrowserPowerPolicyForTests()
  setBrowserPowerGlobalModeReader(() => true)
})

async function executePower(
  toolName: BrowserPublicToolName,
  operationId: BrowserOperationId,
  args: Record<string, unknown>,
  fixture: ReturnType<typeof controllerFixture>,
): Promise<Record<string, unknown>> {
  await browserSnapshotService.capture(
    fixture.controller,
    'tab-1',
    10_000,
    async () => ({ targets: [] }),
    { force: true },
  )
  return parseOutput(await executeBrowserTool(
    toolName,
    args,
    fixture.controller,
    undefined,
    'session-1',
    undefined,
    undefined,
    undefined,
    {
      ...powerTaskContext(toolName, operationId, args),
    },
  ))
}

test('browser_eval fails closed without creating a retired confirmation checkpoint', async () => {
  const fixture = controllerFixture()
  const args = { code: 'document.title', purpose: 'read title' }
  const denied = await executePower('browser_eval', 'eval', args, fixture)
  assert.equal(denied.errorKind, 'grant_required')
  assert.equal(denied.browserSuspensionRequest, undefined)
  assert.equal(denied.suspendAfterToolResult, undefined)
  assert.equal(denied.outcome, undefined)
  assert.equal(denied.actionId, undefined)
  assert.equal(fixture.calls.includes('Runtime.evaluate'), false)
  assert.equal(__browserPowerAuditEventsForTests().length, 0)
})

test('repeating browser_eval cannot mint a grant or persistent preflight receipt', async () => {
  const fixture = controllerFixture(42)
  const args = { code: 'fetch("/pay")', purpose: 'submit a payment' }
  const first = await executePower('browser_eval', 'eval', args, fixture)
  const second = await executePower('browser_eval', 'eval', args, fixture)
  assert.equal(first.errorKind, 'grant_required')
  assert.equal(second.errorKind, 'grant_required')
  assert.equal(first.browserSuspensionRequest, undefined)
  assert.equal(second.browserSuspensionRequest, undefined)
  assert.equal(fixture.preflights.length, 0)
  assert.equal(fixture.calls.includes('Runtime.evaluate'), false)
})

test('browser_eval does not touch retired preflight storage while failing closed', async () => {
  const fixture = controllerFixture(42)
  ;(fixture.controller as unknown as { recordBrowserPowerPreflightAudit: () => void }).recordBrowserPowerPreflightAudit = () => {
    throw new Error('disk unavailable')
  }
  const args = { code: 'fetch("/pay")', purpose: 'submit a payment' }
  const output = await executePower('browser_eval', 'eval', args, fixture)

  assert.equal(output.errorKind, 'grant_required')
  assert.equal(output.browserSuspensionRequest, undefined)
  assert.equal(output.outcome, undefined)
  assert.equal(fixture.calls.includes('Runtime.evaluate'), false)
})

test('removed generic script aliases cannot bypass the semantic Power surface', async () => {
  const fixture = controllerFixture()
  for (const name of ['browser_execute_js', 'browser_power_eval', 'browser_power_cdp']) {
    const output = parseOutput(await executeBrowserTool(name, {}, fixture.controller))
    assert.equal(output.errorKind, 'tool_not_registered', name)
  }
  assert.equal(fixture.calls.length, 0)
})

test('natural-language confirmation text cannot mint a Power grant', async () => {
  const fixture = controllerFixture('submitted')
  const args = {
    code: "globalThis[['f','e','t','c','h'].join('')]('/checkout',{method:'POST'})",
    purpose: 'run the explicitly requested dynamic script',
    tab_id: 'tab-1',
  }
  const output = await executePower('browser_eval', 'eval', args, fixture)
  assert.equal(output.errorKind, 'grant_required')
  assert.equal(fixture.preflights.length, 0)
  assert.equal(fixture.calls.includes('Runtime.evaluate'), false)
})

test('browser_cdp fails closed without issuing a confirmation receipt', async () => {
  const fixture = controllerFixture('confirmed')
  const args = {
    method: 'Experimental.doAnything',
    purpose: 'inspect an experimental target',
    tab_id: 'tab-1',
  }
  const output = await executePower('browser_cdp', 'cdp', args, fixture)
  assert.equal(output.errorKind, 'grant_required')
  assert.equal(output.browserSuspensionRequest, undefined)
  assert.equal(output.suspendAfterToolResult, undefined)
  assert.equal(fixture.preflights.length, 0)
})

test('browser_eval denial exposes no owner-bound receipt that a later run could replay', async () => {
  const fixture = controllerFixture('submitted')
  const args = {
    code: 'fetch("/pay", { method: "POST" })',
    purpose: 'submit a payment',
    tab_id: 'tab-1',
  }
  const first = await executePower('browser_eval', 'eval', args, fixture)
  assert.equal(first.errorKind, 'grant_required', JSON.stringify(first))
  assert.equal(first.browserSuspensionRequest, undefined)
  assert.equal(fixture.preflights.length, 0)
  assert.equal(fixture.calls.includes('Runtime.evaluate'), false)
})
