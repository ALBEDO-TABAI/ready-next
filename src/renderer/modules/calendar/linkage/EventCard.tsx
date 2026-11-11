import { eventView, type EventRef } from '../../../../shared/calendar-linkage'
import type { CalendarSnapshot } from '../../../../shared/calendar/commands'
import { RefCapsule } from '../../../components/ui/RefCapsule'
// On the board an event card's heading, and a card's schedule mark, are reference capsules (W6 §2.1).
export function EventCard({ reference, snapshot }: { reference: EventRef; snapshot?: CalendarSnapshot }) {
  const event = snapshot ? eventView(snapshot, reference) : undefined
  return <article aria-label="事件卡">
    {event === undefined ? <p role="status">正在读取日程…</p> : event === null ? <p role="status">日程已失效</p> : <>
      <RefCapsule reference={reference} title={event.title || '无标题日程'} canvasUi />
      <p>{event.allDay ? '全天 · ' : ''}{new Date(event.start).toLocaleString(undefined, { timeZone: event.timeZone })} — {new Date(event.end).toLocaleString(undefined, { timeZone: event.timeZone })}</p>
      {event.location && <p>{event.location}</p>}
    </>}
  </article>
}
export function ScheduleMark({ canvasId, nodeId, snapshot }: { canvasId: string; nodeId: string; snapshot?: CalendarSnapshot }) {
  const links = snapshot?.links?.filter(link => link.target.kind === 'canvas' && link.target.id === canvasId && link.target.node === nodeId) ?? []
  return <>{links.map(link => {
    const reference: EventRef = { kind: 'event', id: link.eventId, ...(link.originalStart === undefined ? {} : { occurrence: String(link.originalStart) }) }
    return <span key={link.id} className="canvas-schedule-mark"><RefCapsule reference={reference} title={(snapshot && eventView(snapshot, reference)?.title) || '日程'} canvasUi /></span>
  })}</>
}
