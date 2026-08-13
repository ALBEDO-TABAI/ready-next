import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
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

test('live task activity replaces the empty welcome panel so confirmation remains visible', () => {
  const host = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(host)
  flushSync(() => {
    root.render(createElement(ChatMessages, {
      messages: [],
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
    }))
  })

  assert.equal(host.textContent?.includes('Ready for work'), false)
  const pending = host.querySelector('[data-chat-pending-task-snapshot="true"]')
  assert.ok(pending)
  assert.match(pending.textContent || '', /等待你确认/)

  flushSync(() => root.unmount())
})
