import { AlertCircle, CalendarClock, MoreHorizontal, Pause, Pencil, Play, RotateCw } from 'lucide-react'
import { useState } from 'react'
import type { AgentScheduleDefinition, ScheduleSpecV1 } from '../../../../shared/scheduled-tasks'

export interface ScheduledTaskCardProps {
  task: AgentScheduleDefinition
  busy?: boolean
  onEdit: (task: AgentScheduleDefinition) => void
  onPause: (task: AgentScheduleDefinition) => void
  onResume: (task: AgentScheduleDefinition) => void
  onRunNow: (task: AgentScheduleDefinition) => void
  onDelete: (task: AgentScheduleDefinition) => void
  onHistory: (task: AgentScheduleDefinition) => void
}

function formatNextRun(value: string | null): string {
  if (!value) return '暂无下次时间'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function scheduleLabel(spec: ScheduleSpecV1): string {
  if (spec.kind === 'once') return '执行一次'
  if (spec.kind === 'interval') {
    const unit = spec.unit === 'minute' ? '分钟' : spec.unit === 'hour' ? '小时' : '天'
    return `每 ${spec.every} ${unit}`
  }
  if (spec.frequency === 'daily' && spec.weekdays?.length === 5
    && [1, 2, 3, 4, 5].every((day) => spec.weekdays?.includes(day))) return '工作日'
  if (spec.frequency === 'daily') return '每天'
  if (spec.frequency === 'weekly') return '每周'
  if (spec.frequency === 'monthly') return '每月'
  return '每年'
}

function issueLabel(task: AgentScheduleDefinition): string | null {
  if (task.migrationState === 'needs_scope') return '需要重新选择会话'
  if (task.migrationState === 'needs_schedule_review') return '需要确认时间规则'
  if (task.blockedReason === 'blocked_scope_missing') return '目标会话不存在'
  if (task.blockedReason === 'blocked_agent_unavailable') return 'Agent 当前不可用'
  if (task.blockedReason === 'blocked_workspace_unavailable') return '工作区当前不可访问'
  return null
}

export function ScheduledTaskCard({
  task,
  busy = false,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onDelete,
  onHistory,
}: ScheduledTaskCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const issue = issueLabel(task)

  return (
    <article className="scheduled-task-card" data-needs-attention={issue ? 'true' : 'false'}>
      <div className="scheduled-task-card__topline">
        <div className="scheduled-task-card__identity">
          <span className={`scheduled-task-card__state ${task.enabled ? 'is-enabled' : 'is-paused'}`} />
          <strong>{task.name}</strong>
        </div>
        <div className="scheduled-task-card__menu-wrap">
          <button
            type="button"
            className="scheduled-task-icon-button"
            aria-label={`更多操作：${task.name}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="scheduled-task-card__menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onHistory(task) }}>
                <CalendarClock size={14} /> 执行历史
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onEdit(task) }}>
                <Pencil size={14} /> 编辑
              </button>
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}
              >
                删除
              </button>
            </div>
          )}
        </div>
      </div>

      <p className="scheduled-task-card__instruction">{task.instruction}</p>

      <div className="scheduled-task-card__meta">
        <span>{scheduleLabel(task.scheduleSpec)}</span>
        <span>{task.enabled ? formatNextRun(task.nextRunAt) : '已暂停'}</span>
        <span>{task.agentId}</span>
      </div>

      {issue && (
        <button type="button" className="scheduled-task-card__issue" onClick={() => onEdit(task)}>
          <AlertCircle size={15} aria-hidden="true" />
          <span>{issue}</span>
          <span className="scheduled-task-card__issue-action">处理</span>
        </button>
      )}

      <div className="scheduled-task-card__actions">
        <button type="button" disabled={busy || Boolean(issue)} onClick={() => onRunNow(task)}>
          <RotateCw size={14} aria-hidden="true" /> 立即运行
        </button>
        {task.enabled ? (
          <button type="button" disabled={busy} onClick={() => onPause(task)}>
            <Pause size={14} aria-hidden="true" /> 暂停
          </button>
        ) : (
          <button type="button" disabled={busy || Boolean(issue)} onClick={() => onResume(task)}>
            <Play size={14} aria-hidden="true" /> 恢复
          </button>
        )}
      </div>

      {confirmDelete && (
        <div className="scheduled-task-card__confirm" role="alertdialog" aria-label="确认删除">
          <span>删除后不再执行，历史记录仍会保留。</span>
          <div>
            <button type="button" onClick={() => setConfirmDelete(false)}>取消</button>
            <button type="button" className="is-danger" disabled={busy} onClick={() => onDelete(task)}>删除</button>
          </div>
        </div>
      )}
    </article>
  )
}
