import assert from 'node:assert/strict'
import test from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
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
