import { useState } from 'react'
import { calendarLayers, type CalendarLayer, type LayerEntry } from '../../../../../shared/calendar-layers'
import { openReadyRef } from '../../../workbench/open-ready-ref'
import { useStore, setPrefs } from '../store'

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
    onPointerDown={e => e.stopPropagation()} onDragOver={e => { if (e.dataTransfer.types.includes('application/x-ready-calendar-layer')) e.preventDefault() }}
    onDrop={e => {
      const id = e.dataTransfer.getData('application/x-ready-calendar-layer'), entry = entries.find(e => e.id === id)
      if (!entry?.edit) return
      e.preventDefault(); e.stopPropagation(); void move(entry, date).catch(error => setError(String(error)))
    }}>
    {entries.filter(e => enabled[e.layer] && e.date <= date && e.lastDate >= date).map(entry => <button key={entry.id} type="button"
      data-layer-entry={entry.id} data-layer={entry.layer} draggable={!!entry.edit} title={entry.readOnlyReason ?? entry.title}
      style={{ display: 'block', width: '100%', textAlign: 'left', color: calendarLayers.find(l => l.id === entry.layer)!.color, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontSize: 11 }}
      onDragStart={e => { if (!entry.edit) { e.preventDefault(); return } e.dataTransfer.setData('application/x-ready-calendar-layer', entry.id); e.dataTransfer.effectAllowed = 'move' }}
      onClick={() => { void openReadyRef(entry.ref, 'calendar').catch(error => setError(String(error))) }}>{entry.title}</button>)}
    {error && <span role="alert">{error}</span>}
  </div>
}
