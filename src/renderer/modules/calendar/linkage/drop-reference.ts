import { readReadyRefTransfers } from '../../../../shared/ready-ref'
import { isoDate, parseIsoDate } from '../../../../shared/calendar/dates'
import type { CalEvent } from '../../../../shared/calendar/model'

/** One atomic calendar delta: no orphan event if linking fails. */
export async function dropCalendarReference(data: Pick<DataTransfer, 'getData'>, date: string): Promise<boolean> {
  const dropped = readReadyRefTransfers(data)
  if (!dropped.length) return false
  const api = window.electronAPI.calendar, snapshot = await api.snapshot()
  if (!snapshot.success || !snapshot.data) throw new Error(snapshot.error || '无法读取日历')
  const calendar = snapshot.data.calendars.find(item => item.primary && !item.readOnly) || snapshot.data.calendars.find(item => !item.readOnly)
  if (!calendar) throw new Error('请先创建本地日历')
  const now = Date.now()
  const put: CalEvent[] = dropped.map(item => {
    const id = crypto.randomUUID()
    return { id, uid: id + '@ready.local', calendarId: calendar.id, title: item.title || '关联日程',
      allDay: true, start: date, end: isoDate(parseIsoDate(date) + 1), status: 'confirmed', transparency: 'transparent', createdAt: now, updatedAt: now }
  })
  const links = put.map((event, index) => ({ eventId: event.id, links: [{ id: crypto.randomUUID(), eventId: event.id, target: dropped[index].ref, purpose: 'related' as const }] }))
  const result = await api.restore({ put, remove: [], links }, Object.fromEntries(put.map(event => [event.id, 0])))
  if (!result.success) throw new Error(result.error || '创建关联日程失败')
  return true
}
