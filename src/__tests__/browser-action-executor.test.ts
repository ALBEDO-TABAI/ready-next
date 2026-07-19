import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BrowserActionExecutor,
  interactionSignalFromResult,
  normalizeBareBrowserToolError,
  type BrowserWorkflowJournalPort,
} from '../main/modules/tools/browser-action-executor'
import { browserMutationController } from '../main/modules/tools/browser-mutation-controller'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { BrowserActionOutcome } from '../shared/browser-action-outcome'

const DOCUMENT_IDENTITY = {
  documentState: 'document' as const,
  tabId: 'tab-1',
  physicalTargetToken: 'physical-1',
  frameId: '0',
  frameDocumentToken: 'document-1',
  targetRef: null,
}

const resolveDocumentIdentity = () => DOCUMENT_IDENTITY

function outputData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
  }
  const output = value as { data?: Record<string, unknown>; text?: string }
  if (output.data) return output.data
  try { return JSON.parse(String(output.text || '{}')) as Record<string, unknown> } catch { return {} }
}

function journal(events: string[] = []): BrowserWorkflowJournalPort & {
  outcomes: BrowserActionOutcome[]
  observations: Array<{ operationId: string; resultDigest: string }>
} {
  let sequence = 0
  let searchActionId: string | null = null
  const outcomes: BrowserActionOutcome[] = []
  const observations: Array<{ operationId: string; resultDigest: string }> = []
  return {
    taskId: 'browser-workflow-1',
    ownerRunId: 'run-1',
    outcomes,
    observations,
    beginAction(input) {
      sequence += 1
      if (input.operationId === 'search') searchActionId ||= 'search-1'
      events.push(`begin:${sequence}`)
      return {
        actionId: `action-${sequence}`,
        actionSeq: sequence,
        identity: input.identity,
        ...(searchActionId ? { searchActionId } : {}),
      }
    },
    settleAction(actionId, outcome) {
      events.push(`settle:${actionId}`)
      outcomes.push(outcome)
      return { receiptId: `receipt-${actionId}`, outcome }
    },
    recordObservation(input) {
      observations.push({ operationId: input.operationId, resultDigest: input.resultDigest })
      return {
        receiptId: 'observation-1',
        observationSeq: 1,
        operationId: input.operationId,
        ownerRunId: 'run-1',
        observedAfterActionSeq: sequence,
        identity: input.identity,
        searchActionId: null,
        queryDigest: null,
        causalActions: [],
        resultDigest: input.resultDigest,
        resourceId: 'resource-observation-1',
        observedAt: new Date().toISOString(),
      }
    },
  }
}

test('unknown browser tools are rejected before dispatch', async () => {
  let dispatched = false
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_read_page',
    args: {},
    dispatch: async () => {
      dispatched = true
      return 'unexpected'
    },
  })
  assert.equal(dispatched, false)
  assert.equal(outputData(result).errorKind, 'tool_not_registered')
})

test('a rejected preparation performs no journal write and no transport', async () => {
  const events: string[] = []
  let transports = 0
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 10, y: 20 },
    journal: journal(events),
    resolveTargetIdentity: resolveDocumentIdentity,
    prepare: async () => JSON.stringify({ ok: false, errorKind: 'dialog_open' }),
    dispatch: async (_invocation, _signal, boundary) => {
      boundary.invokeTransport(() => { transports += 1 })
      return JSON.stringify({ ok: true })
    },
  })
  assert.equal(outputData(result).errorKind, 'dialog_open')
  assert.equal(outputData(result).operationId, 'click_coordinate')
  assert.equal(transports, 0)
  assert.deepEqual(events, [])
})

