import { useState, type ReactElement } from 'react'
import { AlertCircle, Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, LockKeyhole, Minimize2, ShieldAlert, X } from 'lucide-react'

import type {
  AgentBrowserCollectionTask,
  AgentBrowserControlState,
  AgentBrowserSurface,
  BrowserLeaseSurfaceSnapshot,
  BrowserTargetClaimSnapshot,
} from '../../modules/browser/useAgentBrowserSupervision'
import {
  browserTaskStatusLabel,
  isBrowserSupervisionVisibleTaskStatus,
  isBrowserTaskTerminalStatus,
} from '../../../shared/browser-task-status'

interface AgentBrowserSupervisionPanelProps {
  controlState: AgentBrowserControlState
  tasks: AgentBrowserCollectionTask[]
  claims: BrowserTargetClaimSnapshot[]
  requestInterruption: () => Promise<void>
  resumeTargetClaim: (claim: BrowserTargetClaimSnapshot) => Promise<{ success: boolean; error?: string; errorKind?: string }>
  surfaces?: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot> | null
  activeWriteSurface?: AgentBrowserSurface | null
  takeoverError?: string | null
  variant?: 'floating' | 'pane' | 'collapsed' | 'collapsedRail'
  onCollapse?: () => void
  onExpand?: () => void
  onClose?: () => void
}

function surfaceLabel(surface: AgentBrowserSurface): string {
  return surface === 'user-view' ? '当前可见页协作' : '后台 Agent 页'
}

function activeSurfaceLockText(
  surfaces?: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot> | null,
  activeWriteSurface?: AgentBrowserSurface | null,
): string | null {
  if (!surfaces) return null
  const takeoverSurface = (['user-view', 'agent-view'] as AgentBrowserSurface[])
    .find((surface) => surfaces[surface]?.state === 'takeover')
  if (takeoverSurface) return `${surfaceLabel(takeoverSurface)}已由用户接管`
  if (!activeWriteSurface) return null
  const snapshot = surfaces[activeWriteSurface]
  if (!snapshot || snapshot.state !== 'held') return null
  return `${surfaceLabel(activeWriteSurface)}写锁${snapshot.heldBy ? ` · ${snapshot.heldBy}` : ''}`
}

function isActiveTask(task: AgentBrowserCollectionTask): boolean {
  return isBrowserSupervisionVisibleTaskStatus(task.status)
}

function isTerminalTask(task: AgentBrowserCollectionTask): boolean {
  return isBrowserTaskTerminalStatus(task.status)
}

/**
 * Fastcard-style nested sub-agent supervision panel (plan §0.1/§3.6).
 *
 * Hidden until the agent is actually driving the browser (an active
 * note-collection task, or a pending/frozen control gate). Collapsed it is a
 * small floating chip; expanded it lists the dispatched sub-agent sessions
 * (one per background task), each of which expands to its current sub-task
 * (note being collected) + progress. A user takeover is immediate.
 *
 * NOTE: positioned over the browser content; because the BrowserView is a
 * native overlay, the exact placement / hideAll behaviour is tuned in live
 * verification.
 */
