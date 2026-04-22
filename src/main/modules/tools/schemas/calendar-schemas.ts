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
  start: z.string().describe('开始时间 ISO 字符串'),
  end: z.string().describe('结束时间 ISO 字符串'),
})

export const CalendarCreateEventSchema = z.object({
  title: z.string().describe('事件标题'),
  startTime: z.string().describe('开始时间 ISO 字符串'),
  endTime: z.string().describe('结束时间 ISO 字符串'),
  calendarId: z.string().optional().describe('目标日历 ID'),
  description: z.string().optional().describe('事件描述'),
})

export const CalendarUpdateEventSchema = z.object({
  id: z.string().describe('事件 ID'),
  title: z.string().optional().describe('可选，更新后的标题'),
  startTime: z.string().optional().describe('可选，新的开始时间 ISO 字符串'),
  endTime: z.string().optional().describe('可选，新的结束时间 ISO 字符串'),
  description: z.string().optional().describe('可选，新的事件描述'),
})

export const CalendarDeleteEventSchema = z.object({
  id: z.string().describe('事件 ID'),
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
