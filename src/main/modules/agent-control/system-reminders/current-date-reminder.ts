/**
 * Stage R W1.3 — current-date system reminder.
 *
 * Registers a per-turn reminder that surfaces today's ISO date plus a
 * Chinese weekday label. The reminder is consumed by the model when it
 * cites `web_search` / `web_fetch` results so it can apply staleness
 * judgement (e.g. avoid quoting a 2024-published article as "the latest").
 *
 * The live SDK turn assembly uses `buildCurrentDateReminderText()` directly;
 * registry users share the same formatter so calendar date and weekday can
 * never come from different time zones.
 */

import type { SystemReminderRegistry } from './system-reminder-registry'

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

type LocalCalendarDate = Pick<Date, 'getFullYear' | 'getMonth' | 'getDate' | 'getDay'>

export function formatLocalCalendarDate(now: Pick<LocalCalendarDate, 'getFullYear' | 'getMonth' | 'getDate'>): string {
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function buildCurrentDateReminderText(now: LocalCalendarDate = new Date()): string {
  const date = formatLocalCalendarDate(now)
  const weekday = WEEKDAY_LABELS[now.getDay()] ?? ''
  return `当前日期：${date}（${weekday}）。引用网络资料时需考虑信息时效性。`
}

export function registerCurrentDateReminder(
  registry: SystemReminderRegistry,
  now: Date = new Date(),
): void {
  registry.register({
    topic: 'current-date',
    priority: 90,
    text: buildCurrentDateReminderText(now),
  })
}
