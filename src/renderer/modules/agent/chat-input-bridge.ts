import { useAgent } from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'
import type { ChatAttachment } from '../../stores/useAgent'
import { createLocalPathAttachment } from '../../components/agent/chat-panel/attachments-helpers'
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
    items: [
      {
        id: 'reference-to-input',
        label: '引用到输入框',
        iconText: '@',
      },
    ],
  }).catch(() => null)
  return Boolean(result?.success && result.selectedId === 'reference-to-input')
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

async function createReadyContextAttachment(reference: ReadyContextReference): Promise<ChatAttachment> {
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
    let snapshot = {
      title: fallbackTitle,
      url: reference.url || '',
      heading: reference.heading || '',
      selection: reference.selection || '',
      excerpt: reference.excerpt || '',
      capturedAt: Date.now(),
    }
    try {
      if (window.electronAPI?.browser?.getTabContext && reference.tabId) {
        const ctx = await window.electronAPI.browser.getTabContext(reference.tabId)
        if (ctx.success && ctx.data) {
          snapshot = {
            title: ctx.data.title || snapshot.title,
            url: ctx.data.url || snapshot.url,
            heading: ctx.data.heading || snapshot.heading,
            selection: ctx.data.selection || snapshot.selection,
            excerpt: ctx.data.excerpt || snapshot.excerpt,
            capturedAt: ctx.data.capturedAt || snapshot.capturedAt,
          }
        }
      }
    } catch {
      // silent-catch: tab context lookup may legitimately fail (tab closed mid-attachment). The fallback tab metadata is still useful as a reference and no user-facing impact.
    }
    const path = snapshot.url || (reference.tabId ? `browser-tab://${reference.tabId}` : `browser-tab://${Date.now()}`)
    return {
      id: createAttachmentId('attach-browser'),
      name: snapshot.title || fallbackTitle,
      path,
      type: 'text',
      size: snapshot.excerpt.length,
      ext: '.url',
      source: 'browser-tab',
      browserTabId: reference.tabId,
      url: snapshot.url || reference.url,
      title: snapshot.title || fallbackTitle,
      heading: snapshot.heading,
      selection: snapshot.selection,
      excerpt: snapshot.excerpt,
      capturedAt: snapshot.capturedAt,
    }
  }

  if (reference.type === 'doc-tab') {
    const title = reference.title || reference.name || '文档标签页'
    const content = reference.content || ''
    const path = reference.path || `doc-tab://${encodeURIComponent(reference.tabId || title)}`
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
      excerpt: content.slice(0, 12000),
      dirty: reference.dirty,
      saveStatus: reference.saveStatus,
    }
  }

  const title = reference.title || reference.name || '日程'
  const path = reference.eventId
    ? `calendar-event://${encodeURIComponent(reference.eventId)}`
    : `calendar-event://${Date.now()}`
  return {
    id: createAttachmentId('attach-calendar'),
    name: title,
    path,
    type: 'text',
    size: String(reference.description || '').length,
    ext: '.calendar',
    source: 'calendar-event',
    title,
    eventId: reference.eventId,
    startTime: reference.startTime,
    endTime: reference.endTime,
    calendarId: reference.calendarId,
    description: reference.description,
    location: reference.location,
    allDay: reference.allDay,
    contentType: reference.contentType,
    platform: reference.platform,
    publishStatus: reference.publishStatus,
  }
}

export async function addReadyContextReferenceToAgentInput(reference: ReadyContextReference): Promise<void> {
  const attachment = await createReadyContextAttachment(reference)
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

export function addDocumentQuoteReference(context: DocumentQuoteContext): void {
  const selection = context.selection.trim()
  if (!selection) return

  const lineLabel = context.lineStart && context.lineEnd
    ? context.lineStart === context.lineEnd
      ? `#L${context.lineStart}`
      : `#L${context.lineStart}-${context.lineEnd}`
    : '#引用'

  const attachmentName = `${context.title} ${lineLabel}`
  const attachmentPath = context.path || `document-quote://${encodeURIComponent(context.title)}${lineLabel}`

  useWorkspace.setState({ chatPanelVisible: true })
  useAgent.getState().addAttachments([{
    id: `attach-doc-quote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: attachmentName,
    path: attachmentPath,
    type: 'text',
    size: selection.length,
    ext: '.md',
    source: 'document-quote',
    title: context.title,
    selection,
    lineStart: context.lineStart ?? undefined,
    lineEnd: context.lineEnd ?? undefined,
    sectionTitle: context.sectionTitle ?? undefined,
    excerpt: selection.slice(0, 2000),
  }])
  window.dispatchEvent(new CustomEvent(READY_FOCUS_CHAT_INPUT_EVENT))
}
