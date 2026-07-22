import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { mapBrowserAgentPointerToOverlay } from '../shared/browser-agent-pointer'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { executeBrowserActTool, runBrowserFillFormSequence } from '../main/modules/tools/browser-act-tools'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import {
  browserOriginInteractionBudget,
  scopedOriginInteractionKey,
} from '../main/modules/browser-engine/origin-interaction-budget'
import {
  captureAgentPageMap,
  executeBrowserObserveTool,
  __resetBrowserAgentPageMapForTests,
} from '../main/modules/tools/browser-observe-tools'

function observeContext(controller: BrowserController) {
  return { controller }
}

test('browser_fill_form stops at the first failed field and never submits partial data', async () => {
  const calls: string[] = []
  const outcome = await runBrowserFillFormSequence(
    [
      { selector: '#name', value: 'Ada' },
      { selector: '#email', value: 'bad' },
      { selector: '#city', value: 'London' },
    ],
    { submit: true },
    async (operation) => {
      calls.push(operation)
      return calls.length === 2
        ? createToolExecutionOutput('{"ok":false,"errorKind":"target_not_found"}', {
          data: { ok: false, errorKind: 'target_not_found' },
        })
        : createToolExecutionOutput('{"ok":true}', { data: { ok: true } })
    },
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failedIndex, 1)
  assert.equal(outcome.submitted, false)
  assert.deepEqual(calls, ['type_selector', 'type_selector'])
})

test('browser_fill_form reports a failed submit instead of claiming submitted', async () => {
  const calls: string[] = []
  const outcome = await runBrowserFillFormSequence(
    [{ selector: '#name', value: 'Ada' }],
    { submit: true },
    async (operation) => {
      calls.push(operation)
      return operation === 'press_key' ? 'Error: key dispatch failed' : '{"ok":true}'
    },
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorKind, 'form_submit_failed')
  assert.equal(outcome.submitted, false)
  assert.deepEqual(calls, ['type_selector', 'press_key'])
})

test('browser takeover persists the exact user instruction through the typed intent port', async () => {
  let capturedPrompt: Record<string, unknown> | null = null
  const result = await executeBrowserActTool(
    'request_takeover',
    {
      reason: '请完成页面验证',
      instruction: '验证完成后继续当前任务',
      timeout_sec: 90,
    },
    {
      controller: {
        getActiveTab: () => ({ id: 'tab-challenge' }),
        executeJS: async () => ({ blocked: true, blockerCount: 1, matchedKinds: ['captcha'] }),
      } as unknown as BrowserController,
      mutationBoundary: {} as never,
      createHumanTakeoverIntent: async (prompt) => {
        capturedPrompt = prompt
        return { takeoverId: 'takeover-1' }
      },
      attachBrowserToolOutput: (output) => output,
    },
  )

  assert.deepEqual(capturedPrompt, {
    callToAction: '请完成页面验证',
    details: '验证完成后继续当前任务',
    timeoutSec: 90,
    tabId: 'tab-challenge',
  })
  assert.equal((result as ToolExecutionOutput).data?.phase, 'human_required')
})

test('browser_read enforces max_chars and returns structured selector ambiguity', async () => {
  let selectorMatches = 1
  const controller = {
    getActiveTab: () => ({ id: 'tab-a', url: 'https://example.test/' }),
    getTabList: () => [{ id: 'tab-a', url: 'https://example.test/', active: true }],
    getPageContent: async () => 'abcdefghijk',
    executeJS: async () => ({ matchCount: selectorMatches, content: 'selected region' }),
  } as unknown as BrowserController

  const bounded = await executeBrowserObserveTool('read', { tab_id: 'tab-a', max_chars: 5 }, observeContext(controller))
  assert.equal((bounded as ToolExecutionOutput).data?.content, 'abcde')

  selectorMatches = 2
  const ambiguous = await executeBrowserObserveTool('read', { tab_id: 'tab-a', selector: '.card' }, observeContext(controller))
  assert.equal(typeof ambiguous, 'object')
  assert.equal((ambiguous as ToolExecutionOutput).data?.ok, false)
  assert.equal((ambiguous as ToolExecutionOutput).data?.errorKind, 'target_ambiguous')
  assert.equal((ambiguous as ToolExecutionOutput).data?.matchCount, 2)
})

