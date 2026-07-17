import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __browserPowerAuditEventsForTests,
  __clearBrowserPowerPolicyForTests,
  registerBrowserPowerGrant,
} from '../main/modules/browser-engine/browser-power-policy'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type { BrowserTaskEnvelope } from '../shared/browser-task-envelope'

function parseOutput(out: string | ToolExecutionOutput): Record<string, unknown> {
  if (typeof out !== 'string') return (out.data || JSON.parse(out.text)) as Record<string, unknown>
  return JSON.parse(out) as Record<string, unknown>
}

function controllerFixture(result: unknown = 'Example Title') {
  const calls: string[] = []
  const preflights: Array<Record<string, unknown>> = []
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Example', url: 'https://example.com/page', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Example', url: 'https://example.com/page', active: true }],
    executeJS: async () => ({
      url: 'https://example.com/page',
      title: 'Example',
      timeOrigin: 1234,
      mutationRevision: 0,
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
  instruction: string,
  requestPowerConfirmation?: (details: Record<string, unknown>) => Promise<boolean>,
) {
  const taskEnvelope: BrowserTaskEnvelope = {
    version: 1,
    scopeId: 'session-1',
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'ready',
    primaryInstruction: instruction,
    allowedToolNames: ['browser_eval', 'browser_cdp'],
    allowedEffects: ['observe', 'page_mutation'],
    allowedSensitiveOperations: [],
    tabId: 'tab-1',
    origin: 'https://example.com',
    destination: null,
    workspaceRoots: [],
    createdAt: Date.now(),
  }
  return {
    ownerRunId: 'run-1',
    parentTaskId: 'task-1',
    taskEnvelope,
    requestPowerConfirmation,
  }
}

test.beforeEach(() => __clearBrowserPowerPolicyForTests())

test('browser_eval executes nondestructive code and records its outcome', async () => {
  const fixture = controllerFixture()
  const output = parseOutput(await executeBrowserTool(
    'browser_eval',
    { code: 'document.title', purpose: 'read title' },
    fixture.controller,
    undefined,
    'session-1',
  ))

  assert.equal(output.ok, true)
  assert.equal(output.result, 'Example Title')
  assert.ok(fixture.calls.includes('Runtime.evaluate'))
  assert.equal(__browserPowerAuditEventsForTests().length, 1)
})

test('destructive browser_eval requires a matching bounded grant', async () => {
  const fixture = controllerFixture(42)
  const args = { code: 'fetch("/pay")', purpose: 'submit a payment' }
  const denied = parseOutput(await executeBrowserTool('browser_eval', args, fixture.controller, undefined, 'session-1'))
  assert.equal(denied.errorKind, 'grant_required')
  assert.equal(fixture.calls.length, 0)

  const grant = registerBrowserPowerGrant({
    id: 'grant-payment',
    source: 'test',
    scopeId: 'session-1',
    effects: ['observe', 'external_submit', 'payment'],
    hostname: 'example.com',
    expiresAt: Date.now() + 60_000,
    remainingCalls: 1,
  })
  const allowed = parseOutput(await executeBrowserTool(
    'browser_eval',
    { ...args, grant_id: grant.id },
    fixture.controller,
    undefined,
    'session-1',
  ))
  assert.equal(allowed.ok, true)
  assert.match(String(allowed.preflightAuditId || ''), /^browser-power-preflight-/)
  assert.equal(fixture.preflights.length, 1)
  assert.equal(fixture.preflights[0].grant_id, grant.id)
  assert.equal(fixture.preflights[0].confirmation_source, 'test')
  assert.match(String(fixture.preflights[0].input_hash || ''), /^[a-f0-9]{64}$/)
  assert.ok(fixture.calls.indexOf('persist-preflight') < fixture.calls.indexOf('Runtime.evaluate'))

  const exhausted = parseOutput(await executeBrowserTool(
    'browser_eval',
    { ...args, grant_id: grant.id },
    fixture.controller,
    undefined,
    'session-1',
  ))
  assert.equal(exhausted.errorKind, 'grant_mismatch')
})

test('destructive browser_eval fails closed before page execution when persistent preflight storage fails', async () => {
  const fixture = controllerFixture(42)
  ;(fixture.controller as unknown as { recordBrowserPowerPreflightAudit: () => void }).recordBrowserPowerPreflightAudit = () => {
    throw new Error('disk unavailable')
  }
  const grant = registerBrowserPowerGrant({
    id: 'grant-payment-audit-failure',
    source: 'confirmation_card',
    scopeId: 'session-1',
    effects: ['observe', 'external_submit', 'payment'],
    hostname: 'example.com',
    expiresAt: Date.now() + 60_000,
    remainingCalls: 1,
  })
  const output = parseOutput(await executeBrowserTool(
    'browser_eval',
    { code: 'fetch("/pay")', purpose: 'submit a payment', grant_id: grant.id },
    fixture.controller,
    undefined,
    'session-1',
  ))

  assert.equal(output.errorKind, 'power_preflight_audit_failed')
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

test('current user verbatim mints one production grant bound to the exact Power object', async () => {
  const fixture = controllerFixture('submitted')
  const output = parseOutput(await executeBrowserTool(
    'browser_eval',
    {
      code: "globalThis[['f','e','t','c','h'].join('')]('/checkout',{method:'POST'})",
      purpose: 'run the explicitly requested dynamic script',
      tab_id: 'tab-1',
    },
    fixture.controller,
    undefined,
    'session-1',
    undefined,
    '确认运行这个混淆脚本',
    undefined,
    powerTaskContext('确认运行这个混淆脚本'),
  ))
  assert.equal(output.ok, true)
  assert.equal(fixture.preflights.length, 1)
  assert.equal(fixture.preflights[0].confirmation_source, 'current_user_verbatim')
  assert.match(String(fixture.preflights[0].object_ref), /^[a-f0-9]{64}$/)
})

test('production confirmation callback mints a one-shot exact Power grant', async () => {
  const fixture = controllerFixture('confirmed')
  let confirmations = 0
  const output = parseOutput(await executeBrowserTool(
    'browser_cdp',
    {
      method: 'Experimental.doAnything',
      purpose: 'inspect an experimental target',
      tab_id: 'tab-1',
    },
    fixture.controller,
    undefined,
    'session-1',
    undefined,
    '检查实验目标',
    undefined,
    powerTaskContext('检查实验目标', async () => { confirmations += 1; return true }),
  ))
  assert.equal(confirmations, 1)
  assert.equal(output.ok, true)
  assert.equal(fixture.preflights[0].confirmation_source, 'confirmation_card')
})
