import { webMcpFixture } from './utils/webmcp-fixture'
import type { BrowserActionOutcome } from '../shared/browser-action-outcome'
import assert from 'node:assert/strict'
import test from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { browserSnapshotService } from '../main/modules/browser-engine/browser-snapshot-service'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { createBrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import { BrowserTargetClaimService, MemoryBrowserTargetClaimRepository } from '../main/modules/browser-engine/browser-target-claims'
import { answerPageMarkdownFromPageContent } from './utils/browser-page-markdown-fixture'

test('browser-surface-gate declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-surface-gate transitive sqlite load')
})

function controller(): BrowserController & { goBackCalls: number; readCalls: number } {
  const mock: Partial<BrowserController> & { goBackCalls: number; readCalls: number } = {
    goBackCalls: 0,
    readCalls: 0,
    getActiveTab: () => ({ id: 'tab-1', title: 'T', url: 'https://example.test', active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'T', url: 'https://example.test', active: true }],
    getPageContent: async function () {
      this.readCalls += 1
      return 'page text'
    },
    executeJS: async () => ({ blocked: false, blockerCount: 0, matchedKinds: [] }),
    goBack() {
      this.goBackCalls += 1
      return { success: true }
    },
  }
  return mock as BrowserController & { goBackCalls: number; readCalls: number }
}

function ctx(browserController: BrowserController): ToolContext {
  // The fake pages below say what their getPageContent holds when the read tool asks for their Markdown.
  answerPageMarkdownFromPageContent(browserController)
  return {
    browserController,
    allowedToolNames: null,
    sessionId: 'surface-gate-session',
    scopeId: 'surface-gate-session',
    runId: 'surface-gate-run',
    taskId: 'surface-gate-task',
    authorization: buildExplicitNoSkillAuthorization(),
  }
}

function referencedPageEnvelope(documentToken = 'document-token-ref'): Record<string, unknown> {
  return {
    environmentHints: {
      workbenchMode: 'browser',
      browserPageRef: {
        tabId: 'tab-ref',
        physicalTargetToken: 'physical-ref',
        mainFrameId: '0',
        mainFrameDocumentToken: documentToken,
      },
    },
  }
}

function textOf(out: unknown): string {
  const value = out as { text?: unknown; output?: unknown }
  if (typeof value.text === 'string') return value.text
  if (typeof value.output === 'string') return value.output
  return typeof out === 'string' ? out : JSON.stringify(out)
}