test('browser_read exposes challenge content for observation but never accepts it as research evidence', async () => {
  let contentRead = false
  const controller = {
    getActiveTab: () => ({ id: 'tab-a', url: 'https://example.test/' }),
    getTabList: () => [{ id: 'tab-a', url: 'https://example.test/', active: true }],
    getPageContent: async () => {
      contentRead = true
      return 'stale result that must not become evidence'
    },
    executeJS: async (_tabId: string | null, script: string) => script.includes('__READY_BLOCKING_CHALLENGE_PROBE__')
      ? { blocked: true, blockerCount: 1, matchedKinds: ['qr_login'] }
      : null,
  } as unknown as BrowserController

  const result = await executeBrowserObserveTool('read', { tab_id: 'tab-a' }, observeContext(controller))
  assert.equal(typeof result, 'object')
  assert.equal((result as ToolExecutionOutput).data?.ok, false)
  assert.equal((result as ToolExecutionOutput).data?.errorKind, 'challenge_required')
  assert.deepEqual((result as ToolExecutionOutput).data?.evidence, ['visible_blocker:1', 'challenge:qr_login'])
  assert.equal((result as ToolExecutionOutput).data?.observed, true)
  assert.equal((result as ToolExecutionOutput).data?.content, 'stale result that must not become evidence')
  assert.equal((result as ToolExecutionOutput).data?.usableAsResearchEvidence, false)
  assert.equal(contentRead, true)
})

test('browser_read never turns an empty or error page into body evidence', async () => {
  let pageState: Record<string, unknown> = { blocked: false, pageError: false, emptyShell: true, matchedKinds: [] }
  const controller = {
    getActiveTab: () => ({ id: 'tab-a', url: 'https://example.test/' }),
    getTabList: () => [{ id: 'tab-a', url: 'https://example.test/', active: true }],
    getPageContent: async () => '',
    executeJS: async () => pageState,
  } as unknown as BrowserController

  const empty = await executeBrowserObserveTool('read', { tab_id: 'tab-a' }, observeContext(controller)) as ToolExecutionOutput
  assert.equal(empty.data?.ok, false)
  assert.equal(empty.data?.errorKind, 'page_content_empty')

  pageState = { blocked: false, pageError: true, emptyShell: false, matchedKinds: [] }
  const error = await executeBrowserObserveTool('read', { tab_id: 'tab-a' }, observeContext(controller)) as ToolExecutionOutput
  assert.equal(error.data?.ok, false)
  assert.equal(error.data?.errorKind, 'page_error')
})

test('browser_read resolves a fresh opaque target and rejects stale refs structurally', async () => {
  __resetBrowserAgentPageMapForTests()
  let documentKey = 'doc-1'
  const controller = {
    getActiveTab: () => ({ id: 'tab-a', url: 'https://example.test/' }),
    getTabList: () => [{ id: 'tab-a', url: 'https://example.test/', active: true }],
    getPhysicalTargetToken: () => 'physical-tab-a',
    listFrames: () => [],
    callFunctionOnBackendNode: async () => ({ matchCount: 1, content: 'Open details\nAccount details' }),
    executeJS: async (_tabId: string | null, script: string) => {
      if (script.includes('__readyBrowserSnapshotMutationState')) {
        return {
          url: `https://example.test/${documentKey}`,
          title: 'Example',
          timeOrigin: documentKey,
          mutationRevision: 0,
          frameDocumentToken: documentKey,
        }
      }
      if (script.includes('__READY_AGENT_PAGE_MAP__')) {
        return {
          identity: { url: 'https://example.test/', title: 'Example' },
          viewport: { width: 1000, height: 800 },
          bodyText: 'body',
          rawRoots: [{
            role: 'generic',
            children: [{ role: 'button', name: 'Open details', backendDOMNodeId: 1 }],
          }],
        }
      }
      if (script.includes('__READY_AGENT_TARGET_READ__')) {
        return { matchCount: 1, content: 'Open details\nAccount details' }
      }
      return null
    },
  } as unknown as BrowserController

  const snapshot = await captureAgentPageMap(controller, 'tab-a')
  const ref = String(((snapshot.pageMap as { targets: Array<{ targetId: string }> }).targets[0]).targetId)
  const content = await executeBrowserObserveTool('read', { tab_id: 'tab-a', target_id: ref, max_chars: 12 }, observeContext(controller))
  assert.equal((content as ToolExecutionOutput).data?.content, 'Open details')

  documentKey = 'doc-2'
  const stale = await executeBrowserObserveTool('read', { tab_id: 'tab-a', target_id: ref }, observeContext(controller))
  assert.equal(typeof stale, 'object')
  assert.equal((stale as ToolExecutionOutput).data?.ok, false)
  assert.equal((stale as ToolExecutionOutput).data?.errorKind, 'target_stale')
})

