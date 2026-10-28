import { expand } from './rrule'
import { registerCalendarZone } from './custom-zone'
import { z } from 'zod'
import { parseIsoDate } from './dates'
import { isValidTimeZone } from './tz'
import type { CalEvent } from './model'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { try { parseIsoDate(v); return true } catch { return false } }, '日期无效')
const instant = z.number().finite().safe()
const zone = z.string().refine(isValidTimeZone, '时区无效')
const link = z.string().refine(v => { try { return ['https:', 'http:'].includes(new URL(v).protocol) } catch { return false } }, '链接必须使用 http 或 https')
export const calendarEventSchema = z.object({
  id: z.string().min(1).max(300), uid: z.string().min(1).max(2000), calendarId: z.string().min(1),
  title: z.string().max(2000), description: z.string().max(200000).optional(), location: z.string().max(5000).optional(),
  url: link.optional(), conferenceUrl: link.optional(), allDay: z.boolean(),
  start: z.union([date, instant]), end: z.union([date, instant]), timeZone: zone.optional(), endTimeZone: zone.optional(),
  timeZoneDefinition: z.string().max(100000).optional(), endTimeZoneDefinition: z.string().max(100000).optional(),
  rrule: z.string().max(4000).optional(), exdates: z.array(z.union([date, instant])).optional(), rdates: z.array(z.union([date, instant])).optional(),
  recurringEventId: z.string().optional(), originalStart: z.union([date, instant]).optional(),
  status: z.enum(['confirmed','tentative','cancelled']), transparency: z.enum(['opaque','transparent']), visibility: z.enum(['default','public','private']).optional(),
  attendees: z.array(z.object({ email: z.string().max(500), name: z.string().max(1000).optional(), rsvp: z.enum(['accepted','declined','tentative','needsAction']), organizer: z.boolean().optional(), self: z.boolean().optional(), optional: z.boolean().optional() })).optional(),
  reminders: z.array(z.object({ minutes: z.number().int().finite(), method: z.enum(['notification','sound','email']) })).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), createdAt: instant, updatedAt: instant, sequence: z.number().int().nonnegative().optional(), revision: z.number().int().nonnegative().optional(),
}).superRefine((e, ctx) => {
  if ((e.allDay && (typeof e.start !== 'string' || typeof e.end !== 'string' || e.end <= e.start)) || (!e.allDay && (typeof e.start !== 'number' || typeof e.end !== 'number' || e.end < e.start))) ctx.addIssue({ code: 'custom', message: '起止时间或全天日期不正确' })
  if([...(e.exdates||[]),...(e.rdates||[])].some(v=>typeof v !== (e.allDay?'string':'number')))ctx.addIssue({code:'custom',message:'重复日期必须与事件的全天或定时类型一致'})
  if (!!e.recurringEventId !== (e.originalStart !== undefined)) ctx.addIssue({ code: 'custom', message: '重复实例必须带有完整身份' })
})

export function validateCalendarEvent(value: unknown): CalEvent {
  const candidate={...(value as CalEvent)}
  if(candidate.timeZoneDefinition&&registerCalendarZone(candidate.timeZoneDefinition)!==candidate.timeZone)delete candidate.timeZoneDefinition
  if(candidate.endTimeZoneDefinition&&registerCalendarZone(candidate.endTimeZoneDefinition)!==candidate.endTimeZone)delete candidate.endTimeZoneDefinition
  if(candidate.timeZone?.startsWith('ready-tz:')&&!candidate.timeZoneDefinition)throw new Error('事件缺少原始时区定义')
  const parsed=calendarEventSchema.parse(candidate)
  if(parsed.rrule){const start=parsed.allDay?parseIsoDate(String(parsed.start)):Number(parsed.start);expand({rule:parsed.rrule,dtstart:start,allDay:parsed.allDay,timeZone:parsed.timeZone},start,start+(parsed.allDay?1:1000))}
  return parsed
}
