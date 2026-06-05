import { useState, type ReactElement } from 'react'
import { AlertCircle, Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, Minimize2, ShieldAlert, X } from 'lucide-react'

import type { AgentBrowserCollectionTask, AgentBrowserControlState } from '../../modules/browser/useAgentBrowserSupervision'

interface AgentBrowserSupervisionPanelProps {
  controlState: AgentBrowserControlState
  tasks: AgentBrowserCollectionTask[]
  requestInterruption: () => Promise<void>
  confirmInterruption: () => Promise<void>
  dismissInterruption: () => Promise<void>
  variant?: 'floating' | 'pane' | 'collapsed' | 'collapsedRail'
  onCollapse?: () => void
  onExpand?: () => void
  onClose?: () => void
}

function isActiveTask(task: AgentBrowserCollectionTask): boolean {
  return task.status === 'running' || task.status === 'queued' || task.status === 'paused'
}

function isTerminalTask(task: AgentBrowserCollectionTask): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
}

function taskStatusLabel(task: AgentBrowserCollectionTask): string {
  if (task.status === 'completed') return '已完成'
  if (task.status === 'failed') return '失败'
  if (task.status === 'cancelled') return '已取消'
  if (task.status === 'queued') return '等待中'
  if (task.status === 'paused') return '暂停'
  return '运行中'
}

/**
 * Fastcard-style nested sub-agent supervision panel (plan §0.1/§3.6).
 *
 * Hidden until the agent is actually driving the browser (an active
 * note-collection task, or a pending/frozen control gate). Collapsed it is a
 * small floating chip; expanded it lists the dispatched sub-agent sessions
 * (one per background task), each of which expands to its current sub-task
 * (note being collected) + progress. Interrupting the agent's control requires
 * an explicit second confirmation (freeze → confirm).
 *
 * NOTE: positioned over the browser content; because the BrowserView is a
 * native overlay, the exact placement / hideAll behaviour is tuned in live
 * verification.
 */