test('native dialogs bypass blocked page scripts while ordinary tools fail immediately and physical pins remain enforced', async (t) => {
  let pending = true
  let physical = 'physical-ref'
  let pageCallsWhileOpen = 0
  const accepted: boolean[] = []
  const c = controller()
  Object.assign(c, {
    getActiveTab: () => ({ id: 'tab-ref', title: 'Dialog', url: 'https://referenced.test/', active: false }),
    getTabList: () => [{ id: 'tab-ref', title: 'Dialog', url: 'https://referenced.test/', active: false }],
    getPhysicalTargetToken: () => physical,
    getBrowserDialog: async () => pending ? { tabId: 'tab-ref', type: 'confirm', message: '继续吗？', url: 'https://referenced.test/' } : null,
    handleBrowserDialog: async (_tabId: string, input: { accept: boolean }) => { accepted.push(input.accept); pending = false; return { success: true } },
    executeJS: async () => {
      if (pending) { pageCallsWhileOpen += 1; throw new Error('page script blocked by modal') }
      return { url: 'https://referenced.test/', title: 'Dialog', frameDocumentToken: 'document-token-ref', timeOrigin: 1 }
    },
    beginBrowserWorkflowAction: (input: { identity: unknown }) => ({ actionId: 'dialog-action', actionSeq: 1, identity: input.identity }),
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: unknown) => ({ receiptId: actionId, outcome }),
    bindBrowserWorkflowPhysicalTarget: () => () => undefined,
    isBrowserWorkflowWriteAdmitted: () => true,
    consumeBrowserSiteNotices: () => [],
    getTaskPayload: () => ({}),
  })
  const context = ctx(c)
  context.requestEnvelope = { environmentHints: { ...(referencedPageEnvelope().environmentHints as Record<string, unknown>), browserWriteOrigins: ['https://referenced.test'] } }
  context.browserWorkflowRoute = { browserTaskId: 'browser-task-ref', requestAnchorSnapshotDigest: 'anchor-ref' }
  context.browserLease = createBrowserTurnLease({ taskId: context.taskId!, runId: context.runId! }, new BrowserTargetClaimService(new MemoryBrowserTargetClaimRepository()))
  t.after(() => context.browserLease?.release())
  for (const name of ['browser_read', 'browser_snapshot', 'browser_press_key', 'browser_navigate']) {
    const out = await executeToolCall(name, name === 'browser_press_key' ? { key: 'Enter' } : name === 'browser_navigate' ? { action: 'back' } : {}, context)
    assert.equal(out.data?.errorKind, 'dialog_open', textOf(out))
  }
  const read = await executeToolCall('browser_dialog', { action: 'get' }, context)
  assert.match(textOf(read), /继续吗/)
  assert.equal(pageCallsWhileOpen, 0)
  const dismissed = await executeToolCall('browser_dialog', { action: 'dismiss' }, context)
  assert.equal(dismissed.data?.ok, true, textOf(dismissed))
  assert.deepEqual(accepted, [false])
  pending = true
  const confirmed = await executeToolCall('browser_dialog', { action: 'accept' }, context)
  assert.equal(confirmed.data?.ok, true, textOf(confirmed))
  assert.deepEqual(accepted, [false, true])
  pending = true
  physical = 'replacement-target'
  const stale = await executeToolCall('browser_dialog', { action: 'get' }, context)
  assert.equal(stale.data?.errorKind, 'browser_reference_stale')
  assert.equal(pageCallsWhileOpen, 0)
})

test('tool-executor refuses browser writes without a durable workflow route', async () => {
  const c = controller()
  const out = await executeToolCall('browser_navigate', { action: 'back' }, ctx(c))
  assert.match(textOf(out), /browser_workflow_route_required/)
  assert.equal(c.goBackCalls, 0, 'browser write must not dispatch without a workflow route')
})

test('tool-executor refuses browser reads without the same durable workflow route', async () => {
  const c = controller()
  const out = await executeToolCall('browser_read', {}, ctx(c))
  assert.match(textOf(out), /browser_workflow_route_required/)
  assert.equal(c.readCalls, 0, 'browser read must not dispatch without a workflow route')
})

test('tool-executor binds an omitted browser tab to the exact referenced background page', async () => {
  let readTabId: string | null = null
  const c = controller()
  Object.assign(c, {
    getActiveTab: () => ({ id: 'tab-active', title: 'Active', url: 'https://active.test', active: true }),
    getTabList: () => [
      { id: 'tab-active', title: 'Active', url: 'https://active.test', active: true },
      { id: 'tab-ref', title: 'Referenced', url: 'https://referenced.test', active: false },
    ],
    getPhysicalTargetToken: (tabId: string | null) => tabId === 'tab-ref' ? 'physical-ref' : 'physical-active',
    executeJS: async (tabId: string | null) => ({
      url: tabId === 'tab-ref' ? 'https://referenced.test' : 'https://active.test',
      title: tabId === 'tab-ref' ? 'Referenced' : 'Active',
      timeOrigin: 1,
      mutationRevision: 0,
      frameDocumentToken: tabId === 'tab-ref' ? 'document-token-ref' : 'document-token-active',
    }),
    getPageContent: async (tabId: string | null) => {
      readTabId = tabId
      return 'referenced page text'
    },
  })
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-ref',
    requestAnchorSnapshotDigest: 'anchor-ref',
  }
  const output = await executeToolCall('browser_read', {}, context)
  assert.equal(readTabId, 'tab-ref')
  assert.doesNotMatch(textOf(output), /browser_reference_stale|browser_reference_target_mismatch/)
})