test('durable begin, start event and physical transport share one ordered boundary', async () => {
  const events: string[] = []
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 10, y: 20 },
    journal: journal(events),
    resolveTargetIdentity: resolveDocumentIdentity,
    onEvent: (event) => events.push(`${event.phase}:${event.actionId || 'none'}`),
    dispatch: async (_invocation, _signal, boundary) => {
      boundary.invokeTransport(() => events.push('transport'))
      boundary.recordMechanicalFact({ delivery: 'delivered' })
      return JSON.stringify({ ok: true })
    },
  })
  assert.deepEqual(events.slice(0, 3), ['begin:1', 'start:action-1', 'transport'])
  assert.equal(events[3], 'settle:action-1')
  const data = outputData(result)
  assert.equal(data.operationId, 'click_coordinate')
  assert.equal(data.actionId, 'action-1')
  assert.equal(data.actionSeq, 1)
  assert.equal((data.browserActionOutcome as BrowserActionOutcome).delivery, 'delivered')
})

test('typed ok:false is journaled as rejected and legacy prose is not reclassified', async () => {
  const port = journal()
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    journal: port,
    resolveTargetIdentity: resolveDocumentIdentity,
    dispatch: async (_invocation, _signal, boundary) => {
      boundary.invokeTransport(() => undefined)
      return JSON.stringify({ ok: false, errorKind: 'target_not_found' })
    },
  })
  const outcome = outputData(result).browserActionOutcome as BrowserActionOutcome
  assert.equal(outcome.dispatch, 'rejected')
  assert.equal(outcome.mayHaveCommitted, false)
  assert.equal(normalizeBareBrowserToolError('Error: permission denied'), 'Error: permission denied')
  assert.equal(interactionSignalFromResult('登录后才能继续').loginWall, false)
})

test('search persists fill and submit as distinct actions under one search id', async () => {
  const port = journal()
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_search',
    args: { query: 'neutral query' },
    journal: port,
    resolveTargetIdentity: resolveDocumentIdentity,
    dispatch: async (_invocation, _signal, boundary) => {
      await boundary.runSearchStep('fill', async () => {
        const value = await boundary.invokeTransport(async () => ({ ok: true }))
        boundary.recordMechanicalFact({ delivery: 'delivered' })
        return value
      })
      await boundary.runSearchStep('submit', async () => {
        const value = await boundary.invokeTransport(async () => ({ ok: true }))
        boundary.recordMechanicalFact({ delivery: 'delivered' })
        return value
      })
      return JSON.stringify({ ok: true, submitted: true })
    },
  })
  assert.equal(port.outcomes.length, 2)
  assert.equal(port.outcomes[0].actionId, 'action-1')
  assert.equal(port.outcomes[1].actionId, 'action-2')
  assert.equal(port.outcomes[0].search?.searchActionId, 'search-1')
  assert.equal(port.outcomes[1].search?.searchActionId, 'search-1')
  assert.match(port.outcomes[1].search?.queryDigest || '', /^[a-f0-9]{64}$/)
  assert.equal(port.outcomes[1].mayHaveCommitted, true)
  assert.equal(port.outcomes[1].search?.phase, 'submitted_needs_observation')
  const data = outputData(result)
  assert.equal(data.actionId, 'action-2')
  assert.equal((data.browserActionOutcome as BrowserActionOutcome).search?.fillActionId, 'action-1')
  assert.equal((data.browserActionOutcome as BrowserActionOutcome).search?.submitActionId, 'action-2')
})

test('deadline drains a briefly non-cooperative dispatch before returning', async () => {
  let writes = 0
  const startedAt = Date.now()
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    journal: journal(),
    resolveTargetIdentity: resolveDocumentIdentity,
    deadlineMs: 5,
    abortDrainMs: 100,
    dispatch: async (_invocation, _signal, boundary) => {
      boundary.invokeTransport(() => { writes += 1 })
      await new Promise((resolve) => setTimeout(resolve, 35))
      return JSON.stringify({ ok: true })
    },
  })
  const data = outputData(result)
  assert.equal(data.errorKind, 'browser_deadline_exceeded')
  assert.equal(data.abortDrained, true)
  assert.equal(data.writesAfterReturn, 0)
  assert.ok(Date.now() - startedAt >= 30)
  assert.equal(writes, 1)
})

