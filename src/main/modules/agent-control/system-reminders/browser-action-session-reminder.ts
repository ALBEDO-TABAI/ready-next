import { buildBrowserActionSessionReminderText } from '../../browser-engine/browser-action-session'
import type { SystemReminderRegistry } from './system-reminder-registry'

export function registerBrowserActionSessionReminder(
  registry: SystemReminderRegistry,
  scopeId: string | null | undefined,
): void {
  const text = buildBrowserActionSessionReminderText(scopeId)
  if (!text) return
  registry.register({
    topic: 'browser-action-session',
    priority: 70,
    conflictsWith: [],
    text,
  })
}
