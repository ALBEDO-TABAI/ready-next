/**
 * P1-A1 (2026-07-03, 7/01 browser reliability contract A1) — Power tool
 * failures return structured JSON that preserves target identity (tabId /
 * currentUrl / origin / frameId) and a class-matched recovery hint, instead
 * of the generic "Error executing browser_power_*" string.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import {
  classifyBrowserPowerFailure,
  browserToolOriginFromUrl,
} from '../main/modules/tools/browser-power-failure'
import {
  __clearBrowserPowerPolicyForTests,
  inferBrowserPowerEffects,
  registerBrowserPowerGrant,
  setBrowserPowerGlobalModeReader,
} from '../main/modules/browser-engine/browser-power-policy'
import { browserSnapshotService } from '../main/modules/browser-engine/browser-snapshot-service'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { resolveBrowserCapability, type BrowserPublicToolName } from '../shared/browser-capability-registry'
import { browserInvocationArgsDigest } from '../main/modules/tools/browser-task-envelope-binding'

function parseOutput(out: string | ToolExecutionOutput): Record<string, unknown> {
  if (typeof out !== 'string') return (out.data || JSON.parse(out.text)) as Record<string, unknown>
  return JSON.parse(out) as Record<string, unknown>
}

function controller(overrides: Partial<BrowserController> = {}): BrowserController {
  const overrideExecuteJS = overrides.executeJS
  return {
    ...overrides,
    getActiveTab: () => ({ id: 'tab-1', title: 'XHS', url: 'https://creator.xiaohongshu.com/publish', active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'XHS', url: 'https://creator.xiaohongshu.com/publish', active: true }] as never,
    getPhysicalTargetToken: () => 'physical-tab-1',
    beginBrowserWorkflowAction: (input: Record<string, unknown>) => ({
      actionId: 'power-failure-action-1',
      actionSeq: 1,
      identity: input.identity,
    }),
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: unknown) => ({
      receiptId: 'power-failure-receipt-1',
      actionId,
      actionSeq: 1,
      outcome,
    }),
    recordBrowserPowerPreflightAudit: () => undefined,
    executeJS: async (tabId: string | null, script: string) => {
      if (script.includes('__readyBrowserTargetIdentityV3')) {
        return {
          url: 'https://creator.xiaohongshu.com/publish',
          title: 'XHS',
          timeOrigin: 1,
          mutationRevision: 0,
          frameDocumentToken: 'document-tab-1',
        }
      }
      return overrideExecuteJS ? overrideExecuteJS(tabId, script) : { title: 'XHS' }
    },
    navigate: async () => ({ success: true }) as never,
  } as BrowserController
}

test.beforeEach(() => {
  __clearBrowserPowerPolicyForTests()
  setBrowserPowerGlobalModeReader(() => true)
})

async function executeGrounded(
  toolName: string,
  rawArgs: Record<string, unknown>,
  browserController: BrowserController,
) {
  await browserSnapshotService.capture(
    browserController,
    'tab-1',
    10_000,
    async () => ({ pageMap: { targets: [] } }),
    { force: true },
  )
  let args = rawArgs
  const effects = inferBrowserPowerEffects({ toolName, args })
  if (effects.includes('access_control_circumvention')) {
    const identity = await browserSnapshotService.documentIdentity(browserController, 'tab-1')
    const documentKeyHash = createHash('sha256').update(JSON.stringify(identity.key)).digest('hex')
    const objectInput = toolName === 'browser_eval'
      ? {
          code: String(args.code || ''),
          frameId: String(args.frame_id || '').trim() || null,
          world: args.world === 'main' ? 'main' : 'isolated',
        }
      : {
          method: String(args.method || '').trim(),
          params: args.params && typeof args.params === 'object' ? args.params : {},
          frameId: String(args.frame_id || '').trim() || null,
        }
    const objectRef = createHash('sha256').update(JSON.stringify(objectInput)).digest('hex')
    const grant = registerBrowserPowerGrant({
      source: 'test',
      scopeId: 'session-1',
      runId: 'run-power-failure-test',
      taskId: 'browser-task-power-failure-test',
      tabId: 'tab-1',
      documentKeyHash,
      objectRef,
      hostname: 'creator.xiaohongshu.com',
      effects,
      expiresAt: Date.now() + 60_000,
      remainingCalls: 1,
    })
    args = { ...args, grant_id: grant.id }
  }
  const capability = resolveBrowserCapability(toolName, args)
  assert.ok(capability, `missing Browser capability for ${toolName}`)
  const taskEnvelope = {
    version: 3 as const,
    scopeId: 'session-1',
    runId: 'run-power-failure-test',
    parentTaskId: 'parent-power-failure-test',
    browserTaskId: 'browser-task-power-failure-test',
    agentId: 'ready',
    toolName: toolName as BrowserPublicToolName,
    operationId: capability.operationId,
    argsDigest: browserInvocationArgsDigest(toolName as BrowserPublicToolName, capability.operationId, args),
    tabId: 'tab-1',
    origin: 'https://creator.xiaohongshu.com',
    createdAt: Date.now(),
  }
  return executeBrowserTool(
    toolName,
    args,
    browserController,
    undefined,
    'session-1',
    undefined,
    undefined,
    undefined,
    {
      ownerRunId: 'run-power-failure-test',
      browserTaskId: 'browser-task-power-failure-test',
      parentTaskId: 'parent-power-failure-test',
      inputSource: 'trusted_internal',
      taskEnvelope,
    },
  )
}

test('classifyBrowserPowerFailure maps each failure family to a distinct recovery hint', () => {
  assert.equal(classifyBrowserPowerFailure('browser_eval timed out after 8000ms').failureClass, 'timeout')
  assert.equal(classifyBrowserPowerFailure('no active tab for network trace').failureClass, 'target_stale')
  assert.equal(classifyBrowserPowerFailure('Target closed').failureClass, 'target_stale')
  assert.equal(classifyBrowserPowerFailure('browser_power_frame_context_unavailable').failureClass, 'frame_context')
  assert.equal(classifyBrowserPowerFailure('ReferenceError: foo is not defined').failureClass, 'eval_runtime')
  assert.equal(classifyBrowserPowerFailure('something totally unexpected').failureClass, 'unknown')
  // hints are distinct per class
  const hints = new Set([
    classifyBrowserPowerFailure('timed out').nextSuggestedAction,
    classifyBrowserPowerFailure('Target closed').nextSuggestedAction,
    classifyBrowserPowerFailure('isolated world').nextSuggestedAction,
    classifyBrowserPowerFailure('SyntaxError').nextSuggestedAction,
  ])
  assert.equal(hints.size, 4)
})

test('browserToolOriginFromUrl extracts origin and tolerates junk', () => {
  assert.equal(browserToolOriginFromUrl('https://creator.xiaohongshu.com/publish?x=1'), 'https://creator.xiaohongshu.com')
  assert.equal(browserToolOriginFromUrl(''), null)
  assert.equal(browserToolOriginFromUrl('not a url'), null)
})

test('browser_eval failure preserves target identity and a runtime recovery hint', async () => {
  const out = await executeGrounded(
    'browser_eval',
    { code: 'boom()', purpose: 'probe editor', world: 'main', tab_id: 'tab-1' },
    controller({ executeJS: async () => { throw new Error('ReferenceError: boom is not defined') } }),
  )
  const parsed = parseOutput(out)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'browser_eval_failed')
  assert.equal(parsed.failureClass, 'eval_runtime')
  assert.equal(parsed.tabId, 'tab-1')
  assert.equal(parsed.currentUrl, 'https://creator.xiaohongshu.com/publish')
  assert.equal(parsed.origin, 'https://creator.xiaohongshu.com')
  assert.match(String(parsed.nextSuggestedAction), /async IIFE|Runtime\.evaluate/)
})

test('browser_cdp failure is structured (no generic thrown string) with frame hint', async () => {
  const out = await executeGrounded(
    'browser_cdp',
    { method: 'Runtime.evaluate', purpose: 'probe', params: {}, tab_id: 'tab-1' },
    controller({
      sendCdpCommand: async () => { throw new Error('Cannot find context with specified id') },
    } as Partial<BrowserController>),
  )
  const parsed = parseOutput(out)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'browser_cdp_failed')
  assert.equal(parsed.tabId, 'tab-1')
  assert.equal(parsed.origin, 'https://creator.xiaohongshu.com')
  assert.equal(parsed.method, 'Runtime.evaluate')
  assert.ok(typeof parsed.nextSuggestedAction === 'string' && (parsed.nextSuggestedAction as string).length > 0)
})

test('browser_resources failure is structured, not a thrown string', async () => {
  const out = await executeGrounded(
    'browser_resources',
    { include_response_bodies: true, purpose: 'sniff', kinds: ['video'], tab_id: 'tab-1' },
    controller({
      startNetworkObserver: async () => { throw new Error('observer attach timed out') },
      executeJS: async () => { throw new Error('observer attach timed out') },
    } as Partial<BrowserController>),
  )
  const parsed = parseOutput(out)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'browser_resources_failed')
  assert.equal(parsed.tabId, 'tab-1')
  assert.ok(typeof parsed.nextSuggestedAction === 'string')
})
