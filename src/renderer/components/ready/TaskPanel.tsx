import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Send } from 'lucide-react'
import {
  useAgent,
  type AgentArtifact,
  type ScopeRunState,
  type ToolTraceEvent
} from '../../stores/useAgent'
import type { RecoveryRecordData, TaskProjectionRecordData } from '../../types/electron'
import { deriveTaskCardRuntimeState } from '../../modules/agent/taskCardViewModel'
import { phaseToUserLabel, projectionStatusToUserLabel } from '../../modules/agent/task-status-vocabulary'
import { isForegroundBusyScopeRunState } from '../../modules/agent/scopeRunState'
import AgentSelector from './AgentSelector'
import AgentTagRow from './AgentTagRow'

interface Task {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed'
}

function extractTasksFromMessages(
  messages: { id: string; content: string; type: string }[]
): Task[] {
  const tasks: Task[] = []
  let taskIndex = 0

  for (const msg of messages) {
    if (msg.type !== 'agent') continue
    const lines = msg.content.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      const checkboxMatch = trimmed.match(/^[-*]\s*\[([ xX])\]\s+(.+)/)
      if (checkboxMatch) {
        tasks.push({
          id: `task-${msg.id}-${taskIndex++}`,
          title: checkboxMatch[2].trim(),
          status: checkboxMatch[1].toLowerCase() === 'x' ? 'completed' : 'pending'
        })
        continue
      }
      const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)/)
      if (numberedMatch && numberedMatch[1].length > 2 && numberedMatch[1].length < 60) {
        tasks.push({
          id: `task-${msg.id}-${taskIndex++}`,
          title: numberedMatch[1].trim(),
          status: 'pending'
        })
      }
    }
  }

  return tasks
}

function phaseLabel(phase: ScopeRunState['phase'] | undefined): string {
  return phaseToUserLabel(phase, 'taskPanel')
}

function phaseTone(phase: ScopeRunState['phase'] | undefined): { bg: string; color: string } {
  switch (phase) {
    case 'done':
      return { bg: 'var(--color-green-light)', color: 'var(--color-green)' }
    case 'error':
    case 'cancelled':
      return { bg: 'rgba(224, 69, 72, 0.12)', color: 'var(--color-red)' }
    case 'takeover':
    case 'checkpoint':
      return { bg: 'var(--color-orange-light)', color: 'var(--color-orange)' }
    default:
      return { bg: 'var(--color-blue-light)', color: 'var(--color-blue)' }
  }
}

