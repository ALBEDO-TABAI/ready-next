import { useAgent } from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'

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

export function buildDocumentQuoteSnippet(context: DocumentQuoteContext): string {
  const lines = [
    '### 文档内容引用',
    `- 文档: ${context.title}`,
    `- 路径: ${context.path || '(未保存草稿)'}`,
    context.sectionTitle ? `- 章节: ${context.sectionTitle}` : null,
    context.lineStart && context.lineEnd
      ? `- 位置: 第 ${context.lineStart} - ${context.lineEnd} 行`
      : context.lineStart
        ? `- 位置: 第 ${context.lineStart} 行附近`
        : null,
    '',
    '```quote',
    context.selection.trim(),
    '```',
    '',
    '请基于这段原文的位置和内容继续处理。',
  ].filter(Boolean)

  return lines.join('\n')
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
