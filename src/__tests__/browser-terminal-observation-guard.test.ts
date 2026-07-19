import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySession } from '@openai/agents'
import {
  executeAgentSdkModelToolLoop,
  type AgentSdkModelToolLoopState,
} from '../main/modules/agent-control/runtime-core/agent-sdk-turn-model-loop'
import { DeliveryOutputBuffer } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-output-buffer'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { TurnOrchestratorHost } from '../main/modules/agent-control/runtime-core/agent-sdk-turn-context'
import type {
  AgentSdkSession,
  RunHandle,
  ToolBridgeRuntimeContext,
} from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

const runId = 'run-browser-terminal-observation'
const taskId = 'task-browser-terminal-observation'
const browserTaskId = 'browser-task-terminal-observation'
const identity = {
  documentState: 'document' as const,
  tabId: 'tab-browser-terminal-observation',
  physicalTargetToken: 'physical-browser-terminal-observation',
  frameId: '0',
  frameDocumentToken: 'document-browser-terminal-observation',
  targetRef: null,
}
const outcome = {
  actionId: 'action-browser-terminal-observation',
  actionSeq: 1,
  taskId: browserTaskId,
  ownerRunId: runId,
  operationId: 'type_target' as const,
  mode: 'mutate' as const,
  dispatch: 'accepted' as const,
  delivery: 'delivered' as const,
  effect: 'unknown' as const,
  needsObservation: true,
  mayHaveCommitted: true,
  identity,
  successorIdentity: identity,
}

function runtimeContext(): ToolBridgeRuntimeContext {
  return {
    runId,
    taskId,
    browserWorkflowRoute: {
      browserTaskId,
      requestAnchorSnapshotDigest: 'anchor-browser-terminal-observation',
    },
    browserRequiredOperationIds: ['type_target'],
    lastEffectiveBrowserActionSeq: 1,
    browserObservationGaps: [],
    browserObservationBarrier: null,
    browserSuspensionRequest: null,
    activatedCapabilityGroups: ['browser'],
    latestResearchSearchDelivery: null,
    nativeMapCriticalClose: null,
    hostControl: 'owner',
  } as unknown as ToolBridgeRuntimeContext
}

function state(): AgentSdkModelToolLoopState {
  return {
    criteriaSelfCheckInjected: true,
    finalText: '',
    hasSuccessfulDocumentTargetMutation: false,
    hasSuccessfulLocalDocumentSourceRead: false,
    lastDocumentSaveFailure: null,
    lastDocumentSaveSuccessText: null,
    lastRollingCheckpointToolCalls: 0,
    liveTaskBudgetRuntime: null,
    newDocumentNeedsSave: false,
    nextInput: 'original request',
    runMetaBudgetRuntime: null,
    runMetaContinuationRef: null,
    runMetaUsage: null,
    sessionRestoreNotice: null,
  }
}

function unresolvedEvidence() {
  return {
    journal: {
      nextActionSeq: 2,
      nextObservationSeq: 1,
      activeAction: null,
      settledOutcomes: [{
        receiptId: 'receipt-browser-terminal-observation',
        actionId: outcome.actionId,
        actionSeq: outcome.actionSeq,
        settledAt: '2026-07-19T00:00:00.000Z',
        outcome,
      }],
      observationReceipts: [],
    },
    resources: [],
    researchState: 'not_requested',
    researchAssessment: null,
    unresolvedActions: [{
      receiptId: 'receipt-browser-terminal-observation',
      actionId: outcome.actionId,
      actionSeq: outcome.actionSeq,
      settledAt: '2026-07-19T00:00:00.000Z',
      outcome,
    }],
  }
}

