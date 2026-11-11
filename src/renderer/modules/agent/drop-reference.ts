import { draggedSkill } from '../workbench/skill-drag'
import { createSkillReferenceAttachment } from './chat-input-bridge'
import { createDayAttachment } from '../calendar/linkage/attachments'
import { readReadyRefTransfers, toReadyUri, type ReadyRef } from '../../../shared/ready-ref'
import { rssReferenceFromReadyRef } from '../../../shared/rss-reference'
import { parseBookLocation } from '../../../shared/book-location'
import { calendarEventReferenceId } from '../../../shared/calendar-event-identity'
import { buildLibraryBoardSelection, buildLibraryBookLocation } from './libraryResourceSelection'
import type { ChatAttachment } from './types'
import { createLocalPathAttachment } from '../../components/agent/chat-panel/attachments-helpers'
import { useAgent } from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'
import { captureComposerAuthority, isComposerAuthorityCurrent } from './composer-authority'
import { READY_FOCUS_CHAT_INPUT_EVENT } from './chat-input-bridge'

export async function referenceAttachment(ref: ReadyRef, name: string): Promise<ChatAttachment> {
  const base: ChatAttachment = { id: crypto.randomUUID(), name: name || '引用', path: toReadyUri(ref), type: 'text', size: 0, ext: '.reference', source: 'file' }
  const skill = draggedSkill(ref)
  if (skill) return createSkillReferenceAttachment(skill)
  const api = window.electronAPI
  switch (ref.kind) {
    case 'page': case 'file': {
      const location = await api.objects.locate(ref.id)
      if (!location) throw new Error('引用文件已不存在')
      const stat = await api.document.stat(location.path)
      if (!stat.success) throw new Error(stat.error || '无法读取文件')
      return createLocalPathAttachment({ name: base.name, path: location.path, isDirectory: stat.data?.isDirectory ?? stat.stat?.isDirectory ?? false })
    }
    case 'canvas': {
      const opened = await api.canvas.open(ref.id)
      if (!opened.ok) throw new Error(opened.error)
      try {
        const ids = ref.node ? [ref.node] : opened.value.canvas.nodes.filter(node => !node.ready.trash).map(node => node.id)
        return { ...base, libraryResource: await buildLibraryBoardSelection({ title: name, objectId: ref.id }, ids) }
      } finally { await api.canvas.release(opened.value.handleId) }
    }
    case 'book-location': {
      const location = parseBookLocation(ref.loc)
      if (!location) throw new Error('书籍位置无效')
      return { ...base, libraryResource: await buildLibraryBookLocation(ref.book, location, name) }
    }
    case 'event': return { ...base, source: 'calendar-event', eventId: calendarEventReferenceId(ref), allDay: /^\d{4}-\d{2}-\d{2}$/.test(ref.occurrence || '') }
    case 'day': return createDayAttachment(await api.calendarLinkage.day({ date: ref.date, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }))
    case 'web': {
      const tabs = await api.browser.getTabs()
      const tab = tabs.find(tab => tab.url === ref.url)
      if (!tab) return { ...base, readyRef: ref }
      return { ...base, source: 'browser-tab', browserTabId: tab.id, url: ref.url }
    }
    case 'rss-item': case 'rss-query': case 'rss-digest': {
      const reference = rssReferenceFromReadyRef(ref)
      return reference ? { ...base, source: 'rss-reference', rssReference: reference }
        : ref.kind === 'rss-item' ? { ...base, source: 'rss-item', rssItemId: ref.id } : base
    }
    case 'fastcard': case 'conversation': return { ...base, readyRef: ref }
  }
}
export async function dropAgentReference(data: Pick<DataTransfer, 'getData'>, add: (attachments: ChatAttachment[]) => void): Promise<boolean> {
  const dropped = readReadyRefTransfers(data)
  if (!dropped.length) return false
  const authority = captureComposerAuthority(useAgent.getState())
  const attachments = await Promise.all(dropped.map(item => referenceAttachment(item.ref, item.title)))
  if (!isComposerAuthorityCurrent(useAgent.getState(), authority)) throw new Error('对话已切换，请重新拖入')
  add(attachments)
  return true
}
export async function captureToAgent(ref: ReadyRef, title: string): Promise<void> {
  const authority = captureComposerAuthority(useAgent.getState())
  const attachment = await referenceAttachment(ref, title)
  if (!isComposerAuthorityCurrent(useAgent.getState(), authority)) throw new Error('对话已切换，请重新引用')
  useAgent.getState().addAttachments([attachment])
  useWorkspace.setState({ chatPanelVisible: true })
  window.dispatchEvent(new CustomEvent(READY_FOCUS_CHAT_INPUT_EVENT))
}

/** Selected words are visible composer context; the file remains an ordinary structured resource. */
export async function captureSelectionToAgent(selection: { ref: ReadyRef; title: string; text: string }): Promise<void> {
  const authority = captureComposerAuthority(useAgent.getState())
  const attachment = await referenceAttachment(selection.ref, selection.title)
  if (!isComposerAuthorityCurrent(useAgent.getState(), authority)) throw new Error('对话已切换，请重新引用')
  const state = useAgent.getState()
  state.addAttachments([attachment])
  state.setInputValue([state.inputValue, selection.text.split(/\r?\n/).map(line => `> ${line}`).join('\n')].filter(Boolean).join('\n\n'))
  useWorkspace.setState({ chatPanelVisible: true })
  window.dispatchEvent(new CustomEvent(READY_FOCUS_CHAT_INPUT_EVENT))
}
