import { memoryNavigationAPI } from './utils/navigation-memory'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

Object.defineProperties(globalThis, {
  window: { value: dom.window, configurable: true },
  CustomEvent: { value: dom.window.CustomEvent, configurable: true },
  document: { value: dom.window.document, configurable: true },
  HTMLElement: { value: dom.window.HTMLElement, configurable: true },
  Element: { value: dom.window.Element, configurable: true },
  Node: { value: dom.window.Node, configurable: true },
  navigator: { value: dom.window.navigator, configurable: true },
  localStorage: { value: dom.window.localStorage, configurable: true },
  requestAnimationFrame: { value: (callback: FrameRequestCallback) => { callback(0); return 0 }, configurable: true },
  cancelAnimationFrame: { value: () => undefined, configurable: true },
})

;(dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined

const channel = new Proxy({}, {
  get: (_target, property) => property.toString().startsWith('on')
    ? () => () => undefined
    : async () => ({ success: true, data: [] }),
})
;(dom.window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  agentInteraction: channel,
  calendar: channel,
  // Opening a reference records it in the shared navigation history (W6 §4).
  navigationHistory: memoryNavigationAPI(),
}

const ChatMessages = (await import('../renderer/components/agent/ChatMessages')).default
const { MarkdownContent } = await import('../renderer/components/agent/chat-panel/markdown')

function renderMessages(t: test.TestContext, overrides: Partial<ComponentProps<typeof ChatMessages>>) {
  const host = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(host)
  t.after(() => flushSync(() => root.unmount()))
  flushSync(() => {
    root.render(createElement(ChatMessages, {
      messages: [],
      contextBoundaries: [],
      productTurnActionProjectionByRunId: {},
      messageTaskSnapshots: {},
      messageGeneratedImageArtifacts: {},
      messageToolTraceSnapshots: {},
      pendingTaskRun: createElement('div', null, '等待你确认'),
      pendingToolTrace: null,
      runDurationMeter: null,
      isStreaming: true,
      streamingMessageId: 'stream-live-task',
      toolTrace: [],
      toolTraceStatus: 'running',
      toolTraceExpanded: false,
      copiedMessageId: null,
      showToolTraceCapsule: false,
      bottomOverlayInset: 0,
      onSetInputSuggestion: () => undefined,
      onToggleToolTrace: () => undefined,
      onCopyMessage: () => undefined,
      onAttachmentPreview: () => undefined,
      onReferenceSelect: () => undefined,
      onRevealDocumentQuote: () => undefined,
      getDocumentQuoteTooltip: () => '',
      getAttachmentMetaSummary: () => null,
      getAttachmentPreviewSrc: () => null,
      renderAttachmentIcon: () => null,
      renderMarkdown: (content: string) => content,
      ...overrides,
    }))
  })
  return host
}

test('live task activity replaces the empty welcome panel so confirmation remains visible', (t) => {
  const host = renderMessages(t, {})
  assert.equal(host.textContent?.includes('Ready for work'), false)
  const pending = host.querySelector('[data-chat-pending-task-snapshot="true"]')
  assert.ok(pending)
  assert.match(pending.textContent || '', /等待你确认/)

})

test('a context boundary after an answered question renders exactly once between old and new messages', (t) => {
  const host = renderMessages(t, {
    isStreaming: false, pendingTaskRun: null, streamingMessageId: null,
    messages: [
      { id: 'answered-card', agent: 'butler', type: 'ask_user_questions', content: '', timestamp: new Date(),
        askUserQuestions: { cardId: 'answered-card', status: 'submitted', askedAt: 1, questions: [], answers: [] } },
      { id: 'new-user', agent: 'butler', type: 'user', content: 'New context input', timestamp: new Date() },
    ],
    contextBoundaries: [{ operationId: 'boundary-card', scopeId: 'scope', scopeEpoch: 0,
      sourceThreadBindingId: 'source', sourceAliasGeneration: 1, sourceRevision: 1,
      targetThreadBindingId: 'target', targetAliasGeneration: 2,
      previousVisibleMessageAnchor: 'answered-card', committedAt: '2026-09-05T00:00:00Z', receiptDigest: 'a'.repeat(64) }],
  })
  const markers = host.querySelectorAll('[data-ready-context-boundary="boundary-card"]')
  assert.equal(markers.length, 1)
  const card = host.querySelector('[data-chat-message-ask-user="answered-card"]')!
  assert.ok(card.compareDocumentPosition(markers[0]) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING)
  assert.ok((host.textContent || '').indexOf('从这里开始新的上下文') < (host.textContent || '').indexOf('New context input'))
})

test('installed reply framing selects the real markdown surface rather than assuming paragraph tags', (t) => {
  const marker = 'READY_HISTORY_OK_H01_R3'
  const host = renderMessages(t, {
    isStreaming: false, pendingTaskRun: null, streamingMessageId: null,
    messages: [{ id: 'reply', agent: 'butler', type: 'agent', content: marker, timestamp: new Date() }],
    renderMarkdown: (content) => createElement(MarkdownContent, { content }),
  })
  const targets = [...host.querySelectorAll('[data-liquid-scroll-root="chat-messages"] .ready-agent-prose')]
    .filter((element) => element.textContent?.trim() === marker)
  assert.equal(targets.length, 1)
})


test('R3c history renders mapped and unavailable attachments, and opens the mapped occurrence', async t => {
  const { useAttachmentPreview } = await import('../renderer/components/agent/chat-panel/attachments-preview/use-attachment-preview')
  const opened: string[] = []
  const queried: string[][] = []
  let resolve!: (value: unknown) => void
  const pending = new Promise(r => { resolve = r })
  const api = {
    getAttachmentDisplayRefs: (ids: string[]) => { queried.push(ids); return pending },
    revealEvent: async (id: string) => { opened.push(id); return { success: true } },
    // The opened event is titled from the snapshot for the navigation history (W6 §4).
    snapshot: async () => ({ success: true, data: { events: [], calendars: [] } }),
  }
  Object.defineProperty(dom.window.electronAPI, 'calendar', { value: api, configurable: true })
  t.after(() => Object.defineProperty(dom.window.electronAPI, 'calendar', { value: channel, configurable: true }))
  let preview!: ReturnType<typeof useAttachmentPreview>
  const previewRoot = createRoot(document.createElement('div'))
  function Preview() {
    preview = useAttachmentPreview({ setActiveAttachmentPreview: value => assert.fail(value?.error || 'unexpected preview error'), setAttachmentPreviewLoading: () => {} })
    return null
  }
  flushSync(() => previewRoot.render(createElement(Preview)))
  t.after(() => flushSync(() => previewRoot.unmount()))
  const attachments = [
    { id: 'one', name: 'Second', path: 'calendar-event://old', type: 'text' as const, size: 0, ext: '' },
    { id: 'two', name: 'Gone', path: 'calendar-event://gone', type: 'text' as const, size: 0, ext: '' },
    { id: 'three', name: 'Missing（无法定位）', path: '', source: 'calendar-event' as const, description: '缺少事件身份', type: 'text' as const, size: 0, ext: '' },
  ]
  const original = JSON.stringify(attachments)
  const host = renderMessages(t, {
    isStreaming: false, pendingTaskRun: null, streamingMessageId: null,
    messages: [{ id: 'closed-message', agent: 'butler', type: 'user', content: 'Saved', timestamp: new Date(), attachments }],
    onAttachmentPreview: att => preview(att),
  })
  assert.deepEqual(queried, [['closed-message']])
  assert.equal(host.querySelector<HTMLButtonElement>('[data-chat-message-attachment]')!.disabled, true)
  resolve({ success: true, data: [
    { messageId: 'closed-message', attachmentIndex: 0, target: { status: 'resolved', ref: { kind: 'event', id: 'timed', occurrence: '1793350800000' } } },
    { messageId: 'closed-message', attachmentIndex: 1, target: { status: 'unlocatable', reason: '真实事件或原始实例不存在' } },
  ] })
  await new Promise(r => setTimeout(r, 30))
  const buttons = host.querySelectorAll<HTMLButtonElement>('[data-chat-message-attachment]')
  assert.equal(buttons[0].disabled, false)
  assert.match(buttons[0].title, /ready:\/\/calendar\/event\/timed#occurrence=1793350800000/)
  assert.match(buttons[1].textContent!, /无法定位/)
  assert.match(buttons[1].title, /真实事件或原始实例不存在/)
  assert.equal(buttons[1].disabled, true)
  assert.equal(buttons[2].textContent, 'Missing（无法定位）')
  assert.match(buttons[2].title, /缺少事件身份/)
  assert.equal(buttons[2].disabled, true)
  buttons[0].click(); buttons[1].click()
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(opened, ['timed#1793350800'])
  assert.equal(JSON.stringify(attachments), original)
})

test('R3c a failed mapping read is visible and cannot open the original attachment', async t => {
  Object.defineProperty(dom.window.electronAPI, 'calendar', { configurable: true, value: {
    getAttachmentDisplayRefs: async () => ({ success: false, error: '历史附件原值摘要不匹配' }),
  } })
  t.after(() => Object.defineProperty(dom.window.electronAPI, 'calendar', { value: channel, configurable: true }))
  const host = renderMessages(t, {
    isStreaming: false, pendingTaskRun: null, streamingMessageId: null,
    messages: [{ id: 'failed-map', agent: 'butler', type: 'user', content: '', timestamp: new Date(),
      attachments: [{ id: 'a', name: 'Saved', type: 'text', size: 0, ext: '', path: 'opaque-original' }] }],
    onAttachmentPreview: () => assert.fail('must not open unverified history'),
  })
  await new Promise(r => setTimeout(r, 20))
  const button = host.querySelector<HTMLButtonElement>('[data-chat-message-attachment]')!
  assert.equal(button.disabled, true)
  assert.match(button.textContent!, /读取失败/)
  assert.match(button.title, /摘要不匹配/)
  button.click()
})


test('W6 conversation reveal scrolls to the exact question and does not auto-scroll to the latest answer', async t => {
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useConversationReveal } = await import('../renderer/modules/agent/conversation-navigation')
  const saved = useAgent.getState(), reveal = useConversationReveal.getState(), scroll = dom.window.HTMLElement.prototype.scrollIntoView
  const targets: Array<string | null> = []
  dom.window.HTMLElement.prototype.scrollIntoView = function () { targets.push(this.getAttribute('data-message-id')) }
  t.after(() => { useAgent.setState(saved, true); useConversationReveal.setState(reveal, true); dom.window.HTMLElement.prototype.scrollIntoView = scroll })
  useAgent.setState({ conversationId: 'scope' })
  useConversationReveal.setState({ target: { scopeId: 'scope', messageId: 'wanted', requestId: 'request' } })
  renderMessages(t, { messages: [
    { id: 'wanted', type: 'user', content: '问题', timestamp: new Date() },
    { id: 'answer', type: 'assistant', content: '回答', timestamp: new Date() },
    { id: 'latest', type: 'user', content: '之后的问题', timestamp: new Date() },
  ], isStreaming: false, pendingTaskRun: null })
  assert.deepEqual(targets, ['wanted'])
  assert.equal(useConversationReveal.getState().target, null)
  flushSync(() => {
    useConversationReveal.setState({ target: { scopeId: 'scope', messageId: 'wanted', requestId: 'stale' } })
    useAgent.setState({ conversationId: 'other' })
  })
  assert.deepEqual(targets, ['wanted'])
  assert.equal(useConversationReveal.getState().target, null)
})
