import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import {
  useAgent,
  type AgentArtifact,
  type ScopeRunState,
  type ToolTraceEvent
} from '../../stores/useAgent'
import type { RecoveryRecordData, TaskProjectionRecordData } from '../../types/electron'
import {
  deriveTaskCardRuntimeState,
  formatTaskProgressLabel,
  formatTaskStepDisplayTitle,
  formatTaskUserFacingText,
} from '../../modules/agent/taskCardViewModel'
import {
  interactionStateToUserLabel,
  phaseToUserLabel,
  projectionStatusToUserLabel,
  taskStepStatusToUserLabel,
} from '../../modules/agent/task-status-vocabulary'
import { createDebouncedFetch } from '../../modules/agent/debouncedFetch'
import {
  captureScopeEpoch,
  captureScopeReadAuthority,
  isScopeReadAuthorityCurrent,
  scopeRowMatchesReadAuthority,
} from '../../modules/agent/scope-read-authority'
import { useNavigate } from 'react-router-dom'
import { EmergenceFeedSection } from './EmergenceFeedSection'
import {
  buildBrowserConfirmationCard,
  readBrowserConfirmationRequest,
} from '../../../shared/browser-confirmation-card'

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

async function revealArtifact(artifact: AgentArtifact): Promise<void> {
  const path = artifact.path || artifact.url
  if (!path || !window.electronAPI?.document) return
  await window.electronAPI.document.showInFolder(path).catch(() => undefined)
}

function projectionStatusLabel(status: TaskProjectionRecordData['status'] | undefined): string {
  // `taskPanel` surface always returns a non-null label; fall back to phase
  // helper rather than inlining a canonical label string.
  return projectionStatusToUserLabel(status, 'taskPanel') ?? phaseToUserLabel(undefined, 'taskPanel')
}

function projectionStatusTone(
  status: TaskProjectionRecordData['status'] | undefined,
): { bg: string; color: string } {
  switch (status) {
    case 'completed':
      return { bg: 'var(--color-green-light)', color: 'var(--color-green)' }
    case 'failed':
    case 'killed':
      return { bg: 'rgba(224, 69, 72, 0.12)', color: 'var(--color-red)' }
    case 'recoverable_paused':
    case 'budget_paused':
    case 'blocked':
      return { bg: 'var(--color-orange-light)', color: 'var(--color-orange)' }
    default:
      return { bg: 'var(--color-blue-light)', color: 'var(--color-blue)' }
  }
}

function userFacingTaskSummary(summary: string | null | undefined): string | null {
  const raw = String(summary || '').trim()
  if (!raw) return null
  return formatTaskUserFacingText(raw)
}

function userFacingTaskTitle(title: string | null | undefined): string | null {
  const raw = String(title || '').trim()
  if (!raw) return null
  if (/^(后台)?技能(任务|执行)\s*[·:：-]?/i.test(raw)) return '正在处理后台任务'
  return formatTaskUserFacingText(raw)
}

function selectCurrentProjectionStep(
  steps: TaskProjectionRecordData['steps'],
  currentStepId?: string | null,
): TaskProjectionRecordData['steps'][number] | null {
  return steps.find((step) => step.id === currentStepId)
    || steps.find((step) => step.status === 'running' || step.status === 'blocked')
    || steps.at(-1)
    || null
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

  return selectFallbackProjection(taskProjections)
}

function isStalePausedProjection(item: TaskProjectionRecordData): boolean {
  const actions = item.resumableActions || []
  return item.degradationReason === 'stale_paused'
    && item.canResume !== true
    && !actions.includes('continue')
    && !actions.includes('retry')
}

function isLiveProjectionCandidate(item: TaskProjectionRecordData): boolean {
  return item.status === 'running'
    || item.interactionState === 'resuming'
    || (item.status === 'blocked' && !isStalePausedProjection(item))
}

function selectFallbackProjection(items: TaskProjectionRecordData[]): TaskProjectionRecordData | null {
  return items.find(isLiveProjectionCandidate)
    || items.find((item) => item.status === 'completed' && (item.recentArtifacts?.length || 0) > 0)
    || items.find((item) => item.status === 'completed')
    || items[0]
    || null
}

function captureProjectionActionEpoch(
  projection: Pick<TaskProjectionRecordData, 'scopeId' | 'messageVisibilityEpoch'> | null | undefined,
): number | null {
  if (!projection?.scopeId) return null
  const expectedMessageVisibilityEpoch = captureScopeEpoch(useAgent.getState(), projection.scopeId)
  return expectedMessageVisibilityEpoch !== null
    && projection.messageVisibilityEpoch === expectedMessageVisibilityEpoch
    ? expectedMessageVisibilityEpoch
    : null
}