test('model browser_tabs list only returns the pinned page', async () => {
  const c = controller()
  Object.assign(c, {
    getActiveTab: () => ({ id: 'tab-active', title: 'Active', url: 'https://active.test', active: true }),
    getTabList: () => [
      { id: 'tab-active', title: 'Active', url: 'https://active.test', active: true },
      { id: 'tab-ref', title: 'Referenced', url: 'https://referenced.test', active: false },
    ],
    getPhysicalTargetToken: (tabId: string | null) => tabId === 'tab-ref' ? 'physical-ref' : 'physical-active',
    executeJS: async (tabId: string | null) => ({
      url: tabId === 'tab-ref' ? 'https://referenced.test' : 'https://active.test',
      title: tabId === 'tab-ref' ? 'Referenced' : 'Active',
      timeOrigin: 1,
      mutationRevision: 0,
      frameDocumentToken: tabId === 'tab-ref' ? 'document-token-ref' : 'document-token-active',
    }),
  })
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-ref',
    requestAnchorSnapshotDigest: 'anchor-ref',
  }
  const output = await executeToolCall('browser_tabs', { action: 'list' }, context)
  const listed = (output.data as { tabs?: Array<{ id?: string }> } | undefined)?.tabs || []
  assert.deepEqual(listed.map((tab) => tab.id), ['tab-ref'])
})

test('model browser_tabs open refuses an unreferenced opener', async () => {
  const c = controller()
  let created = 0
  Object.assign(c, {
    createTab: async () => {
      created += 1
      return { id: 'tab-orphan', url: 'https://created.test' }
    },
    ensureAgentWorkTab: async () => {
      created += 1
      return { id: 'tab-orphan', url: 'https://created.test' }
    },
  })
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-ref',
    requestAnchorSnapshotDigest: 'anchor-ref',
  }
  const output = await executeToolCall('browser_tabs', { action: 'open', url: 'https://created.test', opener_tab_id: 'other-user-tab' }, context)
  assert.equal(output.data?.errorKind, 'browser_reference_target_mismatch')
  assert.equal(created, 0)
})

test('model browser read without a trusted page ref does not fall back to the active tab', async () => {
  const c = controller()
  let dialogReads = 0
  c.getBrowserDialog = async () => { dialogReads += 1; return null }
  const context = ctx(c)
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-active',
    requestAnchorSnapshotDigest: 'anchor-active',
  }
  const output = await executeToolCall('browser_read', {}, context)
  assert.equal(output.data?.errorKind, 'browser_page_ref_required')
  assert.equal(c.readCalls, 0)
  assert.equal(dialogReads, 0)
})

test('document-workbench envelope still pins read to the referenced background tab', async () => {
  let readTabId: string | null = null
  const c = controller()
  Object.assign(c, {
    getActiveTab: () => ({ id: 'tab-active', title: 'Active', url: 'https://active.test', active: true }),
    getTabList: () => [
      { id: 'tab-active', title: 'Active', url: 'https://active.test', active: true },
      { id: 'tab-ref', title: 'Referenced', url: 'https://referenced.test', active: false },
    ],
    getPhysicalTargetToken: (tabId: string | null) => tabId === 'tab-ref' ? 'physical-ref' : 'physical-active',
    executeJS: async (tabId: string | null) => ({
      url: tabId === 'tab-ref' ? 'https://referenced.test' : 'https://active.test',
      title: tabId === 'tab-ref' ? 'Referenced' : 'Active',
      timeOrigin: 1,
      mutationRevision: 0,
      frameDocumentToken: tabId === 'tab-ref' ? 'document-token-ref' : 'document-token-active',
    }),
    getPageContent: async (tabId: string | null) => {
      readTabId = tabId
      return 'referenced page text'
    },
  })
  const context = ctx(c)
  context.requestEnvelope = {
    environmentHints: {
      workbenchMode: 'document',
      browserPageRef: {
        tabId: 'tab-ref',
        physicalTargetToken: 'physical-ref',
        mainFrameId: '0',
        mainFrameDocumentToken: 'document-token-ref',
      },
    },
  }
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-ref',
    requestAnchorSnapshotDigest: 'anchor-ref',
  }
  const output = await executeToolCall('browser_read', {}, context)
  assert.equal(readTabId, 'tab-ref')
  assert.doesNotMatch(textOf(output), /browser_reference_stale|browser_reference_target_mismatch|browser_page_ref_required/)
})