test('a timed-out transport drains before the public result and later writes stay fenced', async () => {
  let lateError: unknown = null
  let writes = 0
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    journal: journal(),
    resolveTargetIdentity: resolveDocumentIdentity,
    deadlineMs: 5,
    abortDrainMs: 10,
    dispatch: async (_invocation, _signal, boundary) => {
      boundary.invokeTransport(() => { writes += 1 })
      await new Promise((resolve) => setTimeout(resolve, 25))
      try {
        boundary.invokeTransport(() => { writes += 1 })
      } catch (error) {
        lateError = error
      }
      return JSON.stringify({ ok: true })
    },
  })
  const data = outputData(result)
  assert.equal(data.abortDrained, true)
  assert.equal(data.ownershipRetained, false)
  assert.equal(data.writesAfterReturn, 0)
  assert.equal(data.guardedTransportWritesAfterReturn, 0)
  assert.equal(writes, 1)
  assert.equal((lateError as { code?: string })?.code, 'browser_action_fenced')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(writes, 1, 'no page write may appear after the public result')
})

test('management operations need no journal while page-bound work does', async () => {
  const status = await new BrowserActionExecutor().execute({
    toolName: 'browser_status',
    args: {},
    dispatch: async () => JSON.stringify({ ok: true }),
  })
  assert.equal(outputData(status).operationId, 'status')

  const read = await new BrowserActionExecutor().execute({
    toolName: 'browser_read',
    args: {},
    dispatch: async () => 'unreachable',
  })
  assert.equal(outputData(read).errorKind, 'browser_workflow_journal_required')
  assert.equal(outputData(read).operationId, 'read')
})

test('opaque legacy strings remain readable without being reclassified', async () => {
  for (const text of ['plain success body', 'Error: opaque failure', '未知语言の読み取り']) {
    const result = await new BrowserActionExecutor().execute({
      toolName: 'browser_read',
      args: {},
      journal: journal(),
      resolveTargetIdentity: resolveDocumentIdentity,
      dispatch: async () => text,
    })
    const data = outputData(result)
    assert.equal(data.opaqueOriginalText, text)
    assert.equal(data.operationId, 'read')
    assert.equal(data.ok, undefined)
  }
})

test('a mutate leaf that invokes no real transport fails closed', async () => {
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    journal: journal(),
    resolveTargetIdentity: resolveDocumentIdentity,
    dispatch: async () => JSON.stringify({ ok: true }),
  })
  assert.equal(outputData(result).errorKind, 'browser_mutation_transport_not_invoked')
})

test('installing an input delivery probe is not a semantic transport', async () => {
  const controller = {
    executeJS: async () => 'probe-token',
  } as unknown as BrowserController
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    journal: journal(),
    resolveTargetIdentity: resolveDocumentIdentity,
    dispatch: async (_invocation, _signal, boundary) => {
      const guarded = browserMutationController(controller, 'click_coordinate', boundary)
      await guarded.executeJS(null, '(() => { const __READY_AGENT_INPUT_DELIVERY_PROBE__ = true; return "token" })()')
      return JSON.stringify({ ok: true })
    },
  })
  assert.equal(outputData(result).errorKind, 'browser_mutation_transport_not_invoked')
})

