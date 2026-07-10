import type { AgentInputItem } from '@openai/agents'
import { classifyFollowupIntent } from '../../../../shared/agent-followup-intent'
import type {
  ExecutionTurnResult,
  TaskBudgetRuntime,
  TurnTranscriptEvent
} from '../contracts/run-contracts'
import { registerActionAnnouncementSteerReminder } from '../system-reminders/action-announcement-steer-reminder'
import { getActivePlanForScope } from '../system-reminders/active-plan-step-reminder'
import { createSystemReminderRegistry } from '../system-reminders/system-reminder-registry'
import { createTaskBudgetRuntime } from '../task-projection/run-budget-policy'
import {
  buildActionAnnouncementCheckpointMessage,
  buildActionAnnouncementSteerInput,
  evaluateActionAnnouncementGuard
} from './action-announcement-guard'
import { mergeProjectionPatches } from './agent-sdk-document-utils'
import { resolveTaskTypeFromBrowserWorkflowText } from './agent-sdk-foundation-utils'
import { resolveSkillHintRelevanceForTurn } from './agent-sdk-skill-intent-utils'
import { buildExecutionTurnResult } from './agent-sdk-turn-closeout'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import type {
  AgentSdkBudgetCheckpointRestore,
  AgentSdkExecutionOptions,
  AgentSdkProviderDiagnostics,
  ReadyAgentSdkRunParams,
  ReadyAgentSdkRunResult,
  RunHandle
} from './agent-sdk-types'
import { finalizeRunOutcome, writeRunCloseMetric } from './run-finalizer'
import {
  buildSkillClarificationCheckpointMessage,
  buildSkillClarificationSteerInput,
  buildSkillClarificationSteerReminder,
  evaluateSkillClarificationGuard
} from './skill-clarification-guard'
import type { TurnTerminalReason } from './turn-frame'

export interface AgentSdkTurnGuardState {
  actionAnnouncementSteered: boolean
  finalText: string
  liveTaskBudgetRuntime: TaskBudgetRuntime | null
  newDocumentNeedsSave: boolean
  nextInput: ReadyAgentSdkRunParams['input']
  runMetaBudgetRuntime: TaskBudgetRuntime | null
  runMetaContinuationRef: Record<string, unknown> | null
  runMetaUsage: ReadyAgentSdkRunResult['usage'] | null
  skillClarificationSteered: boolean
}

export interface AgentSdkTurnGuardContext {
  state: AgentSdkTurnGuardState
  host: TurnOrchestratorHost
  name: string
  runId: string
  taskId: string
  sessionId?: string
  runStartedAt: number
  pureUserTurnText: string
  effectiveExecutionOptions?: AgentSdkExecutionOptions
  checkpointRestore: AgentSdkBudgetCheckpointRestore | null
  skillHintRelevanceForTurn: ReturnType<typeof resolveSkillHintRelevanceForTurn>
  turnFollowup: ReturnType<typeof classifyFollowupIntent>
  recentCollectionIntent: boolean
  inferredSdkTaskType: ReturnType<typeof resolveTaskTypeFromBrowserWorkflowText>
  allowedToolNames: string[]
  requiredCapabilityGroups: string[]
  runHandle: RunHandle
  usedTools: string[]
  projectionPatches: Record<string, unknown>[]
  transcriptEvents: TurnTranscriptEvent[]
  runMetaProviderDiagnostics: AgentSdkProviderDiagnostics | null
  emitOutput: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  emitOutputForRun: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  emitStatusForRun: (status: string, terminalReason?: TurnTerminalReason | null) => void
  buildResult: (params: Parameters<typeof buildExecutionTurnResult>[1]) => ExecutionTurnResult
}

