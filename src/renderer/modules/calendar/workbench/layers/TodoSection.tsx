import { useCallback, useEffect, useState } from 'react'
import type { TodoEntry } from '../../../../../shared/calendar-layers'
import { isoDate } from '../../../../../shared/calendar/dates'
import { openReadyRef } from '../../../workbench/open-ready-ref'
import { toast, useStore } from '../store'
import { SectionHeader } from '../../../../components/ui/Display'
import { writeTodoTransfer, endTodoTransfer, todoFromList, toggleTodo } from './todo-actions'

// The calendar sidebar's 待办 (W4 §5): every open checkbox in the library, in three groups. Ticking writes the
// one line through Main; dragging a row onto a day gives it that date (LayerDay accepts the drop).
const SHOWN = 6

type Group = { key: 'today' | 'overdue' | 'unscheduled'; label: string; items: TodoEntry[] }

export function TodoSection() {
  const today = useStore(state => isoDate(state.today))
  const [todos, setTodos] = useState<TodoEntry[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const reload = useCallback(async () => {
    try {
      const reply = await window.electronAPI.calendarLayers.listTodos()
      if (!reply.ok) throw new Error(reply.message)
      setTodos(reply.value); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [])
  useEffect(() => {
    void reload()
    return window.electronAPI.calendarLayers.onChanged(() => { void reload() })
  }, [reload])
  const report = (cause: unknown) => { toast(cause instanceof Error ? cause.message : String(cause)); void reload() }
  const groups: Group[] = [
    { key: 'today', label: '今天', items: (todos ?? []).filter(todo => todo.date === today) },
    { key: 'overdue', label: '已过期', items: (todos ?? []).filter(todo => !!todo.date && todo.date < today) },
    { key: 'unscheduled', label: '未安排', items: (todos ?? []).filter(todo => !todo.date) },
  ]
  const visible = groups.filter(group => group.items.length)
  return <div className="side-sec todo-sec" aria-label="待办">
    <SectionHeader title="待办" />
    {error && <p role="alert" className="todo-note">{error}</p>}
    {todos && !visible.length && !error && <p className="todo-note">今天没有要做的，也没有过期或未安排的待办。</p>}
    {visible.map(group => {
      const expanded = open[group.key] || group.items.length <= SHOWN
      return <div key={group.key} className="todo-group" data-todo-group={group.key}>
        <div className="todo-sub">{group.label}<span className="todo-count">{group.items.length}</span></div>
        {(expanded ? group.items : group.items.slice(0, SHOWN)).map(todo => <TodoRow key={todo.id} todo={todo} overdue={group.key === 'overdue'} onError={report} />)}
        {!expanded && <button type="button" className="todo-more" onClick={() => setOpen(current => ({ ...current, [group.key]: true }))}>
          还有 {group.items.length - SHOWN} 项</button>}
      </div>
    })}
  </div>
}

function TodoRow({ todo, overdue, onError }: { todo: TodoEntry; overdue: boolean; onError(cause: unknown): void }) {
  const handle = todoFromList(todo)
  const where = [todo.page.title, todo.heading].filter(Boolean).join(' › ')
  return <div className="side-row todo-row" data-todo-id={todo.id} draggable
    onDragStart={event => { writeTodoTransfer(event.dataTransfer, handle, todo.page.ref); event.dataTransfer.effectAllowed = 'move' }} onDragEnd={endTodoTransfer}>
    <button type="button" role="checkbox" aria-checked={false} className="todo-check" aria-label={`勾掉：${todo.title}`}
      onClick={() => { void toggleTodo(handle, true).then(state => { if (state === 'unsaved') toast('已在打开的页面里勾掉，保存那一页后生效') }, onError) }} />
    <button type="button" className="todo-title" title={where} onClick={() => { void openReadyRef(todo.page.ref, 'calendar').catch(onError) }}>
      <span className="lbl">{todo.title}</span>
      <span className="todo-meta">{overdue && todo.date ? `${Number(todo.date.slice(5, 7))}月${Number(todo.date.slice(8, 10))}日 · ` : ''}{todo.page.title}</span>
    </button>
  </div>
}
