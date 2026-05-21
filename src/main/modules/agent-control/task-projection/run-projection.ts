import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunSummary,
} from '../contracts/types'
import { logAgentMetric } from '../metrics'
import type { ProjectionTruthSnapshot, RunProjectionPatch } from '../contracts/run-contracts'

function readProjectionTruthPatch(projectionTruth?: ProjectionTruthSnapshot | null): RunProjectionPatch {
  let patch: Record<string, unknown> | null = null
  for (const event of projectionTruth?.transcriptEvents || []) {
    if (event.kind !== 'structured_payload' || !event.projectionPatch) continue
    patch = {
      ...(patch || {}),
      ...event.projectionPatch,
    }
  }
  if (projectionTruth?.projectionPatch) {
    patch = {
      ...(patch || {}),
      ...projectionTruth.projectionPatch,
    }
  }
  if (!patch) return {}
  return patch as RunProjectionPatch
}

export class RunProjection {
  constructor(private readonly deps: {
    getScope: (scopeId: string) => ConversationScope | null
    getPrevious: (scopeId: string) => ScopeRunSummary | undefined
    setSummary: (scopeId: string, summary: ScopeRunSummary) => void
    toChannelKey: (scope: ConversationScope) => string
  }) {}

  recordEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): ScopeRunSummary | null {
    const scope = this.deps.getScope(payload.scopeId)
    if (!scope) return null
    const previous = this.deps.getPrevious(payload.scopeId)
    const resolvedTaskId = payload.taskId ?? previous?.taskId ?? payload.taskProjectionId ?? previous?.taskProjectionId ?? payload.runId ?? null
    const isSameTaskAsPrevious = Boolean(
      resolvedTaskId
      && (
        previous?.taskId === resolvedTaskId
        || previous?.taskProjectionId === resolvedTaskId
      ),
    )
    const truthPatch = readProjectionTruthPatch(projectionTruth)
    const recentArtifacts = (payload.recentArtifacts || payload.artifactRefs || previous?.recentArtifacts || []).slice(-4)
    const activePhase =
      payload.phase === 'queued'
      || payload.phase === 'planning'
      || payload.phase === 'tool_running'
      || payload.phase === 'checkpoint'
      || payload.phase === 'takeover'
      || payload.phase === 'resuming'
      || payload.phase === 'responding'
    const summary: ScopeRunSummary = {
      scopeId: payload.scopeId,
      agent: payload.agent,
      title: scope.title,
      sourceKind: scope.sourceKind,
      sourceId: scope.sourceId,
      channelKey: this.deps.toChannelKey(scope),
      threadKey: scope.threadKey,
      phase: payload.phase,
      taskId: resolvedTaskId,
      parentTaskId: payload.parentTaskId ?? (isSameTaskAsPrevious ? previous?.parentTaskId : null) ?? null,
      parentStepId: payload.parentStepId ?? (isSameTaskAsPrevious ? previous?.parentStepId : null) ?? null,
      taskTitle: payload.taskTitle ?? truthPatch.taskTitle ?? previous?.taskTitle ?? null,
      taskSummary: payload.taskSummary ?? truthPatch.taskSummary ?? previous?.taskSummary ?? payload.latestText ?? null,
      taskType: payload.taskType ?? previous?.taskType,
      interactionState: payload.interactionState ?? previous?.interactionState,
      steps: payload.steps ?? truthPatch.steps ?? previous?.steps ?? [],
      currentStepId: payload.currentStepId ?? truthPatch.currentStepId ?? previous?.currentStepId ?? null,
      waitingFor: payload.waitingFor ?? truthPatch.waitingFor ?? previous?.waitingFor ?? 'none',
      resumableActions: payload.resumableActions ?? truthPatch.resumableActions ?? previous?.resumableActions ?? [],
      recentArtifacts,
      taskContinuation: payload.taskContinuation ?? truthPatch.taskContinuation ?? previous?.taskContinuation ?? null,
      progress: payload.progress ?? truthPatch.progress ?? previous?.progress ?? null,
      memoryCapture: payload.memoryCapture ?? previous?.memoryCapture ?? null,
      executionDiagnostics: payload.executionDiagnostics ?? previous?.executionDiagnostics ?? null,
      budgetUsagePercent:
        payload.budgetUsagePercent
        ?? payload.executionDiagnostics?.budgetUsagePercent
        ?? previous?.budgetUsagePercent
        ?? null,
      recoveryHistory:
        payload.recoveryHistory
        ?? payload.executionDiagnostics?.recoveryHistory
        ?? previous?.recoveryHistory
        ?? null,
      degradationReason:
        payload.degradationReason
        ?? payload.executionDiagnostics?.degradationReason
        ?? previous?.degradationReason
        ?? null,
      stepBudget:
        payload.stepBudget
        ?? payload.executionDiagnostics?.stepBudget
        ?? previous?.stepBudget
        ?? null,
      budgetWarningLevel:
        payload.budgetWarningLevel
        ?? payload.executionDiagnostics?.budgetWarningLevel
        ?? previous?.budgetWarningLevel
        ?? null,
      taskProjectionId:
        payload.taskId
        ?? payload.taskProjectionId
        ?? previous?.taskId
        ?? previous?.taskProjectionId
        ?? payload.runId
        ?? null,
      blockedReason: payload.blockedReason ?? truthPatch.blockedReason ?? previous?.blockedReason ?? null,
      error: payload.error ?? previous?.error ?? null,
      terminalReason: payload.terminalReason ?? (activePhase ? null : previous?.terminalReason ?? null),
      updatedAt: payload.timestamp,
    }
    if (previous?.taskTitle === '正在理解需求' && summary.taskTitle && summary.taskTitle !== previous.taskTitle) {
      logAgentMetric('task_title_correction_rate', {
        scopeId: payload.scopeId,
        nextTaskTitle: summary.taskTitle,
      })
    }
    this.deps.setSummary(payload.scopeId, summary)
    return summary
  }
}
