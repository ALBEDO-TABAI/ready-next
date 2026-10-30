import { calendarEventReadyRef } from '../../../shared/calendar-event-identity'
import { ReadyRefSchema, toReadyUri } from '../../../shared/ready-ref'
import { RSSReferenceSchema, rssReferencePath, type RSSReference } from '../../../shared/rss-reference'
import { useAgent } from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'
import type { ChatAttachment } from '../../stores/useAgent'
import { createLocalPathAttachment } from '../../components/agent/chat-panel/attachments-helpers'
import {
  captureComposerAuthority,
  isComposerAuthorityCurrent,
} from './composer-authority'
import {
  buildWidgetTargetUpdatePrompt,
  createDocumentWidgetTargetAttachment,
  type DocumentWidgetTargetContext,
} from './widget-target-attachment'

export const READY_FOCUS_CHAT_INPUT_EVENT = 'ready:focus-chat-input'
export const READY_WIDGET_MESSAGE_EVENT = 'ready:widget-message'

export interface DocumentQuoteContext {
  title: string
  path: string | null
  selection: string
  sectionTitle?: string | null
  lineStart?: number | null
  lineEnd?: number | null
}

export interface ReadyBrowserTabReference {
  type: 'browser-tab'
  name: string
  title?: string
  url?: string
  tabId?: string
  heading?: string
  selection?: string
  excerpt?: string
}

export interface ReadyDocumentTabReference {
  type: 'doc-tab'
  name: string
  title?: string
  path?: string | null
  tabId?: string
  content?: string
  ext?: string
  size?: number
  dirty?: boolean
  saveStatus?: string
}

export interface ReadyCalendarEventReference {
  type: 'calendar-event'
  name: string
  title?: string
  eventId?: string
  startTime?: string
  endTime?: string
  calendarId?: string
  description?: string
  location?: string
  allDay?: boolean
  contentType?: string
  platform?: string[] | string
  publishStatus?: string
}

export interface ReadySkillReference {
  type: 'skill-folder'
  name: string
  path?: string
  skillId?: string
  description?: string
  defaultAction?: string
}

export interface ReadyFileReference {
  type: 'file'
  name: string
  path: string
  ext?: string
  size?: number
  isDirectory?: boolean
}

export type ReadyContextReference =
  | ReadyBrowserTabReference
  | ReadyDocumentTabReference
  | ReadyCalendarEventReference
  | ReadySkillReference
  | ReadyFileReference

export function addRSSReferenceToAgentInput(name: string, input: RSSReference): void {
  const reference = RSSReferenceSchema.parse(input)
  const attachment: ChatAttachment = { id: crypto.randomUUID(), name,
    path: rssReferencePath(reference), type: 'text', size: 0, ext: '.rss', source: 'rss-reference', rssReference: reference }
  useWorkspace.setState({ chatPanelVisible: true })
  useAgent.getState().addAttachments([attachment])
  window.dispatchEvent(new CustomEvent(READY_FOCUS_CHAT_INPUT_EVENT))
}

export function appendToAgentInput(snippet: string): void {
  const trimmed = snippet.trim()
  if (!trimmed) return

  const currentInput = useAgent.getState().inputValue.trim()
  const nextValue = currentInput ? `${currentInput}\n\n${trimmed}` : trimmed

  useWorkspace.setState({ chatPanelVisible: true })
  useAgent.getState().setInputValue(nextValue)
  window.dispatchEvent(new CustomEvent(READY_FOCUS_CHAT_INPUT_EVENT))
}

export function appendWidgetMessageToAgentInput(text: string, title?: string): void {
  const trimmed = text.trim()
  if (!trimmed) return

  const snippet = [
    '### Widget 交互',
    title ? `- Widget: ${title}` : null,
    '',
    trimmed,
  ].filter(Boolean).join('\n')

  appendToAgentInput(snippet)
  window.dispatchEvent(new CustomEvent(READY_WIDGET_MESSAGE_EVENT, {
    detail: { title: title || null, text: trimmed },
  }))
}

function createAttachmentId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeAttachmentExt(value: string | undefined, fallback = '.txt'): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return fallback
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

export async function showReferenceToInputMenu(point: { x: number; y: number }): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.electronAPI?.ui : null
  if (!api?.showNativeContextMenu) return false
  const result = await api.showNativeContextMenu({
    x: point.x,
    y: point.y,
    items: [{ id: 'reference-to-input', label: '引用到输入框', iconText: '@' }],
  }).catch(() => null)
  return result?.success === true && result.selectedId === 'reference-to-input'
}

export type BrowserTabContextMenuAction = 'reference-to-input' | 'close-tab'

export async function showBrowserTabContextMenu(
  point: { x: number; y: number },
  options?: { canReference?: boolean },
): Promise<BrowserTabContextMenuAction | null> {
  const api = typeof window !== 'undefined' ? window.electronAPI?.ui : null
  if (!api?.showNativeContextMenu) return null
  const items: Array<{ id: string; label: string; iconText: string }> = []
  if (options?.canReference !== false) {
    items.push({ id: 'reference-to-input', label: '引用到输入框', iconText: '@' })
  }
  items.push({ id: 'close-tab', label: '关闭标签页', iconText: '✕' })
  const result = await api.showNativeContextMenu({ x: point.x, y: point.y, items }).catch(() => null)
  if (!result?.success) return null
  if (result.selectedId === 'reference-to-input') return 'reference-to-input'
  if (result.selectedId === 'close-tab') return 'close-tab'
  return null
}

