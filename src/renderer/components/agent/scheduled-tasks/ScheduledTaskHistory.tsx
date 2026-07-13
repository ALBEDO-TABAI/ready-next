import { AlertCircle, ArrowLeft, CheckCircle2, Clock3, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { AgentScheduleDefinition, AgentScheduleOccurrence } from '../../../../shared/scheduled-tasks'

export interface ScheduledTaskHistoryProps {
  task: AgentScheduleDefinition
  onBack: () => void
  onOpenOccurrence?: (occurrence: AgentScheduleOccurrence) => void
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value))
}

function statusText(item: AgentScheduleOccurrence): string {
  if (item.interactionState === 'awaiting_confirmation') return '等待确认'
  if (item.interactionState === 'awaiting_clarification') return '等待补充信息'
  if (item.runStatus === 'running') return '运行中'
  if (item.runStatus === 'completed') return '已完成'
  if (item.runStatus === 'failed') return '执行失败'
  if (item.claimStatus === 'dispatch_failed') return '启动失败'
  if (item.claimStatus === 'blocked_target') return '需要处理'
  if (item.claimStatus === 'skipped_coalesced') return '已合并'
  if (item.claimStatus === 'skipped_missed') return '已跳过'
  if (item.claimStatus === 'queued') return '等待执行'
  if (item.claimStatus === 'dispatching') return '正在启动'
  return '已进入会话'
}

function duration(item: AgentScheduleOccurrence): string | null {
  if (!item.startedAt || !item.finishedAt) return null
  const seconds = Math.max(0, Math.round((Date.parse(item.finishedAt) - Date.parse(item.startedAt)) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export function ScheduledTaskHistory({ task, onBack, onOpenOccurrence }: ScheduledTaskHistoryProps) {
  const [items, setItems] = useState<AgentScheduleOccurrence[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const response = await window.electronAPI.scheduledTasks.listOccurrences(task.id, 30)
    if (response.success) {
      setItems(response.data)
      setError(null)
    } else {
      setError(response.error.message)
    }
    setLoading(false)
  }, [task.id])

  useEffect(() => {
    void load()
    return window.electronAPI.scheduledTasks.onChanged((scheduleId) => {
      if (!scheduleId || scheduleId === task.id) void load()
    })
  }, [load, task.id])

  return (
    <section className="scheduled-task-history">
      <header className="scheduled-tasks-subheader">
        <button type="button" className="scheduled-task-icon-button" onClick={onBack} aria-label="返回任务列表">
          <ArrowLeft size={17} />
        </button>
        <div><span>执行历史</span><strong>{task.name}</strong></div>
      </header>

      {loading && <div className="scheduled-tasks-state"><LoaderCircle className="scheduled-tasks-spin" size={20} />正在读取…</div>}
      {!loading && error && <div className="scheduled-tasks-state is-error"><AlertCircle size={20} />{error}<button type="button" onClick={() => void load()}>重试</button></div>}
      {!loading && !error && items.length === 0 && (
        <div className="scheduled-tasks-state"><Clock3 size={22} /><strong>还没有执行记录</strong><span>任务到点或手动运行后，记录会出现在这里。</span></div>
      )}
      {!loading && !error && items.length > 0 && (
        <div className="scheduled-task-history__list">
          {items.map((item) => {
            const failed = item.claimStatus === 'dispatch_failed' || item.claimStatus === 'blocked_target'
            const late = item.delayMs > 60_000
            return (
              <article key={item.id} className="scheduled-task-history__item" data-failed={failed ? 'true' : 'false'}>
                <div className="scheduled-task-history__status">
                  {failed ? <AlertCircle size={16} /> : item.claimStatus === 'dispatched' ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}
                  <strong>{statusText(item)}</strong>
                  <span>{formatDate(item.scheduledFor)}</span>
                </div>
                {late && <p>应用关闭或休眠期间错过，已延迟 {Math.round(item.delayMs / 60_000)} 分钟处理。</p>}
                {(item.errorMessage || item.runBlockedReason) && <p className="is-error">{item.errorMessage || item.runBlockedReason}</p>}
                <div className="scheduled-task-history__details">
                  <span>实际开始 {formatDate(item.startedAt ?? item.triggeredAt)}</span>
                  {duration(item) && <span>用时 {duration(item)}</span>}
                </div>
                {(item.runId || item.taskId) && onOpenOccurrence && (
                  <button type="button" onClick={() => onOpenOccurrence(item)}>
                    {failed || item.interactionState === 'awaiting_confirmation' ? '去处理' : '查看对应会话'}
                  </button>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