export default function TaskPanel() {
  const {
    messages,
    currentScopeId,
    scopeAuthorityRevision,
    scopeRunStates,
    setCurrentScope
  } = useAgent()
  const navigate = useNavigate()

  const [taskProjections, setTaskProjections] = useState<TaskProjectionRecordData[]>([])
  const taskProjectionsRequestRevisionRef = useRef(0)
  const activeRun = currentScopeId ? scopeRunStates[currentScopeId] || null : null
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

  const activeTaskTitle = userFacingTaskTitle(activeProjection?.taskTitle || activeRun?.taskTitle)
  const activeTaskSummary = userFacingTaskSummary(activeProjection?.taskSummary || activeRun?.taskSummary)
  const artifactItems = useMemo(() => {
    if (activeProjection?.recentArtifacts && activeProjection.recentArtifacts.length > 0) {
      return activeProjection.recentArtifacts.slice(-6)
    }
    return activeRun?.artifactRefs?.slice(-6) || []
  }, [activeProjection, activeRun])
  const documentPipelineDiagnostics = activeRun?.executionDiagnostics?.pipeline?.document || null
  const projectionSteps = useMemo(() => activeProjection?.steps || [], [activeProjection])
  const currentProjectionStep = useMemo(() => {
    return selectCurrentProjectionStep(projectionSteps, activeProjection?.currentStepId)
  }, [projectionSteps, activeProjection?.currentStepId])
  const projectionProgressLabel = activeProjection?.progress
    ? formatTaskProgressLabel(activeProjection.progress as ScopeRunState['progress'])
    : null
  const currentProjectionStepTitle = currentProjectionStep?.title || currentProjectionStep?.description
    ? formatTaskStepDisplayTitle(
      currentProjectionStep.title || currentProjectionStep.description,
      activeProjection?.progress as ScopeRunState['progress'] | null | undefined,
    )
    : null
  const currentProjectionStepDetail = userFacingTaskSummary(
    currentProjectionStep?.detail || currentProjectionStep?.description,
  )
  const projectionNowLabel =
    projectionProgressLabel
    || currentProjectionStepDetail
    || currentProjectionStepTitle
    || (activeProjection ? interactionStateToUserLabel(activeProjection.interactionState) : null)
  const projectionRecoveryHistory = useMemo(() => {
    return (activeProjection?.recoveryHistory || []).slice(-3).reverse()
  }, [activeProjection])
  const projectionConfirmationRequest = readBrowserConfirmationRequest(activeProjection?.continuationRef)
  const projectionConfirmationCard = projectionConfirmationRequest
    ? buildBrowserConfirmationCard(projectionConfirmationRequest)
    : null
  const projectionRuntimeState = useMemo(() => {
    if (!activeProjection) return null
    return deriveTaskCardRuntimeState({
      scopeId: activeProjection.scopeId,
      taskId: activeProjection.taskId,
      phase:
        activeProjection.status === 'completed'
          ? 'done'
          : activeProjection.status === 'failed'
            ? 'error'
            : activeProjection.status === 'killed'
              ? 'cancelled'
              : activeProjection.status === 'blocked'
                || activeProjection.status === 'recoverable_paused'
                || activeProjection.status === 'budget_paused'
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
      // Stage Q (Stage 11) — propagate main-derived canResume so
      // `deriveTaskCardRuntimeState` correctly gates continue/retry
      // actions through the same single-source truth.
      canResume: activeProjection.canResume,
      updatedAt: activeProjection.updatedAt,
    })
  }, [activeProjection])

  const refreshTaskProjections = useCallback(async () => {
    const requestRevision = ++taskProjectionsRequestRevisionRef.current
    const scopeId = currentScopeId
    const authority = scopeId
      ? captureScopeReadAuthority(useAgent.getState(), [scopeId])
      : null
    if (!scopeId || !authority || !window.electronAPI?.agent?.listTaskProjections) {
      setTaskProjections([])
      return
    }
    const result = await window.electronAPI.agent.listTaskProjections(scopeId).catch(() => null)
    if (taskProjectionsRequestRevisionRef.current !== requestRevision
      || !isScopeReadAuthorityCurrent(useAgent.getState(), authority)) return
    if (!result?.success || !Array.isArray(result.data)) {
      setTaskProjections([])
      return
    }
    setTaskProjections(result.data.filter((row) => (
      scopeRowMatchesReadAuthority(
        authority,
        row.scopeId,
        row.messageVisibilityEpoch,
      )
    )))
  }, [currentScopeId, scopeAuthorityRevision])

  const handleCancelProjection = useCallback(async () => {
    if (!activeProjection?.scopeId) return
    const expectedMessageVisibilityEpoch = captureProjectionActionEpoch(activeProjection)
    if (expectedMessageVisibilityEpoch === null) return
    const detachedTaskId = activeProjection.continuationRef?.detachedTaskId || null
    if (detachedTaskId && window.electronAPI?.agent?.cancelDetachedSkillTask) {
      await window.electronAPI.agent.cancelDetachedSkillTask(detachedTaskId, activeProjection.scopeId).catch(() => null)
      return
    }
    const childRunId = activeProjection.continuationRef?.childRunId || null
    if (childRunId && window.electronAPI?.agent?.cancelChildRun) {
      await window.electronAPI.agent.cancelChildRun(childRunId).catch(() => null)
    }
  }, [activeProjection])

  const phaseColors = phaseTone(activeRun?.phase)
  const projectionColors = projectionStatusTone(activeProjection?.status)

  useEffect(() => {
    taskProjectionsRequestRevisionRef.current += 1
    setTaskProjections([])
  }, [scopeAuthorityRevision])

  useEffect(() => {
    void refreshTaskProjections()
  }, [refreshTaskProjections, activeRun?.updatedAt])

  useEffect(() => {
    if (!window.electronAPI?.agent?.onTaskProjectionsChanged) return
    const debouncer = createDebouncedFetch(refreshTaskProjections, 100)
    const off = window.electronAPI.agent.onTaskProjectionsChanged((event) => {
      if (event.scopeId === useAgent.getState().currentScopeId) {
        debouncer.run()
      }
    })
    return () => {
      try { off?.() } catch { /* silent-catch: projection unsubscribe cleanup is best-effort */ }
      debouncer.cancel()
    }
  }, [refreshTaskProjections])

  return (
    <div
      className="flex-shrink-0 flex flex-col"
      style={{
        width: 240,
        background: 'var(--bg-panel)',
        borderRight: '1px solid var(--border-default)'
      }}
    >
      {/* 梯队三 — emergence feed（空 feed 自动隐藏；出口=打开 scope / 跳设置确认面）。 */}
      <EmergenceFeedSection
        onOpenScope={(scopeId) => { void setCurrentScope(scopeId) }}
        onOpenSettings={() => navigate('/settings')}
      />

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
                className="rounded-[8px] border px-2.5 py-2"
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
                className="rounded-[8px] border px-2.5 py-2"
                style={{
                  borderColor: 'var(--border-default)',
                  background: 'var(--surface-card-bg)'
                }}
              >
                <div className="text-[10px] font-semibold" style={{ color: 'var(--text-light)' }}>
                  当前进展
                </div>
                <div
                  className="mt-1 text-[11px]"
                  style={{ color: 'var(--text-body)', lineHeight: 1.5 }}
                >
                  {projectionNowLabel || '正在处理任务'}
                </div>
                {currentProjectionStepTitle && currentProjectionStepDetail && currentProjectionStepDetail !== currentProjectionStepTitle && (
                  <div
                    className="mt-1 text-[10px]"
                    style={{ color: 'var(--text-light)', lineHeight: 1.5 }}
                  >
                    {currentProjectionStepTitle}
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
                className="rounded-[8px] border px-2.5 py-2"
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
            {activeProjection?.waitingFor === 'confirmation' && projectionConfirmationCard && (
              <div
                data-ready-browser-confirmation-card={projectionConfirmationCard.kind}
                data-ready-browser-confirmation-request-id={projectionConfirmationCard.requestId}
                data-ready-browser-confirmation-target={projectionConfirmationRequest?.target.tabId || ''}
                className="rounded-[8px] border px-2.5 py-2"
                style={{ borderColor: 'var(--border-default)', background: 'var(--bg-subtle)' }}
              >
                <div className="text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {projectionConfirmationCard.title}
                </div>
                <div className="mt-1 text-[10px]" style={{ color: 'var(--text-body)', lineHeight: 1.5 }}>
                  {projectionConfirmationCard.description}
                </div>
                <div className="mt-1 text-[10px]" style={{ color: 'var(--text-light)', lineHeight: 1.5 }}>
                  {projectionConfirmationCard.detail}
                </div>
              </div>
            )}
            {activeProjection && (
              <div className="flex flex-wrap gap-1.5">
                {projectionRuntimeState?.actionSet.includes('cancel') && Boolean(
                  activeProjection.continuationRef?.detachedTaskId
                  || activeProjection.continuationRef?.childRunId
                ) && (
                  <button
                    type="button"
                    onClick={handleCancelProjection}
                    className="rounded-[8px] border px-2.5 py-1.5 text-[10.5px] transition-colors hover:bg-black/5"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-body)' }}
                  >
                    取消任务
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
                    className="rounded-[8px] border px-2.5 py-2"
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
                      className="rounded-[8px] border px-2.5 py-2 text-left hover:bg-black/5 transition-colors"
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
                      {taskStepStatusToUserLabel(step.status)}
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
                    {formatTaskStepDisplayTitle(
                      step.title || step.description,
                      activeProjection.progress as ScopeRunState['progress'] | null | undefined,
                    )}
                  </div>
                  {step.detail && (
                    <div className="mt-1 text-[10px]" style={{ color: 'var(--text-light)', lineHeight: 1.5 }}>
                      {formatTaskUserFacingText(step.detail)}
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

    </div>
  )
}
