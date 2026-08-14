import assert from 'node:assert/strict'
import test from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { browserSnapshotService } from '../main/modules/browser-engine/browser-snapshot-service'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

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

test('model browser_tabs open is rejected without successor authority', async () => {
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
  const output = await executeToolCall('browser_tabs', { action: 'open', url: 'https://created.test' }, context)
  assert.equal(output.data?.errorKind, 'browser_tabs_successor_unbound')
  assert.equal(created, 0)
})

test('model browser read without a trusted page ref does not fall back to the active tab', async () => {
  const c = controller()
  const context = ctx(c)
  context.browserWorkflowRoute = {
    browserTaskId: 'browser-task-active',
    requestAnchorSnapshotDigest: 'anchor-active',
  }
  const output = await executeToolCall('browser_read', {}, context)
  assert.equal(output.data?.errorKind, 'browser_page_ref_required')
  assert.equal(c.readCalls, 0)
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