test('tool-executor refuses a model-selected browser tab that differs from the user reference', async () => {
  const c = controller()
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-ref',
    requestAnchorSnapshotDigest: 'anchor-ref',
  }
  const output = await executeToolCall('browser_read', { tab_id: 'tab-other' }, context)
  assert.equal(output.data?.errorKind, 'browser_reference_target_mismatch')
  assert.equal(c.readCalls, 0)
})

test('successful navigate is not rewritten as a stale reference after the page changes', async () => {
  let frameToken = 'document-token-ref'
  let navigateCalls = 0
  const c = controller()
  Object.assign(c, {
    getActiveTab: () => ({ id: 'tab-ref', title: 'Referenced', url: 'https://referenced.test/v2', active: true }),
    getTabList: () => [{ id: 'tab-ref', title: 'Referenced', url: 'https://referenced.test/v2', active: true }],
    getPhysicalTargetToken: () => 'physical-ref',
    executeJS: async () => ({
      url: 'https://referenced.test/v2',
      title: 'Referenced v2',
      timeOrigin: 2,
      mutationRevision: 1,
      frameDocumentToken: frameToken,
    }),
    navigate: (tabId: string | null, url: string) => {
      navigateCalls += 1
      frameToken = 'document-token-v2'
      return { success: true, tabId, url }
    },
    beginBrowserWorkflowAction: (input: { identity: unknown }) => ({
      actionId: 'nav-1',
      actionSeq: 1,
      identity: input.identity,
    }),
    settleBrowserWorkflowAction: (
      _taskId: string,
      actionId: string,
      outcome: unknown,
    ) => ({ receiptId: `receipt-${actionId}`, outcome }),
    bindBrowserWorkflowPhysicalTarget: () => () => undefined,
    isBrowserWorkflowWriteAdmitted: () => true,
    consumeBrowserSiteNotices: () => [],
  })
  await browserSnapshotService.capture(c, 'tab-ref', 1024, async () => ({ targets: [] }))
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-ref',
    requestAnchorSnapshotDigest: 'anchor-ref',
  }
  context.browserLease = {
    ensureGateForTarget: () => ({
      service: {
        checkWrite: () => null,
        beginAgentAction: () => 'lease-action-1',
        endAgentAction: () => undefined,
      },
      identity: {
        partition: 'persist:browser',
        tabId: 'tab-ref',
        physicalTargetToken: 'physical-ref',
        bootIncarnationId: 'boot-current',
        claimId: 'claim-ref',
        generation: 1,
        ownerRunId: 'surface-gate-run',
      },
      surface: 'user-view',
    }),
  } as ToolContext['browserLease']
  const output = await executeToolCall('browser_navigate', { action: 'open', url: 'https://referenced.test/v2' }, context)
  if (navigateCalls !== 1) {
    throw new Error(`navigate not dispatched: ${textOf(output)}`)
  }
  assert.equal(navigateCalls, 1)
  assert.match(textOf(output), /Navigated to https:\/\/referenced\.test\/v2/)
  assert.notEqual(output.data?.errorKind, 'browser_reference_stale')
  assert.doesNotMatch(textOf(output), /browser_reference_stale/)
})

