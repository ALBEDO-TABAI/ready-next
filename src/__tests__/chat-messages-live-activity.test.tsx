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