test('browser_screenshot with analysis always returns the image and honors clip mode', async () => {
  let captured: unknown = null
  const controller = {
    getActiveTab: () => ({ id: 'tab-a', url: 'https://example.test/' }),
    getTabList: () => [{ id: 'tab-a', url: 'https://example.test/', active: true }],
    screenshotAdvanced: async (_tabId: string | null, options: unknown) => {
      captured = options
      return 'ZmFrZS1wbmc='
    },
    executeJS: async () => ({ title: 'Example', url: 'https://example.test/', activeElement: 'body:' }),
  } as unknown as BrowserController

  const result = await executeBrowserObserveTool('screenshot_analyze', {
    tab_id: 'tab-a',
    mode: 'clip',
    clip: { x: 1, y: 2, width: 300, height: 200 },
  }, observeContext(controller))
  assert.equal(typeof result, 'object')
  const output = result as ToolExecutionOutput
  assert.equal(output.shape, 'multimodal')
  assert.deepEqual(captured, { mode: 'clip', clip: { x: 1, y: 2, width: 300, height: 200 } })
  assert.equal(output.data?.action, 'general')
  assert.equal(output.content?.[0]?.type, 'image')
  assert.equal(output.content?.[0]?.type === 'image' ? output.content[0].data : '', 'ZmFrZS1wbmc=')
})

test('browser_tabs reports popup lineage from tabs and ownership from the lease authority', async () => {
  const controller = {
    getTabList: () => [
      { id: 'tab-root', title: 'Root', url: 'https://example.test/', active: false, openerTabId: null, owner: 'manual', activity: 'idle' },
      { id: 'tab-popup', title: 'Popup', url: 'https://example.test/popup', active: true, openerTabId: 'tab-root', owner: 'agent', activity: 'running' },
      { id: 'tab-other', title: 'Other task', url: 'https://other.test/', active: false, openerTabId: null, owner: 'manual', activity: 'running' },
    ],
    getBrowserLeaseSnapshot: () => ({
      surfaces: {
        'agent-view': { state: 'held', heldBy: 'task-popup', runId: 'run-popup', tabId: 'tab-popup', leaseId: 'lease-popup' },
        'user-view': { state: 'held', heldBy: 'task-other', runId: 'run-other', tabId: 'tab-other', leaseId: 'lease-other' },
      },
    }),
  } as unknown as BrowserController

  const result = await executeBrowserObserveTool('tabs_list', {}, observeContext(controller)) as ToolExecutionOutput
  const tabs = result.data?.tabs as Array<Record<string, unknown>>
  const popup = tabs.find((tab) => tab.id === 'tab-popup')!
  const other = tabs.find((tab) => tab.id === 'tab-other')!
  assert.equal(popup.openerTabId, 'tab-root')
  assert.equal(popup.rootTabId, 'tab-root')
  assert.deepEqual(
    (popup.workflowBindings as Array<Record<string, unknown>>).map((item) => item.kind),
    ['write_lease'],
  )
  assert.equal((other.workflowBindings as Array<Record<string, unknown>>)[0]?.taskId, 'task-other')
})