test('a controlled same-tab navigate can be read immediately on the successor page', async () => {
  let frameToken = 'document-token-ref'
  let readCalls = 0
  const settledOutcomes: Array<{ successorIdentity?: { frameDocumentToken?: string } }> = []
  const c = controller()
  Object.assign(c, {
    getActiveTab: () => ({ id: 'tab-ref', title: 'Referenced', url: 'https://referenced.test/v2', active: true }),
    getTabList: () => [{ id: 'tab-ref', title: 'Referenced', url: 'https://referenced.test/v2', active: true }],
    getPhysicalTargetToken: () => 'physical-ref',
    executeJS: async () => ({
      url: 'https://referenced.test/v2',
      title: 'Referenced v2',
      timeOrigin: 2,
      mutationRevision: 1,
      frameDocumentToken: frameToken,
    }),
    navigate: (tabId: string | null, url: string) => {
      frameToken = 'document-token-v2'
      return { success: true, tabId, url }
    },
    getPageContent: async () => {
      readCalls += 1
      return 'successor page text'
    },
    beginBrowserWorkflowAction: (input: { identity: unknown }) => ({
      actionId: `action-${settledOutcomes.length + 1}`,
      actionSeq: settledOutcomes.length + 1,
      identity: input.identity,
    }),
    settleBrowserWorkflowAction: (
      _taskId: string,
      actionId: string,
      outcome: { successorIdentity?: { frameDocumentToken?: string } },
    ) => {
      settledOutcomes.push(outcome)
      return { receiptId: `receipt-${actionId}`, outcome }
    },
    recordBrowserWorkflowObservation: (input: Record<string, unknown>) => input,
    readBrowserWorkflowSettledOutcomes: () => settledOutcomes,
    bindBrowserWorkflowPhysicalTarget: () => () => undefined,
    isBrowserWorkflowWriteAdmitted: () => true,
    consumeBrowserSiteNotices: () => [],
  })
  await browserSnapshotService.capture(c, 'tab-ref', 1024, async () => ({ targets: [] }))
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-ref',
    requestAnchorSnapshotDigest: 'anchor-ref',
  }
  context.browserLease = {
    ensureGateForTarget: () => ({
      service: {
        checkWrite: () => null,
        beginAgentAction: () => 'lease-action-1',
        endAgentAction: () => undefined,
      },
      identity: {
        partition: 'persist:browser',
        tabId: 'tab-ref',
        physicalTargetToken: 'physical-ref',
        bootIncarnationId: 'boot-current',
        claimId: 'claim-ref',
        generation: 1,
        ownerRunId: 'surface-gate-run',
      },
      surface: 'user-view',
    }),
  } as ToolContext['browserLease']
  const navigated = await executeToolCall(
    'browser_navigate',
    { action: 'open', url: 'https://referenced.test/v2' },
    context,
  )
  assert.doesNotMatch(textOf(navigated), /browser_reference_stale/)
  const read = await executeToolCall('browser_read', {}, context)
  assert.equal(readCalls, 1, textOf(read))
  assert.match(textOf(read), /successor page text/)
  assert.notEqual(read.data?.errorKind, 'browser_reference_stale')
})

test('browser_read fails closed when the same tab navigates during the read', async () => {
  let frameToken = 'document-token-ref'
  const c = controller()
  Object.assign(c, {
    getActiveTab: () => ({ id: 'tab-ref', title: 'Referenced', url: 'https://referenced.test', active: true }),
    getTabList: () => [{ id: 'tab-ref', title: 'Referenced', url: 'https://referenced.test', active: true }],
    getPhysicalTargetToken: () => 'physical-ref',
    executeJS: async () => ({
      url: 'https://referenced.test',
      title: 'Referenced',
      timeOrigin: 1,
      mutationRevision: 0,
      frameDocumentToken: frameToken,
    }),
    getPageContent: async () => {
      frameToken = 'document-token-v2'
      return 'new document body'
    },
  })
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-ref',
    requestAnchorSnapshotDigest: 'anchor-ref',
  }
  const output = await executeToolCall('browser_read', {}, context)
  assert.equal(output.data?.errorKind, 'browser_reference_stale')
  assert.doesNotMatch(textOf(output), /new document body/)
})

test('tool-executor rejects a referenced browser page after its document identity changes', async () => {
  const c = controller()
  Object.assign(c, {
    getTabList: () => [{ id: 'tab-ref', title: 'Referenced', url: 'https://referenced.test', active: false }],
    getPhysicalTargetToken: () => 'physical-ref',
    executeJS: async () => ({
      url: 'https://referenced.test/changed',
      title: 'Changed',
      timeOrigin: 2,
      mutationRevision: 0,
      frameDocumentToken: 'document-token-changed',
    }),
  })
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-ref',
    requestAnchorSnapshotDigest: 'anchor-ref',
  }
  const output = await executeToolCall('browser_read', {}, context)
  assert.equal(output.data?.errorKind, 'browser_reference_stale')
  assert.equal(c.readCalls, 0)
})


