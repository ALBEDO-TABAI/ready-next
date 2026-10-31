import { eventView, type EventRef } from '../../../../shared/calendar-linkage'
import type { CalendarSnapshot } from '../../../../shared/calendar/commands'
import { openReadyRef } from '../../workbench/open-ready-ref'
export function EventCard({ reference, snapshot }: { reference: EventRef; snapshot?: CalendarSnapshot }) {
  const event = snapshot ? eventView(snapshot, reference) : undefined
  return <article aria-label="事件卡">
    {event === undefined ? <p role="status">正在读取日程…</p> : event === null ? <p role="status">日程已失效</p> : <>
      <strong>{event.title || '无标题日程'}</strong>
      <p>{event.allDay ? '全天 · ' : ''}{new Date(event.start).toLocaleString(undefined, { timeZone: event.timeZone })} — {new Date(event.end).toLocaleString(undefined, { timeZone: event.timeZone })}</p>
      {event.location && <p>{event.location}</p>}
    </>}
  </article>
}
export function ScheduleMark({ canvasId, nodeId, snapshot, report }: { canvasId: string; nodeId: string; snapshot?: CalendarSnapshot; report(error: unknown): void }) {
  const links = snapshot?.links?.filter(link => link.target.kind === 'canvas' && link.target.id === canvasId && link.target.node === nodeId) ?? []
  return <>{links.map(link => <button key={link.id} data-canvas-ui aria-label="查看卡片日程"
    onClick={() => void openReadyRef({ kind: 'event', id: link.eventId, ...(link.originalStart === undefined ? {} : { occurrence: String(link.originalStart) }) }, 'document').catch(report)}>◷ 日程</button>)}</>
}