test('agent pointer follows page zoom while remaining Retina-DIP invariant', () => {
  const bounds = { left: 50, top: 80, width: 1000, height: 800 }
  for (const [zoom, expectedX, expectedY] of [
    [0.72, 72, 144],
    [1, 100, 200],
    [1.25, 125, 250],
    [2, 200, 400],
  ] as const) {
    assert.deepEqual(
      mapBrowserAgentPointerToOverlay({ x: 100, y: 200, bounds, pageZoomFactor: zoom, displayScaleFactor: 2 }),
      { x: expectedX, y: expectedY },
    )
  }
  assert.deepEqual(
    mapBrowserAgentPointerToOverlay({ x: 100, y: 200, bounds, pageZoomFactor: 1, displayScaleFactor: 1 }),
    mapBrowserAgentPointerToOverlay({ x: 100, y: 200, bounds, pageZoomFactor: 1, displayScaleFactor: 2 }),
  )
})

test('browser tool wiring records same-origin network 429 and rejects an ungrounded takeover route', async () => {
  browserOriginInteractionBudget.resetForTests()
  let stopped = false
  let dialogOpen = true
  const controller = {
    getActiveTab: () => ({ id: 'tab-a', url: 'https://example.test/' }),
    getTabList: () => [{ id: 'tab-a', url: 'https://example.test/', active: true }],
    getPhysicalTargetToken: () => 'physical-tab-a',
    beginBrowserWorkflowAction: (input: Record<string, unknown>) => ({
      actionId: 'dialog-action-1',
      actionSeq: 1,
      identity: input.identity,
    }),
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: Record<string, unknown>) => ({
      receiptId: 'dialog-receipt-1',
      actionId,
      actionSeq: 1,
      outcome,
    }),
    recordBrowserWorkflowObservation: () => ({ receiptId: 'dialog-observation-1' }),
    executeJS: async (_tabId: string | null, script: string) => script.includes('__READY_AGENT_PAGE_MAP__')
      ? {
          identity: {
            url: 'https://example.test/',
            title: 'Example',
            frameDocumentToken: 'document-tab-a',
          },
          viewport: { width: 1000, height: 800 },
          rawRoots: [],
        }
      : {
          url: 'https://example.test/',
          title: 'Example',
          timeOrigin: 1,
          mutationRevision: 0,
          frameDocumentToken: 'document-tab-a',
        },
    getBrowserDialog: async () => dialogOpen ? { type: 'confirm', message: 'Publish?' } : null,
    handleBrowserDialog: async () => { dialogOpen = false },
    startNetworkObserver: async () => ({
      events: () => [{
        requestId: 'request-1',
        url: 'https://example.test/api/publish',
        status: 429,
        responseHeaders: { 'Retry-After': '3' },
      }],
      stop: async () => { stopped = true },
    }),
  } as unknown as BrowserController
  const executionContext = {
    ownerRunId: 'run-semantic-test',
    browserTaskId: 'browser-task-semantic-test',
    parentTaskId: 'parent-semantic-test',
    inputSource: 'trusted_internal' as const,
  }
  const budgetKey = scopedOriginInteractionKey({
    profile: 'default',
    scopeId: null,
    origin: 'https://example.test',
  })

  try {
    await captureAgentPageMap(controller, 'tab-a')
    const dialogResult = await executeBrowserTool(
      'browser_dialog',
      { action: 'accept' },
      controller,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      executionContext,
    )
    assert.equal(typeof dialogResult, 'object')
    assert.equal((dialogResult as ToolExecutionOutput).data?.ok, true)
    const limited = browserOriginInteractionBudget.getState(budgetKey)
    assert.equal(stopped, true)
    assert.equal(limited.consecutiveFailures, 1)
    assert.ok(limited.cooldownUntil > Date.now())

    const takeover = await executeBrowserTool(
      'browser_request_takeover',
      { reason: 'challenge must be handled by the user' },
      controller,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      executionContext,
    )
    assert.equal(typeof takeover, 'object')
    assert.equal((takeover as ToolExecutionOutput).data?.errorKind, 'human_takeover_not_grounded')
  } finally {
    browserOriginInteractionBudget.resetForTests()
  }
})