export function AgentBrowserSupervisionPanel({
  controlState,
  tasks,
  claims = [],
  requestInterruption,
  resumeTargetClaim = async () => ({ success: false, error: 'target_claim_resume_unavailable' }),
  surfaces,
  activeWriteSurface,
  takeoverError,
  variant = 'floating',
  onCollapse,
  onExpand,
  onClose,
}: AgentBrowserSupervisionPanelProps): ReactElement | null {
  const [panelOpen, setPanelOpen] = useState(true)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [resumingClaimId, setResumingClaimId] = useState<string | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)

  const activeTasks = tasks.filter(isActiveTask)
  const userOwnedClaims = claims.filter((claim) => claim.state === 'user_owned')
  const terminalTasks = tasks.filter(isTerminalTask)
  const visibleTasks = activeTasks.length > 0 ? activeTasks : terminalTasks.slice(0, 1)
  const visible = variant === 'collapsed' || variant === 'collapsedRail' || activeTasks.length > 0 || terminalTasks.length > 0 || userOwnedClaims.length > 0 || controlState !== 'active' || Boolean(takeoverError)
  if (!visible) return null
  const waitingForVerification = activeTasks.some((task) => task.status === 'waiting_human')
  const statusText = activeTasks.length > 0
    ? waitingForVerification ? '等待确认' : `${activeTasks.length} 个采集`
    : visibleTasks[0]
      ? browserTaskStatusLabel(visibleTasks[0].status)
      : controlState === 'active'
        ? '浏览中'
        : userOwnedClaims.length > 0 ? `${userOwnedClaims.length} 页待继续` : '已接管'
  const surfaceLockText = activeSurfaceLockText(surfaces, activeWriteSurface)
  const surfaceModeLabel = activeWriteSurface === 'user-view'
    ? '当前页协作'
    : activeWriteSurface === 'agent-view'
      ? '后台 Agent 页'
      : 'Agent 浏览器'
  const headerTitle = activeWriteSurface === 'user-view'
    ? 'Agent 正在协作当前页'
    : activeWriteSurface === 'agent-view'
      ? 'Agent 正在后台页工作'
      : 'Agent 浏览器监控'

  if (variant === 'collapsed' || variant === 'collapsedRail') {
    const task = visibleTasks[0]
    return (
      <button
        type="button"
        onClick={onExpand}
        className={`${variant === 'collapsedRail' ? 'flex w-full justify-center' : 'absolute right-3 top-3 z-[60] flex'} items-center gap-2 rounded-[12px] border px-3 py-2 text-[12px] font-semibold shadow-lg`}
        style={{
          borderColor: 'color-mix(in srgb, var(--color-blue) 36%, transparent)',
          background: 'color-mix(in srgb, var(--surface-card-bg) 96%, transparent)',
          color: 'var(--text-title)',
          boxShadow: '0 0 0 1px color-mix(in srgb, var(--color-blue) 22%, transparent), 0 8px 24px color-mix(in srgb, var(--color-blue) 18%, transparent)',
        }}
      >
        <Bot style={{ width: 15, height: 15 }} className="text-[var(--color-blue)]" strokeWidth={2} />
        <span>{surfaceModeLabel}</span>
        <span style={{ color: 'var(--text-gray)', fontWeight: 500 }}>{task ? browserTaskStatusLabel(task.status) : statusText}</span>
      </button>
    )
  }

  const containerClass = variant === 'pane'
    ? 'relative z-[1] mx-2 mt-2 mb-1 flex min-h-0 flex-col overflow-hidden rounded-[12px] border text-[12px]'
    : 'absolute bottom-3 right-3 z-[60] w-[280px] overflow-hidden rounded-[16px] border text-[12px] shadow-lg'

  return (
    <div
      className={containerClass}
      style={{
        borderColor: 'color-mix(in srgb, var(--color-blue) 30%, transparent)',
        background: 'color-mix(in srgb, var(--surface-card-bg) 96%, transparent)',
        backdropFilter: 'blur(12px)',
        maxHeight: variant === 'pane' ? '40%' : undefined,
        boxShadow: variant === 'pane'
          ? '0 0 0 1px color-mix(in srgb, var(--color-blue) 18%, transparent), 0 0 18px color-mix(in srgb, var(--color-blue) 20%, transparent)'
          : '0 8px 28px color-mix(in srgb, var(--color-blue) 22%, transparent)',
      }}
    >
      {/* Header chip */}
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        className="flex w-full shrink-0 items-center gap-2 px-3 py-2 text-left"
        style={{ color: 'var(--text-title)' }}
      >
        <Bot style={{ width: 15, height: 15 }} className="text-[var(--color-blue)]" strokeWidth={2} />
        <span className="flex-1 font-semibold">{headerTitle}</span>
        <span
          className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
          style={{ background: 'var(--color-blue-light)', color: 'var(--color-blue)' }}
        >
          {statusText}
        </span>
        {panelOpen ? <ChevronDown style={{ width: 14, height: 14 }} /> : <ChevronRight style={{ width: 14, height: 14 }} />}
      </button>
      {(onCollapse || onClose) && (
        <div className="absolute right-2 top-2 flex items-center gap-1">
          {onCollapse && (activeTasks.length > 0 || terminalTasks.length === 0) && (
            <button
              type="button"
              onClick={onCollapse}
              className="flex h-6 w-6 items-center justify-center rounded-[8px]"
              style={{ color: 'var(--text-gray)' }}
              title="折叠 Agent 浏览器监控"
            >
              <Minimize2 style={{ width: 13, height: 13 }} strokeWidth={2} />
            </button>
          )}
          {onClose && activeTasks.length === 0 && (terminalTasks.length > 0 || tasks.length === 0) && (
            <button
              type="button"
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded-[8px]"
              style={{ color: 'var(--text-gray)' }}
              title="关闭 Agent 浏览器面板"
            >
              <X style={{ width: 13, height: 13 }} strokeWidth={2} />
            </button>
          )}
        </div>
      )}

      {panelOpen && (
        <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
          {takeoverError && (
            <div
              role="alert"
              data-browser-takeover-error
              className="flex items-start gap-1.5 rounded-[8px] px-2 py-1.5 text-[11px] font-medium"
              style={{ background: 'color-mix(in srgb, var(--color-red) 12%, transparent)', color: 'var(--color-red)' }}
            >
              <AlertCircle style={{ width: 13, height: 13, flexShrink: 0 }} strokeWidth={2} />
              <span>{takeoverError}</span>
            </div>
          )}
          {/* Sub-agent session cards */}
          {surfaceLockText && (
            <div
              className="flex items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-[11px] font-medium"
              data-browser-surface-lock={activeWriteSurface || 'takeover'}
              style={{
                background: 'color-mix(in srgb, var(--color-blue) 10%, transparent)',
                color: 'var(--text-title)',
              }}
            >
              <LockKeyhole style={{ width: 13, height: 13 }} className="text-[var(--color-blue)]" strokeWidth={2} />
              <span className="min-w-0 truncate">{surfaceLockText}</span>
            </div>
          )}

          {visibleTasks.map((task) => {
            const total = task.progress.total || task.progress.completed + task.progress.failed
            const done = task.progress.completed + task.progress.failed
            const pct = total > 0 ? Math.round((done / total) * 100) : 0
            const open = expandedTaskId === task.taskId
            const active = isActiveTask(task)
            const taskStatusText = task.status === 'waiting_human'
              ? browserTaskStatusLabel(task.status)
              : active
                ? `${done}/${total || '?'}`
                : browserTaskStatusLabel(task.status)
            return (
              <div
                key={task.taskId}
                className="rounded-[12px] border"
                style={{ borderColor: 'color-mix(in srgb, var(--text-gray) 16%, transparent)', background: 'color-mix(in srgb, var(--surface-card-bg) 60%, transparent)' }}
              >
                <button
                  type="button"
                  onClick={() => setExpandedTaskId(open ? null : task.taskId)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
                  style={{ color: 'var(--text-title)' }}
                >
                  {task.status === 'running'
                    ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin text-[var(--color-blue)]" strokeWidth={2} />
                    : task.status === 'completed'
                      ? <CheckCircle2 style={{ width: 13, height: 13 }} className="text-[var(--color-green)]" strokeWidth={2} />
                      : task.status === 'failed' || task.status === 'cancelled'
                        ? <AlertCircle style={{ width: 13, height: 13 }} className="text-[var(--color-orange)]" strokeWidth={2} />
                        : <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: 'var(--text-gray)' }} />}
                  <span className="min-w-0 flex-1 truncate">{task.progress.currentLabel || '浏览器子任务'}</span>
                  <span className="text-[10px]" style={{ color: 'var(--text-gray)' }}>
                    {taskStatusText}
                  </span>
                </button>
                {/* progress bar */}
                <div className="mx-2.5 mb-1 h-[3px] overflow-hidden rounded-full" style={{ background: 'color-mix(in srgb, var(--text-gray) 18%, transparent)' }}>
                  <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, background: 'var(--color-blue)' }} />
                </div>
                {open && (
                  <div className="px-2.5 pb-2 pt-0.5 text-[11px]" style={{ color: 'var(--text-gray)' }}>
                    <div>当前：{task.progress.currentLabel || '准备中'}</div>
                    <div>已完成 {task.progress.completed} · 失败 {task.progress.failed}</div>
                    {task.error && <div className="text-[var(--color-orange)]">错误：{task.error}</div>}
                  </div>
                )}
              </div>
            )
          })}

          {userOwnedClaims.map((claim) => (
            <div
              key={claim.claimId}
              className="rounded-[12px] border p-2.5"
              data-browser-target-user-owned={claim.tabId}
              style={{
                borderColor: 'color-mix(in srgb, var(--color-orange) 34%, transparent)',
                background: 'color-mix(in srgb, var(--color-orange) 8%, transparent)',
              }}
            >
              <div className="flex items-center gap-2" style={{ color: 'var(--text-title)' }}>
                <ShieldAlert style={{ width: 13, height: 13 }} className="text-[var(--color-orange)]" strokeWidth={2} />
                <span className="min-w-0 flex-1 truncate">页面 {claim.tabId} 已由你接管</span>
              </div>
              <div className="mt-1 truncate text-[10px]" style={{ color: 'var(--text-gray)' }}>
                任务 {claim.parentTaskId}
              </div>
              <button
                type="button"
                disabled={resumingClaimId !== null || !claim.suspensionCheckpointId}
                onClick={() => {
                  setResumingClaimId(claim.claimId)
                  setResumeError(null)
                  void resumeTargetClaim(claim)
                    .then((result) => {
                      if (!result.success) setResumeError(result.error || '暂时无法继续')
                    })
                    .finally(() => setResumingClaimId(null))
                }}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[8px] py-1.5 text-[11px] font-semibold disabled:opacity-50"
                style={{ background: 'var(--color-blue)', color: 'white' }}
              >
                {resumingClaimId === claim.claimId && <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" strokeWidth={2} />}
                继续 Agent
              </button>
            </div>
          ))}
          {resumeError && (
            <div className="px-1 text-[10px]" role="alert" style={{ color: 'var(--color-orange)' }}>
              {resumeError}
            </div>
          )}

          {/* Immediate takeover */}
          <div className="mt-0.5 px-0.5">
            {controlState === 'active' && (activeTasks.length > 0 || activeWriteSurface === 'agent-view') && (
              <button
                type="button"
                onClick={() => void requestInterruption()}
                className="flex w-full items-center justify-center gap-1.5 rounded-[8px] py-1.5 text-[11px] font-medium transition-colors"
                style={{ background: 'color-mix(in srgb, var(--text-gray) 12%, transparent)', color: 'var(--text-title)' }}
              >
                <ShieldAlert style={{ width: 13, height: 13 }} strokeWidth={2} />
                立即接管浏览器
              </button>
            )}
            {controlState === 'frozen' && (
              <div className="rounded-[8px] py-1.5 text-center text-[11px] font-medium" style={{ background: 'color-mix(in srgb, var(--color-orange) 14%, transparent)', color: 'var(--color-orange)' }}>
                已接管的页面已暂停，其他页面不受影响
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