function researchEvidence(satisfied: boolean) {
  const workItems = ['query-a', 'query-b', 'query-c'].map((workItemId, index) => ({
    workItemId,
    goalRefs: [],
    requirement: `collect ${workItemId}`,
    query: workItemId,
    url: null,
    fieldGoals: ['title', 'body'],
    required: true,
    evidenceRefIds: satisfied ? [`evidence-${index}`] : [],
    createdAt: '2026-07-19T00:00:00.000Z',
  }))
  return {
    journal: {
      nextActionSeq: 1,
      nextObservationSeq: 1,
      activeAction: null,
      settledOutcomes: [],
      observationReceipts: [],
    },
    resources: [],
    researchState: satisfied ? 'satisfied' as const : 'incomplete' as const,
    researchAssessment: {
      taskId: browserTaskId,
      satisfied,
      missingWorkItemIds: satisfied ? [] : workItems.map((item) => item.workItemId),
      workItems,
      evidenceRefs: [],
    },
    unresolvedActions: [],
  }
}

test('research-incomplete terminal candidate stays hidden and the same owner continues', async () => {
  const modelSession = new MemorySession({ sessionId: 'model-browser-research-incomplete' })
  const buffer = new DeliveryOutputBuffer()
  const context = runtimeContext()
  const loopState = state()
  loopState.liveTaskBudgetRuntime = createTaskBudgetRuntime('research')
  loopState.runMetaBudgetRuntime = loopState.liveTaskBudgetRuntime
  const inputs: unknown[] = []
  let calls = 0
  let satisfied = false
  const host = {
    runAgent: async ({ input, onTextDelta }: { input: unknown; onTextDelta: (text: string) => void }) => {
      calls += 1
      inputs.push(input)
      if (calls === 1) {
        onTextDelta('only one of three targets is done')
        return { finalText: 'only one of three targets is done', iterationsUsed: 1 }
      }
      satisfied = true
      onTextDelta('all three targets are done')
      return { finalText: 'all three targets are done', iterationsUsed: 1 }
    },
    readVerifiedBrowserWorkflowEvidence: () => researchEvidence(satisfied),
  } as unknown as TurnOrchestratorHost
  const definition = { name: 'browser_read' } as ToolDefinition

  const result = await executeAgentSdkModelToolLoop({
    state: loopState,
    host,
    name: 'butler',
    runId,
    taskId,
    sessionId: 'scope-browser-research-incomplete',
    pureUserTurnText: 'collect three independent targets',
    providerContent: 'collect three independent targets',
    useTextToolBridge: false,
    toolDefinitions: [definition],
    allowedToolNames: ['browser_read'],
    definitionByName: new Map([[definition.name, definition]]),
    toolBridgeRuntimeContext: context,
    documentTargetGuard: null,
    requiresLocalDocumentExcerpt: false,
    preferCurrentDocumentRead: false,
    requiresLocalDocumentWrite: false,
    runHandle: { capturedSession: modelSession } as RunHandle,
    modelSession,
    session: {} as AgentSdkSession,
    abortController: new AbortController(),
    instructions: 'system',
    model: 'model',
    provider: {} as never,
    sdkTools: [{} as never],
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_000,
    turnTaskType: 'research',
    requiredCapabilityGroups: ['browser'],
    usedTools: [],
    emitOutput: (chunk, type) => {
      if (type === 'text') buffer.append(chunk)
    },
    emitHeartbeat: () => undefined,
    candidateOutputBuffer: buffer,
    nativeTextToolBoundaryFlush: { current: null },
    finishBudgetCheckpointIfNeeded: async () => null,
    finishBrowserObservationCheckpoint: async () => {
      throw new Error('research progress should continue in the same run')
    },
    finishBrowserIncompleteCheckpoint: async () => {
      throw new Error('research progress should not checkpoint')
    },
    maybeHandleSkillClarificationGuard: async () => null,
    maybeHandleActionAnnouncementGuard: async () => null,
    finalizeEarlyReturn: async () => {
      throw new Error('early finalization should not be used')
    },
  })

  assert.equal(result, null)
  assert.equal(calls, 2)
  assert.equal(loopState.finalText, 'all three targets are done')
  assert.equal(buffer.snapshot(), 'all three targets are done')
  assert.ok(!buffer.snapshot().includes('only one'))
  assert.match(JSON.stringify(inputs[1]), /query-a/)
  assert.match(JSON.stringify(inputs[1]), /query-b/)
  assert.match(JSON.stringify(inputs[1]), /query-c/)
})

