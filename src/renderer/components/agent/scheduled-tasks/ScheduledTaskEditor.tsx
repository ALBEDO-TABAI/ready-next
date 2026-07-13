import { AlertCircle, ArrowLeft, Check, LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  AgentScheduleDefinition,
  ScheduleMutationRequest,
  SchedulePreview,
  ScheduleSpecV1,
} from '../../../../shared/scheduled-tasks'

type FrequencyMode = 'once' | 'daily' | 'workday' | 'weekly' | 'monthly' | 'yearly' | 'interval' | 'custom'

export interface ScheduledTaskAgentOption { id: string; name: string }

export interface ScheduledTaskEditorProps {
  task?: AgentScheduleDefinition | null
  currentScopeId: string | null
  currentAgentId: string
  workspaceRoots: string[]
  agentOptions?: ScheduledTaskAgentOption[]
  onCancel: () => void
  onSaved: (task: AgentScheduleDefinition) => void
}

const WEEKDAYS = [
  { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' },
  { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' }, { value: 7, label: '日' },
]

function localDateInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

function localDateTimeInput(value: string): string {
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function inferMode(spec?: ScheduleSpecV1): FrequencyMode {
  if (!spec) return 'daily'
  if (spec.kind !== 'calendar') return spec.kind
  if (spec.frequency === 'daily' && spec.weekdays?.length === 5 && [1, 2, 3, 4, 5].every((day) => spec.weekdays?.includes(day))) return 'workday'
  if (spec.months?.length || spec.until || spec.count || (spec.weekdays?.length && spec.frequency === 'daily')) return 'custom'
  return spec.frequency
}

function formatPreview(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    weekday: 'short', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

export function ScheduledTaskEditor({
  task,
  currentScopeId,
  currentAgentId,
  workspaceRoots,
  agentOptions,
  onCancel,
  onSaved,
}: ScheduledTaskEditorProps) {
  const existingCalendar = task?.scheduleSpec.kind === 'calendar' ? task.scheduleSpec : null
  const now = new Date()
  const [name, setName] = useState(task?.name ?? '')
  const [instruction, setInstruction] = useState(task?.instruction ?? '')
  const [mode, setMode] = useState<FrequencyMode>(() => inferMode(task?.scheduleSpec))
  const [localDate, setLocalDate] = useState(task?.scheduleSpec.kind === 'once' ? task.scheduleSpec.localDate : localDateInput(new Date(now.getTime() + 86_400_000)))
  const [localTime, setLocalTime] = useState(task?.scheduleSpec.kind === 'once' || task?.scheduleSpec.kind === 'calendar' ? task.scheduleSpec.localTime : '09:00')
  const [weekdays, setWeekdays] = useState<number[]>(existingCalendar?.weekdays ?? [])
  const [dayOfMonth, setDayOfMonth] = useState(existingCalendar?.dayOfMonth ?? 1)
  const [months, setMonths] = useState<number[]>(existingCalendar?.months ?? [1])
  const [customUseDay, setCustomUseDay] = useState(existingCalendar?.dayOfMonth !== undefined)
  const [customUseMonths, setCustomUseMonths] = useState(Boolean(existingCalendar?.months?.length))
  const [intervalEvery, setIntervalEvery] = useState(task?.scheduleSpec.kind === 'interval' ? task.scheduleSpec.every : 30)
  const [intervalUnit, setIntervalUnit] = useState<'minute' | 'hour' | 'day'>(task?.scheduleSpec.kind === 'interval' ? task.scheduleSpec.unit : 'minute')
  const [anchorAt, setAnchorAt] = useState(task?.scheduleSpec.kind === 'interval' ? localDateTimeInput(task.scheduleSpec.anchorAt) : localDateTimeInput(now.toISOString()))
  const [timezone, setTimezone] = useState(task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [agentId, setAgentId] = useState(task?.agentId ?? currentAgentId)
  const [scopeMode, setScopeMode] = useState<'dedicated' | 'existing'>(task?.scopeMode ?? 'dedicated')
  const [scopeId, setScopeId] = useState(task?.scopeId ?? currentScopeId ?? '')
  const [roots, setRoots] = useState((task?.workspaceRoots ?? workspaceRoots).join('\n'))
  const [until, setUntil] = useState(existingCalendar?.until ?? '')
  const [count, setCount] = useState(existingCalendar?.count?.toString() ?? '')
  const [missedPolicy, setMissedPolicy] = useState<'coalesce_latest' | 'skip'>(task?.missedPolicy ?? 'coalesce_latest')
  const [enabled, setEnabled] = useState(task?.enabled ?? true)
  const [advanced, setAdvanced] = useState(Boolean(existingCalendar?.until || existingCalendar?.count || task?.missedPolicy === 'skip'))
  const [preview, setPreview] = useState<SchedulePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const scheduleSpec = useMemo<ScheduleSpecV1>(() => {
    if (mode === 'once') return { kind: 'once', localDate, localTime }
    if (mode === 'interval') return {
      kind: 'interval', every: intervalEvery, unit: intervalUnit,
      anchorAt: Number.isNaN(Date.parse(anchorAt)) ? '' : new Date(anchorAt).toISOString(),
    }
    const limits = advanced ? {
      ...(until ? { until } : {}),
      ...(count ? { count: Number(count) } : {}),
    } : {}
    if (mode === 'workday') return { kind: 'calendar', frequency: 'daily', localTime, weekdays: [1, 2, 3, 4, 5], ...limits }
    if (mode === 'weekly') return { kind: 'calendar', frequency: 'weekly', localTime, weekdays, ...limits }
    if (mode === 'monthly') return { kind: 'calendar', frequency: 'monthly', localTime, dayOfMonth, ...limits }
    if (mode === 'yearly') return { kind: 'calendar', frequency: 'yearly', localTime, months, dayOfMonth, ...limits }
    if (mode === 'custom') return {
      kind: 'calendar', frequency: 'daily', localTime,
      ...(weekdays.length ? { weekdays } : {}),
      ...(customUseMonths && months.length ? { months } : {}),
      ...(customUseDay ? { dayOfMonth } : {}),
      ...limits,
    }
    return { kind: 'calendar', frequency: 'daily', localTime, ...limits }
  }, [advanced, anchorAt, count, customUseDay, customUseMonths, dayOfMonth, intervalEvery, intervalUnit, localDate, localTime, mode, months, until, weekdays])

  const localError = useMemo(() => {
    if (!instruction.trim()) return '请填写要让 Agent 完成的事'
    if (!timezone.trim()) return '请填写时区'
    if (!agentId.trim()) return '请选择 Agent'
    if (scopeMode === 'existing' && !scopeId.trim()) return '请选择当前会话'
    if (mode === 'weekly' && weekdays.length === 0) return '请至少选择一个星期'
    if (mode === 'interval' && Number.isNaN(Date.parse(anchorAt))) return '请选择间隔起点'
    if (mode === 'interval' && (!Number.isInteger(intervalEvery) || intervalEvery < 1 || (intervalUnit === 'minute' && intervalEvery < 5))) return '分钟间隔不能少于 5 分钟'
    return null
  }, [agentId, anchorAt, instruction, intervalEvery, intervalUnit, mode, scopeId, scopeMode, timezone, weekdays.length])

  useEffect(() => {
    if (localError) { setPreview(null); setPreviewError(null); return }
    let active = true
    setPreviewing(true)
    const timer = window.setTimeout(async () => {
      const response = await window.electronAPI.scheduledTasks.preview({ scheduleSpec, timezone, count: 3 })
      if (!active) return
      if (response.success) { setPreview(response.data); setPreviewError(null) }
      else { setPreview(null); setPreviewError(response.error.message) }
      setPreviewing(false)
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [localError, scheduleSpec, timezone])

  const toggleWeekday = (day: number) => setWeekdays((values) => values.includes(day) ? values.filter((value) => value !== day) : [...values, day].sort())
  const toggleMonth = (month: number) => setMonths((values) => values.includes(month) ? values.filter((value) => value !== month) : [...values, month].sort((a, b) => a - b))

  const submit = async () => {
    if (localError || previewError || !preview?.occurrences.length) return
    setSaving(true); setSaveError(null)
    const base: ScheduleMutationRequest = {
      name: name.trim(), instruction: instruction.trim(), scheduleSpec, timezone: timezone.trim(), agentId: agentId.trim(),
      workspaceRoots: roots.split('\n').map((value) => value.trim()).filter(Boolean), enabled, missedPolicy,
      ...(scopeMode === 'dedicated' ? { scopeMode } : { scopeMode, scopeId: scopeId.trim() }),
    }
    const response = task
      ? await window.electronAPI.scheduledTasks.update({ ...base, id: task.id })
      : await window.electronAPI.scheduledTasks.create(base)
    if (response.success) onSaved(response.data)
    else setSaveError(response.error.message)
    setSaving(false)
  }

  return (
    <section className="scheduled-task-editor">
      <header className="scheduled-tasks-subheader">
        <button type="button" className="scheduled-task-icon-button" onClick={onCancel} aria-label="返回任务列表"><ArrowLeft size={17} /></button>
        <div><span>{task ? '编辑定时任务' : '新建定时任务'}</span><strong>{task?.name ?? '设置时间与执行目标'}</strong></div>
      </header>

      <div className="scheduled-task-editor__body">
        <label><span>名称（可选）</span><input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="留空时使用指令首句" /></label>
        <label><span>指令</span><textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={4} placeholder="清楚写下希望 Agent 到时完成的事…" /></label>
        <label><span>频率</span><select value={mode} onChange={(event) => setMode(event.target.value as FrequencyMode)}>
          <option value="once">一次</option><option value="daily">每天</option><option value="workday">工作日</option>
          <option value="weekly">每周</option><option value="monthly">每月</option><option value="yearly">每年</option>
          <option value="interval">间隔</option><option value="custom">自定义日历规则</option>
        </select></label>

        {mode === 'once' && <div className="scheduled-task-editor__row"><label><span>日期</span><input type="date" value={localDate} onChange={(event) => setLocalDate(event.target.value)} /></label><label><span>时间</span><input type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} /></label></div>}
        {mode !== 'once' && mode !== 'interval' && <label><span>时间</span><input type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} /></label>}
        {(mode === 'weekly' || mode === 'custom') && <fieldset><legend>星期</legend><div className="scheduled-task-editor__choice-grid is-weekdays">{WEEKDAYS.map((day) => <button key={day.value} type="button" data-selected={weekdays.includes(day.value)} onClick={() => toggleWeekday(day.value)}>{day.label}</button>)}</div></fieldset>}
        {(mode === 'monthly' || mode === 'yearly') && <label><span>日期（几号）</span><input type="number" min={1} max={31} value={dayOfMonth} onChange={(event) => setDayOfMonth(Number(event.target.value))} /></label>}
        {mode === 'custom' && <><label className="scheduled-task-editor__check"><input type="checkbox" checked={customUseDay} onChange={(event) => setCustomUseDay(event.target.checked)} /><span>限定为每月某一天</span></label>{customUseDay && <label><span>日期（几号）</span><input type="number" min={1} max={31} value={dayOfMonth} onChange={(event) => setDayOfMonth(Number(event.target.value))} /></label>}<label className="scheduled-task-editor__check"><input type="checkbox" checked={customUseMonths} onChange={(event) => setCustomUseMonths(event.target.checked)} /><span>限定月份</span></label></>}
        {(mode === 'yearly' || (mode === 'custom' && customUseMonths)) && <fieldset><legend>月份</legend><div className="scheduled-task-editor__choice-grid">{Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <button key={month} type="button" data-selected={months.includes(month)} onClick={() => toggleMonth(month)}>{month}月</button>)}</div></fieldset>}
        {mode === 'interval' && <><div className="scheduled-task-editor__row"><label><span>每隔</span><input type="number" min={intervalUnit === 'minute' ? 5 : 1} value={intervalEvery} onChange={(event) => setIntervalEvery(Number(event.target.value))} /></label><label><span>单位</span><select value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as typeof intervalUnit)}><option value="minute">分钟</option><option value="hour">小时</option><option value="day">天</option></select></label></div><label><span>从这一刻开始</span><input type="datetime-local" value={anchorAt} onChange={(event) => setAnchorAt(event.target.value)} /></label></>}

        <div className="scheduled-task-editor__row"><label><span>时区</span><input value={timezone} onChange={(event) => setTimezone(event.target.value)} list="scheduled-task-timezones" /></label><label><span>Agent</span>{agentOptions?.length ? <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agentOptions.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select> : <input value={agentId} onChange={(event) => setAgentId(event.target.value)} />}</label></div>
        <datalist id="scheduled-task-timezones"><option value="Asia/Singapore" /><option value="Asia/Shanghai" /><option value="America/Los_Angeles" /><option value="Europe/London" /><option value="UTC" /></datalist>

        <fieldset><legend>会话</legend><div className="scheduled-task-editor__segmented"><button type="button" data-selected={scopeMode === 'dedicated'} onClick={() => setScopeMode('dedicated')}>专用任务会话</button><button type="button" data-selected={scopeMode === 'existing'} disabled={!currentScopeId && !task?.scopeId} onClick={() => setScopeMode('existing')}>当前会话</button></div></fieldset>
        {scopeMode === 'existing' && <label><span>会话目标</span><input value={scopeId} onChange={(event) => setScopeId(event.target.value)} placeholder="会话 ID" /></label>}
        <label><span>工作区（每行一个）</span><textarea value={roots} onChange={(event) => setRoots(event.target.value)} rows={2} /></label>

        <button type="button" className="scheduled-task-editor__advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>高级设置 {advanced ? '−' : '+'}</button>
        {advanced && <div className="scheduled-task-editor__advanced"><div className="scheduled-task-editor__row"><label><span>结束日期</span><input type="date" value={until} onChange={(event) => setUntil(event.target.value)} /></label><label><span>最多执行次数</span><input type="number" min={1} max={10000} value={count} onChange={(event) => setCount(event.target.value)} /></label></div><label><span>错过后</span><select value={missedPolicy} onChange={(event) => setMissedPolicy(event.target.value as typeof missedPolicy)}><option value="coalesce_latest">只补最新一次</option><option value="skip">跳过，不补执行</option></select></label><label className="scheduled-task-editor__check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>保存后立即启用</span></label></div>}

        <div className="scheduled-task-editor__preview" data-invalid={previewError || localError ? 'true' : 'false'}>
          <div><strong>未来三次</strong>{previewing && <LoaderCircle className="scheduled-tasks-spin" size={15} />}</div>
          {(localError || previewError) ? <p><AlertCircle size={15} />{localError ?? previewError}</p> : <ol>{preview?.occurrences.map((value) => <li key={value}><Check size={14} />{formatPreview(value)} <small>{timezone}</small></li>)}</ol>}
        </div>
        {saveError && <p className="scheduled-task-editor__save-error"><AlertCircle size={15} />{saveError}</p>}
      </div>

      <footer className="scheduled-task-editor__footer"><button type="button" onClick={onCancel}>取消</button><button type="button" className="is-primary" disabled={saving || previewing || Boolean(localError || previewError) || !preview?.occurrences.length} onClick={() => void submit()}>{saving ? '保存中…' : '保存任务'}</button></footer>
    </section>
  )
}
