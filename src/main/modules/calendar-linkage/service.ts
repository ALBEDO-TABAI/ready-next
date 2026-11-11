import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { ScheduleCardSchema, DayInputSchema, occurrenceRef, type ScheduleCard, type EventRef, type DaySummary, type DayInput } from '../../../shared/calendar-linkage'
import { ReadyCanvasSchema } from '../../../shared/ready-canvas'
import { occurrences } from '../../../shared/calendar/model'
import { planCalendarMutation } from '../../../shared/calendar/commands'
import { isoDate, parseIsoDate } from '../../../shared/calendar/dates'
import { dayOf, startOfDayMs } from '../../../shared/calendar/tz'
import { dateMentionReference, type DateMentionReminder } from '../../../shared/calendar/date-mentions'
import type { LayerEntry } from '../../../shared/calendar-layers'
import { ObjectRegistry, isInside } from '../object-service/registry'
import { checkedPath, hashBytes, vaultRoot } from '../document-drafts/files'
import type { CalendarStore } from '../database/calendar-store'

/** The day's events alone: all that 这一天 has to show while no vault is configured. */
export function eventsOfDay(calendar: CalendarStore, raw: DayInput): DaySummary {
  const input = DayInputSchema.parse(raw), day = parseIsoDate(input.date)
  return { ...input, items: occurrences(calendar.snapshot().events, day, day + 1, input.timeZone).map(o => ({ id: `event:${o.key}`, kind: 'events', title: o.event.title || '无标题日程', ref: occurrenceRef(o), detail: [o.allDay ? '全天' : new Date(o.start).toLocaleTimeString('zh-CN', { timeZone: input.timeZone, hour: '2-digit', minute: '2-digit' }), o.event.location].filter(Boolean).join(' · ') })) }
}

export class CalendarLinkageService {
  readonly root: string
  constructor(readonly registry: ObjectRegistry, root: string, readonly calendar: CalendarStore) { this.root = vaultRoot(root) }
  schedule(raw: ScheduleCard): EventRef {
    const input = ScheduleCardSchema.parse(raw), db = this.registry.db
    const fingerprint = JSON.stringify(input), id = `card-${input.operationId}`
    const prior = db.prepare('SELECT input_json,state FROM calendar_card_schedules WHERE root=? AND operation_id=?').get<{ input_json: string; state: string }>(this.root, input.operationId)
    if (prior && prior.input_json !== fingerprint) throw new Error('operation_id_reused')
    const snapshot = this.calendar.snapshot(), existing = snapshot.events.find(e => e.id === id)
    if (prior && existing) return { kind: 'event', id }
    if (prior?.state === 'completed') throw new Error('日程已删除，不会重复创建')
    if (existing) throw new Error('日程身份已占用')
    const object = this.registry.get(input.objectId)
    if (!object?.current_path || object.kind !== 'canvas' || object.status !== 'present' || object.identity_state === 'conflict') throw new Error('画板不可用')
    const content = readFileSync(checkedPath(this.root, object.current_path), 'utf8')
    if (hashBytes(content) !== input.expectedVersion) throw new Error('画板已变化，请重新打开菜单')
    const canvas = ReadyCanvasSchema.parse(JSON.parse(content)), node = canvas.nodes.find(n => n.id === input.nodeId && !n.ready.trash)
    if (!node || !['text', 'note', 'document'].includes(node.ready.kind)) throw new Error('请选择文字卡或文档卡')
    const now = Date.now()
    const created = planCalendarMutation(snapshot, { type: 'create', event: { id, uid: `${id}@ready.local`, calendarId: input.calendarId,
      title: input.title, start: input.start, end: input.end, timeZone: input.timeZone, allDay: false, status: 'confirmed', transparency: 'opaque', createdAt: now, updatedAt: now } })
    const linked = planCalendarMutation({ ...snapshot, events: [...snapshot.events, ...created.put] }, { type: 'link', key: id, target: { kind: 'canvas', id: input.objectId, node: input.nodeId } })
    // Intent precedes the one atomic event+relation commit. Retry recovers a lost receipt without creating another event.
    db.prepare("INSERT OR IGNORE INTO calendar_card_schedules(root,operation_id,event_id,input_json,state) VALUES(?,?,?,?,'pending')").run(this.root, input.operationId, id, fingerprint)
    this.calendar.restore(linked, {})
    return { kind: 'event', id }
  }
  day(raw: DayInput, layers: LayerEntry[], reminders: DateMentionReminder[]): DaySummary {
    const input = DayInputSchema.parse(raw), day = parseIsoDate(input.date), toDate = isoDate(day + 1)
    const from = startOfDayMs(day, input.timeZone), to = startOfDayMs(day + 1, input.timeZone)
    const summary = eventsOfDay(this.calendar, input)
    summary.items.push(...layers.filter(e => e.date < toDate && e.lastDate >= input.date).map(e => ({ id: e.id, kind: e.layer, title: e.title, ref: e.ref })))
    for (const row of reminders) {
      const object = this.registry.get(row.objectId)
      if (object?.current_path && isInside(this.root, object.current_path) && dayOf(row.startTime * 1000, input.timeZone) === day) {
        summary.items.push({ id: row.id, kind: 'reminders', title: row.title, ref: dateMentionReference(row), detail: row.deliveredAt === null ? '待提醒' : '已提醒' })
      }
    }
    // Pages and canvases created or changed that day: the files' own birth/modify times plus Ready's save events.
    // (No synthetic activity rows: file emergence ranks by file_activity_events and must not see scans as edits.)
    const touched = this.registry.db.prepare(`SELECT o.id FROM objects o JOIN workspaces w ON w.id=o.workspace_id
      WHERE w.root=? AND o.status='present' AND o.kind IN ('markdown','canvas') AND (
        (CAST(o.mtime_ns AS INTEGER)/1000000 >= ? AND CAST(o.mtime_ns AS INTEGER)/1000000 < ?)
        OR (CAST(o.birthtime_ns AS INTEGER)/1000000 >= ? AND CAST(o.birthtime_ns AS INTEGER)/1000000 < ?))
      UNION SELECT object_id FROM file_activity_events
      WHERE workspace_root=? AND event_type='save' AND created_at>=? AND created_at<? AND object_id IS NOT NULL`)
      .all<{ id: string }>(this.root, from, to, from, to, this.root, from, to)
    for (const { id } of touched) {
      const object = this.registry.get(id)
      if (!object || !['markdown', 'canvas'].includes(object.kind) || !isInside(this.root, object.current_path ?? object.last_known_path)) continue
      summary.items.push({ id: `activity:${object.id}`, kind: 'activity', title: basename(object.current_path ?? object.last_known_path),
        ref: { kind: object.kind === 'canvas' ? 'canvas' : 'page', id: object.id }, detail: '创建或修改' })
    }
    return summary
  }
}
