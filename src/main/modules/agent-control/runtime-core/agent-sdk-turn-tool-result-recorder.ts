import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import type { AgentSdkPreparedTurnState } from './agent-sdk-turn-execution-types'
import type { ToolBridgeRuntimeContext } from './agent-sdk-types'
import type { TaskBudgetRuntime } from '../contracts/run-contracts'
import {
  collectToolOutputProofs,
  isNonterminalToolOutput,
  isSuccessfulToolOutput,
  type createTaskProofSink,
} from '../quality/proof-collector'
import { logAgentMetric } from '../metrics'
import {
  consumeToolCallBudget,
  ensureLongRunningTaskBudgetCapacity,
  LONG_RUNNING_TASK_EMERGENCY_CAP,
  rebindTaskBudgetRuntime,
} from '../task-projection/run-budget-policy'
import { normalizeToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { applyContextModifier } from '../tools-runtime/tool-runtime'
import {
  DOCUMENT_TARGET_MUTATION_TOOL_NAMES,
  documentSaveSucceeded,
  documentToolMutatedContent,
  isDocumentToolFailure,
  isSameObservedDocumentTarget,
  readDocumentToolTarget,
} from './agent-sdk-document-utils'
import { readStructuredResultRecord } from './agent-sdk-provider-utils'
import {
  buildFileReadExcerptCheckpoint,
  buildTerminalFailureProjectionPatch,
  extractLongSkillCheckpoint,
  isLocalDocumentSourceReadFailure,
  isLocalDocumentSourceReadTool,
} from './agent-sdk-runtime-outcome-utils'
import { recordBrowserWorkflowToolResult } from './agent-sdk-browser-turn-control'
import { captureResearchSearchDelivery } from './research-result-delivery'

export function createAgentSdkToolResultRecorder(input: {
  runtimeContext: () => ToolBridgeRuntimeContext
  state: AgentSdkPreparedTurnState
  syncBefore: () => void
  syncAfter: () => void
  setLiveTaskBudgetRuntime: (runtime: TaskBudgetRuntime) => void
  usedTools: string[]
  projectionPatches: Record<string, unknown>[]
  taskProofSink: ReturnType<typeof createTaskProofSink> | null
  host: Pick<TurnOrchestratorHost, 'readVerifiedBrowserWorkflowEvidence'>
  runId: string
  taskId: string
  noteProgress: () => void
}): ToolBridgeRuntimeContext['recordToolResult'] {
  return (toolName, output) => {
    input.syncBefore()
    try {
      const runtimeContext = input.runtimeContext()
      const state = input.state
      input.usedTools.push(toolName)
      state.actionAnnouncementSteered = false

      if (runtimeContext.taskBudgetRuntime) {
        const previousWarning = runtimeContext.taskBudgetRuntime.warningLevel
        const nextRuntime = consumeToolCallBudget(runtimeContext.taskBudgetRuntime)
        runtimeContext.taskBudgetRuntime = nextRuntime
        state.runMetaBudgetRuntime = nextRuntime
        input.setLiveTaskBudgetRuntime(nextRuntime)
        const nextWarning = nextRuntime.warningLevel
        if (
          nextWarning !== 'none'
          && nextWarning !== previousWarning
        ) {
          input.projectionPatches.push({ budgetWarningLevel: nextWarning })
        }
      }

      const normalized = normalizeToolExecutionOutput(output)
      const resultRecordedAt = new Date()
      const researchDelivery = captureResearchSearchDelivery(toolName, normalized, resultRecordedAt)
      if (researchDelivery) runtimeContext.latestResearchSearchDelivery = researchDelivery
      if (input.taskProofSink) {
        try {
          input.taskProofSink.append(
            input.taskId,
            collectToolOutputProofs(toolName, normalized, resultRecordedAt, { runId: input.runId }),
          )
        } catch (error) {
          logAgentMetric('proof_collect_failed', {
            taskId: input.taskId,
            toolName,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const structuredData = readStructuredResultRecord(normalized)
      recordBrowserWorkflowToolResult(runtimeContext, toolName, structuredData)
      const route = runtimeContext.browserWorkflowRoute
      const currentBudget = runtimeContext.taskBudgetRuntime
      if (
        route
        && currentBudget
        && (
          currentBudget.taskType !== 'research'
          || currentBudget.bootstrapBudget
          || currentBudget.budget.maxIterations < LONG_RUNNING_TASK_EMERGENCY_CAP
          || currentBudget.budget.maxToolCalls < LONG_RUNNING_TASK_EMERGENCY_CAP
        )
      ) {
        const evidence = input.host.readVerifiedBrowserWorkflowEvidence(route.browserTaskId)
        if (evidence?.researchAssessment || currentBudget.bootstrapBudget) {
          const durableTaskType = evidence?.researchAssessment ? 'research' : currentBudget.taskType
          const rebound = durableTaskType === currentBudget.taskType
            ? ensureLongRunningTaskBudgetCapacity(currentBudget)
            : rebindTaskBudgetRuntime(currentBudget, durableTaskType, { bootstrapBudget: false })
          const nextRuntime = rebound.bootstrapBudget
            ? { ...rebound, bootstrapBudget: false }
            : rebound
          runtimeContext.taskBudgetRuntime = nextRuntime
          state.runMetaBudgetRuntime = nextRuntime
          input.setLiveTaskBudgetRuntime(nextRuntime)
          input.projectionPatches.push({
            taskType: durableTaskType,
            module: 'browser',
            budgetWarningLevel: nextRuntime.warningLevel,
          })
        }
      }

      const documentToolFailed = isDocumentToolFailure(normalized)
      const sourceReadFailed = isLocalDocumentSourceReadFailure(toolName, normalized.text)
      const structuredStatus = typeof structuredData.status === 'string'
        ? structuredData.status.trim().toLowerCase()
        : ''
      const toolReportedNonterminal = isNonterminalToolOutput(normalized)
      const toolReportedFailure = !toolReportedNonterminal && (
        !isSuccessfulToolOutput(normalized, toolName)
        || documentToolFailed
        || structuredData.ok === false
        || typeof structuredData.errorKind === 'string'
        || structuredStatus === 'error'
        || structuredStatus === 'failed'
        || sourceReadFailed
      )
      if (!toolReportedFailure && !toolReportedNonterminal) {
        state.hasSuccessfulToolProgress = true
        input.noteProgress()
      }
      if (isLocalDocumentSourceReadTool(toolName) && !toolReportedFailure) {
        state.hasSuccessfulLocalDocumentSourceRead = true
        state.hasSuccessfulLocalDocumentSourceReadForRecovery = true
      }

      const documentToolChangedContent = DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(toolName)
        && !documentToolFailed
        && documentToolMutatedContent(normalized)
      if (documentToolChangedContent) {
        state.hasSuccessfulDocumentTargetMutation = true
        const documentTarget = readDocumentToolTarget(normalized)
        if (!documentTarget) {
          state.observedDocumentMutationMissingTarget = true
        } else if (!state.observedDocumentMutationTarget) {
          state.observedDocumentMutationTarget = documentTarget
        } else if (isSameObservedDocumentTarget(state.observedDocumentMutationTarget, documentTarget)) {
          state.observedDocumentMutationTarget = documentTarget
        } else {
          state.observedDocumentMutationConflict = true
        }
      }
      if (documentToolChangedContent && input.usedTools.includes('document_new_tab')) {
        state.newDocumentNeedsSave = true
      }
      if (toolName === 'document_save_tab') {
        state.lastDocumentSaveFailure = documentToolFailed
          ? normalized.text || 'document_save_tab failed'
          : null
        if (!documentToolFailed && documentSaveSucceeded(normalized)) {
          state.lastDocumentSaveSuccessText = normalized.text
          state.newDocumentNeedsSave = false
          const savedDocumentTarget = readDocumentToolTarget(normalized)
          if (
            savedDocumentTarget
            && state.observedDocumentMutationTarget
            && isSameObservedDocumentTarget(state.observedDocumentMutationTarget, savedDocumentTarget)
          ) state.observedDocumentMutationTarget = savedDocumentTarget
        }
      }
      if (toolName === 'file_read_excerpt' && !toolReportedFailure) {
        state.fileReadExcerptCheckpointForRecovery = buildFileReadExcerptCheckpoint(normalized)
      }

      applyContextModifier(runtimeContext, normalized)
      state.longSkillCheckpoint = extractLongSkillCheckpoint(
        toolName,
        normalized,
        state.longSkillCheckpoint,
      )
      if (normalized.projectionPatch) input.projectionPatches.push(normalized.projectionPatch)
      if (toolReportedFailure) {
        input.projectionPatches.push(buildTerminalFailureProjectionPatch(toolName, structuredData))
      }
    } finally {
      input.syncAfter()
    }
  }
}
