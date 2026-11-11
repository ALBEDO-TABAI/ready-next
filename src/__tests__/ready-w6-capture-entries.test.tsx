import assert from 'node:assert/strict'
import test from 'node:test'
import { act, type ReactNode } from 'react'
import { editorFixture } from './helpers/ready-block-editor-fixture'
import { createDraftFixture } from './helpers/ready-drafts-fixture'
import { importWithoutStyles } from './utils/import-without-styles'
import type { FastCardItem, FastCardTransferRequest } from '../shared/fastcard'
import type { PageOperation } from '../shared/document-pages'
import type { RSSItem } from '../renderer/components/rss/RSSFeed'

// W6 §3.2 收下 entries, through their visible controls: real components, capture wiring, stores, floats and toasts;
// only window.electronAPI (the process boundary) is an observable stand-in.

async function mount(t: test.TestContext) {
  let cleanup = async () => {}
  t.after(() => cleanup())
  const f = await editorFixture(t, '正文')
  const customEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent')
  Object.defineProperty(globalThis, 'CustomEvent', { value: f.dom.window.CustomEvent, configurable: true, writable: true })
  Object.assign(globalThis, { ResizeObserver: class { observe() {} disconnect() {} }, CSS: { escape: (value: string) => value } })
  f.dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const added: FastCardItem[] = [], transfers: FastCardTransferRequest[] = [], operations: PageOperation[] = []
  let cards: FastCardItem[] = []
  const api = {
    browser: {
      addFastCardItem: async (item: FastCardItem) => { added.push(item); cards = [item, ...cards]; return { success: true, data: item } },
      removeFastCardItem: async (id: string) => { cards = cards.filter(card => card.id !== id); return { success: true } },
      listFastCardItems: async () => ({ success: true, data: cards }),
      getTabs: async () => [],
      seed: (items: FastCardItem[]) => { cards = items },
    },
    fastCard: {
      transfer: async (request: FastCardTransferRequest) => { transfers.push(request); return { success: true, data: { state: 'completed', operationId: request.operationId, objectId: 'board', title: '灵感', nodeIds: ['node'] } } },
      undo: async () => ({ success: true, data: { state: 'undone' } }), targets: async () => ({ success: true, data: [] }), pending: async () => ({ success: true, data: [] }),
    },
    objects: { locate: async (id: string) => ({ objectId: id, path: `/vault/${id}.pdf`, revision: 1 }), resolvePath: async (path: string) => ({ objectId: 'saved-page', path, revision: 1 }), onMoved: () => () => {},
      prepareMigration: async () => ({ resolved: [] }), completeMigration: async () => ({ state: 'completed' }) },
    document: { stat: async () => ({ success: true, data: { isDirectory: false } }), readFile: async () => ({ success: true, content: '' }) },
    vault: { get: async () => ({ status: 'ready', root: '/vault' }), onChanged: () => () => {} },
    documentPages: {
      operate: async (input: PageOperation) => { operations.push(input); return { ok: true, value: { operationId: input.operationId, state: 'committed', objectId: 'saved-page', revision: 2, path: null } } },
      tree: async () => ({ ok: true, value: { objectId: 'vault', revision: 1, path: '/vault', name: 'vault', kind: 'vault', title: '资料库', children: [], hasChildren: false, position: 0 } }),
      states: async () => ({ ok: true, value: [] }), onChanged: () => () => {},
    },
    rss: { onOrganizationChanged: () => () => {}, onEventSeenChanged: () => () => {}, readArticle: async () => ({ success: true, data: {
      article: { id: 'article', title: '筛子理论', revision: 'r1', source: '演示订阅源', summary: '先理解你在做什么，再决定给你看什么。', link: 'https://example.com/a', classifications: [] },
      body: { status: 'ready', sourceUrl: 'https://example.com/a' }, text: '第一段正文。\n\n第二段正文。', textKind: 'body', nextOffset: null } }) },
  }
  Object.assign(f.dom.window, { electronAPI: api })
  const { ui } = await importWithoutStyles(async () => ({ ui: await import('../renderer/components/ui') }))
  const toastStore = await import('../renderer/components/ui/toast-store')
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useFastCard } = await import('../renderer/stores/useFastCard')
  const agentBefore = useAgent.getState(), cardsBefore = useFastCard.getState()
  const host = document.createElement('div'); document.body.append(host)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(host)
  const clearToasts = () => toastStore.getToasts().forEach(item => toastStore.dismissToast(item.id))
  clearToasts()
  cleanup = async () => {
    await act(async () => { ui.closeAllFloats(); clearToasts(); root.unmount() }); host.remove()
    useAgent.setState(agentBefore, true); useFastCard.setState(cardsBefore, true)
    Reflect.deleteProperty(globalThis, 'ResizeObserver'); Reflect.deleteProperty(globalThis, 'CSS')
    if (customEvent) Object.defineProperty(globalThis, 'CustomEvent', customEvent)
  }
  const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 5)) })
  const render = async (node: ReactNode) => { await act(async () => root.render(<>{node}<ui.FloatHost /><ui.ToastHost /></>)); await settle() }
  const press = async (element: Element | null | undefined, what: string) => { assert.ok(element, what); await act(async () => (element as HTMLElement).click()); await settle() }
  const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  const toast = () => [...document.querySelectorAll('.rn-toast')].at(-1)?.textContent ?? ''
  /** Durable steps (draft finalize, transfer) settle over several turns; wait for the toast they end with. */
  const toastAfter = async (pattern: RegExp) => {
    for (let i = 0; i < 100 && !pattern.test(toast()); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    return toast()
  }
  return { f, api, added, transfers, operations, useAgent, useFastCard, render, press, button, toast, toastAfter, settle }
}

