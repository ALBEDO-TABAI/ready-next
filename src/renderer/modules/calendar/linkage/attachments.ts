import { captureComposerAuthority, isComposerAuthorityCurrent } from '../../agent/composer-authority'
import { digestCodexDocumentValue } from '../../agent/codexCurrentDocumentAnchor'
import { toReadyUri } from '../../../../shared/ready-ref'
import { calendarEventReferenceId } from '../../../../shared/calendar-event-identity'
import type { DaySummary, EventRef } from '../../../../shared/calendar-linkage'
import { addReadyContextReferenceToAgentInput, READY_FOCUS_CHAT_INPUT_EVENT } from '../../agent/chat-input-bridge'
import { useAgent } from '../../../stores/useAgent'
import { useWorkspace } from '../../../stores/useWorkspace'

export function attachEvent(ref: EventRef, title: string, allDay: boolean) {
  return addReadyContextReferenceToAgentInput({ type: 'calendar-event', eventId: calendarEventReferenceId(ref), name: title, allDay })
}
/** Only identity and scope cross the send boundary; Main reads the selected day. */
export async function createDayAttachment(summary: DaySummary) {
  const vault = await window.electronAPI.vault.get()
  if (vault.status !== 'ready') throw new Error('请先配置资料库')
  const id = crypto.randomUUID(), name = `这一天 · ${summary.date}`, path = toReadyUri({ kind: 'day', date: summary.date })
  const libraryResource = { kind: 'calendar_day' as const, id, name, libraryId: await digestCodexDocumentValue(vault.root),
    date: summary.date, timeZone: summary.timeZone, categories: [...new Set(summary.items.map(item => item.kind))],
    items: summary.items.map(item => ({ id: item.id, uri: toReadyUri(item.ref) })) }
  return { id, name, path, type: 'text' as const, size: 0, ext: '', source: 'calendar-day' as const, libraryResource }
}
export async function attachDay(summary: DaySummary) {
  const authority = captureComposerAuthority(useAgent.getState())
  const attachment = await createDayAttachment(summary)
  if (!isComposerAuthorityCurrent(useAgent.getState(), authority)) return
  useAgent.getState().addAttachments([attachment])
  useWorkspace.setState({ chatPanelVisible: true })
  window.dispatchEvent(new CustomEvent(READY_FOCUS_CHAT_INPUT_EVENT))
}