function summarizeTraceItem(item: ToolTraceEvent): string {
  try {
    const parsed = JSON.parse(item.text) as Record<string, unknown>
    const summary =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.summary === 'string'
          ? parsed.summary
          : ''
    if (summary) {
      return summary.replace(/\s+/g, ' ').trim().slice(0, 180)
    }
  } catch {
    // ignore structured payload parse errors
  }
  return item.text.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function moduleLabel(module: ScopeRunState['module'] | string | undefined): string {
  switch (module) {
    case 'browser':
      return '浏览器'
    case 'document':
      return '文档'
    case 'design':
      return '设计'
    case 'video':
      return '剪辑'
    case 'rss':
      return 'RSS'
    case 'calendar':
      return '日程'
    case 'feishu':
      return '飞书'
    case 'system':
      return '系统'
    default:
      return '通用'
  }
}

function memorySourceLabel(
  sourceType:
    | 'resident_agent'
    | 'resident_user'
    | 'scope_memory'
    | 'trigger_rule'
    | 'session_recall'
    | undefined
): string {
  switch (sourceType) {
    case 'resident_agent':
      return '常驻记忆'
    case 'resident_user':
      return '用户偏好'
    case 'scope_memory':
      return '当前任务'
    case 'trigger_rule':
      return '触发规则'
    case 'session_recall':
      return '旧会话引用'
    default:
      return '上下文'
  }
}

async function revealArtifact(artifact: AgentArtifact): Promise<void> {
  const path = artifact.path || artifact.url
  if (!path || !window.electronAPI?.document) return
  await window.electronAPI.document.showInFolder(path).catch(() => undefined)
}

function taskTypeLabel(taskType: TaskProjectionRecordData['taskType'] | undefined): string {
  switch (taskType) {
    case 'direct_answer':
      return '直答'
    case 'short_task':
      return '短任务'
    case 'multi_step_task':
      return '多步任务'
    case 'media_task':
      return '媒体任务'
    case 'continuation':
      return '继续任务'
    default:
      return '任务'
  }
}

function interactionStateLabel(
  interactionState: TaskProjectionRecordData['interactionState'] | undefined,
): string {
  switch (interactionState) {
    case 'awaiting_clarification':
      return '等待补充'
    case 'awaiting_confirmation':
      return '等待确认'
    case 'human_takeover':
      return '人工接手'
    case 'suspended':
      return '已暂停'
    case 'resuming':
      return '恢复中'
    case 'running':
      return '执行中'
    default:
      return '进行中'
  }
}

function projectionStatusLabel(status: TaskProjectionRecordData['status'] | undefined): string {
  return projectionStatusToUserLabel(status, 'taskPanel') ?? '待命'
}

function projectionStatusTone(
  status: TaskProjectionRecordData['status'] | undefined,
): { bg: string; color: string } {
  switch (status) {
    case 'done':
      return { bg: 'var(--color-green-light)', color: 'var(--color-green)' }
    case 'failed':
    case 'cancelled':
      return { bg: 'rgba(224, 69, 72, 0.12)', color: 'var(--color-red)' }
    case 'blocked':
      return { bg: 'var(--color-orange-light)', color: 'var(--color-orange)' }
    default:
      return { bg: 'var(--color-blue-light)', color: 'var(--color-blue)' }
  }
}

function recoveryKindLabel(kind: RecoveryRecordData['kind']): string {
  switch (kind) {
    case 'rate_limit':
      return '限流重试'
    case 'context_overflow':
      return '上下文压缩'
    case 'timeout_model':
      return '模型超时'
    case 'timeout_tool':
      return '工具超时'
    case 'auth':
      return '认证失败'
    case 'transient':
      return '瞬态重试'
    case 'host_unavailable':
      return '宿主降级'
    default:
      return '自动恢复'
  }
}

function resolveActiveProjection(
  taskProjections: TaskProjectionRecordData[],
  activeRun: ScopeRunState | null,
): TaskProjectionRecordData | null {
  const candidateIds = [
    activeRun?.taskId,
    activeRun?.taskContinuation?.taskId,
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)

  for (const candidateId of candidateIds) {
    const matched = taskProjections.find((item) => item.taskId === candidateId)
    if (matched) return matched
  }

  return taskProjections.find((item) =>
    item.status === 'running' || item.status === 'blocked' || item.interactionState === 'resuming',
  ) || taskProjections[0] || null
}

function buildProjectionContinuationIntent(
  activeProjection: TaskProjectionRecordData | null,
  responseText?: string,
) {
  const ref = activeProjection?.continuationRef || null
  if (!activeProjection?.taskId) return undefined
  return {
    taskId: activeProjection.taskId,
    executionId: ref?.executionId || undefined,
    stepId: ref?.stepId || activeProjection.currentStepId || undefined,
    blockedReason: activeProjection.blockedReason || undefined,
    responseText: responseText || undefined,
    todoId: ref?.todoId || undefined,
    todoTitle: ref?.todoTitle || undefined,
    pauseReason: ref?.pauseReason || undefined,
    detachedTaskId: ref?.detachedTaskId || undefined,
    taskRunId: ref?.taskRunId || undefined,
    jobId: ref?.jobId || undefined,
    skillId: ref?.skillId || undefined,
    action: ref?.action || undefined,
    runStatePath: ref?.runStatePath || undefined,
    outputDir: ref?.outputDir || undefined,
    progressFingerprint: ref?.progressFingerprint || undefined,
  }
}

export default function TaskPanel() {
  const {
    inputValue,
    isStreaming,
    messages,
    currentScopeId,
    scopeRunStates,
    setComposerDraft,
    setInputValue,
    sendMessage
  } = useAgent()

  const [taskProjections, setTaskProjections] = useState<TaskProjectionRecordData[]>([])
  const activeRun = currentScopeId ? scopeRunStates[currentScopeId] || null : null
  const composerLocked = activeRun ? isForegroundBusyScopeRunState(activeRun) : isStreaming
  const activeProjection = useMemo(() => {
    return resolveActiveProjection(taskProjections, activeRun)
  }, [taskProjections, activeRun])
  const fallbackTasks = useMemo(() => {
    const extracted = extractTasksFromMessages(messages)
    if (extracted.length > 0) return extracted
    return [
      { id: 'default-1', title: '等待结构化任务运行数据', status: 'running' as const },
      { id: 'default-2', title: '接收新的用户指令', status: 'pending' as const }
    ]
  }, [messages])

  const timelineItems = useMemo(() => {
    if (!activeRun) return []
    return activeRun.toolTrace.slice(-14).map((item) => ({
      ...item,
      summary: summarizeTraceItem(item)
    }))
  }, [activeRun])

  const activeTaskTitle = activeProjection?.taskTitle || activeRun?.taskTitle || null
  const activeTaskSummary = activeProjection?.taskSummary || activeRun?.taskSummary || null
  const artifactItems = useMemo(() => {
    if (activeProjection?.recentArtifacts && activeProjection.recentArtifacts.length > 0) {
      return activeProjection.recentArtifacts.slice(-6)
    }
    return activeRun?.artifactRefs?.slice(-6) || []
  }, [activeProjection, activeRun])
  const memoryRefs = useMemo(() => activeRun?.memoryRefs?.slice(-6) || [], [activeRun])
  const triggerHits = useMemo(() => activeRun?.triggerHits?.slice(-4) || [], [activeRun])
  const documentPipelineDiagnostics = activeRun?.executionDiagnostics?.pipeline?.document || null
  const projectionSteps = useMemo(() => activeProjection?.steps || [], [activeProjection])
  const projectionRecoveryHistory = useMemo(() => {
    return (activeProjection?.recoveryHistory || []).slice(-3).reverse()
  }, [activeProjection])
  const projectionBudgetPercent =
    activeProjection?.budgetUsagePercent == null
      ? null
      : Math.max(0, Math.min(100, Math.round(activeProjection?.budgetUsagePercent)))
  const safeProjectionBudgetPercent = projectionBudgetPercent ?? 0
  const projectionStepBudget = activeProjection?.budget?.stepBudget || null
  const isAwaitingSupplement =
    activeProjection?.interactionState === 'awaiting_clarification'
    || activeRun?.waitingFor === 'input'
    || activeRun?.waitingFor === 'clarification'
  const projectionRuntimeState = useMemo(() => {
    if (!activeProjection) return null
    return deriveTaskCardRuntimeState({
      scopeId: activeProjection.scopeId,
      taskId: activeProjection.taskId,
      phase:
        activeProjection.status === 'done'
          ? 'done'
          : activeProjection.status === 'failed'
            ? 'error'
            : activeProjection.status === 'cancelled'
              ? 'cancelled'
              : activeProjection.status === 'blocked'
                ? 'checkpoint'
                : 'tool_running',
      status: activeProjection.status,
      title: activeProjection.taskTitle || '任务',
      taskTitle: activeProjection.taskTitle,
      taskSummary: activeProjection.taskSummary,
      waitingFor: activeProjection.waitingFor || 'none',
      resumableActions: activeProjection.resumableActions,
      recentArtifacts: activeProjection.recentArtifacts,
      taskContinuation: activeProjection.continuationRef,
      interactionState: activeProjection.interactionState,
      degradationReason: activeProjection.degradationReason,
      blockedReason: activeProjection.blockedReason,
      updatedAt: activeProjection.updatedAt,
    })
  }, [activeProjection])

  const handleSend = async () => {
    if (!inputValue.trim() || composerLocked) return
    const content = inputValue
    setInputValue('')
    const result = await sendMessage(content)
    if (result.preserveInput) {
      setInputValue(content)
    }
  }

  const handleResumeProjection = useCallback(async () => {
    if (!activeProjection?.scopeId) return
    await window.electronAPI.agent.resumeRun({
      scopeId: activeProjection.scopeId,
      taskId: activeProjection.taskId || undefined,
      continuationIntent: buildProjectionContinuationIntent(activeProjection),
    })
  }, [activeProjection])

  const handleRespondToProjection = useCallback(async () => {
    if (!activeProjection?.scopeId) return
    const placeholder =
      activeProjection.interactionState === 'awaiting_confirmation'
        ? '确认继续'
        : activeProjection.interactionState === 'human_takeover'
          ? '我已完成，请继续'
          : '请继续，补充信息如下：'
    const responseText = window.prompt('补充后继续', placeholder)
    if (responseText == null) return
    const trimmed = responseText.trim() || placeholder
    if (!trimmed) return
    await window.electronAPI.agent.respondToInteraction({
      scopeId: activeProjection.scopeId,
      taskId: activeProjection.taskId || undefined,
      responseText: trimmed,
      continuationIntent: buildProjectionContinuationIntent(activeProjection, trimmed),
    })
  }, [activeProjection])

  const handleRetryProjection = useCallback(() => {
    if (!(activeProjection?.resumableActions || []).includes('retry')) return
    setComposerDraft(
      '请重试刚才的任务，并在开始前先说明你准备怎么继续。',
      buildProjectionContinuationIntent(activeProjection) || null,
    )
  }, [activeProjection, setComposerDraft])

  const handleCancelProjection = useCallback(async () => {
    if (!activeProjection?.scopeId) return
    const detachedTaskId = activeProjection.continuationRef?.detachedTaskId || null
    if (detachedTaskId && window.electronAPI?.agent?.cancelDetachedSkillTask) {
      await window.electronAPI.agent.cancelDetachedSkillTask(detachedTaskId, activeProjection.scopeId).catch(() => null)
      return
    }
    await window.electronAPI.agent.suspendRun({
      scopeId: activeProjection.scopeId,
      taskId: activeProjection.taskId || undefined,
    })
  }, [activeProjection])

  const phaseColors = phaseTone(activeRun?.phase)
  const projectionColors = projectionStatusTone(activeProjection?.status)

  useEffect(() => {
    let cancelled = false

    if (!currentScopeId || !window.electronAPI?.agent?.listTaskProjections) {
      setTaskProjections([])
      return () => {
        cancelled = true
      }
    }

    void window.electronAPI.agent.listTaskProjections(currentScopeId)
      .then((result) => {
        if (cancelled) return
        if (!result?.success || !Array.isArray(result.data)) {
          setTaskProjections([])
          return
        }
        setTaskProjections(result.data)
      })
      .catch(() => {
        if (!cancelled) setTaskProjections([])
      })

    return () => {
      cancelled = true
    }
  }, [currentScopeId, activeRun?.updatedAt])

  return (
    <div
      className="flex-shrink-0 flex flex-col"
      style={{
        width: 240,
        background: 'var(--bg-panel)',
        borderRight: '1px solid var(--border-default)'
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-default)' }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>Agent</span>
      </div>

      <div style={{ padding: '8px 6px', borderBottom: '1px solid var(--border-default)' }}>
        <AgentSelector />
      </div>

      <div
        className="flex items-center justify-between"
        style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-default)' }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>
          {activeRun || activeProjection ? '运行时间线' : '任务'}
        </span>
        <button
          className="flex items-center justify-center rounded-lg hover:bg-black/5 transition-colors"
          style={{ width: 24, height: 24 }}
        >
          <Plus
            style={{ width: 14, height: 14 }}
            className="text-[var(--text-light)]"
            strokeWidth={2}
          />
        </button>
      </div>

      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-default)' }}>
        {activeRun || activeProjection ? (
          <div className="flex flex-col" style={{ gap: 8 }}>
            <div className="flex items-center justify-between">
              <span
                className="rounded-full px-2 py-1 text-[10px] font-semibold"
                style={{
                  background: activeProjection ? projectionColors.bg : phaseColors.bg,
                  color: activeProjection ? projectionColors.color : phaseColors.color
                }}
              >
                {activeProjection ? projectionRuntimeState?.statusLabel || projectionStatusLabel(activeProjection?.status) : phaseLabel(activeRun?.phase)}
              </span>
              {activeRun ? (
                <span className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                  工具 {activeRun.stepMetrics?.toolCalls || 0}/
                  {activeRun.stepMetrics?.toolResults || 0}
                </span>
              ) : (
                <span className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                  步骤 {projectionSteps.length}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between" style={{ gap: 8 }}>
              <span className="text-[10px] font-semibold" style={{ color: 'var(--text-light)' }}>
                模块：{moduleLabel(activeRun?.module || activeProjection?.module)}
              </span>
              {activeRun?.executionKind && (
                <span className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                  {activeRun.executionKind}
                </span>
              )}
            </div>
            {(activeTaskTitle || activeTaskSummary) && (
              <div
                className="rounded-[10px] border px-2.5 py-2"
                style={{
                  borderColor: 'var(--border-default)',
                  background: 'var(--surface-card-bg)'
                }}
              >
                {activeTaskTitle && (
                  <div className="text-[11px] font-semibold" style={{ color: 'var(--text-body)' }}>
                    {activeTaskTitle}
                  </div>
                )}
                {activeTaskSummary && (
                  <div
                    className="mt-1 text-[10px]"
                    style={{ color: 'var(--text-light)', lineHeight: 1.5 }}
                  >
                    {activeTaskSummary}
                  </div>
                )}
              </div>
            )}
            {activeProjection && (
              <div
                className="rounded-[10px] border px-2.5 py-2"
                style={{
                  borderColor: 'var(--border-default)',
                  background: 'var(--surface-card-bg)'
                }}
              >
                <div
                  className="grid grid-cols-2"
                  style={{ gap: 6, fontSize: 10.5, color: 'var(--text-light)' }}
                >
                  <div>任务类型</div>
                  <div style={{ color: 'var(--text-body)', textAlign: 'right' }}>
                    {taskTypeLabel(activeProjection.taskType)}
                  </div>
                  <div>当前状态</div>
                  <div style={{ color: 'var(--text-body)', textAlign: 'right' }}>
                    {interactionStateLabel(activeProjection?.interactionState)}
                  </div>
                </div>
                {activeProjection?.budgetUsagePercent != null && (
                  <div style={{ marginTop: 8 }}>
                    <div
                      className="flex items-center justify-between"
                      style={{ fontSize: 10, color: 'var(--text-light)', marginBottom: 5 }}
                    >
                      <span>预算进度</span>
                      <span>{projectionBudgetPercent}%</span>
                    </div>
                    <div
                      style={{
                        height: 6,
                        borderRadius: 999,
                        background: 'color-mix(in srgb, var(--text-light) 14%, transparent)',
                        overflow: 'hidden'
                      }}
                    >
                      <div
                        style={{
                          width: `${safeProjectionBudgetPercent}%`,
                          height: '100%',
                          background:
                            safeProjectionBudgetPercent >= 90
                              ? 'var(--color-orange)'
                              : 'var(--color-blue)'
                        }}
                      />
                    </div>
                  </div>
                )}
                {projectionStepBudget && (
                  <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-light)', lineHeight: 1.5 }}>
                    当前步骤额度
                    {projectionStepBudget.stepId ? ` · ${projectionStepBudget.stepId}` : ''}
                    {typeof projectionStepBudget.remainingIterations === 'number'
                      ? ` · 剩余 ${projectionStepBudget.remainingIterations}/${projectionStepBudget.maxIterations}`
                      : ` · 总计 ${projectionStepBudget.maxIterations}`}
                  </div>
                )}
                {activeProjection?.degradationReason && (
                  <div style={{ marginTop: 8, fontSize: 10, color: 'var(--color-orange)', lineHeight: 1.5 }}>
                    degradationReason: {activeProjection.degradationReason}
                  </div>
                )}
              </div>
            )}
            {activeRun?.ownerResourceId && (
              <div className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                资源：{String(activeRun.ownerResourceId).slice(0, 48)}
              </div>
            )}
            {((activeProjection ? activeProjection.blockedReason : activeRun?.blockedReason) || null) && (
              <div
                className="rounded-[10px] border px-2.5 py-2"
                style={{
                  borderColor: 'var(--color-orange)',
                  background: 'var(--color-orange-light)'
                }}
              >
                <div className="text-[10px] font-semibold" style={{ color: 'var(--color-orange)' }}>
                  当前阻塞
                </div>
                <div
                  className="mt-1 text-[11px]"
                  style={{ color: 'var(--text-body)', lineHeight: 1.5 }}
                >
                  {activeProjection ? activeProjection.blockedReason : activeRun?.blockedReason}
                </div>
              </div>
            )}
            {activeProjection && (
              <div className="flex flex-wrap gap-1.5">
                {projectionRuntimeState?.actionSet.includes('continue') && (
                  <button
                    type="button"
                    onClick={handleResumeProjection}
                    className="rounded-[10px] border px-2.5 py-1.5 text-[10.5px] transition-colors hover:bg-black/5"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-body)' }}
                  >
                    继续运行
                  </button>
                )}
                {projectionRuntimeState?.actionSet.includes('cancel') && (
                  <button
                    type="button"
                    onClick={handleCancelProjection}
                    className="rounded-[10px] border px-2.5 py-1.5 text-[10.5px] transition-colors hover:bg-black/5"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-body)' }}
                  >
                    取消任务
                  </button>
                )}
                {(isAwaitingSupplement
                  || activeProjection?.interactionState === 'awaiting_confirmation'
                  || activeProjection?.interactionState === 'human_takeover') && (
                  <button
                    type="button"
                    onClick={handleRespondToProjection}
                    className="rounded-[10px] border px-2.5 py-1.5 text-[10.5px] transition-colors hover:bg-black/5"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-body)' }}
                  >
                    {activeProjection?.interactionState === 'awaiting_confirmation'
                      ? '确认继续'
                      : activeProjection?.interactionState === 'human_takeover'
                        ? '我已完成'
                        : '补充后继续'}
                  </button>
                )}
                {projectionRuntimeState?.actionSet.includes('retry') && (
                  <button
                    type="button"
                    onClick={handleRetryProjection}
                    className="rounded-[10px] border px-2.5 py-1.5 text-[10.5px] transition-colors hover:bg-black/5"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-body)' }}
                  >
                    重试任务
                  </button>
                )}
              </div>
            )}
            {projectionRecoveryHistory.length > 0 && (
              <div className="flex flex-col" style={{ gap: 6 }}>
                <div className="text-[10px] font-semibold" style={{ color: 'var(--text-light)' }}>
                  自动恢复
                </div>
                {projectionRecoveryHistory.map((entry) => (
                  <div
                    key={`${entry.timestamp}-${entry.kind}-${entry.attempt}`}
                    className="rounded-[10px] border px-2.5 py-2"
                    style={{
                      borderColor: 'var(--border-default)',
                      background: 'var(--surface-card-bg)'
                    }}
                  >
                    <div
                      className="flex items-center justify-between"
                      style={{ gap: 8, marginBottom: 4 }}
                    >
                      <div
                        className="text-[10px] font-semibold"
                        style={{ color: 'var(--text-body)' }}
                      >
                        {recoveryKindLabel(entry.kind)}
                      </div>
                      <div className="text-[9px]" style={{ color: 'var(--text-light)' }}>
                        第 {entry.attempt} 次
                      </div>
                    </div>
                    <div className="text-[10px]" style={{ color: 'var(--text-light)', lineHeight: 1.5 }}>
                      {entry.message}
                      {entry.recovered ? ' · 已恢复' : ' · 未恢复'}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {artifactItems.length > 0 && (
              <div className="flex flex-col" style={{ gap: 6 }}>
                <div className="text-[10px] font-semibold" style={{ color: 'var(--text-light)' }}>
                  Artifacts
                </div>
                <div className="flex flex-col" style={{ gap: 6 }}>
                  {artifactItems.map((artifact) => (
                    <button
                      key={artifact.id}
                      onClick={() => {
                        void revealArtifact(artifact)
                      }}
                      className="rounded-[10px] border px-2.5 py-2 text-left hover:bg-black/5 transition-colors"
                      style={{ borderColor: 'var(--border-default)' }}
                    >
                      <div
                        className="text-[11px] font-medium"
                        style={{ color: 'var(--text-body)' }}
                      >
                        {artifact.label}
                      </div>
                      <div className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                        {artifact.kind}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(memoryRefs.length > 0 || triggerHits.length > 0 || activeRun?.contextBudget) && (
              <div className="flex flex-col" style={{ gap: 6 }}>
                {triggerHits.length > 0 && (
                  <div className="flex flex-col" style={{ gap: 4 }}>
                    <div
                      className="text-[10px] font-semibold"
                      style={{ color: 'var(--text-light)' }}
                    >
                      触发规则
                    </div>
                    {triggerHits.map((trigger) => (
                      <div
                        key={trigger.id}
                        className="rounded-[10px] border px-2.5 py-2"
                        style={{
                          borderColor: 'var(--border-default)',
                          background: 'var(--surface-card-bg)'
                        }}
                      >
                        <div
                          className="text-[11px] font-medium"
                          style={{ color: 'var(--text-body)' }}
                        >
                          {trigger.label}
                        </div>
                        <div className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                          {trigger.blocking ? 'blocking' : 'advisory'} · refs {trigger.refs.length}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {memoryRefs.length > 0 && (
                  <div className="flex flex-col" style={{ gap: 4 }}>
                    <div
                      className="text-[10px] font-semibold"
                      style={{ color: 'var(--text-light)' }}
                    >
                      上下文来源
                    </div>
                    {memoryRefs.map((ref) => (
                      <div
                        key={ref.id}
                        className="text-[10px]"
                        style={{ color: 'var(--text-light)' }}
                      >
                        {memorySourceLabel(ref.sourceType)} · {ref.title}
                      </div>
                    ))}
                  </div>
                )}
                {activeRun?.contextBudget && (
                  <div
                    className="text-[10px]"
                    style={{ color: 'var(--text-light)', lineHeight: 1.5 }}
                  >
                    Budget：{activeRun.contextBudget.totalChars} chars
                    {' · '}L0 {activeRun.contextBudget.l0Chars}
                    {' · '}L1 {activeRun.contextBudget.l1Chars}
                    {' · '}L2 {activeRun.contextBudget.l2Chars}
                    {activeRun.contextBudget.droppedRefs.length > 0
                      ? ` · dropped ${activeRun.contextBudget.droppedRefs.length}`
                      : ''}
                  </div>
                )}
                {documentPipelineDiagnostics && (
                  <div
                    className="text-[10px]"
                    style={{ color: 'var(--text-light)', lineHeight: 1.5 }}
                  >
                    文档深读
                    {documentPipelineDiagnostics.phase ? ` · ${documentPipelineDiagnostics.phase}` : ''}
                    {typeof documentPipelineDiagnostics.chunkCount === 'number'
                      ? ` · 共 ${documentPipelineDiagnostics.chunkCount} 段`
                      : ''}
                    {typeof documentPipelineDiagnostics.selectedChunkCount === 'number'
                      ? ` · 用 ${documentPipelineDiagnostics.selectedChunkCount} 段`
                      : ''}
                    {documentPipelineDiagnostics.cacheHit ? ' · 缓存命中' : ''}
                    {documentPipelineDiagnostics.usedSectionAnchors === true ? ' · 章节切分' : ''}
                    {documentPipelineDiagnostics.usedSectionAnchors === false ? ' · 段落切分' : ''}
                  </div>
                )}
              </div>
            )}
            {activeRun?.latestText && !activeRun?.blockedReason && (
              <div
                className="text-[11px]"
                style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}
              >
                {activeRun.latestText.slice(0, 120)}
              </div>
            )}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: '#8A8A8A' }}>{fallbackTasks.length} 个任务</span>
        )}
      </div>

      <div className="flex-1 overflow-auto" style={{ padding: 8 }}>
        {activeRun ? (
          timelineItems.length === 0 ? (
            <div
              className="rounded-[12px] border px-3 py-3"
              style={{ borderColor: 'var(--border-default)' }}
            >
              <div className="text-[11px]" style={{ color: 'var(--text-light)' }}>
                当前还没有工具轨迹，等待运行事件。
              </div>
            </div>
          ) : (
            <div className="flex flex-col" style={{ gap: 8 }}>
              {timelineItems.map((item) => (
                <div
                  key={item.id}
                  className="rounded-[12px] border px-3 py-2.5"
                  style={{
                    borderColor:
                      item.kind === 'call' ? 'rgba(57, 128, 255, 0.18)' : 'var(--border-default)',
                    background:
                      item.kind === 'call' ? 'rgba(57, 128, 255, 0.06)' : 'var(--surface-card-bg)'
                  }}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                      style={{
                        background:
                          item.kind === 'call'
                            ? 'var(--color-blue-light)'
                            : 'rgba(16, 185, 129, 0.12)',
                        color: item.kind === 'call' ? 'var(--color-blue)' : 'var(--color-green)'
                      }}
                    >
                      {item.kind === 'call' ? 'Tool' : 'Result'}
                    </span>
                    <span className="text-[9px]" style={{ color: 'var(--text-light)' }}>
                      {item.timestamp.toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                      })}
                    </span>
                  </div>
                  <div
                    className="text-[11px]"
                    style={{ color: 'var(--text-body)', lineHeight: 1.5 }}
                  >
                    {item.summary}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : activeProjection ? (
          projectionSteps.length === 0 ? (
            <div
              className="rounded-[12px] border px-3 py-3"
              style={{ borderColor: 'var(--border-default)' }}
            >
              <div className="text-[11px]" style={{ color: 'var(--text-light)' }}>
                当前任务已经写入看板，等待新的步骤或恢复记录。
              </div>
            </div>
          ) : (
            <div className="flex flex-col" style={{ gap: 8 }}>
              {projectionSteps.map((step) => (
                <div
                  key={step.id}
                  className="rounded-[12px] border px-3 py-2.5"
                  style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card-bg)' }}
                >
                  <div className="mb-1 flex items-center justify-between" style={{ gap: 8 }}>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                      style={{
                        background:
                          step.status === 'done'
                            ? 'rgba(16, 185, 129, 0.12)'
                            : step.status === 'running'
                              ? 'var(--color-blue-light)'
                              : 'rgba(120, 120, 120, 0.12)',
                        color:
                          step.status === 'done'
                            ? 'var(--color-green)'
                            : step.status === 'running'
                              ? 'var(--color-blue)'
                              : 'var(--text-light)'
                      }}
                    >
                      {step.status === 'done'
                        ? '已完成'
                        : step.status === 'running'
                          ? '进行中'
                          : step.status === 'blocked'
                            ? '待继续'
                            : step.status === 'error'
                              ? '失败'
                              : '待执行'}
                    </span>
                    {step.updatedAt && (
                      <span className="text-[9px]" style={{ color: 'var(--text-light)' }}>
                        {new Date(step.updatedAt).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-body)', lineHeight: 1.5 }}>
                    {step.title || step.description}
                  </div>
                  {step.detail && (
                    <div className="mt-1 text-[10px]" style={{ color: 'var(--text-light)', lineHeight: 1.5 }}>
                      {step.detail}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="flex flex-col" style={{ gap: 6 }}>
            {fallbackTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center rounded-lg transition-colors hover:bg-black/5"
                style={{ padding: '8px 10px', gap: 8 }}
              >
                <span
                  className={`
                    w-2 h-2 rounded-full flex-shrink-0
                    ${task.status === 'completed' ? 'bg-[var(--color-green)]' : ''}
                    ${task.status === 'running' ? 'bg-[var(--color-blue)] animate-pulse' : ''}
                    ${task.status === 'pending' ? 'bg-[var(--text-light)]' : ''}
                  `}
                />
                <span
                  className={task.status === 'completed' ? 'line-through' : ''}
                  style={{
                    fontSize: 12,
                    color: task.status === 'completed' ? '#8A8A8A' : 'var(--text-body)'
                  }}
                >
                  {task.title}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          padding: '10px 10px',
          borderTop: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6
        }}
      >
        <AgentTagRow />

        <div className="flex items-center" style={{ gap: 6 }}>
          <div
            className="ready-input-shell flex-1 flex items-center"
            style={{
              borderRadius: 10,
              padding: '6px 10px'
            }}
          >
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value, { preserveContinuationIntent: true })}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              disabled={composerLocked}
              placeholder="给 Agent 发指令..."
              className="ready-input-slot-inner flex-1 bg-transparent border-none outline-none"
              style={{ fontSize: 11, color: 'var(--text-body)', opacity: composerLocked ? 0.7 : 1 }}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!inputValue.trim() || composerLocked}
            className="flex items-center justify-center text-white hover:brightness-95 disabled:opacity-40 transition-[filter,opacity,background-color] duration-200"
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              background: 'var(--color-green)',
              flexShrink: 0
            }}
          >
            <Send style={{ width: 11, height: 11 }} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}