test('资讯: 收下 › 存入 FastCard keeps the article as the source; selected words go through the shared bar', async t => {
  const h = await mount(t)
  const { default: RSSArticleReader } = await importWithoutStyles(() => import('../renderer/components/rss/RSSArticleReader'))
  const { RSSTopbarContext } = await import('../renderer/components/rss/rss-topbar-context')
  const lead = document.createElement('div'), tools = document.createElement('div')
  document.body.append(lead, tools)
  t.after(() => { lead.remove(); tools.remove() })
  const item = { id: 'article', title: '筛子理论', link: 'https://example.com/a', revision: 'r1', summary: '', author: '', source: '演示订阅源' } as RSSItem
  await h.render(<RSSTopbarContext.Provider value={{ lead, tools }}><RSSArticleReader item={item} onClose={() => {}} onOpened={async () => {}} onToggleStar={() => {}} /></RSSTopbarContext.Provider>)

  await h.press(h.button('收下', tools) ?? [...tools.querySelectorAll('button')].find(entry => entry.textContent?.startsWith('收下')), '收下 menu button')
  assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map(entry => entry.textContent), ['存入 FastCard', '保存到画板', '引用到文档'])
  await h.press([...document.querySelectorAll('[role="menuitem"]')].find(entry => entry.textContent === '存入 FastCard'), '存入 FastCard')
  assert.equal(h.added.length, 1)
  assert.deepEqual(h.added[0].source?.ref, { kind: 'rss-item', id: 'article' })
  assert.equal(h.added[0].text, '先理解你在做什么，再决定给你看什么。')
  assert.equal(h.added[0].title, '筛子理论')
  assert.match(h.toast(), /已存入 FastCard/)
  assert.equal(h.useFastCard.getState().panelOpen, false, 'the shelf stays closed; the toast offers 打开')

  // Selected words: the shared bar over the selection, with the exact reading range as the source.
  const body = document.querySelector<HTMLElement>('.rss-reader-body')!
  const run = body.querySelector('[data-ready-reading-run]')!
  const range = document.createRange(); range.setStart(run.firstChild!, 0); range.setEnd(run.firstChild!, 3)
  h.f.dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 100, top: 200, right: 160, bottom: 220, width: 60, height: 20, x: 100, y: 200, toJSON: () => ({}) })
  body.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) })
  await act(async () => { h.f.dom.window.getSelection()!.removeAllRanges(); h.f.dom.window.getSelection()!.addRange(range); body.dispatchEvent(new h.f.dom.window.MouseEvent('mouseup', { bubbles: true })) })
  await h.settle()
  const bar = document.querySelector('[data-ready-selection-bar]')
  assert.ok(bar, 'the selection bar opens over the selection')
  assert.deepEqual([...bar.querySelectorAll('button')].map(entry => entry.textContent), ['划线', '存入 FastCard', '引用到文档', '问 AI', '保存到画板'])
  await h.press(h.button('存入 FastCard', bar), 'bar 存入 FastCard')
  assert.equal(h.added.length, 2)
  assert.equal(h.added[1].text, '第一段')
  assert.deepEqual(h.added[1].source?.ref, { kind: 'rss-item', id: 'article', excerpt: { format: 'reading-v1', expectedRevision: 'r1', range: { start: { run: 0, offset: 0 }, end: { run: 0, offset: 3 } }, offset: 0, length: 12000 } })
  assert.equal(document.querySelector('[data-ready-selection-bar]'), null, 'the bar closes after its action')
})

