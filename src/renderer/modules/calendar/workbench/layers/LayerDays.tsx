import { useState } from 'react'
import { calendarLayers, type CalendarLayer, type LayerEntry } from '../../../../../shared/calendar-layers'
import { openReadyRef } from '../../../workbench/open-ready-ref'
import { useStore, setPrefs, toast } from '../store'
import { readDraggedTodo, scheduleTodo, todoFromLayer, toggleTodo, TODO_MIME } from './todo-actions'

export function LayerSwitches() {
  const enabled = useStore(s => s.prefs.layers)
  return <div className="side-sec" aria-label="日历图层">{calendarLayers.map(layer => <label key={layer.id} className="side-row" style={{ color: layer.color }}>
    <input type="checkbox" aria-label={layer.label} checked={enabled[layer.id]} onChange={() => setPrefs({ layers: { ...enabled, [layer.id]: !enabled[layer.id] } })} />{layer.label}
  </label>)}</div>
}

export function LayerDay({ date, entries, enabled, move }: {
  date: string; entries: LayerEntry[]; enabled: Record<CalendarLayer, boolean>; move: (entry: LayerEntry, date: string) => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  return <div data-layer-day={date} style={{ minHeight: 44, maxHeight: 64, overflow: 'auto', position: 'relative', zIndex: 4 }}
    onPointerDown={e => e.stopPropagation()} onDragOver={e => { if (e.dataTransfer.types.includes('application/x-ready-calendar-layer') || e.dataTransfer.types.includes(TODO_MIME)) e.preventDefault() }}
    onDrop={e => {
      // A to-do from the sidebar list or the tasks layer: Main writes or moves its date link (asking once for Obsidian dates).
      const todo = readDraggedTodo(e.dataTransfer)
      if (todo) {
        e.preventDefault(); e.stopPropagation()
        void scheduleTodo(todo, date).then(state => { if (state === 'unsaved') toast('已在打开的页面里改了日期，保存那一页后生效') }, error => setError(error instanceof Error ? error.message : String(error)))
        return
      }
      const id = e.dataTransfer.getData('application/x-ready-calendar-layer'), entry = entries.find(e => e.id === id)
      if (!entry?.edit) return
      e.preventDefault(); e.stopPropagation(); void move(entry, date).catch(error => setError(String(error)))
    }}>
    {entries.filter(e => enabled[e.layer] && e.date <= date && e.lastDate >= date).map(entry => entry.layer === 'tasks' && todoFromLayer(entry)
      ? <TaskEntry key={entry.id} entry={entry} onError={message => setError(message)} />
      : <button key={entry.id} type="button"
      data-layer-entry={entry.id} data-layer={entry.layer} draggable={!!entry.edit} title={entry.readOnlyReason ?? entry.title}
      style={{ display: 'block', width: '100%', textAlign: 'left', color: calendarLayers.find(l => l.id === entry.layer)!.color, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontSize: 11 }}
      onDragStart={e => { if (!entry.edit) { e.preventDefault(); return } e.dataTransfer.setData('application/x-ready-calendar-layer', entry.id); e.dataTransfer.effectAllowed = 'move' }}
      onClick={() => { void openReadyRef(entry.ref, 'calendar').catch(error => setError(String(error))) }}>{entry.title}</button>)}
    {error && <span role="alert">{error}</span>}
  </div>
}

/** A to-do on its day: tick it here, open its page, or drag it to another day. */
function TaskEntry({ entry, onError }: { entry: LayerEntry; onError(message: string): void }) {
  const handle = todoFromLayer(entry)!
  const report = (error: unknown) => onError(error instanceof Error ? error.message : String(error))
  return <div data-layer-entry={entry.id} data-layer="tasks" className="layer-task" draggable title={handle.title} style={{ color: calendarLayers.find(layer => layer.id === 'tasks')?.color }}
    onDragStart={e => { e.dataTransfer.setData(TODO_MIME, JSON.stringify(handle)); e.dataTransfer.effectAllowed = 'move' }}>
    <button type="button" role="checkbox" aria-checked={!!entry.checked} className="todo-check" aria-label={entry.checked ? `标为未完成：${handle.title}` : `勾掉：${handle.title}`}
      onClick={e => { e.stopPropagation(); void toggleTodo(handle, !entry.checked).then(state => { if (state === 'unsaved') toast('已在打开的页面里改了，保存那一页后生效') }, report) }} />
    <button type="button" className="layer-task-title" data-checked={entry.checked || undefined}
      onClick={() => { void openReadyRef(entry.ref, 'calendar').catch(report) }}>{handle.title}</button>
  </div>
}

