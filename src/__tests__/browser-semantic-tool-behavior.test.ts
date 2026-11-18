import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { mapBrowserAgentPointerToOverlay } from '../shared/browser-agent-pointer'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { runBrowserFillFormSequence } from '../main/modules/tools/browser-act-tools'
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

import { isPageMarkdownScript, pageMarkdownDocument } from './utils/browser-page-markdown-fixture'

function observeContext(controller: BrowserController) {
  return { controller }
}

test('browser_read includes same-origin and cross-origin nested frames within one text budget and reports a failed frame', async () => {
  let removed = false
  const controller = {
    executeJS: async (_tabId: string | null, code: string) => isPageMarkdownScript(code)
      ? pageMarkdownDocument('# MAIN\n\nSee [the docs](https://same.test/docs).', { url: 'https://same.test/', title: 'Main page' })
      : { blocked: false },
    getPageContent: async () => { throw new Error('a readable page is not read as plain text') },
    listContentFrames: () => [
      { frameKey: '0', main: true, url: 'https://same.test/' },
      { frameKey: '1-2', main: false, url: 'https://same.test/middle' },
      { frameKey: '3-4', main: false, url: 'https://cross.test/deep' },
    ],
    executeJSInFrame: async (_tabId: string, frame: string) => {
      if (removed && frame === '3-4') throw new Error('FRAME_NOT_FOUND')
      return pageMarkdownDocument(frame === '1-2' ? 'MID-7' : 'DEEP-42')
    },
  } as unknown as BrowserController
  const read = await executeBrowserObserveTool('read', {}, observeContext(controller)) as ToolExecutionOutput
  const whole = '# MAIN\n\nSee [the docs](https://same.test/docs).\n\n[frame 1-2 https://same.test/middle]\nMID-7\n\n[frame 3-4 https://cross.test/deep]\nDEEP-42'
  assert.deepEqual(read.data, {
    ok: true,
    observationFresh: true,
    url: 'https://same.test/',
    title: 'Main page',
    format: 'markdown',
    totalChars: whole.length,
    returnedChars: whole.length,
    truncated: false,
    content: whole,
  })

  // A page longer than the window says so, and the windows join up to the whole.
  const first = await executeBrowserObserveTool('read', { max_chars: 50 }, observeContext(controller)) as ToolExecutionOutput
  assert.deepEqual([first.data?.returnedChars, first.data?.totalChars, first.data?.truncated, first.data?.nextOffset], [50, whole.length, true, 50])
  let joined = String(first.data?.content)
  for (let offset = 50; offset < whole.length; offset += 50) {
    const next = await executeBrowserObserveTool('read', { max_chars: 50, offset }, observeContext(controller)) as ToolExecutionOutput
    joined += String(next.data?.content)
    assert.equal(next.data?.truncated, offset + 50 < whole.length)
  }
  assert.equal(joined, whole)

  removed = true
  const failed = await executeBrowserObserveTool('read', {}, observeContext(controller)) as ToolExecutionOutput
  assert.equal(failed.data?.errorKind, 'frame_read_failed')
  assert.equal(failed.data?.frameId, '3-4')
  assert.equal(failed.data?.content, undefined)
})

test('browser_read says so when the page cannot be turned into text, instead of returning an empty success', async () => {
  for (const answer of [null, { ok: false, reason: 'no_document_body' }]) {
    const controller = {
      executeJS: async (_tabId: string | null, code: string) => isPageMarkdownScript(code) ? answer : { blocked: false },
      getPageContent: async () => 'plain text that must not stand in for the page',
      listContentFrames: () => [],
    } as unknown as BrowserController
    const failed = await executeBrowserObserveTool('read', {}, observeContext(controller)) as ToolExecutionOutput
    assert.deepEqual([failed.data?.ok, failed.data?.errorKind, failed.data?.content], [false, 'page_read_failed', undefined])
  }
})

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
    async () => { assert.fail('partial forms must never be submitted') },
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
      return '{"ok":true}'
    },
    async () => { calls.push('submit'); return 'Error: form submission failed' },
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorKind, 'form_submit_failed')
  assert.equal(outcome.submitted, false)
  assert.deepEqual(calls, ['type_selector', 'submit'])
})

test('boolean form fields without an exact control never become text in another input', async () => {
  const result = await runBrowserFillFormSequence([{ label: '订阅', value: true }], { submit: true },
    async () => { assert.fail('must not guess a text input') }, async () => { assert.fail('must not submit') })
  assert.equal(result.errorKind, 'form_control_target_required')
  assert.match(String(result.message), /browser_snapshot.*checkbox\/radio target_id/)
})

