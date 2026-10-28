/**
 * Zod schemas for the 5 calendar domain tools (Phase 2.5 PR 4).
 *
 * SSOT for dispatch-time validation + LLM-facing param derivation. Strings
 * only — no enums or typed arrays — so this file is one of the tightest
 * mirrors of the hand-rolled params. The golden snapshot test pins byte
 * equivalence before the derivation swap.
 *
 * Pure module — Zod only.
 */

import { z } from 'zod'

export const CalendarListWindowSchema = z.object({
  calendarId: z.string().optional().describe('可选，限定日历来源 ID'),
  start: z.string().optional().describe('开始时间 ISO 字符串；省略时使用本轮日历窗口'),
  end: z.string().optional().describe('结束时间 ISO 字符串；省略时使用本轮日历窗口'),
})

const ReminderSchema = z.object({
  offsetMinutes: z
    .number()
    .describe('相对事件开始时间的分钟偏移，负数表示开始前（例如 -15 表示提前 15 分钟）'),
  method: z.enum(['notification', 'sound']).describe('提醒方式'),
})

const EventDetails = {
  startTz: z.string().optional().describe('事件开始时区，如 Asia/Shanghai'),
  endTz: z.string().optional().describe('事件结束时区'),
  startDate: z.string().optional().describe('全天开始日期 YYYY-MM-DD'),
  endDate: z.string().optional().describe('全天结束日期 YYYY-MM-DD，不含该日'),
  url: z.string().nullable().optional().describe('相关网页链接；null 清除'),
  conferenceUrl: z.string().nullable().optional().describe('会议链接；null 清除'),
  color: z.string().nullable().optional().describe('事件颜色 #RRGGBB；null 跟随日历'),
  status: z.enum(['confirmed','tentative','cancelled']).optional().describe('事件状态'),
  transparency: z.enum(['opaque','transparent']).optional().describe('opaque 忙碌；transparent 空闲'),
  visibility: z.enum(['default','public','private']).optional().describe('本地可见性标记，不发送邀请'),
  attendees: z.array(z.object({email:z.string(),name:z.string().optional(),rsvp:z.enum(['accepted','declined','tentative','needsAction']),organizer:z.boolean().optional(),self:z.boolean().optional(),optional:z.boolean().optional()})).optional().describe('本地参与人记录，不发送邀请'),
}
const EventTarget = {
  scope: z.enum(['this','following','all']).optional().describe('重复日程必须明确选择：仅本次、本次及后续、整个系列'),
  occurrenceStart: z.string().optional().describe('原实例开始时间 ISO；仅从本轮读取的实例选择，不用修改后的时间'),
  expectedRevision: z.number().int().optional().describe('最近读取返回的 revision；省略时使用本轮列表读取回执'),
}

export const CalendarCreateEventSchema = z.object({
  ...EventDetails,
  title: z.string().describe('事件标题'),
  startTime: z.string().optional().describe('定时事件开始时间 ISO 字符串；全天可用 startDate'),
  endTime: z.string().optional().describe('定时事件结束时间 ISO 字符串；全天可用 endDate'),
  calendarId: z.string().optional().describe('目标日历 ID'),
  description: z.string().optional().describe('事件描述'),
  location: z.string().optional().describe('事件地点'),
  allDay: z.boolean().optional().describe('是否全天事件'),
  reminders: z.array(ReminderSchema).optional().describe('提醒列表'),
  recurrenceRule: z.string().optional().describe('RFC 5545 RRULE 字符串，描述循环规则'),
}).superRefine((event, ctx) => {
  if (event.allDay && event.startDate && event.endDate) return
  if (!event.startTime || !event.endTime) ctx.addIssue({ code: 'custom', message: '请提供完整起止时间；全天日程也可提供开始日期和不包含的结束日期' })
})

export const CalendarUpdateEventSchema = z.object({
  ...EventDetails,
  ...EventTarget,
  id: z.string().optional().describe('事件 ID；省略时使用本轮唯一日程目标或列表回执'),
  title: z.string().optional().describe('可选，更新后的标题'),
  startTime: z.string().optional().describe('可选，新的开始时间 ISO 字符串'),
  endTime: z.string().optional().describe('可选，新的结束时间 ISO 字符串'),
  description: z.string().nullable().optional().describe('新的事件描述；null 清除'),
  location: z.string().nullable().optional().describe('新的事件地点；null 清除'),
  allDay: z.boolean().optional().describe('可选，是否全天事件'),
  reminders: z.array(ReminderSchema).optional().describe('可选，新的提醒列表（整组替换）'),
  recurrenceRule: z.string().nullable().optional().describe('新的 RFC 5545 RRULE；null 清除'),
})

export const CalendarDeleteEventSchema = z.object({
  ...EventTarget,
  id: z.string().optional().describe('事件 ID；省略时使用本轮唯一日程目标或列表回执'),
})

export const CalendarCaptureSessionSchema = z.object({})

export type CalendarToolName =
  | 'calendar_list_window'
  | 'calendar_create_event'
  | 'calendar_update_event'
  | 'calendar_delete_event'
  | 'calendar_capture_session'

export const CALENDAR_SCHEMAS: Record<CalendarToolName, z.ZodObject<z.ZodRawShape>> = {
  calendar_list_window: CalendarListWindowSchema,
  calendar_create_event: CalendarCreateEventSchema,
  calendar_update_event: CalendarUpdateEventSchema,
  calendar_delete_event: CalendarDeleteEventSchema,
  calendar_capture_session: CalendarCaptureSessionSchema,
}