test('unrelated browser activity cannot postpone a stalled research checkpoint', async () => {
  const modelSession = new MemorySession({ sessionId: 'model-browser-research-stalled' })
  const buffer = new DeliveryOutputBuffer()
  const context = runtimeContext()
  const loopState = state()
  loopState.liveTaskBudgetRuntime = createTaskBudgetRuntime('research')
  loopState.runMetaBudgetRuntime = loopState.liveTaskBudgetRuntime
  let calls = 0
  let checkpointMessage = ''
  const checkpointResult = { status: 'checkpoint', terminalReason: 'checkpoint_incomplete' }
  const host = {
    runAgent: async () => {
      calls += 1
      return { finalText: `stalled candidate ${calls}`, iterationsUsed: 1 }
    },
    readVerifiedBrowserWorkflowEvidence: () => {
      const evidence = researchEvidence(false)
      return {
        ...evidence,
        journal: {
          ...evidence.journal,
          settledOutcomes: [{ actionId: `unrelated-action-${calls}` }],
          observationReceipts: [{ receiptId: `unrelated-observation-${calls}` }],
        },
        resources: [{ resourceId: `unrelated-resource-${calls}` }],
      }
    },
  } as unknown as TurnOrchestratorHost
  const definition = { name: 'browser_read' } as ToolDefinition

  const result = await executeAgentSdkModelToolLoop({
    state: loopState,
    host,
    name: 'butler',
    runId,
    taskId,
    sessionId: 'scope-browser-research-stalled',
    pureUserTurnText: 'collect three independent targets',
    providerContent: 'collect three independent targets',
    useTextToolBridge: false,
    toolDefinitions: [definition],
    allowedToolNames: ['browser_read'],
    definitionByName: new Map([[definition.name, definition]]),
    toolBridgeRuntimeContext: context,
    documentTargetGuard: null,
    requiresLocalDocumentExcerpt: false,
    preferCurrentDocumentRead: false,
    requiresLocalDocumentWrite: false,
    runHandle: { capturedSession: modelSession } as RunHandle,
    modelSession,
    session: {} as AgentSdkSession,
    abortController: new AbortController(),
    instructions: 'system',
    model: 'model',
    provider: {} as never,
    sdkTools: [{} as never],
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_000,
    turnTaskType: 'research',
    requiredCapabilityGroups: ['browser'],
    usedTools: [],
    emitOutput: (chunk, type) => {
      if (type === 'text') buffer.append(chunk)
    },
    emitHeartbeat: () => undefined,
    candidateOutputBuffer: buffer,
    nativeTextToolBoundaryFlush: { current: null },
    finishBudgetCheckpointIfNeeded: async () => null,
    finishBrowserObservationCheckpoint: async () => {
      throw new Error('observation checkpoint is unrelated')
    },
    finishBrowserIncompleteCheckpoint: async (message = '') => {
      checkpointMessage = message
      return checkpointResult as never
    },
    maybeHandleSkillClarificationGuard: async () => null,
    maybeHandleActionAnnouncementGuard: async () => null,
    finalizeEarlyReturn: async () => {
      throw new Error('generic early finalization should not be used')
    },
  })

  assert.equal(result, checkpointResult)
  assert.equal(calls, 3)
  assert.match(checkpointMessage, /没有新增页面证据/)
  assert.equal(buffer.snapshot(), '')
  assert.ok((loopState.liveTaskBudgetRuntime?.usage.iterationsUsed || 0) < 220)
})