export function AgentBrowserSupervisionPanel({
  controlState,
  tasks,
  requestInterruption,
  confirmInterruption,
  dismissInterruption,
  variant = 'floating',
  onCollapse,
  onExpand,
  onClose,
}: AgentBrowserSupervisionPanelProps): ReactElement | null {
  const [panelOpen, setPanelOpen] = useState(true)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)

  const activeTasks = tasks.filter(isActiveTask)
  const terminalTasks = tasks.filter(isTerminalTask)
  const visibleTasks = activeTasks.length > 0 ? activeTasks : terminalTasks.slice(0, 1)
  const visible = variant === 'collapsed' || variant === 'collapsedRail' || activeTasks.length > 0 || terminalTasks.length > 0 || controlState !== 'active'
  if (!visible) return null
  const statusText = activeTasks.length > 0
    ? `${activeTasks.length} 个采集`
    : visibleTasks[0]
      ? taskStatusLabel(visibleTasks[0])
      : controlState === 'active'
        ? '浏览中'
        : '等待确认'

  if (variant === 'collapsed' || variant === 'collapsedRail') {
    const task = visibleTasks[0]
    return (
      <button
        type="button"
        onClick={onExpand}
        className={`${variant === 'collapsedRail' ? 'flex w-full justify-center' : 'absolute right-3 top-3 z-[60] flex'} items-center gap-2 rounded-[14px] border px-3 py-2 text-[12px] font-semibold shadow-lg`}
        style={{
          borderColor: 'color-mix(in srgb, var(--color-blue) 36%, transparent)',
          background: 'color-mix(in srgb, var(--surface-card-bg) 96%, transparent)',
          color: 'var(--text-title)',
          boxShadow: '0 0 0 1px color-mix(in srgb, var(--color-blue) 22%, transparent), 0 8px 24px color-mix(in srgb, var(--color-blue) 18%, transparent)',
        }}
      >
        <Bot style={{ width: 15, height: 15 }} className="text-[var(--color-blue)]" strokeWidth={2} />
        <span>Agent 浏览器</span>
        <span style={{ color: 'var(--text-gray)', fontWeight: 500 }}>{task ? taskStatusLabel(task) : statusText}</span>
      </button>
    )
  }

  const containerClass = variant === 'pane'
    ? 'relative z-[1] mx-2 mt-2 mb-1 overflow-hidden rounded-[12px] border text-[12px]'
    : 'absolute bottom-3 right-3 z-[60] w-[280px] overflow-hidden rounded-[16px] border text-[12px] shadow-lg'

  return (
    <div
      className={containerClass}
      style={{
        borderColor: 'color-mix(in srgb, var(--color-blue) 30%, transparent)',
        background: 'color-mix(in srgb, var(--surface-card-bg) 96%, transparent)',
        backdropFilter: 'blur(12px)',
        boxShadow: variant === 'pane'
          ? '0 0 0 1px color-mix(in srgb, var(--color-blue) 18%, transparent), 0 0 18px color-mix(in srgb, var(--color-blue) 20%, transparent)'
          : '0 8px 28px color-mix(in srgb, var(--color-blue) 22%, transparent)',
      }}
    >
      {/* Header chip */}
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        style={{ color: 'var(--text-title)' }}
      >
        <Bot style={{ width: 15, height: 15 }} className="text-[var(--color-blue)]" strokeWidth={2} />
        <span className="flex-1 font-semibold">Agent 正在使用浏览器</span>
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
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {/* Sub-agent session cards */}
          {visibleTasks.map((task) => {
            const total = task.progress.total || task.progress.completed + task.progress.failed
            const done = task.progress.completed + task.progress.failed
            const pct = total > 0 ? Math.round((done / total) * 100) : 0
            const open = expandedTaskId === task.taskId
            const active = isActiveTask(task)
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
                  <span className="min-w-0 flex-1 truncate">{task.progress.currentLabel || '浏览器采集子任务'}</span>
                  <span className="text-[10px]" style={{ color: 'var(--text-gray)' }}>
                    {active ? `${done}/${total || '?'}` : taskStatusLabel(task)}
                  </span>
                </button>
                {/* progress bar */}
                <div className="mx-2.5 mb-1 h-[3px] overflow-hidden rounded-full" style={{ background: 'color-mix(in srgb, var(--text-gray) 18%, transparent)' }}>
                  <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, background: 'var(--color-blue)' }} />
                </div>
                {open && (
                  <div className="px-2.5 pb-2 pt-0.5 text-[11px]" style={{ color: 'var(--text-gray)' }}>
                    <div>当前：{task.progress.currentLabel || '准备中'}</div>
                    <div>已采集 {task.progress.completed} · 失败 {task.progress.failed}</div>
                    {task.error && <div className="text-[var(--color-orange)]">错误：{task.error}</div>}
                  </div>
                )}
              </div>
            )
          })}

          {/* Two-step interrupt */}
          <div className="mt-0.5 px-0.5">
            {controlState === 'active' && (
              <button
                type="button"
                onClick={() => void requestInterruption()}
                className="flex w-full items-center justify-center gap-1.5 rounded-[10px] py-1.5 text-[11px] font-medium transition-colors"
                style={{ background: 'color-mix(in srgb, var(--text-gray) 12%, transparent)', color: 'var(--text-title)' }}
              >
                <ShieldAlert style={{ width: 13, height: 13 }} strokeWidth={2} />
                中断 agent 对浏览器的控制
              </button>
            )}
            {controlState === 'pending_confirm' && (
              <div className="rounded-[10px] p-2" style={{ background: 'color-mix(in srgb, var(--color-orange) 12%, transparent)' }}>
                <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-title)' }}>确定要中断吗？agent 会停止后台采集。</div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void confirmInterruption()}
                    className="flex-1 rounded-[8px] py-1 text-[11px] font-semibold text-white"
                    style={{ background: 'var(--color-orange)' }}
                  >
                    确认中断
                  </button>
                  <button
                    type="button"
                    onClick={() => void dismissInterruption()}
                    className="flex-1 rounded-[8px] py-1 text-[11px] font-medium"
                    style={{ background: 'color-mix(in srgb, var(--text-gray) 14%, transparent)', color: 'var(--text-title)' }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            {controlState === 'frozen' && (
              <div className="rounded-[10px] py-1.5 text-center text-[11px] font-medium" style={{ background: 'color-mix(in srgb, var(--color-orange) 14%, transparent)', color: 'var(--color-orange)' }}>
                已接管：agent 浏览器控制已冻结
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