test('unmentioned origin write requires an action-confirmation card and delivers no input', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser origin scope')) return
  const c = controller()
  let writes = 0
  Object.assign(c, {
    getTaskPayload: () => ({}),
    getPhysicalTargetToken: () => 'physical-ref',
    executeJS: async (_tabId: string | null, script: string) => script === 'location.origin'
      ? 'https://foreign.test' : { url: 'https://foreign.test', title: 'Foreign', timeOrigin: 1, mutationRevision: 0, frameDocumentToken: 'document-token-ref' },
    typeTextDirectly: async () => { writes++; return { success: true } },
  })
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserWorkflowRoute = { browserTaskId: 'origin-task', requestAnchorSnapshotDigest: 'origin-anchor' }
  const output = await executeToolCall('browser_type', { selector: 'input', text: 'value' }, context)
  assert.equal(output.data?.ruleId, 'browser-origin-write')
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
  assert.equal(writes, 0)
})


test('model opens a task page with causal journal identity then reads it without exposing other user tabs', async (t) => {
  if (skipIfSqliteUnavailable(t, 'task tabs')) return
  const c = controller()
  const outcomes: BrowserActionOutcome[] = []
  const tabs = [
    { id: 'tab-ref', title: 'Root', url: 'https://referenced.test', active: true },
    { id: 'private', title: 'Private', url: 'https://private.test', active: false },
  ]
  let selected: string | null = null
  Object.assign(c, {
    getActiveTab: () => tabs[0], getTabList: () => tabs,
    getPhysicalTargetToken: (id: string) => id === 'tab-ref' ? 'physical-ref' : 'physical-work',
    executeJS: async (id: string, script: string) => script === 'location.origin' ? 'https://referenced.test' : {
      url: 'https://referenced.test', title: 'Page', timeOrigin: 1, mutationRevision: 0,
      frameDocumentToken: id === 'tab-ref' ? 'document-token-ref' : 'document-work',
    },
    getTaskWorkTabIds: () => selected ? [selected] : [], getAgentWorkTab: () => selected,
    createAgentWorkTab: async (_task: string, url: string, openerTabId: string) => {
      assert.equal(openerTabId, 'tab-ref')
      tabs.push({ id: 'work', title: 'Work', url, active: false }); selected = 'work'
      return { success: true, tabId: 'work' }
    },
    waitForCondition: async () => ({ matched: true, elapsedMs: 0 }),
    getPageContent: async () => 'task page body',
    beginBrowserWorkflowAction: (input: { identity: unknown }) => ({ actionId: 'open-1', actionSeq: 1, identity: input.identity }),
    settleBrowserWorkflowAction: (_task: string, _id: string, outcome: BrowserActionOutcome) => {
      outcomes.push(outcome); return { receiptId: 'open-receipt', outcome }
    },
    readBrowserWorkflowSettledOutcomes: () => outcomes,
    recordBrowserWorkflowObservation: (input: Record<string, unknown>) => input,
    consumeBrowserSiteNotices: () => [],
  })
  await browserSnapshotService.capture(c, 'tab-ref', 1024, async () => ({ targets: [] }))
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserWorkflowRoute = { browserTaskId: 'browser-task-ref', requestAnchorSnapshotDigest: 'anchor' }
  const opened = await executeToolCall('browser_tabs', { action: 'open', url: 'https://referenced.test/next' }, context)
  assert.equal(opened.data?.success, true, textOf(opened))
  assert.equal(outcomes[0].identity.tabId, 'tab-ref')
  assert.equal(outcomes[0].postActionTabId, 'work')
  assert.equal(outcomes[0].successorIdentity.tabId, 'work')
  const read = await executeToolCall('browser_read', { tab_id: 'work' }, context)
  assert.match(read.text, /task page body/)
  const listed = await executeToolCall('browser_tabs', { action: 'list' }, context)
  assert.deepEqual((listed.data?.tabs as { id: string }[]).map(tab => tab.id), ['tab-ref', 'work'])
  assert.equal(c.getActiveTab()?.id, 'tab-ref')
  const denied = await executeToolCall('browser_tabs', { action: 'close', tab_id: 'private' }, context)
  assert.equal(denied.data?.errorKind, 'browser_task_tab_not_owned')
})