test('terminal candidate stays hidden while the same owner performs one observation closure phase', async () => {
  const modelSession = new MemorySession({ sessionId: 'model-browser-terminal-observation' })
  const buffer = new DeliveryOutputBuffer()
  const context = runtimeContext()
  const loopState = state()
  const inputs: unknown[] = []
  let calls = 0
  let resolved = false
  const host = {
    runAgent: async ({ input, onTextDelta }: { input: unknown; onTextDelta: (text: string) => void }) => {
      calls += 1
      inputs.push(input)
      if (calls === 1) {
        onTextDelta('premature candidate')
        return { finalText: 'premature candidate', iterationsUsed: 1 }
      }
      assert.equal(context.runId, runId)
      assert.equal(context.taskId, taskId)
      assert.equal(context.browserWorkflowRoute?.browserTaskId, browserTaskId)
      resolved = true
      onTextDelta('verified candidate')
      return { finalText: 'verified candidate', iterationsUsed: 1 }
    },
    readVerifiedBrowserWorkflowEvidence: () => (
      resolved
        ? { ...unresolvedEvidence(), unresolvedActions: [] }
        : unresolvedEvidence()
    ),
  } as unknown as TurnOrchestratorHost
  const definition = { name: 'browser_read' } as ToolDefinition
  const result = await executeAgentSdkModelToolLoop({
    state: loopState,
    host,
    name: 'butler',
    runId,
    taskId,
    sessionId: 'scope-browser-terminal-observation',
    pureUserTurnText: 'original request',
    providerContent: 'original request',
    useTextToolBridge: false,
    toolDefinitions: [definition],
    allowedToolNames: ['browser_read'],
    definitionByName: new Map([[definition.name, definition]]),
    toolBridgeRuntimeContext: context,
    documentTargetGuard: null,
    requiresLocalDocumentExcerpt: false,
    preferCurrentDocumentRead: false,
    requiresLocalDocumentWrite: false,
    runHandle: { capturedSession: modelSession } as RunHandle,
    modelSession,
    session: {} as AgentSdkSession,
    abortController: new AbortController(),
    instructions: 'system',
    model: 'model',
    provider: {} as never,
    sdkTools: [{} as never],
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_000,
    turnTaskType: 'browser_transaction',
    requiredCapabilityGroups: ['browser'],
    usedTools: [],
    emitOutput: (chunk, type) => {
      if (type === 'text') buffer.append(chunk)
    },
    emitHeartbeat: () => undefined,
    candidateOutputBuffer: buffer,
    nativeTextToolBoundaryFlush: { current: null },
    finishBudgetCheckpointIfNeeded: async () => null,
    finishBrowserObservationCheckpoint: async () => {
      throw new Error('observation checkpoint should not be needed')
    },
    finishBrowserIncompleteCheckpoint: async () => {
      throw new Error('research checkpoint should not be needed')
    },
    maybeHandleSkillClarificationGuard: async () => null,
    maybeHandleActionAnnouncementGuard: async () => null,
    finalizeEarlyReturn: async () => {
      throw new Error('early finalization should not be used')
    },
  })

  assert.equal(result, null)
  assert.equal(calls, 2)
  assert.equal(loopState.finalText, 'verified candidate')
  assert.equal(buffer.snapshot(), 'verified candidate')
  assert.ok(!buffer.snapshot().includes('premature'))
  const closureInput = inputs[1] as Array<{ role?: string; content?: string }>
  assert.equal(closureInput.length, 1, 'the original user request must not be duplicated')
  assert.equal(closureInput[0]?.role, 'system')
  assert.match(String(closureInput[0]?.content || ''), /action-browser-terminal-observation/)
  assert.doesNotMatch(String(closureInput[0]?.content || ''), /browser_snapshot/)
})

