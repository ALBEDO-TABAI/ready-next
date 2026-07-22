import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { browserSnapshotService } from '../main/modules/browser-engine/browser-snapshot-service'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { BrowserTargetClaimGate } from '../main/modules/browser-engine/agent-browser-lease-gate'
import { attachBrowserWorkflowFixture } from './utils/browser-workflow-fixture'
import { acquireTarget, createTargetClaimService, identityOf } from './utils/browser-target-claim-fixture'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('agent-browser-lease-gate-integration declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-browser-lease-gate-integration transitive sqlite load')
})

function createController(overrides?: Partial<BrowserController>): BrowserController {
  let actionSeq = 0
  let observationSeq = 0
  const mock: Partial<BrowserController> = {
    getTabList: () => [{ id: 'tab-1', title: 'T', url: 'https://example.com', active: true }],
    getActiveTab: () => ({ id: 'tab-1', title: 'T', url: 'https://example.com', active: true }) as never,
    getPhysicalTargetToken: () => 'physical-tab-1',
    getPageContent: async () => 'visible page text',
    normalizedToCss: async (_t, x, y) => ({ x: Number(x), y: Number(y), width: 1000, height: 800 }),
    dispatchMouse: async () => {},
    getViewportMetrics: async () => ({ width: 1000, height: 800, pageX: 0, pageY: 0, scale: 1 }),
    executeJS: async () => ({
      url: 'https://example.com',
      title: 'T',
      timeOrigin: 1,
      mutationRevision: 0,
      frameDocumentToken: 'document-tab-1',
    }),
    beginBrowserWorkflowAction: ((input: { identity: unknown }) => ({
      actionId: `action-${++actionSeq}`,
      actionSeq,
      identity: input.identity,
    })) as BrowserController['beginBrowserWorkflowAction'],
    settleBrowserWorkflowAction: ((_taskId: string, actionId: string, outcome: unknown) => ({
      receiptId: `receipt-${actionId}`,
      outcome,
    })) as BrowserController['settleBrowserWorkflowAction'],
    recordBrowserWorkflowObservation: ((input: { operationId: string; ownerRunId: string; identity: unknown; resultDigest: string }) => ({
      receiptId: `observation-${++observationSeq}`,
      observationSeq,
      operationId: input.operationId,
      ownerRunId: input.ownerRunId,
      observedAfterActionSeq: actionSeq,
      identity: input.identity,
      searchActionId: null,
      queryDigest: null,
      causalActions: [],
      resultDigest: input.resultDigest,
      observedAt: new Date(0).toISOString(),
    })) as BrowserController['recordBrowserWorkflowObservation'],
    ...(overrides || {}),
  }
  return attachBrowserWorkflowFixture(mock as BrowserController).controller
}

function workflowContext(): NonNullable<Parameters<typeof executeBrowserTool>[8]> {
  return {
    ownerRunId: 'run-lease-test',
    browserTaskId: 'browser-task-lease-test',
    parentTaskId: 'parent-lease-test',
    inputSource: 'trusted_internal',
  }
}

function targetGate(input: { held?: boolean } = {}): BrowserTargetClaimGate {
  const service = createTargetClaimService()
  if (input.held !== false) {
    const claim = acquireTarget(service, {
      partition: 'persist:browser',
      tabId: 'tab-1',
      physicalTargetToken: 'physical-tab-1',
      bootIncarnationId: 'physical-tab-1',
      parentTaskId: 'parent-lease-test',
      browserTaskId: 'browser-task-lease-test',
      ownerRunId: 'run-lease-test',
    })
    return { service, surface: 'user-view', identity: identityOf(claim) }
  }
  return {
    service,
    surface: 'user-view',
    identity: {
      partition: 'persist:browser',
      tabId: 'tab-1',
      physicalTargetToken: 'physical-tab-1',
      bootIncarnationId: 'physical-tab-1',
      claimId: 'missing-claim',
      generation: 1,
      ownerRunId: 'run-lease-test',
    },
  }
}

