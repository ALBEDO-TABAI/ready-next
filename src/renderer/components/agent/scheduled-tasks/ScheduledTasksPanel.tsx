import { AlertCircle, Clock3, LoaderCircle, Plus, X } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { AgentScheduleDefinition, AgentScheduleOccurrence } from '../../../../shared/scheduled-tasks'
import { LiquidSurfaceLayer } from '../../ui/liquid-glass/LiquidFloatingPanel'
import { ScheduledTaskCard } from './ScheduledTaskCard'
import { ScheduledTaskEditor, type ScheduledTaskAgentOption } from './ScheduledTaskEditor'
import { ScheduledTaskHistory } from './ScheduledTaskHistory'

type TaskFilter = 'all' | 'active' | 'attention'

export interface ScheduledTasksSummary { enabledCount: number; attentionCount: number }

export interface ScheduledTasksPanelProps {
  open: boolean
  onClose: () => void
  presentation?: 'popover' | 'workspace'
  currentScopeId: string | null
  currentAgentId: string
  workspaceRoots: string[]
  agentOptions?: ScheduledTaskAgentOption[]
  onSummaryChange?: (summary: ScheduledTasksSummary) => void
  onOpenOccurrence?: (occurrence: AgentScheduleOccurrence) => void
}

function needsAttention(task: AgentScheduleDefinition): boolean {
  return Boolean(task.blockedReason || task.migrationState)
}

export const ScheduledTasksPanel = forwardRef<HTMLDivElement, ScheduledTasksPanelProps>(function ScheduledTasksPanel({
  open,
  onClose,
  presentation = 'popover',
  currentScopeId,
  currentAgentId,
  workspaceRoots,
  agentOptions,
  onSummaryChange,
  onOpenOccurrence,
}, forwardedRef) {
  const rootRef = useRef<HTMLDivElement>(null)
  const summaryCallbackRef = useRef(onSummaryChange)
  summaryCallbackRef.current = onSummaryChange
  useImperativeHandle(forwardedRef, () => rootRef.current as HTMLDivElement)
  const [tasks, setTasks] = useState<AgentScheduleDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [editing, setEditing] = useState<AgentScheduleDefinition | null | 'new'>(null)
  const [historyTask, setHistoryTask] = useState<AgentScheduleDefinition | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await window.electronAPI.scheduledTasks.list()
    if (response.success) {
      setTasks(response.data)
      setError(null)
      summaryCallbackRef.current?.({
        enabledCount: response.data.filter((task) => task.enabled).length,
        attentionCount: response.data.filter(needsAttention).length,
      })
    } else {
      setError(response.error.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
    return window.electronAPI.scheduledTasks.onChanged(() => void load())
  }, [load])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const onPointerDown = (event: PointerEvent) => {
      if (presentation === 'workspace') return
      const target = event.target as Element | null
      if (target?.closest('.scheduled-tasks-trigger')) return
      if (rootRef.current && target && !rootRef.current.contains(target)) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [onClose, open, presentation])

  useEffect(() => {
    if (!open) { setEditing(null); setHistoryTask(null) }
  }, [open])

  const mutate = async (task: AgentScheduleDefinition, action: 'pause' | 'resume' | 'delete' | 'runNow') => {
    setBusyId(task.id)
    const response = await window.electronAPI.scheduledTasks[action](task.id)
    if (!response.success) setError(response.error.message)
    await load()
    setBusyId(null)
  }

  if (!open) return null

  const filtered = tasks.filter((task) => filter === 'all' || (filter === 'active' ? task.enabled : needsAttention(task)))

  return (
    <div
      ref={rootRef}
      className={`scheduled-tasks-panel ready-app-liquid-panel${presentation === 'workspace' ? ' is-workspace' : ''}`}
      role="dialog"
      aria-modal={presentation === 'workspace'}
      aria-label="定时任务"
    >
      <LiquidSurfaceLayer
        className="ready-liquid-popover__lens ready-app-liquid-panel__lens"
        radius={22}
        sourceSelector={presentation === 'workspace' ? "[data-workbench-content-backdrop='true']" : "[data-liquid-scroll-root='chat-messages']"}
        blur={8}
        frost={0}
        saturation={1.16}
        brightness={1.06}
        contrast={0.82}
      />
      {editing !== null ? (
        <ScheduledTaskEditor
          task={editing === 'new' ? null : editing}
          currentScopeId={currentScopeId}
          currentAgentId={currentAgentId}
          workspaceRoots={workspaceRoots}
          agentOptions={agentOptions}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load() }}
        />
      ) : historyTask ? (
        <ScheduledTaskHistory task={historyTask} onBack={() => setHistoryTask(null)} onOpenOccurrence={onOpenOccurrence} />
      ) : (
        <>
          <header className="scheduled-tasks-panel__header">
            <div><span>自动开始一项工作</span><h2>定时任务</h2></div>
            <div className="scheduled-tasks-panel__header-actions">
              <button type="button" className="scheduled-tasks-new" onClick={() => setEditing('new')}><Plus size={15} />新建</button>
              <button type="button" className="scheduled-task-icon-button" onClick={onClose} aria-label="关闭定时任务"><X size={17} /></button>
            </div>
          </header>

          <nav className="scheduled-tasks-panel__filters" aria-label="任务筛选">
            {([['all', '全部'], ['active', '运行中'], ['attention', '需要处理']] as const).map(([value, label]) => (
              <button key={value} type="button" data-selected={filter === value} onClick={() => setFilter(value)}>{label}{value === 'attention' && tasks.some(needsAttention) ? ` ${tasks.filter(needsAttention).length}` : ''}</button>
            ))}
          </nav>

          <div className="scheduled-tasks-panel__content">
            {loading && <div className="scheduled-tasks-state"><LoaderCircle className="scheduled-tasks-spin" size={20} />正在读取…</div>}
            {!loading && error && <div className="scheduled-tasks-state is-error"><AlertCircle size={20} /><strong>暂时无法读取</strong><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div>}
            {!loading && !error && tasks.length === 0 && <div className="scheduled-tasks-state is-empty"><span className="scheduled-tasks-state__icon"><Clock3 size={23} /></span><strong>让 Agent 按时开始</strong><span>在指定时间让 Agent 自动开始一项工作。</span><button type="button" className="is-primary" onClick={() => setEditing('new')}><Plus size={15} />新建定时任务</button></div>}
            {!loading && !error && tasks.length > 0 && filtered.length === 0 && <div className="scheduled-tasks-state"><strong>没有符合条件的任务</strong><span>换一个筛选条件看看。</span></div>}
            {!loading && !error && filtered.length > 0 && <div className="scheduled-tasks-panel__list">{filtered.map((task) => <ScheduledTaskCard key={task.id} task={task} busy={busyId === task.id} onEdit={setEditing} onHistory={setHistoryTask} onPause={(value) => void mutate(value, 'pause')} onResume={(value) => void mutate(value, 'resume')} onDelete={(value) => void mutate(value, 'delete')} onRunNow={(value) => void mutate(value, 'runNow')} />)}</div>}
          </div>
          <footer className="scheduled-tasks-panel__footer"><span>{tasks.filter((task) => task.enabled).length} 项已启用</span><span>时间由 Ready 主程序统一管理</span></footer>
        </>
      )}
    </div>
  )
})
