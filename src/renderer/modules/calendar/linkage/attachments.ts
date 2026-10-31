import { toReadyUri } from '../../../../shared/ready-ref'
import { calendarEventReferenceId } from '../../../../shared/calendar-event-identity'
import type { DaySummary, EventRef } from '../../../../shared/calendar-linkage'
import { addReadyContextReferenceToAgentInput, READY_FOCUS_CHAT_INPUT_EVENT } from '../../agent/chat-input-bridge'
import { useAgent } from '../../../stores/useAgent'
import { useWorkspace } from '../../../stores/useWorkspace'

export function attachEvent(ref: EventRef, title: string, allDay: boolean) {
  return addReadyContextReferenceToAgentInput({ type: 'calendar-event', eventId: calendarEventReferenceId(ref), name: title, allDay })
}
/** A selected, dated snapshot is quoted text, not a new resource permission or tool. */
export function attachDay(summary: DaySummary) {
  const name = `这一天 · ${summary.date}`, path = toReadyUri({ kind: 'day', date: summary.date })
  const selection = [name, `时区：${summary.timeZone}`, path, ...summary.items.map(item => `${item.title}${item.detail ? ` · ${item.detail}` : ''} ${toReadyUri(item.ref)}`)].join('\n')
  if (selection.length > 30000) throw new Error('当天内容超过单个附件容量，请选择具体条目加入对话')
  useAgent.getState().addAttachments([{ id: crypto.randomUUID(), name, path, type: 'text', size: selection.length, ext: '.md', source: 'document-tab', selection, documentTitle: name }])
  useWorkspace.setState({ chatPanelVisible: true })
  window.dispatchEvent(new CustomEvent(READY_FOCUS_CHAT_INPUT_EVENT))
}