test('text bridge gets one bounded synthesis turn after the observation result at its normal turn limit', async () => {
  const modelSession = new MemorySession({ sessionId: 'model-browser-terminal-observation-text' })
  const buffer = new DeliveryOutputBuffer()
  const context = runtimeContext()
  const loopState = state()
  const budget = createTaskBudgetRuntime('browser_transaction')
  budget.budget.maxIterations = 1
  loopState.liveTaskBudgetRuntime = budget
  loopState.runMetaBudgetRuntime = budget
  const calls: Array<{ input: unknown; maxTurns: number; tools: unknown[] }> = []
  let resolved = false
  let budgetChecks = 0
  const host = {
    runAgent: async ({ input, maxTurns, tools }: {
      input: unknown
      maxTurns: number
      tools: unknown[]
    }) => {
      calls.push({ input, maxTurns, tools })
      if (calls.length === 1) {
        return { finalText: 'premature text-bridge candidate', iterationsUsed: 1 }
      }
      if (calls.length === 2) {
        return {
          finalText: [
            ':::tool_call',
            '{"tool":"browser_read","args":{"target_id":"page"}}',
            ':::',
          ].join('\n'),
          iterationsUsed: 1,
        }
      }
      assert.match(String(input), /fresh observation result/)
      return { finalText: 'verified text-bridge candidate', iterationsUsed: 1 }
    },
    readVerifiedBrowserWorkflowEvidence: () => (
      resolved
        ? { ...unresolvedEvidence(), unresolvedActions: [] }
        : unresolvedEvidence()
    ),
    toolExecutor: {
      executeReadyToolDefinition: async () => {
        resolved = true
        return createToolExecutionOutput('fresh observation result', {
          shape: 'json',
          data: { pageState: 'verified' },
        })
      },
    },
  } as unknown as TurnOrchestratorHost
  const definition = { name: 'browser_read' } as ToolDefinition
  const result = await executeAgentSdkModelToolLoop({
    state: loopState,
    host,
    name: 'butler',
    runId,
    taskId,
    sessionId: 'scope-browser-terminal-observation-text',
    pureUserTurnText: 'original request',
    providerContent: 'original request',
    useTextToolBridge: true,
    toolDefinitions: [definition],
    allowedToolNames: ['browser_read'],
    definitionByName: new Map([[definition.name, definition]]),
    toolBridgeRuntimeContext: context,
    documentTargetGuard: null,
    requiresLocalDocumentExcerpt: false,
    preferCurrentDocumentRead: false,
    requiresLocalDocumentWrite: false,
    runHandle: { capturedSession: modelSession } as RunHandle,
    modelSession,
    session: {} as AgentSdkSession,
    abortController: new AbortController(),
    instructions: 'system',
    model: 'model',
    provider: {} as never,
    sdkTools: [{} as never],
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_000,
    turnTaskType: 'browser_transaction',
    requiredCapabilityGroups: ['browser'],
    usedTools: [],
    emitOutput: (chunk, type) => {
      if (type === 'text') buffer.append(chunk)
    },
    emitHeartbeat: () => undefined,
    candidateOutputBuffer: buffer,
    nativeTextToolBoundaryFlush: { current: null },
    finishBudgetCheckpointIfNeeded: async () => {
      budgetChecks += 1
      return null
    },
    finishBrowserObservationCheckpoint: async () => {
      throw new Error('observation checkpoint should not be needed')
    },
    finishBrowserIncompleteCheckpoint: async () => {
      throw new Error('research checkpoint should not be needed')
    },
    maybeHandleSkillClarificationGuard: async () => null,
    maybeHandleActionAnnouncementGuard: async () => null,
    finalizeEarlyReturn: async () => {
      throw new Error('early finalization should not be used')
    },
  })

  assert.equal(result, null)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map((call) => call.maxTurns), [1, 1, 1])
  assert.deepEqual(calls.map((call) => call.tools.length), [1, 1, 0])
  assert.equal(budgetChecks, 1, 'bounded observation closure must not be preempted by the exhausted normal budget')
  assert.equal(loopState.finalText, 'verified text-bridge candidate')
  assert.equal(buffer.snapshot(), 'verified text-bridge candidate')
  assert.ok(!buffer.snapshot().includes('premature'))
  assert.match(JSON.stringify(calls[1]?.input), /action-browser-terminal-observation/)
  assert.doesNotMatch(JSON.stringify(calls[1]?.input), /original request/)
  assert.match(String(calls[2]?.input), /\[tool_result\]/)
})
