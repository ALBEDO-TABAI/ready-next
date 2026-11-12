import { useEffect, useRef, useState } from 'react'
import type { CalendarSnapshot } from '../../../../shared/calendar/commands'
import type { ScheduleCard } from '../../../../shared/calendar-linkage'
import { fromWall } from '../../../../shared/calendar/tz'
import { Button, Input, Select } from '../../../components/ui'
export function ScheduleCardDialog({ objectId, nodeId, version, title: initialTitle, snapshot, close, saved }: {
  objectId: string; nodeId: string; version: string; title: string; snapshot: CalendarSnapshot; close(): void; saved(): Promise<void>
}) {
  const calendars = snapshot.calendars.filter(c => !c.readOnly && !c.syncUrl)
  const zone = typeof snapshot.prefs?.primaryTimeZone === 'string' ? snapshot.prefs.primaryTimeZone : Intl.DateTimeFormat().resolvedOptions().timeZone
  const [calendarId, setCalendar] = useState(calendars.find(c => c.primary)?.id || calendars[0]?.id || '')
  const [title, setTitle] = useState(initialTitle), [start, setStart] = useState(''), [end, setEnd] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), intent = useRef<ScheduleCard | null>(null)
  const lock = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const instant = (value: string) => { const [y, m, d, h, mi] = value.split(/[-T:]/).map(Number); return fromWall({ y, m, d, h, mi, s: 0 }, zone) }
  return <form role="dialog" aria-label="安排日程" data-canvas-ui className="p-3 flex flex-col gap-2" onKeyDown={e => e.stopPropagation()} onSubmit={e => {
    e.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError('')
    void (async () => {
      intent.current ??= { operationId: crypto.randomUUID(), objectId, nodeId, expectedVersion: version, calendarId, title, start: instant(start), end: instant(end), timeZone: zone }
      await window.electronAPI.calendarLinkage.schedule(intent.current)
      if (!mounted.current) return
      await saved(); if (mounted.current) close()
    })().catch(cause => { if (mounted.current) setError(String(cause)) }).finally(() => { lock.current = false; if (mounted.current) setBusy(false) })
  }}>
    <strong>安排日程 · {zone}</strong>
    <label>标题<Input required value={title} disabled={!!intent.current} onChange={e => setTitle(e.target.value)} /></label>
    <label>日历<Select value={calendarId} disabled={!!intent.current} onChange={e => setCalendar(e.target.value)} options={calendars.map(c => ({ value: c.id, label: c.name }))} /></label>
    <label>开始<Input aria-label="日程开始" required type="datetime-local" value={start} disabled={!!intent.current} onChange={e => setStart(e.target.value)} /></label>
    <label>结束<Input aria-label="日程结束" required type="datetime-local" value={end} disabled={!!intent.current} onChange={e => setEnd(e.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={close}>关闭</Button><Button type="submit" variant="primary" disabled={busy || !calendarId}>{intent.current ? '重试同一日程' : '创建日程'}</Button></div>
  </form>
}