export function createSkillReferenceAttachment(skill: ReadySkillReference): ChatAttachment {
  const skillId = String(skill.skillId || '').trim()
  const path = String(skill.path || (skillId ? `skill://${skillId}` : `skill://${encodeURIComponent(skill.name)}`))
  return {
    id: createAttachmentId('attach-skill'),
    name: skill.name || skillId || 'Skill',
    path,
    type: 'text',
    size: 0,
    ext: '.skill',
    source: 'skill-folder',
    skillId: skillId || undefined,
    skillFolderPath: path,
    excerpt: skill.description,
  }
}

async function documentReferencePath(path: string): Promise<string> {
  const location = await window.electronAPI.objects.resolvePath(path)
  return toReadyUri({ kind: /\.(md|markdown)$/i.test(location.path) ? 'page' : 'file', id: location.objectId })
}

export async function createReadyContextAttachment(reference: ReadyContextReference): Promise<ChatAttachment> {
  if (reference.type === 'skill-folder') {
    return createSkillReferenceAttachment(reference)
  }

  if (reference.type === 'file') {
    return createLocalPathAttachment({
      name: reference.name,
      path: reference.path,
      ext: reference.ext,
      size: reference.size,
      isDirectory: reference.isDirectory,
    })
  }

  if (reference.type === 'browser-tab') {
    const fallbackTitle = reference.title || reference.name || '网页标签'
    const ref = ReadyRefSchema.safeParse({ kind: 'web', url: reference.url })
    const path = ref.success ? toReadyUri(ref.data) : ''
    return {
      id: createAttachmentId('attach-browser'),
      name: fallbackTitle,
      path,
      type: 'text',
      size: 0,
      ext: '.url',
      source: 'browser-tab',
      browserTabId: reference.tabId,
      url: ref.success && ref.data.kind === 'web' ? ref.data.url : undefined,
      title: fallbackTitle,
    }
  }

  if (reference.type === 'doc-tab') {
    const title = reference.title || reference.name || '文档标签页'
    const content = reference.content || ''
    const path = reference.path ? await documentReferencePath(reference.path) : ''
    return {
      id: createAttachmentId('attach-doc-tab'),
      name: title,
      path,
      type: 'text',
      size: typeof reference.size === 'number' ? reference.size : content.length,
      ext: normalizeAttachmentExt(reference.ext, '.md'),
      source: 'document-tab',
      documentTitle: title,
      tabId: reference.tabId,
      title,
      selection: content.slice(0, 30_000),
      dirty: reference.dirty,
      saveStatus: reference.saveStatus,
    }
  }

  const title = reference.title || reference.name || '日程'
  const ref = calendarEventReadyRef(reference.eventId, reference.allDay)
  const path = ref ? toReadyUri(ref) : ''
  return {
    id: createAttachmentId('attach-calendar'),
    name: ref ? title : `${title}（无法定位）`,
    path,
    type: 'text',
    size: String(reference.description || '').length,
    ext: '.calendar',
    source: 'calendar-event',
    title,
    eventId: ref ? reference.eventId : undefined,
    startTime: reference.startTime,
    endTime: reference.endTime,
    calendarId: reference.calendarId,
    description: ref ? reference.description : '无法定位：缺少有效事件身份或原始实例信息。',
    location: reference.location,
    allDay: reference.allDay,
    contentType: reference.contentType,
    platform: reference.platform,
    publishStatus: reference.publishStatus,
  }
}

export async function addReadyContextReferenceToAgentInput(reference: ReadyContextReference): Promise<void> {
  const composerAuthority = captureComposerAuthority(useAgent.getState())
  const attachment = await createReadyContextAttachment(reference)
  if (!isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) return
  useWorkspace.setState({ chatPanelVisible: true })
  useAgent.getState().addAttachments([attachment])
  window.dispatchEvent(new CustomEvent(READY_FOCUS_CHAT_INPUT_EVENT))
}

export function addDocumentWidgetTargetReference(context: DocumentWidgetTargetContext): void {
  const prompt = buildWidgetTargetUpdatePrompt(context.widgetTitle)
  const attachment = createDocumentWidgetTargetAttachment(context)

  useWorkspace.setState({ chatPanelVisible: true })

  useAgent.setState((state) => ({
    attachments: [
      ...state.attachments.filter((item) => item.source !== 'document-widget-target'),
      attachment,
    ],
    inputValue: prompt,
    pendingContinuationIntent: null,
  }))

  window.dispatchEvent(new CustomEvent(READY_FOCUS_CHAT_INPUT_EVENT))
}

export async function addDocumentQuoteReference(context: DocumentQuoteContext): Promise<void> {
  const selection = context.selection.trim()
  if (!selection) return
  const authority = captureComposerAuthority(useAgent.getState())
  let path = '', description: string | undefined
  if (context.path) {
    try { path = await documentReferencePath(context.path) }
    catch (error) { description = `无法定位来源：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isComposerAuthorityCurrent(useAgent.getState(), authority)) return
  const attachment: ChatAttachment = {
    id: createAttachmentId('attach-document-quote'),
    name: context.title || '文档摘录',
    path,
    description,
    type: 'text',
    size: selection.length,
    ext: '.quote',
    source: 'document-quote',
    documentTitle: context.title,
    selection: selection.slice(0, 30_000),
    sectionTitle: context.sectionTitle || undefined,
    lineStart: context.lineStart || undefined,
    lineEnd: context.lineEnd || undefined,
  }
  useWorkspace.setState({ chatPanelVisible: true })
  useAgent.getState().addAttachments([attachment])
  window.dispatchEvent(new CustomEvent(READY_FOCUS_CHAT_INPUT_EVENT))
}