test('browser_read enforces max_chars and returns structured selector ambiguity', async () => {
  let selectorMatches = 1
  const controller = {
    getActiveTab: () => ({ id: 'tab-a', url: 'https://example.test/' }),
    getTabList: () => [{ id: 'tab-a', url: 'https://example.test/', active: true }],
    executeJS: async (_tabId: string | null, code: string) => isPageMarkdownScript(code)
      ? pageMarkdownDocument('abcdefghijk')
      : { matchCount: selectorMatches, content: 'selected region' },
  } as unknown as BrowserController

  const bounded = await executeBrowserObserveTool('read', { tab_id: 'tab-a', max_chars: 5 }, observeContext(controller)) as ToolExecutionOutput
  assert.deepEqual(
    [bounded.data?.content, bounded.data?.totalChars, bounded.data?.returnedChars, bounded.data?.truncated, bounded.data?.nextOffset],
    ['abcde', 11, 5, true, 5],
  )
  const scoped = await executeBrowserObserveTool('read', { tab_id: 'tab-a', selector: '.card', max_chars: 8 }, observeContext(controller)) as ToolExecutionOutput
  assert.deepEqual(
    [scoped.data?.content, scoped.data?.totalChars, scoped.data?.truncated, scoped.data?.nextOffset],
    ['selected', 15, true, 8],
  )
  const rest = await executeBrowserObserveTool('read', { tab_id: 'tab-a', selector: '.card', offset: 8 }, observeContext(controller)) as ToolExecutionOutput
  assert.deepEqual([rest.data?.content, rest.data?.truncated, rest.data?.nextOffset], [' region', false, undefined])

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

test('successful page waits are fresh action observations but never research body evidence', async () => {
  let matched = true
  const controller = {
    waitForCondition: async () => ({
      matched,
      elapsedMs: 25,
      value: { contentSignature: '3812:2964:26' },
    }),
  } as unknown as BrowserController

  const stable = JSON.parse(String(await executeBrowserObserveTool(
    'wait_condition',
    { tab_id: 'tab-a', condition: 'content_stable', stable_iterations: 2 },
    observeContext(controller),
  ))) as Record<string, unknown>
  assert.equal(stable.observationFresh, true)
  assert.equal(stable.usableAsResearchEvidence, false)

  matched = false
  const timedOut = JSON.parse(String(await executeBrowserObserveTool(
    'wait_condition',
    { tab_id: 'tab-a', condition: 'content_stable' },
    observeContext(controller),
  ))) as Record<string, unknown>
  assert.equal(timedOut.observationFresh, false)
  assert.equal(timedOut.usableAsResearchEvidence, false)

  const durationOnly = JSON.parse(String(await executeBrowserObserveTool(
    'wait_condition',
    { duration_ms: 1 },
    observeContext(controller),
  ))) as Record<string, unknown>
  assert.equal(durationOnly.observationFresh, undefined)
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

test('browser_tabs keeps occupancy for every held tab instead of one surface summary', async () => {
  const controller = {
    getTabList: () => [
      { id: 'tab-a', title: 'A', url: 'https://a.test/', active: true, openerTabId: null },
      { id: 'tab-b', title: 'B', url: 'https://b.test/', active: false, openerTabId: null },
    ],
    getBrowserLeaseSnapshot: () => ({
      surfaces: {
        'user-view': { state: 'held', heldBy: 'task-a', runId: 'run-a', tabId: 'tab-a', leaseId: 'lease-a' },
        'agent-view': { state: 'idle', heldBy: null, runId: null, tabId: null, leaseId: null },
      },
      claims: [
        { tabId: 'tab-a', surface: 'user-view', state: 'held', parentTaskId: 'task-a', ownerRunId: 'run-a', claimId: 'lease-a' },
        { tabId: 'tab-b', surface: 'user-view', state: 'held', parentTaskId: 'task-b', ownerRunId: 'run-b', claimId: 'lease-b' },
      ],
    }),
  } as unknown as BrowserController

  const result = await executeBrowserObserveTool('tabs_list', {}, observeContext(controller)) as ToolExecutionOutput
  const tabs = result.data?.tabs as Array<Record<string, unknown>>
  const first = tabs.find((tab) => tab.id === 'tab-a')!
  const second = tabs.find((tab) => tab.id === 'tab-b')!
  assert.equal((first.workflowBindings as Array<Record<string, unknown>>)[0]?.taskId, 'task-a')
  assert.equal((second.workflowBindings as Array<Record<string, unknown>>)[0]?.taskId, 'task-b')
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

test('browser tool wiring records same-origin network 429 and rejects the retired takeover tool', async () => {
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
    assert.equal((takeover as ToolExecutionOutput).data?.errorKind, 'tool_not_registered')
  } finally {
    browserOriginInteractionBudget.resetForTests()
  }
})

test('browser_read by selector hands back what a field holds, except a password', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM(
    '<!doctype html><body><input id="user" type="text" value="bai" aria-label="User name">'
    + '<input id="pw" type="password" value="hunter2-secret" aria-label="Password"></body>',
    { runScripts: 'outside-only' },
  )
  const controller = {
    getActiveTab: () => ({ id: 'tab-a', url: 'https://example.test/' }),
    getTabList: () => [{ id: 'tab-a', url: 'https://example.test/', active: true }],
    executeJS: async (_tabId: string | null, code: string) => code.includes('__READY_BLOCKING_CHALLENGE_PROBE__')
      ? { blocked: false }
      : JSON.parse(JSON.stringify(dom.window.eval(code))),
  } as unknown as BrowserController

  const user = await executeBrowserObserveTool('read', { tab_id: 'tab-a', selector: '#user' }, observeContext(controller)) as ToolExecutionOutput
  assert.equal(user.data?.content, 'bai\nUser name')
  const password = await executeBrowserObserveTool('read', { tab_id: 'tab-a', selector: '#pw' }, observeContext(controller)) as ToolExecutionOutput
  assert.equal(password.data?.ok, true)
  assert.equal(password.data?.content, 'Password')
  assert.equal(JSON.stringify(password).includes('hunter2'), false)
})
