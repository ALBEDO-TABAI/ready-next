import { randomUUID } from 'node:crypto'
import type { DatabaseConnection } from '../../database/connection'
import type { CalendarStore } from '../../database/calendar-store'
import type { ReminderFirePayload } from '../../../../shared/calendar-types'
import { dateMentionStart, matchDateMentionRanges, parseDateMentions, type DateMentionReminder } from '../../../../shared/calendar/date-mentions'
import { objectTransaction } from '../../object-service/registry'

interface Row {
  id: string; object_id: string; start: number; end: number; text: string; title: string; date: string
  time_zone: string; start_time: number; offset_minutes: number | null; revision: number; cancelled: number
}

/** Single writer of the document reminder projection; the calendar remains the delivery ledger owner. */
export class DateMentionService {
  constructor(private db: DatabaseConnection, private calendar: Pick<CalendarStore, 'claimReminder'>) {}

  sync(objectId: string, content: string, timeZone: string): void {
    const next = parseDateMentions(objectId, content)
    objectTransaction(this.db, () => {
      const before = this.db.prepare('SELECT content FROM calendar_date_mention_documents WHERE object_id=?').get<{ content: string }>(objectId)?.content ?? ''
      const old = parseDateMentions(objectId, before)
      const rows = this.db.prepare('SELECT * FROM calendar_date_mentions WHERE object_id=? AND cancelled=0 ORDER BY start').all<Row>(objectId)
      const matches = matchDateMentionRanges(before, content, old, next)
      this.db.prepare('UPDATE calendar_date_mentions SET cancelled=1 WHERE object_id=?').run(objectId)
      next.forEach((mention, j) => {
        const previous = old[matches.get(j) ?? -1]
        const row = previous && rows.find(row => row.start === previous.start && row.end === previous.end)
        const zone = row?.time_zone ?? timeZone, startTime = dateMentionStart(mention.ref, zone), offset = mention.ref.remind === undefined ? null : -mention.ref.remind
        const revision = row ? row.revision + Number(row.start_time !== startTime || row.offset_minutes !== offset) : 1
        this.db.prepare(`INSERT INTO calendar_date_mentions(id,object_id,start,end,text,title,date,time_zone,start_time,offset_minutes,revision,cancelled)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET start=excluded.start,end=excluded.end,text=excluded.text,title=excluded.title,
          date=excluded.date,start_time=excluded.start_time,offset_minutes=excluded.offset_minutes,revision=excluded.revision,cancelled=0`).run(
          row?.id ?? `date-mention:${randomUUID()}`, objectId, mention.start, mention.end, mention.text, mention.title, mention.ref.date, zone, startTime, offset, revision)
      })
      this.db.prepare('INSERT INTO calendar_date_mention_documents(object_id,content) VALUES(?,?) ON CONFLICT(object_id) DO UPDATE SET content=excluded.content').run(objectId, content)
    })
  }

  remove(objectId: string): void { this.sync(objectId, '', 'UTC') }

  list(): DateMentionReminder[] {
    return this.db.prepare(`SELECT m.*, d.delivered_at FROM calendar_date_mentions m LEFT JOIN calendar_reminder_deliveries d
      ON d.event_id=m.id AND d.occurrence_start=m.start_time AND d.offset_minutes=m.offset_minutes AND d.method='notification'
      WHERE m.cancelled=0 AND m.offset_minutes IS NOT NULL ORDER BY m.start_time,m.object_id,m.start`).all<Row & { delivered_at: number | null }>().map(row => ({
      id: row.id, objectId: row.object_id, start: row.start, end: row.end, text: row.text, title: row.title, date: row.date,
      timeZone: row.time_zone, startTime: row.start_time, offsetMinutes: row.offset_minutes!, revision: row.revision, deliveredAt: row.delivered_at,
    }))
  }

  pending(until: number, now: number): ReminderFirePayload[] {
    return this.list().filter(row => row.deliveredAt === null && row.startTime + row.offsetMinutes * 60 <= until).map(row => ({
      eventId: row.id, eventTitle: row.title, eventStartTime: row.startTime, offsetMinutes: row.offsetMinutes,
      method: 'notification', firedAt: now, mention: { objectId: row.objectId, revision: row.revision },
    }))
  }

  claim(payload: ReminderFirePayload): boolean {
    return objectTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM calendar_date_mentions WHERE id=?').get<Row>(payload.eventId)
      if (!payload.mention || !row || row.cancelled || row.object_id !== payload.mention.objectId || row.revision !== payload.mention.revision
        || row.offset_minutes === null || row.start_time !== payload.eventStartTime || row.offset_minutes !== payload.offsetMinutes
        || row.start_time + row.offset_minutes * 60 > payload.firedAt) return false
      return this.calendar.claimReminder(row.id, row.start_time, row.offset_minutes, 'notification', payload.firedAt)
    })
  }
}
