import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunSummary,
  ScopeRunTaskContinuation,
  ScopeRunTaskStep,
} from './types'
import type { RunProjectionPatch } from './run-contracts'

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

function skillStepStatus(value: string): ScopeRunTaskStep['status'] {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'done' || normalized === 'success' || normalized === 'completed') return 'done'
  if (normalized === 'running' || normalized === 'active') return 'running'
  if (normalized === 'waiting' || normalized === 'blocked') return 'blocked'
  if (normalized === 'failed' || normalized === 'cancelled' || normalized === 'error') return 'error'
  return 'pending'
}

export class RunProjection {
  constructor(private readonly deps: {
    getScope: (scopeId: string) => ConversationScope | null
    getPrevious: (scopeId: string) => ScopeRunSummary | undefined
    setSummary: (scopeId: string, summary: ScopeRunSummary) => void
    toChannelKey: (scope: ConversationScope) => string
  }) {}

  recordEvent(payload: ScopeRunEventPayload): ScopeRunSummary | null {
    const scope = this.deps.getScope(payload.scopeId)
    if (!scope) return null
    const previous = this.deps.getPrevious(payload.scopeId)
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
      taskTitle: payload.taskTitle ?? derivedTask.taskTitle ?? previous?.taskTitle ?? null,
      taskSummary: payload.taskSummary ?? derivedTask.taskSummary ?? previous?.taskSummary ?? payload.latestText ?? null,
      steps: payload.steps ?? derivedTask.steps ?? previous?.steps ?? [],
      currentStepId: payload.currentStepId ?? derivedTask.currentStepId ?? previous?.currentStepId ?? null,
      waitingFor: payload.waitingFor ?? derivedTask.waitingFor ?? previous?.waitingFor ?? 'none',
      resumableActions: payload.resumableActions ?? derivedTask.resumableActions ?? previous?.resumableActions ?? [],
      recentArtifacts,
      taskContinuation: payload.taskContinuation ?? derivedTask.taskContinuation ?? previous?.taskContinuation ?? null,
      memoryCapture: payload.memoryCapture ?? previous?.memoryCapture ?? null,
      executionDiagnostics: payload.executionDiagnostics ?? previous?.executionDiagnostics ?? null,
      blockedReason: payload.blockedReason ?? derivedTask.blockedReason ?? previous?.blockedReason ?? null,
      error: payload.error ?? previous?.error ?? null,
      updatedAt: payload.timestamp,
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

    const executionId = rawText.match(/^Execution ID:\s*(.+)$/m)?.[1]?.trim()
    const skillId = rawText.match(/^Skill:\s*(.+)$/m)?.[1]?.trim()
    if (executionId && skillId) {
      const currentStepId = rawText.match(/^Current step:\s*(.+)$/m)?.[1]?.trim() || null
      const blockerMatch = rawText.match(/^Blocker:\s*([^-\n]+)-\s*(.+)$/m)
      const blockerType = blockerMatch?.[1]?.trim() || null
      const blockerMessage = blockerMatch?.[2]?.trim() || null
      const recentSteps = rawText.match(/^Recent steps:\s*(.+)$/m)?.[1]?.trim() || ''
      const steps = recentSteps
        ? recentSteps.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
          const match = item.match(/^(.+)\((.+)\)$/)
          const stepId = (match?.[1] || item).trim()
          return {
            id: stepId,
            title: stepId,
            status: skillStepStatus(match?.[2] || 'pending'),
            updatedAt: payload.timestamp,
          } satisfies ScopeRunTaskStep
        })
        : previous?.steps || []
      return {
        taskTitle: `技能执行 · ${skillId}`,
        taskSummary: blockerMessage || `当前步骤：${currentStepId || '进行中'}`,
        steps,
        currentStepId,
        waitingFor: blockerType === 'need_input'
          ? 'input'
          : blockerType === 'need_confirmation'
            ? 'confirmation'
            : blockerType === 'need_agent_result'
              ? 'agent_result'
              : blockerType
                ? 'background'
                : 'none',
        resumableActions: [
          ...(blockerType ? ['continue'] as const : []),
          'cancel' as const,
        ],
        taskContinuation: {
          executionId,
          stepId: currentStepId,
          blockerType,
        } satisfies ScopeRunTaskContinuation,
      }
    }

    return {}
  }
}
