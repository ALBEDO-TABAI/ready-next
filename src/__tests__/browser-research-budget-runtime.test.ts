import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentSdkToolResultRecorder } from '../main/modules/agent-control/runtime-core/agent-sdk-turn-tool-result-recorder'
import type { AgentSdkPreparedTurnState } from '../main/modules/agent-control/runtime-core/agent-sdk-turn-execution-types'
import type { ToolBridgeRuntimeContext } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import {
  createRunBudgetSeed,
  createTaskBudgetRuntime,
  ensureLongRunningTaskBudgetCapacity,
} from '../main/modules/agent-control/task-projection/run-budget-policy'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

function preparedState(): AgentSdkPreparedTurnState {
  return {
    actionAnnouncementSteered: false,
    criteriaSelfCheckInjected: false,
    fileReadExcerptCheckpointForRecovery: null,
    finalText: '',
    hasSuccessfulDocumentTargetMutation: false,
    hasSuccessfulLocalDocumentSourceRead: false,
    hasSuccessfulLocalDocumentSourceReadForRecovery: false,
    hasSuccessfulToolProgress: false,
    lastDocumentSaveFailure: null,
    lastDocumentSaveSuccessText: null,
    lastRollingCheckpointToolCalls: 0,
    longSkillCheckpoint: null,
    newDocumentNeedsSave: false,
    observedDocumentMutationConflict: false,
    observedDocumentMutationMissingTarget: false,
    observedDocumentMutationTarget: null,
    runMetaBudgetRuntime: null,
    runMetaContinuationRef: null,
    runMetaProviderDiagnostics: null,
    runMetaUsage: null,
    sessionRestoreNotice: null,
    skillClarificationSteered: false,
  }
}

test('durable browser research promotes a browser bootstrap budget in the same run', () => {
  const state = preparedState()
  const bootstrap = ensureLongRunningTaskBudgetCapacity(createTaskBudgetRuntime('short_task', {
    budget: createRunBudgetSeed('short_task'),
    bootstrapBudget: true,
  }))
  let liveBudget = bootstrap
  const runtimeContext = {
    runId: 'run-browser-research-budget',
    taskId: 'task-browser-research-budget',
    browserWorkflowRoute: {
      browserTaskId: 'browser-task-research-budget',
      requestAnchorSnapshotDigest: 'anchor-browser-research-budget',
    },
    browserRequiredOperationIds: [],
    lastEffectiveBrowserActionSeq: 0,
    browserObservationGaps: [],
    browserObservationBarrier: null,
    browserSuspensionRequest: null,
    activatedCapabilityGroups: ['browser'],
    taskBudgetRuntime: bootstrap,
  } as unknown as ToolBridgeRuntimeContext
  const projectionPatches: Record<string, unknown>[] = []
  let researchRequested = false
  const recorder = createAgentSdkToolResultRecorder({
    runtimeContext: () => runtimeContext,
    state,
    syncBefore: () => undefined,
    syncAfter: () => undefined,
    setLiveTaskBudgetRuntime: (runtime) => { liveBudget = runtime },
    usedTools: [],
    projectionPatches,
    taskProofSink: null,
    host: {
      readVerifiedBrowserWorkflowEvidence: () => ({
        journal: {
          nextActionSeq: 1,
          nextObservationSeq: 1,
          activeAction: null,
          settledOutcomes: [],
          observationReceipts: [],
        },
        resources: [],
        researchState: researchRequested ? 'incomplete' : 'not_requested',
        researchAssessment: researchRequested ? {
          taskId: 'browser-task-research-budget',
          satisfied: false,
          missingWorkItemIds: ['query-a', 'query-b', 'query-c'],
          workItems: [],
          evidenceRefs: [],
        } : null,
        unresolvedActions: [],
      }),
    },
    runId: 'run-browser-research-budget',
    taskId: 'task-browser-research-budget',
    noteProgress: () => undefined,
  })

  recorder('browser_snapshot', createToolExecutionOutput('page observed', {
    shape: 'json',
    data: { ok: true },
  }))
  assert.equal(liveBudget.taskType, 'short_task')
  assert.equal(liveBudget.bootstrapBudget, false)

  researchRequested = true
  recorder('browser_research', createToolExecutionOutput('research started', {
    shape: 'json',
    data: { ok: true },
  }))

  assert.equal(liveBudget.taskType, 'research')
  assert.equal(liveBudget.bootstrapBudget, false)
  assert.equal(liveBudget.budget.maxIterations, 220)
  assert.equal(liveBudget.budget.maxToolCalls, 220)
  assert.equal(liveBudget.usage.toolCallsUsed, 2)
  assert.equal(state.runMetaBudgetRuntime?.taskType, 'research')
  assert.deepEqual(projectionPatches.at(-1), {
    taskType: 'research',
    module: 'browser',
    budgetWarningLevel: 'none',
  })
})
