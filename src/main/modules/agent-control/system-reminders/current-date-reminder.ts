/**
 * Stage R W1.3 — current-date system reminder.
 *
 * Registers a per-turn reminder that surfaces today's ISO date plus a
 * Chinese weekday label. The reminder is consumed by the model when it
 * cites `web_search` / `web_fetch` results so it can apply staleness
 * judgement (e.g. avoid quoting a 2024-published article as "the latest").
 *
 * TODO(stage-r-followup): wire `registerCurrentDateReminder(registry)`
 * into the per-turn `createSystemReminderRegistry()` call sites in
 * `turn-engine.ts` / `turn-frame-steering.ts` once the registration order
 * (relative to budget / typed-action-preferred reminders) is finalized.
 * Helper is published here so the wiring PR is mechanical.
 */

import type { SystemReminderRegistry } from '../system-reminder-registry'

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

export function registerCurrentDateReminder(
  registry: SystemReminderRegistry,
  now: Date = new Date(),
): void {
  const iso = now.toISOString().slice(0, 10)
  const weekday = WEEKDAY_LABELS[now.getDay()] ?? ''
  registry.register({
    topic: 'current-date',
    priority: 90,
    text: `当前日期：${iso}（${weekday}）。引用网络资料时需考虑信息时效性。`,
  })
}
