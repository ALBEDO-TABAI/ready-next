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
  start: z.string().optional().describe('开始时间 ISO 字符串；省略时使用本轮日历窗口'),
  end: z.string().optional().describe('结束时间 ISO 字符串；省略时使用本轮日历窗口'),
})

const ReminderSchema = z.object({
  offsetMinutes: z
    .number()
    .describe('相对事件开始时间的分钟偏移，负数表示开始前（例如 -15 表示提前 15 分钟）'),
  method: z.enum(['notification', 'sound']).describe('提醒方式'),
})

export const CalendarCreateEventSchema = z.object({
  title: z.string().describe('事件标题'),
  startTime: z.string().describe('开始时间 ISO 字符串'),
  endTime: z.string().describe('结束时间 ISO 字符串'),
  calendarId: z.string().optional().describe('目标日历 ID'),
  description: z.string().optional().describe('事件描述'),
  location: z.string().optional().describe('事件地点'),
  allDay: z.boolean().optional().describe('是否全天事件'),
  reminders: z.array(ReminderSchema).optional().describe('提醒列表'),
  recurrenceRule: z.string().optional().describe('RFC 5545 RRULE 字符串，描述循环规则'),
})

export const CalendarUpdateEventSchema = z.object({
  id: z.string().optional().describe('事件 ID；省略时使用本轮唯一日程目标或列表回执'),
  title: z.string().optional().describe('可选，更新后的标题'),
  startTime: z.string().optional().describe('可选，新的开始时间 ISO 字符串'),
  endTime: z.string().optional().describe('可选，新的结束时间 ISO 字符串'),
  description: z.string().optional().describe('可选，新的事件描述'),
  location: z.string().optional().describe('可选，新的事件地点'),
  allDay: z.boolean().optional().describe('可选，是否全天事件'),
  reminders: z.array(ReminderSchema).optional().describe('可选，新的提醒列表（整组替换）'),
  recurrenceRule: z.string().optional().describe('可选，新的 RFC 5545 RRULE 字符串'),
})

export const CalendarDeleteEventSchema = z.object({
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