export function createAgentSdkTurnGuards(ctx: AgentSdkTurnGuardContext): {
  maybeHandleSkillClarificationGuard: (
    text: string
  ) => Promise<'continue' | ExecutionTurnResult | null>
  maybeHandleActionAnnouncementGuard: (
    text: string
  ) => Promise<'continue' | ExecutionTurnResult | null>
} {
  const {
    state,
    host,
    name,
    runId,
    taskId,
    sessionId,
    runStartedAt,
    pureUserTurnText,
    effectiveExecutionOptions,
    checkpointRestore,
    skillHintRelevanceForTurn,
    turnFollowup,
    recentCollectionIntent,
    inferredSdkTaskType,
    allowedToolNames,
    requiredCapabilityGroups,
    runHandle,
    usedTools,
    projectionPatches,
    transcriptEvents,
    runMetaProviderDiagnostics,
    emitOutput,
    emitOutputForRun,
    emitStatusForRun,
    buildResult
  } = ctx
  const hasUnfinishedActionTaskReference = (): boolean => {
    if (
      usedTools.length > 0 ||
      // NOTE: a bare executionOptions.taskId is NOT a task signal — the
      // host injects one for every turn (review batch-1 finding). Task
      // reference now requires continuation/budget state, collection
      // intent continuity, an active plan, or a follow-up that points
      // back at prior work.
      getActivePlanForScope(sessionId) ||
      recentCollectionIntent ||
      turnFollowup.kind === 'continue_task' ||
      turnFollowup.kind === 'correction' ||
      turnFollowup.kind === 'status_query' ||
      effectiveExecutionOptions?.continuationIntent ||
      effectiveExecutionOptions?.continuationState ||
      effectiveExecutionOptions?.taskBudgetRuntime ||
      effectiveExecutionOptions?.budget ||
      effectiveExecutionOptions?.budgetState ||
      checkpointRestore
    ) {
      return true
    }
    return host.hasPendingTaskProjection(sessionId)
  }
  const maybeHandleSkillClarificationGuard = async (
    assistantText: string
  ): Promise<ExecutionTurnResult | 'continue' | null> => {
    const decision = evaluateSkillClarificationGuard({
      assistantText,
      toolCallsInCurrentResponse: 0,
      hasSkillAskUserTool: allowedToolNames.includes('skill_ask_user'),
      isSkillClarificationEligible: skillHintRelevanceForTurn.relevant,
      hasUnfinishedTaskReference: hasUnfinishedActionTaskReference(),
      alreadySteered: state.skillClarificationSteered,
      taskType: state.liveTaskBudgetRuntime?.taskType || null
    })
    if (decision.kind === 'none') return null
    if (decision.kind === 'steer') {
      state.skillClarificationSteered = true
      state.nextInput = buildSkillClarificationSteerInput(
        buildSkillClarificationSteerReminder(decision.questionSummary)
      ) as AgentInputItem[]
      return 'continue'
    }

    const checkpointBudgetRuntime =
      state.liveTaskBudgetRuntime || createTaskBudgetRuntime(inferredSdkTaskType || 'short_task')
    state.liveTaskBudgetRuntime = checkpointBudgetRuntime
    state.runMetaBudgetRuntime = checkpointBudgetRuntime
    const checkpoint = await host.runLifecycle.writeBudgetCheckpointState({
      agentName: name,
      sessionId,
      runId,
      taskId,
      taskBudgetRuntime: checkpointBudgetRuntime,
      runHandle,
      usedTools,
      requiredCapabilityGroups,
      requiredToolNames: allowedToolNames,
      lastUserMessage: pureUserTurnText,
      terminalReason: 'checkpoint_steered',
      blockerType: 'skill_clarification_not_card',
      pauseReason: 'skill_clarification_not_card',
      blockedReason: '技能流程需要用户补充信息，但模型没有调用反问卡。',
      waitingFor: 'none',
      resumeKind: 'paused'
    })
    state.runMetaContinuationRef =
      checkpoint.projectionPatch.taskContinuation &&
      typeof checkpoint.projectionPatch.taskContinuation === 'object'
        ? (checkpoint.projectionPatch.taskContinuation as Record<string, unknown>)
        : null
    projectionPatches.push(checkpoint.projectionPatch)
    state.finalText = buildSkillClarificationCheckpointMessage(assistantText)
    emitOutput(state.finalText, 'text', checkpoint.projectionPatch)
    const finalProjectionPatch = mergeProjectionPatches(projectionPatches)
    await finalizeRunOutcome(
      {
        kind: 'checkpoint',
        runId,
        taskId,
        scopeId: sessionId || null,
        continuationHandle: checkpoint.runStatePath,
        durationMs: Math.max(1, Date.now() - runStartedAt),
        toolCallsUsed: usedTools.length,
        initiator: runHandle.abortInitiator || 'done',
        terminalReason: 'checkpoint_steered',
        projectionPatch: finalProjectionPatch,
        finalText: state.finalText,
        taskBudgetRuntime: state.liveTaskBudgetRuntime,
        providerDiagnostics: runMetaProviderDiagnostics,
        usage: state.runMetaUsage
      },
      {
        runMetaRepository: host.getRunMetaRepositoryForFinalize(),
        taskProjectionStore: host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null,
        learnFromCheckIn: (input) => host.learnSiteCardsFromCheckIn(input),
        writeProjectionTerminalPatch: (projectionPatch, terminalReason, status) => {
          emitOutputForRun('', 'done', projectionPatch)
          emitStatusForRun(status, terminalReason as TurnTerminalReason)
        },
        writeRunCloseMetric
      }
    )
    return buildResult({
      success: true,
      finalText: state.finalText,
      cancelled: false,
      taskId,
      usedTools,
      transcriptEvents,
      projectionPatches,
      terminalReason: 'checkpoint_steered',
      taskBudgetRuntime: state.liveTaskBudgetRuntime,
      providerDiagnostics: runMetaProviderDiagnostics,
      usage: state.runMetaUsage
    })
  }
  const maybeHandleActionAnnouncementGuard = async (
    assistantText: string
  ): Promise<ExecutionTurnResult | 'continue' | null> => {
    // D6 仲裁：新文档未保存的义务由退出循环后的自动保存兜底确定性兑现
    // （见下方 state.newDocumentNeedsSave 块），零工具的「我会保存」不属于
    // 未兑现宣告——闸让位，否则 steer/checkpoint 会挡住兜底保存。
    if (state.newDocumentNeedsSave) return null
    const decision = evaluateActionAnnouncementGuard({
      assistantText,
      // This guard runs only after a model response that did not launch a
      // tool. Prior preparation tools in the same run must not mask a new
      // "I'll do it now" promise at the tail.
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: hasUnfinishedActionTaskReference(),
      alreadySteered: state.actionAnnouncementSteered
    })
    if (decision.kind === 'none') return null
    if (decision.kind === 'steer') {
      const registry = createSystemReminderRegistry()
      registerActionAnnouncementSteerReminder(registry, decision.actionSummary)
      const reminder = registry.compose()
      if (!reminder) return null
      state.actionAnnouncementSteered = true
      state.nextInput = buildActionAnnouncementSteerInput(reminder) as AgentInputItem[]
      return 'continue'
    }

    const checkpointBudgetRuntime =
      state.liveTaskBudgetRuntime || createTaskBudgetRuntime(inferredSdkTaskType || 'short_task')
    state.liveTaskBudgetRuntime = checkpointBudgetRuntime
    state.runMetaBudgetRuntime = checkpointBudgetRuntime
    const checkpoint = await host.runLifecycle.writeBudgetCheckpointState({
      agentName: name,
      sessionId,
      runId,
      taskId,
      taskBudgetRuntime: checkpointBudgetRuntime,
      runHandle,
      usedTools,
      requiredCapabilityGroups,
      requiredToolNames: allowedToolNames,
      lastUserMessage: pureUserTurnText,
      terminalReason: 'checkpoint_steered',
      blockerType: 'action_announcement_steered',
      pauseReason: 'action_announcement_steered',
      blockedReason: '行动宣告没有启动实际工具，已保存续跑断点。',
      waitingFor: 'none',
      resumeKind: 'paused'
    })
    state.runMetaContinuationRef =
      checkpoint.projectionPatch.taskContinuation &&
      typeof checkpoint.projectionPatch.taskContinuation === 'object'
        ? (checkpoint.projectionPatch.taskContinuation as Record<string, unknown>)
        : null
    projectionPatches.push(checkpoint.projectionPatch)
    state.finalText = buildActionAnnouncementCheckpointMessage(decision.actionSummary)
    emitOutput(state.finalText, 'text', checkpoint.projectionPatch)
    const finalProjectionPatch = mergeProjectionPatches(projectionPatches)
    await finalizeRunOutcome(
      {
        kind: 'checkpoint',
        runId,
        taskId,
        scopeId: sessionId || null,
        continuationHandle: checkpoint.runStatePath,
        durationMs: Math.max(1, Date.now() - runStartedAt),
        toolCallsUsed: usedTools.length,
        initiator: runHandle.abortInitiator || 'done',
        terminalReason: 'checkpoint_steered',
        projectionPatch: finalProjectionPatch,
        finalText: state.finalText, // EP2-Q3: same variable emitted above
        taskBudgetRuntime: state.liveTaskBudgetRuntime,
        providerDiagnostics: runMetaProviderDiagnostics,
        usage: state.runMetaUsage
      },
      {
        runMetaRepository: host.getRunMetaRepositoryForFinalize(),
        taskProjectionStore: host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null,
        learnFromCheckIn: (input) => host.learnSiteCardsFromCheckIn(input),
        writeProjectionTerminalPatch: (projectionPatch, terminalReason, status) => {
          emitOutputForRun('', 'done', projectionPatch)
          emitStatusForRun(status, terminalReason as TurnTerminalReason)
        },
        writeRunCloseMetric
      }
    )
    return buildResult({
      success: true,
      finalText: state.finalText,
      cancelled: false,
      taskId,
      usedTools,
      transcriptEvents,
      projectionPatches,
      terminalReason: 'checkpoint_steered',
      taskBudgetRuntime: state.liveTaskBudgetRuntime,
      providerDiagnostics: runMetaProviderDiagnostics,
      usage: state.runMetaUsage
    })
  }

  return { maybeHandleSkillClarificationGuard, maybeHandleActionAnnouncementGuard }
}
