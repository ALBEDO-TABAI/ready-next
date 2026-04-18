import { useAgent } from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'
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
