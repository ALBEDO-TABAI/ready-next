import type { SystemReminderRegistry } from './system-reminder-registry'

export const ACTION_ANNOUNCEMENT_STEER_REMINDER_TEXT =
  '系统补充：上一轮用行动宣告结尾但没有调用工具。请立刻调用能推进当前任务的工具；如果确实无法调用工具，直接说明真实阻塞，不要再用“我马上/让我/接下来：”这类宣告句结束。'

export function registerActionAnnouncementSteerReminder(
  registry: SystemReminderRegistry,
  actionSummary?: string | null,
): void {
  const action = typeof actionSummary === 'string' && actionSummary.trim()
    ? `（${actionSummary.trim()}）`
    : ''
  registry.register({
    topic: 'action-announcement-steer',
    priority: 95,
    text: `${ACTION_ANNOUNCEMENT_STEER_REMINDER_TEXT}${action}`,
  })
}
