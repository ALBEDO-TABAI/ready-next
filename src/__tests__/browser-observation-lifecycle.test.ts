import test from 'node:test'
import assert from 'node:assert/strict'
import type { ToolBridgeRuntimeContext } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import type { BrowserActionTargetIdentity } from '../shared/browser-action-outcome'
import {
  recordBrowserWorkflowToolResult,
  syncBrowserObservationGapsFromJournal,
} from '../main/modules/agent-control/runtime-core/agent-sdk-browser-turn-control'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { normalizeToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

const runId = 'run-observation-lifecycle'
const browserTaskId = 'browser-task-observation-lifecycle'
const identity = {
  documentState: 'document' as const,
  tabId: 'tab-observation-lifecycle',
  physicalTargetToken: 'physical-observation-lifecycle',
  frameId: '0',
  frameDocumentToken: 'document-observation-lifecycle',
  targetRef: 'target-observation-lifecycle',
}
const successorIdentity = { ...identity, targetRef: null }

function runtimeContext(): ToolBridgeRuntimeContext {
  return {
    runId,
    browserWorkflowRoute: {
      browserTaskId,
      requestAnchorSnapshotDigest: 'anchor-observation-lifecycle',
    },
    browserRequiredOperationIds: [],
    lastEffectiveBrowserActionSeq: 0,
    browserObservationGaps: [],
    browserObservationBarrier: null,
    activatedCapabilityGroups: ['browser'],
  } as unknown as ToolBridgeRuntimeContext
}

function deliveredOutcome(actionSeq = 1) {
  return {
    actionId: `action-${actionSeq}`,
    actionSeq,
    taskId: browserTaskId,
    ownerRunId: runId,
    operationId: 'type_target',
    mode: 'mutate',
    dispatch: 'accepted',
    delivery: 'delivered',
    effect: 'unknown',
    needsObservation: true,
    mayHaveCommitted: true,
    identity,
    successorIdentity,
  }
}

test('settled browser mutation creates a journal-shaped observation barrier and causal readback clears it', () => {
  const context = runtimeContext()
  const outcome = deliveredOutcome()
  recordBrowserWorkflowToolResult(context, 'browser_type', {
    ok: true,
    operationId: 'type_target',
    browserActionOutcome: outcome,
  })
  assert.equal(context.browserObservationBarrier?.actionId, outcome.actionId)
  assert.equal(context.lastEffectiveBrowserActionSeq, 1)

  recordBrowserWorkflowToolResult(context, 'browser_read', {
    ok: true,
    operationId: 'read',
    browserObservationReceipt: {
      observationSeq: 1,
      operationId: 'read',
      ownerRunId: runId,
      identity: { ...successorIdentity, frameDocumentToken: 'wrong-document' },
      causalActions: [{
        actionId: outcome.actionId,
        actionSeq: outcome.actionSeq,
        predecessorIdentity: identity,
        successorIdentity,
      }],
    },
  })
  assert.equal(context.browserObservationBarrier?.actionId, outcome.actionId)

  recordBrowserWorkflowToolResult(context, 'browser_read', {
    ok: true,
    operationId: 'read',
    browserObservationReceipt: {
      observationSeq: 2,
      operationId: 'read',
      ownerRunId: runId,
      identity: successorIdentity,
      causalActions: [{
        actionId: outcome.actionId,
        actionSeq: outcome.actionSeq,
        predecessorIdentity: identity,
        successorIdentity,
      }],
    },
  })
  assert.equal(context.browserObservationBarrier, null)
  assert.deepEqual(context.browserObservationGaps, [])
})

test('definitively rejected mutation does not create an observation barrier', () => {
  const context = runtimeContext()
  const outcome = {
    ...deliveredOutcome(),
    dispatch: 'rejected',
    delivery: 'not_delivered',
    needsObservation: false,
    mayHaveCommitted: false,
  }
  recordBrowserWorkflowToolResult(context, 'browser_type', {
    ok: false,
    operationId: 'type_target',
    browserActionOutcome: outcome,
  })
  assert.equal(context.browserObservationBarrier, null)
})

test('a later read clears a tabs_open gap only for the exact durably recorded tab', () => {
  const context = runtimeContext()
  const noDocumentIdentity = {
    documentState: 'no_document' as const,
    tabId: null,
    physicalTargetToken: null,
    frameId: null,
    frameDocumentToken: null,
    targetRef: null,
  }
  const openOutcome = {
    actionId: 'action-open-weather',
    actionSeq: 1,
    taskId: browserTaskId,
    ownerRunId: runId,
    operationId: 'tabs_open',
    mode: 'mutate',
    dispatch: 'accepted',
    delivery: 'delivered',
    effect: 'observed',
    needsObservation: false,
    mayHaveCommitted: true,
    identity: noDocumentIdentity,
    successorIdentity: noDocumentIdentity,
    postActionTabId: 'tab-weather',
  }
  recordBrowserWorkflowToolResult(context, 'browser_tabs', {
    ok: true,
    operationId: 'tabs_open',
    browserActionOutcome: openOutcome,
  })
  assert.equal(context.browserObservationBarrier?.actionId, openOutcome.actionId)

  const observation = (tabId: string, observationSeq: number) => ({
    ok: true,
    operationId: 'read',
    browserObservationReceipt: {
      observationSeq,
      operationId: 'read',
      ownerRunId: runId,
      identity: { ...successorIdentity, tabId },
      causalActions: [{
        actionId: openOutcome.actionId,
        actionSeq: openOutcome.actionSeq,
        predecessorIdentity: noDocumentIdentity,
        successorIdentity: { ...successorIdentity, tabId },
      }],
    },
  })
  recordBrowserWorkflowToolResult(context, 'browser_read', observation('tab-other', 1))
  assert.equal(context.browserObservationBarrier?.actionId, openOutcome.actionId)

  recordBrowserWorkflowToolResult(context, 'browser_read', observation('tab-weather', 2))
  assert.equal(context.browserObservationBarrier, null)
})

test('a tabs_open successor probe fallback from a complete page clears only for the created tab', () => {
  const context = runtimeContext()
  const openOutcome = {
    actionId: 'action-open-from-foreground',
    actionSeq: 1,
    taskId: browserTaskId,
    ownerRunId: runId,
    operationId: 'tabs_open',
    mode: 'mutate',
    dispatch: 'accepted',
    delivery: 'delivered',
    effect: 'observed',
    needsObservation: false,
    mayHaveCommitted: true,
    identity,
    successorIdentity: identity,
    postActionTabId: 'tab-created-from-foreground',
  }
  recordBrowserWorkflowToolResult(context, 'browser_tabs', {
    ok: true,
    operationId: 'tabs_open',
    browserActionOutcome: openOutcome,
  })
  assert.equal(context.browserObservationBarrier?.actionId, openOutcome.actionId)

  const observation = (
    observedIdentity: BrowserActionTargetIdentity,
    observationSeq: number,
  ) => {
    return {
      ok: true,
      operationId: 'read',
      browserObservationReceipt: {
        observationSeq,
        operationId: 'read',
        ownerRunId: runId,
        identity: observedIdentity,
        causalActions: [{
          actionId: openOutcome.actionId,
          actionSeq: openOutcome.actionSeq,
          predecessorIdentity: identity,
          successorIdentity: observedIdentity,
        }],
      },
    }
  }
  recordBrowserWorkflowToolResult(context, 'browser_read', observation(identity, 1))
  assert.equal(context.browserObservationBarrier?.actionId, openOutcome.actionId)

  recordBrowserWorkflowToolResult(context, 'browser_read', observation({
    ...successorIdentity,
    tabId: 'tab-created-from-foreground',
    physicalTargetToken: 'physical-tab-created-from-foreground',
    frameDocumentToken: 'document-tab-created-from-foreground',
  }, 2))
  assert.equal(context.browserObservationBarrier, null)
})

test('recovery derives unresolved observations from journal truth even below the checkpoint cursor', () => {
  const context = runtimeContext()
  context.lastEffectiveBrowserActionSeq = 7
  const outcome = deliveredOutcome(1)
  syncBrowserObservationGapsFromJournal(context, [{
    actionId: outcome.actionId,
    actionSeq: outcome.actionSeq,
    outcome,
  }])
  assert.equal(context.lastEffectiveBrowserActionSeq, 7)
  assert.equal(context.browserObservationBarrier?.actionSeq, 1)
})

test('executor resolves mixed browser tool arguments before enforcing the observe-only barrier', async () => {
  let browserDispatches = 0
  const output = await executeToolCall('browser_dialog', { action: 'accept' }, {
    browserController: {
      getActiveTab: () => ({ id: identity.tabId, url: 'https://example.test/' }),
      getTabList: () => [{ id: identity.tabId, url: 'https://example.test/' }],
      acceptDialog: async () => {
        browserDispatches += 1
        return { ok: true }
      },
    },
    browserWorkflowRoute: {
      browserTaskId,
      requestAnchorSnapshotDigest: 'anchor-observation-lifecycle',
    },
    browserObservationBarrier: {
      actionId: 'action-1',
      actionSeq: 1,
      operationId: 'type_target',
      outcome: deliveredOutcome(),
      clearedByObservationSeq: null,
    },
    allowedToolNames: ['browser_dialog'],
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    abortSignal: new AbortController().signal,
    scopeId: 'scope-observation-lifecycle',
    sessionId: 'scope-observation-lifecycle',
    runId,
    taskId: 'parent-observation-lifecycle',
    parentTaskId: 'parent-observation-lifecycle',
    agent: 'butler',
    invoker: 'host',
  } as never)
  const normalized = normalizeToolExecutionOutput(output)
  assert.equal(normalized.data.errorKind, 'browser_observation_required')
  assert.equal(normalized.data.operationId, 'dialog_accept')
  assert.equal(browserDispatches, 0)
})

test('the observation response stays observe-only after its first read clears the journal barrier', async () => {
  let browserDispatches = 0
  const output = await executeToolCall('browser_dialog', { action: 'accept' }, {
    browserController: {
      getActiveTab: () => ({ id: identity.tabId, url: 'https://example.test/' }),
      getTabList: () => [{ id: identity.tabId, url: 'https://example.test/' }],
      acceptDialog: async () => {
        browserDispatches += 1
        return { ok: true }
      },
    },
    browserWorkflowRoute: {
      browserTaskId,
      requestAnchorSnapshotDigest: 'anchor-observation-lifecycle',
    },
    browserObservationBarrier: null,
    browserObservationClosureActive: true,
    allowedToolNames: ['browser_dialog'],
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    abortSignal: new AbortController().signal,
    scopeId: 'scope-observation-lifecycle',
    sessionId: 'scope-observation-lifecycle',
    runId,
    taskId: 'parent-observation-lifecycle',
    parentTaskId: 'parent-observation-lifecycle',
    agent: 'butler',
    invoker: 'host',
  } as never)
  const normalized = normalizeToolExecutionOutput(output)
  assert.equal(normalized.data.errorKind, 'browser_observation_required')
  assert.equal(normalized.data.operationId, 'dialog_accept')
  assert.equal(browserDispatches, 0)
})
