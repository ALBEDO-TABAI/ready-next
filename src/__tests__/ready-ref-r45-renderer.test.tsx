import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { RSSReferenceSchema, rssReferencePath, rssReferenceFromReadyRef } from '../shared/rss-reference'
import { parseReadyUri } from '../shared/ready-ref'

// The actual composer/drop/preview/Markdown entrypoints run in a DOM. Only IPC is substituted.
test('R45 generators, persistence, drop and click share ReadyRef while resource authorization remains separate', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  let root: ReturnType<typeof createRoot> | undefined
  t.after(async () => { if (root) flushSync(() => root!.unmount()); await new Promise(resolve => setImmediate(resolve)); dom.window.close(); for (const [key, value] of globals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) } })
  dom.window.localStorage.setItem('ready-object-presentation-migration-v1', JSON.stringify({ migrationId: 'test', applied: true, report: { state: 'completed', resolved: [], unresolved: [] } }))
  const calls: unknown[] = []
  let stale = false
  Object.defineProperty(dom.window, 'electronAPI', { value: {
    objects: { onMoved: () => () => {}, resolvePath: async (path: string) => ({ objectId: 'doc', path, revision: 1 }), locate: async () => ({ objectId: 'doc', path: '/fixture/renamed.md', revision: 2 }) },
    browser: { createTab: async (url: string) => { calls.push(['web', url]); return { success: true, tabId: 'opened', title: 'Page' } } },
    rss: {
      readArticle: async (read: unknown) => { calls.push(['article', read]); return { success: true, data: { article: { revision: 'v1' } } } },
      readExcerpt: async (read: unknown) => { calls.push(['excerpt', read]); return stale ? { success: false, error: 'article_changed' } : { success: true, data: { text: 'exact' } } },
      readDigests: async (read: unknown) => { calls.push(['digest', read]); return { success: true, data: { view: 'entries' } } },
    },
  } })
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useRSSSession } = await import('../renderer/stores/useRSSSession')
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { createReadyContextAttachment, addDocumentQuoteReference, addRSSReferenceToAgentInput } = await import('../renderer/modules/agent/chat-input-bridge')
  const { serializePersistedAttachments, extractAttachmentsFromMeta, buildCodexIngressInputWithDiagnostics } = await import('../renderer/modules/agent/messageComposer')
  const { useAttachmentIntake } = await import('../renderer/components/agent/chat-panel/drag-drop/use-attachment-intake')
  const { useAttachmentPreview } = await import('../renderer/components/agent/chat-panel/attachments-preview/use-attachment-preview')
  const { renderInline } = await import('../renderer/components/agent/chat-panel/markdown')
  const { openReadyRef } = await import('../renderer/modules/workbench/open-ready-ref')
  useAgent.setState({ attachments: [], filePool: [], sessions: {} })
  const browser = await createReadyContextAttachment({ type: 'browser-tab', name: 'Web', tabId: 'live', url: 'https://example.test/page' })
  const doc = await createReadyContextAttachment({ type: 'doc-tab', name: 'Saved', path: '/fixture/original.md', tabId: 'doc-tab', content: 'saved text' })
  const draft = await createReadyContextAttachment({ type: 'doc-tab', name: 'Draft', content: 'unsaved text', dirty: true })
  assert.equal(doc.path, 'ready://doc/page/doc'); assert.equal(draft.path, '')
  await addDocumentQuoteReference({ title: 'Quote', path: null, selection: 'original quote' })
  const quote = useAgent.getState().attachments[0]
  assert.equal(quote.path, '')
  await addDocumentQuoteReference({ title: 'Saved quote', path: '/fixture/original.md', selection: 'saved selection', lineStart: 2, lineEnd: 2 })
  const savedQuote = useAgent.getState().attachments.find(a => a.name === 'Saved quote')!
  assert.equal(savedQuote.path, 'ready://doc/page/doc')
  const file = await createReadyContextAttachment({ type: 'doc-tab', name: 'File', path: '/fixture/reference.pdf' })
  assert.equal(file.path, 'ready://doc/file/doc')
  const restored = extractAttachmentsFromMeta({ attachments: serializePersistedAttachments([browser, doc, draft, quote]) })!
  assert.deepEqual(restored.map(a => a.selection), [undefined, 'saved text', 'unsaved text', 'original quote'])
  assert.equal(restored[0].browserTabId, undefined)
  const live = await buildCodexIngressInputWithDiagnostics({ content: 'read', attachments: [browser, doc, draft, quote] })
  assert.deepEqual(live.resources.map(r => r.kind), ['browser_tab', 'local_file', 'quoted_text', 'quoted_text'])
  assert.equal(live.resources[1].kind === 'local_file' && live.resources[1].path, '/fixture/renamed.md')
  const historical = await buildCodexIngressInputWithDiagnostics({ content: 'read', attachments: [restored[0]] })
  assert.equal(historical.resources.length, 0, 'a navigable URL cannot grant a browser tab')

  const reference = RSSReferenceSchema.parse({ kind: 'excerpt', read: { format: 'reading-v1', itemId: 'item', expectedRevision: 'v1', range: { start: { run: 0, offset: 1 }, end: { run: 0, offset: 4 } }, offset: 1, length: 2 } })
  const uri = rssReferencePath(reference)
  addRSSReferenceToAgentInput('Excerpt', reference)
  const rssAttachment = useAgent.getState().attachments.find(a => a.source === 'rss-reference')!
  assert.equal(rssAttachment.path, uri)
  const parsed = parseReadyUri(uri); assert.ok(parsed.ok)
  assert.deepEqual(rssReferenceFromReadyRef(parsed.ref), reference)
  const rssInput = await buildCodexIngressInputWithDiagnostics({ content: 'read', attachments: [{ ...rssAttachment, path: 'ready://rss/item/another' }] })
  assert.deepEqual(rssInput.resources[0].kind === 'rss_reference' && rssInput.resources[0].reference, reference, 'scope comes from the structured resource, never navigation')

  let preview!: ReturnType<typeof useAttachmentPreview>, drop!: ReturnType<typeof useAttachmentIntake>['handleDrop']
  const previews: unknown[] = [], dropped: typeof restored = []
  function Harness() {
    preview = useAttachmentPreview({ setActiveAttachmentPreview: value => previews.push(value), setAttachmentPreviewLoading: () => {} })
    drop = useAttachmentIntake({ addAttachments: values => dropped.push(...values), setInputValue: () => {}, setIsDragOver: () => {}, focusInputWithResize: () => {} }).handleDrop
    return createElement('div', { onDrop: drop }, ...renderInline(`[exact](${uri}) ${browser.path}`))
  }
  root = createRoot(dom.window.document.getElementById('root')!)
  flushSync(() => root!.render(createElement(Harness)))
  for (const payload of [{ type: 'browser-tab', name: 'Drop web', tabId: 'drop', url: 'https://example.test/drop' }, { type: 'doc-tab', name: 'Drop doc', path: '/fixture/a.md', selection: 'new edits', dirty: true }]) {
    const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files: [], getData: (mime: string) => mime === 'application/x-ready-drag' ? JSON.stringify(payload) : '' } })
    dom.window.document.getElementById('root')!.firstElementChild!.dispatchEvent(event)
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.deepEqual(dropped.map(a => a.path), ['ready://web?url=https%3A%2F%2Fexample.test%2Fdrop', 'ready://doc/page/doc'])
  assert.equal(dropped[1].selection, 'new edits')
  await preview(restored[0]); assert.deepEqual(calls.at(-1), ['web', 'https://example.test/page'])
  await preview(doc); assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === useDocTabs.getState().activeTabId)?.path, '/fixture/renamed.md')
  await preview(savedQuote); assert.equal(useDocTabs.getState().pendingReveal?.selection, 'saved selection')
  await preview(quote); assert.match(JSON.stringify(previews.at(-1)), /original quote/)
  await preview(draft); assert.match(JSON.stringify(previews.at(-1)), /unsaved text/)
  dom.window.document.querySelector<HTMLAnchorElement>('a')!.click()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.at(-1), ['excerpt', reference.read])
  const before = useRSSSession.getState()
  stale = true
  await assert.rejects(openReadyRef(uri), /article_changed/)
  assert.equal(useRSSSession.getState(), before, 'failed read must not publish a reveal')
  await openReadyRef('ready://rss/digest/report?offset=4&limit=2')
  assert.deepEqual(calls.at(-1), ['digest', { view: 'entries', reportId: 'report', offset: 4, limit: 2 }])
})