test('助手回答: 存为页面 goes through the durable draft and the Save To dialog, keeps ready_source, and 撤销 trashes it', async t => {
  const h = await mount(t)
  const { configureDrafts, useDraftUI } = await import('../renderer/modules/document/drafts/runtime')
  const drafts = createDraftFixture()
  configureDrafts({ ...drafts.port, tabs: () => h.f.useDocTabs.getState().tabs,
    patch: (id, patch) => h.f.useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })) })
  const finalized: unknown[] = []
  // Main writes the draft's own bytes; the controller reads them back and compares hashes before it lets go.
  drafts.api.finalize = async (id, revision, input) => { finalized.push({ id, input }); return { ok: true, value: { draftId: id, revision, contentHash: drafts.drafts.get(id)!.contentHash, objectId: 'saved-page', path: '/vault/筛子的理由.md', operationId: input.operationId, parentObjectId: null } } }
  const { default: ChatMessages } = await importWithoutStyles(() => import('../renderer/components/agent/ChatMessages'))
  const { DraftSaveDialogHost } = await importWithoutStyles(() => import('../renderer/modules/document/drafts/DraftSaveDialog'))
  h.useAgent.setState({ conversationId: 'chat' })
  const message = { id: 'answer', agent: 'butler', type: 'agent' as const, content: '## 筛子的理由\n\n先理解你在做什么。', timestamp: new Date(), meta: { runId: 'run-1' } }
  const noop = () => undefined
  await h.render(<><DraftSaveDialogHost /><ChatMessages messages={[message]} contextBoundaries={[]} productTurnActionProjectionByRunId={{}} messageTaskSnapshots={{}} messageGeneratedImageArtifacts={{}}
    messageToolTraceSnapshots={{}} pendingTaskRun={null} pendingToolTrace={null} runDurationMeter={null} isStreaming={false} streamingMessageId={null} toolTrace={[]} toolTraceStatus="idle"
    toolTraceExpanded={false} copiedMessageId={null} showToolTraceCapsule={false} bottomOverlayInset={0} onSetInputSuggestion={noop} onToggleToolTrace={noop} onCopyMessage={noop}
    onAttachmentPreview={noop} onReferenceSelect={noop} onRevealDocumentQuote={noop} getDocumentQuoteTooltip={() => ''} getAttachmentMetaSummary={() => null} getAttachmentPreviewSrc={() => null}
    renderAttachmentIcon={() => null} renderMarkdown={content => content} /></>)

  await h.press(h.button('收下这段回答'), 'answer menu')
  assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map(entry => entry.textContent), ['存为卡片', '存为页面'])
  await h.press([...document.querySelectorAll('[role="menuitem"]')].find(entry => entry.textContent === '存为页面'), '存为页面')
  // A recoverable draft exists before anything is written: content plus the conversation as ready_source.
  const draft = [...drafts.drafts.values()].at(-1)!
  assert.match(draft.content, /ready_source: ready:\/\/agent\/conversation\/chat#run=run-1/)
  assert.match(draft.content, /先理解你在做什么/)
  assert.equal(useDraftUI.getState().saveHost, 'dialog')
  const dialog = document.querySelector('[role="dialog"][aria-label="保存到…"]')
  assert.ok(dialog, 'the Save To picker opens as a dialog where the person is')
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="标题"]')?.value, '筛子的理由')
  await h.press(h.button('确认', dialog!), '确认')
  assert.match(await h.toastAfter(/已存为页面/), /已存为页面《筛子的理由》.*撤销.*打开/)
  assert.equal(finalized.length, 1)
  assert.equal(document.querySelector('[role="dialog"][aria-label="保存到…"]'), null, 'the dialog closes once the page is saved')
  await h.press([...document.querySelectorAll('.rn-toast button')].find(entry => entry.textContent === '撤销'), '撤销')
  assert.deepEqual(h.operations.map(operation => [operation.type, 'objectId' in operation ? operation.objectId : null, operation.root]), [['trash', 'saved-page', '/vault']])

  // Without a saved conversation there is no source to keep: the entry reports it instead of saving.
  h.useAgent.setState({ conversationId: null })
  await h.press(h.button('收下这段回答'), 'answer menu again')
  await h.press([...document.querySelectorAll('[role="menuitem"]')].find(entry => entry.textContent === '存为卡片'), '存为卡片')
  assert.match(h.toast(), /这段对话还没有保存/)
  assert.equal(h.transfers.length, 0)
})

