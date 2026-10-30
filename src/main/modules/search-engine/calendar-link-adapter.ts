import { readCalendarLinks } from '../calendar-engine/event-links'
import { calendarLinkSource } from '../../../shared/calendar/event-links'
import { toReadyUri } from '../../../shared/ready-ref'
import type { DatabaseConnection } from '../database/connection'
import { ObjectLinkRepository } from './object-links'
import { linkTarget } from './object-link-extract'

/** Calendar rows own these edges; the relation index is only a rebuildable projection. */
export function rebuildCalendarLinks(db: DatabaseConnection): void {
  const own = !db.inTransaction
  if (own) db.exec('BEGIN IMMEDIATE')
  try {
    db.exec("DELETE FROM object_links WHERE kind='calendar-link'")
    const sources = new Map<string, ReturnType<typeof readCalendarLinks>>()
    for (const link of readCalendarLinks(db)) {
      const uri = toReadyUri(calendarLinkSource(link))
      sources.set(uri, [...(sources.get(uri) || []), link])
    }
    const repository = new ObjectLinkRepository(db)
    for (const links of sources.values()) repository.replace({ref: calendarLinkSource(links[0])},
      links.map(link => linkTarget(toReadyUri(link.target), 'calendar-link', null, null)), null)
    if (own) db.exec('COMMIT')
  } catch (error) { if (own) db.exec('ROLLBACK'); throw error }
}
