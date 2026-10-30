import type { ReminderFirePayload } from '../../../../shared/calendar-types'
import type { ReadyRef } from '../../../../shared/ready-ref'
import type { NotificationCtor } from '../reminder-notifier'
import type { DateMentionController } from './controller'

export function createDateMentionNotifier(deps: {
  controller: DateMentionController
  changed(): void
  preferences(): { notifications?: boolean; notifySound?: boolean }
  notification(): NotificationCtor | null
  open(ref: ReadyRef): void
}) {
  return (payload: ReminderFirePayload): void => {
    if (!deps.controller.claim(payload)) return
    deps.changed()
    const prefs = deps.preferences(), Notification = deps.notification()
    if (prefs.notifications === false || !Notification) return
    const notification = new Notification({ title: payload.eventTitle || '文档提醒', body: '点击回到文档中的日期提及', silent: prefs.notifySound === false })
    notification.on('click', () => {
      try {
        const ref = deps.controller.reference(payload.eventId)
        deps.controller.locate(ref)
        deps.open(ref)
      } catch (error) { console.error('[date-mentions] notification target unavailable', error) }
    })
    notification.show()
  }
}