test('FastCard: 插入到文档 on a card puts its reference into the current page; 撤销 takes exactly that out', async t => {
  const h = await mount(t)
  const card: FastCardItem = { id: 'card', kind: 'text', createdAt: 1, title: '一个好的筛子', text: '先理解你在做什么。', source: { pageUrl: 'https://example.com/a' } }
  h.api.browser.seed([card])
  h.useFastCard.setState({ items: [card], panelOpen: true, collapsed: false })
  const { FastCardShelf } = await importWithoutStyles(() => import('../renderer/modules/fastcard/FastCardShelf'))
  await h.render(<FastCardShelf visible />)
  await h.press(h.button('插入到文档', document.querySelector('[data-fastcard-id="card"]')!), '插入到文档')
  const content = () => h.f.useDocTabs.getState().tabs.find(tab => tab.id === t.name)!.content
  assert.ok(content().endsWith('\r\n\r\n[一个好的筛子](ready://fastcard/card)\r\n\r\n'), JSON.stringify(content().slice(-80)))
  assert.match(h.toast(), /已引用到《夹具》/)
  await h.press([...document.querySelectorAll('.rn-toast button')].find(entry => entry.textContent === '撤销'), '撤销')
  h.f.bytes('正文')
})

test('文档块: 发送到画板 from the block menu saves the block’s words with the block as its source', async t => {
  const h = await mount(t)
  await h.render(null)
  h.f.useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, objectId: 'page' })) }))
  const handle = document.querySelector<HTMLButtonElement>('[aria-label="块菜单"]')
  await h.press(handle, 'block handle')
  await h.f.click('发送到画板')
  await h.settle()
  assert.equal(h.transfers.length, 1)
  const item = h.added.at(-1)!
  assert.equal(item.text, '正文')
  assert.deepEqual(item.source?.ref, { kind: 'page', id: 'page' })
  assert.deepEqual(h.transfers[0].itemIds, [item.id])
  assert.match(h.toast(), /已存到画板《灵感》/)
})

test('FastCard names where a reader’s capture came from', async () => {
  const { sourceLabel } = await import('../renderer/components/browser/fastcard-presentation')
  const card = (source: FastCardItem['source']): FastCardItem => ({ id: 'card', kind: 'text', createdAt: 1, text: '原文', source })
  assert.equal(sourceLabel(card({ ref: { kind: 'rss-item', id: 'article' } })), '资讯')
  assert.equal(sourceLabel(card({ ref: { kind: 'book-location', book: 'book', loc: 'c0:0+2' } })), '书')
  assert.equal(sourceLabel(card({ ref: { kind: 'file', id: 'pdf', anchor: 'pdf:{"page":1}' } })), 'PDF')
  assert.equal(sourceLabel(card({ ref: { kind: 'conversation', id: 'chat' } })), '对话')
  assert.equal(sourceLabel(card({ ref: { kind: 'page', id: 'page', anchor: '^block' } })), '页面')
  assert.equal(sourceLabel(card({ ref: { kind: 'web', url: 'https://example.com/a' }, pageUrl: 'https://example.com/a', domain: 'example.com' })), '网页 · example.com')
  assert.equal(sourceLabel(card(undefined)), '快记')
})
