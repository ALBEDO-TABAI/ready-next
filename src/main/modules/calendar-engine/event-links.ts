import { CalendarEventLinkSchema, type CalendarEventLink } from '../../../shared/calendar/event-links'
import { originalFromSeconds, originalToSeconds } from './calendar-row-codec'
import { parseReadyUri, toReadyUri } from '../../../shared/ready-ref'
import type { DatabaseConnection } from '../database/connection'

export function readCalendarLinks(db: DatabaseConnection): CalendarEventLink[] {
  return db.prepare(`SELECT l.*, e.all_day FROM calendar_event_links l JOIN calendar_events e ON e.id=l.event_id ORDER BY l.id`)
    .all<{id:string;event_id:string;occurrence_start:number|null;target_ref:string;purpose:string;all_day:number}>().map(row => {
      const target = parseReadyUri(row.target_ref)
      if (!target.ok) throw new Error('日历关联地址损坏')
      return CalendarEventLinkSchema.parse({ id: row.id, eventId: row.event_id, target: target.ref, purpose: row.purpose,
        ...(row.occurrence_start === null ? {} : {originalStart: originalFromSeconds(row.occurrence_start, !!row.all_day)}) })
    })
}

export function replaceCalendarLinks(db: DatabaseConnection, eventId: string, links: CalendarEventLink[]): void {
  db.prepare('DELETE FROM calendar_event_links WHERE event_id=?').run(eventId)
  for (const link of links) db.prepare('INSERT INTO calendar_event_links(id,event_id,occurrence_start,target_ref,purpose) VALUES (?,?,?,?,?)')
    .run(link.id, eventId, link.originalStart === undefined ? null : originalToSeconds(link.originalStart), toReadyUri(link.target), link.purpose)
}