// 73ba5299（audit roadmap closures）：拒绝路径从裸 JSON 字符串演进为结构化
// ToolExecutionOutput（CLAUDE.md「工具错误由 dispatch 层转成结构化
// ToolExecutionOutput」合同）；.text 仍携带同一 JSON 负载，语义字段不变。
function parseError(result: string | { text?: string; data?: Record<string, unknown> | null }) {
  if (typeof result !== 'string' && result?.data) return result.data
  const text = typeof result === 'string' ? result : String(result?.text ?? '')
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function errorKind(result: string | { text?: string; data?: Record<string, unknown> | null }): unknown {
  const parsed = parseError(result)
  return parsed?.errorKind || parsed?.errorCode
}

describe('lease gate integration on executeBrowserTool', () => {
  it('rejects page access without the canonical workflow route', async () => {
    const controller = createController()
    const out = await executeBrowserTool('browser_read', {}, controller)
    assert.equal(parseError(out)?.errorKind, 'browser_workflow_journal_required')
  })

  it('denies a write tool with lease_required when no target claim is held', async () => {
    const gate = targetGate({ held: false })
    const controller = createController()
    const out = await executeBrowserTool('browser_click', { x: 1, y: 1 }, controller, undefined, undefined, gate, undefined, undefined, workflowContext())
    const err = parseError(out)
    assert.ok(err, `expected structured error, got: ${out}`)
    assert.equal(errorKind(out), 'lease_required')
  })

  it('lets read tools through without a target claim (reads are free)', async () => {
    const gate = targetGate({ held: false })
    const controller = createController()
    const out = await executeBrowserTool('browser_read', {}, controller, undefined, undefined, gate, undefined, undefined, workflowContext())
    assert.equal(parseError(out)?.content, 'visible page text')
  })

  it('keeps structured collection observational and gates collection modes that scroll the page', async () => {
    const gate = targetGate({ held: false })
    const controller = createController({
    } as Partial<BrowserController>)

    const readOut = await executeBrowserTool('browser_collect', { mode: 'structured', fields: ['title'] }, controller, undefined, undefined, gate, undefined, undefined, workflowContext())
    assert.notEqual(errorKind(readOut), 'lease_required')

    const writeOut = await executeBrowserTool('browser_collect', { mode: 'visible' }, controller, undefined, undefined, gate, undefined, undefined, workflowContext())
    const err = parseError(writeOut)
    assert.ok(err, 'visible collection scrolls and must be gated')
    assert.equal(errorKind(writeOut), 'lease_required')
  })

  it('always gates browser_eval as a write-capable tool, even for read-looking code', async () => {
    const gate = targetGate({ held: false })
    const controller = createController()
    const out = await executeBrowserTool('browser_eval', { purpose: 'read title', code: 'document.title' }, controller, undefined, undefined, gate, undefined, undefined, workflowContext())
    const err = parseError(out)
    assert.ok(err)
    assert.equal(errorKind(out), 'lease_required')
  })

  it('permits a write with an exact target claim, then blocks it after user takeover', async () => {
    const gate = targetGate()
    // browser_navigate is a lightweight write (no slow verification path).
    const controller = createController({ goBack: () => ({ success: true }) } as Partial<BrowserController>)
    await browserSnapshotService.capture(
      controller,
      'tab-1',
      10_000,
      async () => ({ pageMap: { targets: [] } }),
      { force: true },
    )

    const ok = await executeBrowserTool('browser_navigate', { action: 'back' }, controller, undefined, undefined, gate, undefined, undefined, workflowContext())
    assert.equal(errorKind(ok), undefined, `write with a valid lease must pass: ${JSON.stringify(parseError(ok))}`)

    gate.service.recordUserSignal({
      target: gate.identity,
      source: 'keyboard',
      suspensionCheckpointId: 'checkpoint-takeover',
    })
    const blocked = await executeBrowserTool('browser_navigate', { action: 'back' }, controller, undefined, undefined, gate, undefined, undefined, workflowContext())
    const err = parseError(blocked)
    assert.ok(err)
    assert.equal(errorKind(blocked), 'lease_takeover')
  })
})
