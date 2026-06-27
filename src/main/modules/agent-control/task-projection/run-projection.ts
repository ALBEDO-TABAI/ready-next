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

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasDefinedOwn(value: object, key: string): boolean {
  return hasOwn(value, key) && (value as Record<string, unknown>)[key] !== undefined
}

function artifactKey(artifact: NonNullable<ScopeRunSummary['recentArtifacts']>[number]): string {
  const record = artifact as Record<string, unknown>
  return String(record.id || record.path || record.label || JSON.stringify(record))
}

function isMediaArtifact(artifact: NonNullable<ScopeRunSummary['recentArtifacts']>[number]): boolean {
  const record = artifact as Record<string, unknown>
  const kind = String(record.kind || '').toLowerCase()
  if (kind === 'image' || kind === 'media' || kind === 'video') return true
  const mimeType = String(record.mimeType || record.contentType || '').toLowerCase()
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) return true
  const path = String(record.path || '').toLowerCase()
  return /\.(png|jpe?g|webp|gif|heic|mp4|mov|m4v|webm)$/.test(path)
}

function selectRecentArtifacts(
  artifacts: ScopeRunSummary['recentArtifacts'],
): ScopeRunSummary['recentArtifacts'] {
  const source = Array.isArray(artifacts) ? artifacts.filter(Boolean) : []
  if (source.length <= 4) return source
  const selectedKeys = new Set([
    ...source.filter(isMediaArtifact).slice(-4).map(artifactKey),
    ...source.slice(-4).map(artifactKey),
  ])
  return source.filter((artifact) => selectedKeys.has(artifactKey(artifact)))
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
    if (
      payload.type !== 'started'
      && payload.runId
      && previous?.runId
      && previous.runId !== payload.runId
    ) {
      return null
    }
    const resolvedTaskId = payload.taskId ?? previous?.taskId ?? payload.taskProjectionId ?? previous?.taskProjectionId ?? payload.runId ?? null
    const isSameTaskAsPrevious = Boolean(
      resolvedTaskId
      && (
        previous?.taskId === resolvedTaskId
        || previous?.taskProjectionId === resolvedTaskId
      ),
    )
    const truthPatch = readProjectionTruthPatch(projectionTruth)
    const payloadHasTaskContinuation = hasDefinedOwn(payload, 'taskContinuation')
    const truthHasTaskContinuation = hasDefinedOwn(truthPatch, 'taskContinuation')
    const payloadHasBlockedReason = hasDefinedOwn(payload, 'blockedReason')
    const truthHasBlockedReason = hasDefinedOwn(truthPatch, 'blockedReason')
    const payloadHasProgress = hasDefinedOwn(payload, 'progress')
    const truthHasProgress = hasDefinedOwn(truthPatch, 'progress')
    const payloadHasInteractionState = hasDefinedOwn(payload, 'interactionState')
    const truthHasInteractionState = hasDefinedOwn(truthPatch, 'interactionState')
    const payloadHasWaitingFor = hasDefinedOwn(payload, 'waitingFor')
    const truthHasWaitingFor = hasDefinedOwn(truthPatch, 'waitingFor')
    const payloadHasResumableActions = hasDefinedOwn(payload, 'resumableActions')
    const truthHasResumableActions = hasDefinedOwn(truthPatch, 'resumableActions')
    const truthRecentArtifacts = Array.isArray(truthPatch.recentArtifacts)
      ? truthPatch.recentArtifacts as ScopeRunSummary['recentArtifacts']
      : null
    const recentArtifacts = selectRecentArtifacts(
      truthRecentArtifacts || payload.recentArtifacts || payload.artifactRefs || previous?.recentArtifacts || [],
    )
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
      runId: payload.runId ?? previous?.runId ?? null,
      taskId: resolvedTaskId,
      parentTaskId: payload.parentTaskId ?? (isSameTaskAsPrevious ? previous?.parentTaskId : null) ?? null,
      parentStepId: payload.parentStepId ?? (isSameTaskAsPrevious ? previous?.parentStepId : null) ?? null,
      taskTitle: payload.taskTitle ?? truthPatch.taskTitle ?? previous?.taskTitle ?? null,
      taskSummary: payload.taskSummary ?? truthPatch.taskSummary ?? previous?.taskSummary ?? payload.latestText ?? null,
      taskType: payload.taskType ?? previous?.taskType,
      interactionState: payload.interactionState
        ?? truthPatch.interactionState
        ?? (payload.phase === 'done' ? undefined : previous?.interactionState),
      steps: payload.steps ?? truthPatch.steps ?? previous?.steps ?? [],
      currentStepId: payload.currentStepId ?? truthPatch.currentStepId ?? previous?.currentStepId ?? null,
      waitingFor: payload.waitingFor
        ?? truthPatch.waitingFor
        ?? (payload.phase === 'done' ? 'none' : previous?.waitingFor ?? 'none'),
      resumableActions: payload.resumableActions
        ?? truthPatch.resumableActions
        ?? (payload.phase === 'done' ? [] : previous?.resumableActions ?? []),
      recentArtifacts,
      taskContinuation: payloadHasTaskContinuation
        ? payload.taskContinuation ?? null
        : truthHasTaskContinuation
          ? truthPatch.taskContinuation ?? null
          : payload.phase === 'done'
            ? null
            : previous?.taskContinuation ?? null,
      progress: payloadHasProgress
        ? payload.progress ?? null
        : truthHasProgress
          ? truthPatch.progress ?? null
          : previous?.progress ?? null,
      memoryCapture: payload.memoryCapture ?? previous?.memoryCapture ?? null,
      executionDiagnostics: payload.executionDiagnostics ?? previous?.executionDiagnostics ?? null,
      contextUsage: payload.contextUsage ?? payload.executionDiagnostics?.contextUsage ?? previous?.contextUsage ?? null,
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
      blockedReason: payloadHasBlockedReason
        ? payload.blockedReason ?? null
        : truthHasBlockedReason
          ? truthPatch.blockedReason ?? null
          : payload.phase === 'done'
            ? null
            : previous?.blockedReason ?? null,
      error: payload.error ?? previous?.error ?? null,
      terminalReason: payload.terminalReason ?? (activePhase || payload.phase === 'done' ? null : previous?.terminalReason ?? null),
      updatedAt: payload.timestamp,
    }
    if (
      payload.phase === 'done'
      && (
        payloadHasInteractionState
        || truthHasInteractionState
        || payloadHasWaitingFor
        || truthHasWaitingFor
        || payloadHasResumableActions
        || truthHasResumableActions
        || payloadHasTaskContinuation
        || truthHasTaskContinuation
        || payloadHasBlockedReason
        || truthHasBlockedReason
      )
    ) {
      summary.interactionState = payload.interactionState ?? truthPatch.interactionState ?? summary.interactionState
      summary.waitingFor = payload.waitingFor ?? truthPatch.waitingFor ?? summary.waitingFor
      summary.resumableActions = payload.resumableActions ?? truthPatch.resumableActions ?? summary.resumableActions
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