for (const [label, annotations, origins, rule] of [
  ['consequential', { readOnlyHint: true, consequentialHint: true }, ['https://page.test'], 'browser-webmcp-write'],
  ['undeclared', undefined, ['https://page.test'], 'browser-webmcp-write'],
  ['foreign-frame', { consequentialHint: true }, ['https://other.test'], 'browser-origin-write'],
] as const) {
  test(`WebMCP ${label} is stopped by the real confirmation gate with zero invocations`, async (t) => {
    if (skipIfSqliteUnavailable(t, 'WebMCP confirmation gate')) return
    const f = webMcpFixture(); await f.service.enableTab('tab-ref'); f.add(annotations)
    const c = controller()
    Object.assign(c, { webMcp: f.service, getTaskPayload: () => ({}), getPhysicalTargetToken: () => 'physical-ref',
      executeJS: async () => ({ url: 'https://page.test', title: 'Page', timeOrigin: 1, mutationRevision: 0, frameDocumentToken: 'document-token-ref' }) })
    const context = ctx(c)
    context.requestEnvelope = { environmentHints: { ...referencedPageEnvelope().environmentHints as object, browserWriteOrigins: origins } }
    context.browserWorkflowRoute = { browserTaskId: 'webmcp-task', requestAnchorSnapshotDigest: 'webmcp-anchor' }
    const output = await executeToolCall('browser_call_page_tool', { frame_id: 'frame-1', tool_name: 'lookup', input: { query: 'x' } }, context)
    assert.equal(output.data?.ruleId, rule)
    assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
    assert.equal(f.commands.filter(command => command.method === 'WebMCP.invokeTool').length, 0)
    f.service.disposeTab('tab-ref')
  })
}

test('WebMCP read-only child-frame call returns data and settles the real browser action journal', async (t) => {
  if (skipIfSqliteUnavailable(t, 'WebMCP journal dispatch')) return
  const f = webMcpFixture()
  await f.service.enableTab('tab-ref')
  f.add({ readOnlyHint: true })
  t.after(() => f.service.disposeTab('tab-ref'))
  const outcomes: BrowserActionOutcome[] = []
  const c = controller()
  Object.assign(c, {
    webMcp: f.service,
    getActiveTab: () => ({ id: 'tab-ref', url: 'https://page.test', title: 'Page', active: true }),
    getTabList: () => [{ id: 'tab-ref', url: 'https://page.test', title: 'Page', active: true }],
    getTaskPayload: () => ({}),
    getPhysicalTargetToken: () => 'physical-ref',
    bindBrowserWorkflowPhysicalTarget: () => () => undefined,
    isBrowserWorkflowWriteAdmitted: () => true,
    executeJS: async () => ({ url: 'https://page.test', title: 'Page', timeOrigin: 1, mutationRevision: 0, frameDocumentToken: 'document-token-ref' }),
    beginBrowserWorkflowAction: (input: { identity: unknown }) => ({ actionId: 'webmcp-action', actionSeq: 1, identity: input.identity }),
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: BrowserActionOutcome) => {
      outcomes.push(outcome)
      return { receiptId: `receipt-${actionId}`, outcome }
    },
  })
  const context = ctx(c)
  context.requestEnvelope = referencedPageEnvelope()
  context.browserLease = createBrowserTurnLease({ taskId: context.taskId!, runId: context.runId! }, new BrowserTargetClaimService(new MemoryBrowserTargetClaimRepository()))
  t.after(() => context.browserLease?.release())
  context.browserWorkflowRoute = { browserTaskId: 'webmcp-task', requestAnchorSnapshotDigest: 'webmcp-anchor' }
  const result = await executeToolCall('browser_call_page_tool', { frame_id: 'frame-1', tool_name: 'lookup', input: { query: 'x' } }, context)
  assert.equal(result.data?.ok, true, result.text)
  assert.equal(result.data?.trust, 'untrusted_web_content')
  assert.equal(f.commands.filter(command => command.method === 'WebMCP.invokeTool').length, 1)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].identity.frameId, 'frame-1')
  assert.ok(outcomes[0].identity.frameDocumentToken)
  assert.equal(outcomes[0].delivery, 'delivered')
  assert.equal(outcomes[0].effect, 'observed')
})