test('exact-target backend probes stay read-only until the physical input transport', async () => {
  const events: string[] = []
  const controller = {
    callFunctionOnBackendNode: async () => {
      events.push('target_probe')
      return { ok: true }
    },
    typeTextDirectly: async () => {
      events.push('text_transport')
    },
  } as unknown as BrowserController
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_type',
    args: { target_id: 'target-1', text: 'value' },
    journal: journal(events),
    resolveTargetIdentity: resolveDocumentIdentity,
    dispatch: async (_invocation, _signal, boundary) => {
      const guarded = browserMutationController(controller, 'type_target', boundary)
      await guarded.callFunctionOnBackendNode(
        'tab-1',
        42,
        'function () { const __READY_AGENT_TARGET_FOCUS__ = true; return { ok: true }; }',
        [],
      )
      await guarded.typeTextDirectly('tab-1', 'value')
      return JSON.stringify({ ok: true })
    },
  })
  assert.equal(outputData(result).outcome !== undefined, true)
  assert.deepEqual(events.slice(0, 3), ['target_probe', 'begin:1', 'text_transport'])
})

test('failed or cached observations never create a receipt', async () => {
  const identity = DOCUMENT_IDENTITY
  const port = journal()
  for (const value of [
    { ok: false, errorKind: 'page_error' },
    { ok: true, observationFresh: false, content: 'cached' },
  ]) {
    await new BrowserActionExecutor().execute({
      toolName: 'browser_read',
      args: {},
      journal: port,
      resolveTargetIdentity: () => identity,
      dispatch: async () => JSON.stringify(value),
    })
  }
  assert.equal(port.observations.length, 0)
  await new BrowserActionExecutor().execute({
    toolName: 'browser_read',
    args: {},
    journal: port,
    resolveTargetIdentity: () => identity,
    dispatch: async () => JSON.stringify({ ok: true, observationFresh: true, content: 'fresh' }),
  })
  assert.equal(port.observations.length, 1)
})

test('workflow metadata results never masquerade as page observation receipts', async () => {
  const port = journal()
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_research',
    args: { action: 'complete' },
    journal: port,
    resolveTargetIdentity: resolveDocumentIdentity,
    dispatch: async () => JSON.stringify({ ok: true, satisfied: true }),
  })
  assert.equal(outputData(result).operationId, 'research_complete')
  assert.equal(port.observations.length, 0)
})

test('deadline settlement does not wait on an unbounded successor probe', async () => {
  const startedAt = Date.now()
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    journal: journal(),
    deadlineMs: 5,
    abortDrainMs: 5,
    identityProbeTimeoutMs: 5,
    resolveTargetIdentity: (phase) => phase === 'predecessor'
      ? { documentState: 'document' as const, tabId: 'tab-1', physicalTargetToken: 'p1', frameId: '0', frameDocumentToken: 'd1', targetRef: null }
      : new Promise(() => {}),
    dispatch: async (_invocation, _signal, boundary) => {
      boundary.invokeTransport(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return JSON.stringify({ ok: true })
    },
  })
  assert.equal(outputData(result).errorKind, 'browser_deadline_exceeded')
  assert.ok(Date.now() - startedAt < 100)
})

test('a typed followed tab becomes the settled successor identity', async () => {
  const port = journal()
  await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1, tab_id: 'tab-1' },
    journal: port,
    resolveTargetIdentity: (phase, hint) => ({
      documentState: 'document' as const,
      tabId: phase === 'successor' ? hint?.tabId || 'tab-1' : 'tab-1',
      physicalTargetToken: phase === 'successor' && hint?.tabId === 'tab-popup' ? 'popup-physical' : 'physical-1',
      frameId: '0',
      frameDocumentToken: phase === 'successor' && hint?.tabId === 'tab-popup' ? 'popup-document' : 'document-1',
      targetRef: null,
    }),
    dispatch: async (_invocation, _signal, boundary) => {
      boundary.invokeTransport(() => undefined)
      boundary.recordMechanicalFact({
        delivery: 'delivered',
        effect: 'popup',
        postActionTabId: 'tab-popup',
      })
      return JSON.stringify({ ok: true })
    },
  })
  assert.equal(port.outcomes[0].successorIdentity.tabId, 'tab-popup')
  assert.equal(port.outcomes[0].successorIdentity.physicalTargetToken, 'popup-physical')
})
