import { decodeCalendarRow } from './calendar-row-codec'
import { validateCalendarEvent } from '../../../shared/calendar/validation'
import type { MigrationDatabase } from '../migrations'
import { dayOf, startOfDayMs } from '../../../shared/calendar/tz'
import { isoDate } from '../../../shared/calendar/dates'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const CALENDAR_UNION_MIGRATION = '133_calendar_union'

export function backupBeforeCalendarMigration(db: MigrationDatabase, path: string): string | null {
  if(path===':memory:' || !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_events'").get())return null
  if(db.prepare('PRAGMA table_info(calendar_events)').all<{name:string}>().some(c=>c.name==='start_date'))return null
  const directory=join(dirname(path),'backups');mkdirSync(directory,{recursive:true,mode:0o700})
  const backup=join(directory,`before-calendar-133-${Date.now()}-${randomUUID()}.sqlite`)
  db.prepare('VACUUM INTO ?').run(backup);chmodSync(backup,0o600)
  return backup
}

/** Recover the civil date of a legacy local-midnight row, independent of today's system zone. */
export function legacyAllDayRange(start: number, end: number, authoredZone?: string | null) {
  let zone = authoredZone
  if (!zone) {
    const seconds = ((start % 86400) + 86400) % 86400
    const candidates = [-seconds / 3600, 24 - seconds / 3600].filter(n => n >= -12 && n <= 14)
    if (candidates.length !== 1 || seconds % 900 !== 0) throw new Error('历史全天日程缺少可确定的录入时区，迁移已撤回')
    const offset = candidates[0]
    zone = offset === 0 ? 'UTC' : Number.isInteger(offset) ? `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}` : `${offset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset))).padStart(2, '0')}:${String(Math.round(Math.abs(offset) % 1 * 60)).padStart(2, '0')}`
  }
  const first = dayOf(start * 1000, zone), last = dayOf(end * 1000, zone)
  const exclusive = end * 1000 === startOfDayMs(last, zone) ? last : last + 1
  return { start: isoDate(first), end: isoDate(Math.max(first + 1, exclusive)), timeZone: zone }
}

export function migrateCalendarUnion(db: MigrationDatabase): void {
  if (db.prepare('PRAGMA table_info(calendar_events)').all<{ name: string }>().some(c => c.name === 'start_date')) return
  const own = !db.inTransaction
  if (own) db.exec('BEGIN')
  try {
    const sourceOrder=db.prepare('SELECT id FROM calendar_sources ORDER BY created_at,rowid').all<{id:string}>()
    const oldEvents = db.prepare('SELECT * FROM calendar_events').all<Record<string, unknown>>()
    const overrides = db.prepare('SELECT * FROM calendar_event_overrides').all<Record<string, unknown>>()
    db.exec(`
      ALTER TABLE calendar_sources ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE calendar_sources ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE calendar_sources ADD COLUMN time_zone TEXT;
      ALTER TABLE calendar_sources ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE calendar_sources ADD COLUMN sync_error TEXT;
      ALTER TABLE calendar_sources ADD COLUMN last_synced_at INTEGER;
      UPDATE calendar_sources SET visible=enabled;
      CREATE TABLE calendar_events_union (
        id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT, location TEXT,
        start_time INTEGER, end_time INTEGER, start_date TEXT, end_date TEXT,
        all_day INTEGER NOT NULL DEFAULT 0, recurrence_rule TEXT, reminders TEXT,
        start_tz TEXT, end_tz TEXT, ics_uid TEXT NOT NULL, source_id TEXT,
        url TEXT, conference_url TEXT, color TEXT, time_zone_definition TEXT, end_time_zone_definition TEXT,
        status TEXT NOT NULL DEFAULT 'confirmed', transparency TEXT NOT NULL DEFAULT 'opaque', visibility TEXT NOT NULL DEFAULT 'default',
        attendees TEXT, rdates TEXT, exdates TEXT, sequence INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        CHECK ((all_day=0 AND start_time IS NOT NULL AND end_time>=start_time AND start_date IS NULL AND end_date IS NULL)
          OR (all_day=1 AND start_time IS NULL AND end_time IS NULL AND start_date IS NOT NULL AND end_date>start_date))
      );
    `)
    sourceOrder.forEach((source,index)=>db.prepare('UPDATE calendar_sources SET position=? WHERE id=?').run(index,source.id))
    const insert = db.prepare(`INSERT INTO calendar_events_union(id,calendar_id,title,description,location,start_time,end_time,start_date,end_date,all_day,recurrence_rule,reminders,start_tz,end_tz,ics_uid,source_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const e of oldEvents) {
      const range = e.all_day ? legacyAllDayRange(Number(e.start_time), Number(e.end_time), e.start_tz as string | null) : null
      insert.run(e.id,e.calendar_id,e.title,e.description,e.location,range ? null : e.start_time,range ? null : e.end_time,range?.start ?? null,range?.end ?? null,e.all_day,e.recurrence_rule,e.reminders,range?.timeZone ?? e.start_tz,e.end_tz,e.ics_uid || `${e.id}@ready.local`,e.source_id,e.created_at,e.updated_at)
      if(e.recurrence_rule){const dates=overrides.filter(o=>o.parent_event_id===e.id&&o.kind==='cancelled').map(o=>range?isoDate(dayOf(Number(o.occurrence_start)*1000,range.timeZone)):Number(o.occurrence_start)*1000);if(dates.length)db.prepare('UPDATE calendar_events_union SET exdates=? WHERE id=?').run(JSON.stringify(dates),e.id)}
    }
    for(const row of db.prepare('SELECT * FROM calendar_events_union').all<Record<string,unknown>>())validateCalendarEvent(decodeCalendarRow(row))
    db.exec(`DROP TABLE calendar_events;
      ALTER TABLE calendar_events_union RENAME TO calendar_events;
      CREATE INDEX idx_calendar_events_time ON calendar_events(start_time,end_time);
      CREATE INDEX idx_calendar_events_dates ON calendar_events(start_date,end_date);
      CREATE INDEX idx_calendar_events_source ON calendar_events(calendar_id);
      CREATE UNIQUE INDEX idx_calendar_import_identity ON calendar_events(source_id,ics_uid) WHERE source_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS calendar_reminder_deliveries (
        event_id TEXT NOT NULL, occurrence_start INTEGER NOT NULL, offset_minutes INTEGER NOT NULL, method TEXT NOT NULL,
        delivered_at INTEGER NOT NULL, PRIMARY KEY(event_id,occurrence_start,offset_minutes,method)
      );`)
    // A table rebuild may cascade under a foreign-key-enabled connection. Restore original exception IDs.
    const putOverride = db.prepare('INSERT OR REPLACE INTO calendar_event_overrides(id,parent_event_id,occurrence_start,kind,patch_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    for (const o of overrides) {
      const parent = oldEvents.find(e => e.id === o.parent_event_id)
      if(o.kind==='cancelled'&&parent?.recurrence_rule)continue
      let original = Number(o.occurrence_start), patch = o.patch_json as string | null
      if(patch&&parent){const fields=JSON.parse(patch);if((fields.all_day??parent.all_day)&&('start_time'in fields||'end_time'in fields)){const parentZone=parent.all_day?legacyAllDayRange(Number(parent.start_time),Number(parent.end_time),parent.start_tz as string|null).timeZone:parent.start_tz as string|null;const converted=legacyAllDayRange(Number(fields.start_time??o.occurrence_start),Number(fields.end_time??(Number(o.occurrence_start)+Number(parent.end_time)-Number(parent.start_time))),fields.start_tz??parentZone);patch=JSON.stringify({...fields,all_day:1,start_time:null,end_time:null,start_date:converted.start,end_date:converted.end,start_tz:converted.timeZone})}}
      if (parent?.all_day) {
        const range = legacyAllDayRange(Number(parent.start_time),Number(parent.end_time),parent.start_tz as string | null)
        original = Date.parse(isoDate(dayOf(original * 1000, range.timeZone))) / 1000
      }
      putOverride.run(o.id,o.parent_event_id,original,o.kind,patch,o.created_at,o.updated_at)
    }
    if (own) db.exec('COMMIT')
  } catch (error) {
    if (own) db.exec('ROLLBACK')
    throw error
  }
}
