import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunSummary,
  ScopeRunTaskStep,
} from './types'
import { logAgentMetric } from './metrics'
import type { ProjectionTruthSnapshot, RunProjectionPatch } from './run-contracts'

function browserStepTitle(id: string): string {
  const titles: Record<string, string> = {
    resolve_target_page: '确认目标页',
    resolve_attachment: '确认附件',
    navigate_target: '进入目标页',
    ensure_upload: '上传附件',
    ensure_prompt: '填写提示词',
    submit: '提交执行',
    final_reconcile: '结果复核',
    recover: '恢复页面',
  }
  return titles[id] || id
}

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
    const derivedTask = this.deriveTaskSummaryPatch(previous, payload)
    const recentArtifacts = (payload.recentArtifacts || payload.artifactRefs || previous?.recentArtifacts || []).slice(-4)
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
      taskTitle: payload.taskTitle ?? truthPatch.taskTitle ?? derivedTask.taskTitle ?? previous?.taskTitle ?? null,
      taskSummary: payload.taskSummary ?? truthPatch.taskSummary ?? derivedTask.taskSummary ?? previous?.taskSummary ?? payload.latestText ?? null,
      taskType: payload.taskType ?? previous?.taskType,
      interactionState: payload.interactionState ?? previous?.interactionState,
      steps: payload.steps ?? truthPatch.steps ?? derivedTask.steps ?? previous?.steps ?? [],
      currentStepId: payload.currentStepId ?? truthPatch.currentStepId ?? derivedTask.currentStepId ?? previous?.currentStepId ?? null,
      waitingFor: payload.waitingFor ?? truthPatch.waitingFor ?? derivedTask.waitingFor ?? previous?.waitingFor ?? 'none',
      resumableActions: payload.resumableActions ?? truthPatch.resumableActions ?? derivedTask.resumableActions ?? previous?.resumableActions ?? [],
      recentArtifacts,
      taskContinuation: payload.taskContinuation ?? truthPatch.taskContinuation ?? derivedTask.taskContinuation ?? previous?.taskContinuation ?? null,
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
      blockedReason: payload.blockedReason ?? truthPatch.blockedReason ?? derivedTask.blockedReason ?? previous?.blockedReason ?? null,
      error: payload.error ?? previous?.error ?? null,
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

  deriveTaskSummaryPatch(
    previous: ScopeRunSummary | undefined,
    payload: ScopeRunEventPayload,
  ): RunProjectionPatch {
    const rawText = payload.toolEvent?.kind === 'result'
      ? payload.toolEvent.text
      : payload.latestText || ''
    if (!rawText) return {}

    const browserPlanTarget = rawText.match(/\[计划\]\s*目标：([^\n]+)/)?.[1]?.trim()
    const browserPlanOrder = rawText.match(/\[计划\]\s*顺序：([^\n]+)/)?.[1]?.trim()
    if (browserPlanTarget && browserPlanOrder) {
      const steps = browserPlanOrder
        .split('->')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((id) => ({
          id,
          title: browserStepTitle(id),
          status: 'pending' as const,
          updatedAt: payload.timestamp,
        }))
      return {
        taskTitle: browserPlanTarget,
        taskSummary: '准备开始浏览器任务',
        steps,
        currentStepId: null,
        waitingFor: 'none',
        resumableActions: ['cancel'],
      }
    }

    const browserStage = rawText.match(/\[阶段\]\s*步骤\s*(\d+)\/(\d+)\s*([^：:]+)[：:]\s*(.+)$/)
    if (browserStage) {
      const currentIndex = Math.max(0, Number(browserStage[1]) - 1)
      const detail = browserStage[4].trim()
      const steps = (previous?.steps || []).map((step, index) => ({
        ...step,
        status: (index < currentIndex ? 'done' : index === currentIndex ? 'running' : 'pending') as ScopeRunTaskStep['status'],
        detail: index === currentIndex ? detail : step.detail || null,
        updatedAt: index <= currentIndex ? payload.timestamp : step.updatedAt,
      }))
      return {
        taskTitle: previous?.taskTitle || '浏览器任务',
        taskSummary: `${browserStage[3].trim()}：${detail}`,
        steps,
        currentStepId: steps[currentIndex]?.id || previous?.currentStepId || null,
        waitingFor: 'none',
        resumableActions: ['cancel'],
      }
    }

    return {}
  }
}
