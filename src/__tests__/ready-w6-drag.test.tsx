import { markdownTree } from '../shared/document-blocks/markdown'
import type { Nodes } from 'mdast'
import type { FastCardTransferRequest } from '../shared/fastcard'
import type { CalendarDelta } from '../shared/calendar/commands'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { editorFixture } from './helpers/ready-block-editor-fixture'
import { READY_REF_MIME, readReadyRefTransfers, toReadyUri, writeReadyRefTransfer, type ReadyRef } from '../shared/ready-ref'
import { RSSQuerySchema } from '../shared/rss-workspace'
import { CanvasNodeSchema, type CanvasOperation } from '../shared/ready-canvas'

class Transfer {
  values = new Map<string, string>()
  get types() { return [...this.values.keys()] }
  setData(key: string, value: string) { this.values.set(key, value) }
  getData(key: string) { return this.values.get(key) || '' }
}
const refs: Array<[string, ReadyRef]> = [
  ['网页标签', { kind: 'web', url: 'https://example.com' }], ['未打开的网页引用', { kind: 'web', url: 'https://example.com/saved' }], ['资讯', { kind: 'rss-item', id: 'article' }],
  ['书', { kind: 'book-location', book: 'book', loc: 'c0:0+2' }], ['划线', { kind: 'page', id: 'book', anchor: '^hl-h' }],
  ['资讯选区', { kind: 'rss-item', id: 'article', excerpt: { format: 'reading-v1', expectedRevision: 'v1', range: { start: { run: 0, offset: 0 }, end: { run: 0, offset: 4 } }, offset: 0, length: 4 } }],
  ['PDF', { kind: 'file', id: 'pdf' }], ['页面', { kind: 'page', id: 'page' }], ['数据库行', { kind: 'page', id: 'row' }],
  ['PDF选区', { kind: 'file', id: 'pdf', anchor: 'pdf:{"page":1}' }], ['文档块', { kind: 'page', id: 'page', anchor: '^block' }],
  ['画板卡片', { kind: 'canvas', id: 'board', node: 'node' }], ['日程', { kind: 'event', id: 'event' }],
  ['FastCard', { kind: 'fastcard', id: 'card' }], ['图片FastCard', { kind: 'fastcard', id: 'image' }],
  ['日期', { kind: 'day', date: '2026-11-12' }], ['对话', { kind: 'conversation', id: 'chat', run: 'run' }],
  ['资讯查询', { kind: 'rss-query', query: { ...RSSQuerySchema.parse({}), expectedRevision: 1 } }],
  ['资讯刊物', { kind: 'rss-digest', id: 'digest', offset: 0, limit: 5 }],
]

test('K3 real drop handlers: every source × document/canvas/composer/calendar/tree', async t => {
  const f = await editorFixture(t, '正文')
  const { dropCanvasReference } = await import('../renderer/modules/canvas/drop-reference')
  const { dropAgentReference } = await import('../renderer/modules/agent/drop-reference')
  const { dropCalendarReference } = await import('../renderer/modules/calendar/linkage/drop-reference')
  const { dropPageTreeReference } = await import('../renderer/modules/workbench/drop-page-tree')
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useFastCard } = await import('../renderer/stores/useFastCard')
  const oldAgent = useAgent.getState(), oldCards = useFastCard.getState()
  t.after(() => { useAgent.setState(oldAgent, true); useFastCard.setState(oldCards, true) })
  const imageCopies: unknown[] = [], transfers: FastCardTransferRequest[] = [], moves: Array<{ objectId: string }> = [], calendar: CalendarDelta[] = []
  const cards = [{ id: 'card', title: '摘录', kind: 'text', text: '原始文字', createdAt: 1 }, { id: 'image', kind: 'image', title: '图片', createdAt: 1 }]
  const hash = 'a'.repeat(64)
  const api = {
    objects: { locate: async (id: string) => ({ objectId: id, path: `/fixture/${id}.${id === 'pdf' ? 'pdf' : 'md'}` }),
      preview: async (ref: ReadyRef) => ref.kind === 'canvas' ? { kind: 'canvas', title: '画板', nodes: [{ id: 'node', title: '卡片原文' }] }
        : { kind: 'book', book: { title: '书', author: '作者' }, passage: { text: '划线原文' } } },
    document: { moveItem: async (path: string) => { moves.push({ objectId: path.split('/').pop()!.split('.')[0] }); return { success: true } }, stat: async () => ({ success: true, data: { isDirectory: false } }), readFile: async () => ({ success: true, content: '正文' }) },
    browser: { getTabs: async () => [{ id: 'tab', url: 'https://example.com' }], listFastCardItems: async () => ({ success: true, data: cards }) },
    fastCard: { documentImage: async (input: unknown) => { imageCopies.push(input); return { success: true, data: 'page.assets/image.png' } },
      transfer: async (input: FastCardTransferRequest) => { transfers.push(input); return { success: true } } },
    canvas: { open: async () => ({ ok: true, value: { handleId: 'handle', canvas: { nodes: [{ id: 'node', ready: {} }] } } }), release: async () => ({ ok: true }) },
    library: { prepareAgentSelection: async (input: { kind: string; id: string; name: string; nodeIds?: string[] }) => ({ success: true, data: [{ id: input.id, name: input.name, libraryId: hash, version: hash,
      ...(input.kind === 'board' ? { kind: 'board_selection', uri: toReadyUri({ kind: 'canvas', id: 'board' }), nodeIds: input.nodeIds }
        : { kind: 'book_location', uri: toReadyUri({ kind: 'book-location', book: 'book', loc: 'c0:0+2' }), chapter: 0, range: { start: 0, end: 2 } }) }] }) },
    vault: { get: async () => ({ status: 'ready', root: '/fixture' }) },
    calendar: { snapshot: async () => ({ success: true, data: { calendars: [{ id: 'local', primary: true }], events: [{ id: 'event', title: '日程', start: '2026-11-12', end: '2026-11-13', allDay: true }] } }),
      restore: async (delta: CalendarDelta) => { calendar.push(delta); return { success: true } } },
    calendarLinkage: { day: async () => ({ date: '2026-11-12', timeZone: 'UTC', items: [] }) },
    documentPages: { operate: async (input: { objectId: string }) => { moves.push(input); return { ok: true } } },
    rss: { readExcerpt: async () => ({ success: true, data: { text: '资讯选区', article: { title: '文章', link: 'https://example.com/article' } } }),
      readArticle: async () => ({ success: true, data: { article: { title: '文章', link: 'https://example.com/article' } } }), sieveRelevance: async () => ({ success: true, data: null }),
      queryItems: async () => ({ success: true, data: { total: 1, items: [{ title: '文章' }] } }),
      readDigests: async () => ({ success: true, data: { view: 'entries', report: { scopeLabel: '刊物' }, entries: [{ source: { title: '文章', quote: '摘录' } }] } }) },
    agent: { listConversationScopes: async () => ({ success: true, data: [{ id: 'chat', title: '对话' }] }), getConversationScopeMessages: async () => ({ success: true, data: [
      { id: 'q', role: 'user', content: '问题', meta: { runId: 'run' } }, { id: 'a', role: 'assistant', content: '回答', meta: { runId: 'run' } }] }) },
  }
  Object.assign(f.dom.window, { electronAPI: api })
  f.useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, objectId: 'page' })) }))
  await t.test('a drop inside an embedded view that owns its drops (database board) leaves the page text alone', async () => {
    const owner = document.createElement('section'); owner.setAttribute('data-own-drops', '')
    const column = document.createElement('div'); owner.append(column)
    document.querySelector('[data-ready-block-editor]')!.append(owner)
    const before = f.buffer.snapshot.content
    const data = new Transfer(); writeReadyRefTransfer(data, { kind: 'page', id: 'row' }, '数据库行')
    const over = new f.dom.window.Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: data })
    const drop = new f.dom.window.Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: data })
    let reached = false
    column.addEventListener('drop', () => { reached = true })
    await act(async () => { column.dispatchEvent(over); column.dispatchEvent(drop) })
    assert.equal(over.defaultPrevented, false, 'the page does not claim the drag')
    assert.equal(reached, true, 'the embedded view receives its own drop')
    assert.equal(f.buffer.snapshot.content, before)
    owner.remove()
  })
  for (const [title, ref] of refs) {
    const data = new Transfer(); writeReadyRefTransfer(data, ref, title)
    await t.test(`${title} → 文档`, async () => {
      const before = f.buffer.snapshot.content
      const event = new f.dom.window.Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: data })
      await act(async () => { document.querySelector('[data-ready-block-editor]')!.dispatchEvent(event) })
      assert.ok(event.defaultPrevented)
      const urls: string[] = []
      function visit(node: Nodes) { if (node.type === 'link') urls.push(node.url); if ('children' in node) node.children.forEach(visit) }
      visit(markdownTree(f.buffer.snapshot.content))
      assert.ok(urls.includes(toReadyUri(ref)), `missing ${toReadyUri(ref)} in ${JSON.stringify(urls)}`)
      if (ref.kind === 'fastcard' && ref.id === 'image') { assert.ok(f.buffer.snapshot.content.includes('![图片](<page.assets/image.png>)')); assert.equal(imageCopies.length, 1) }
      await act(() => { f.buffer.travel('undo') }); assert.equal(f.buffer.snapshot.content, before)
    })
    await t.test(`${title} → 画板`, async () => {
      const operations: CanvasOperation[] = [], count = transfers.length
      assert.equal(await dropCanvasReference(data, { x: 10, y: 20 }, { objectId: 'target', root: '/fixture', write: async ops => { operations.push(...ops) }, refresh: async () => {} }), true)
      if (ref.kind === 'fastcard') { assert.equal(transfers.length, count + 1); assert.deepEqual(transfers.at(-1).itemIds, [ref.id]); return }
      const op = operations[0]; assert.equal(op.type, 'addNode')
      if (op.type !== 'addNode') throw new Error('missing node')
      const node = CanvasNodeSchema.parse(op.node)
      assert.deepEqual(node.ready.ref, ref)
      assert.equal(node.type, ['页面', '数据库行', 'PDF', 'PDF选区', '文档块'].includes(title) ? 'file'
        : ['网页标签', '未打开的网页引用', '资讯', '资讯选区', '日程'].includes(title) ? 'link' : 'text')
    })
    await t.test(`${title} → 助手`, async () => {
      useAgent.getState().clearAttachments()
      assert.equal(await dropAgentReference(data, attachments => useAgent.getState().addAttachments(attachments)), true)
      const attachment = useAgent.getState().attachments[0]
      assert.ok(attachment)
      assert.equal(attachment.name.includes(title) || !!attachment.libraryResource, true)
      assert.ok(attachment.path || attachment.libraryResource)
    })
    await t.test(`${title} → 日历`, async () => {
      await dropCalendarReference(data, '2026-11-12')
      const delta = calendar.at(-1)
      assert.equal(delta.put[0].title, title)
      assert.deepEqual(delta.links[0].links[0].target, ref)
      assert.equal(delta.links[0].eventId, delta.put[0].id)
    })
    await t.test(`${title} → 页面树`, async () => {
      const count = moves.length, accepted = (ref.kind === 'page' || ref.kind === 'file') && ref.anchor === undefined
      assert.equal(await dropPageTreeReference(data, { root: '/fixture', parentPath: '/fixture/target' }), accepted)
      assert.equal(moves.length, count + Number(accepted))
      if (accepted) assert.equal(moves.at(-1).objectId, ref.id)
    })
  }
  await t.test('malformed input rejected without mutations; batch format remains one MIME', async () => {
    const data = new Transfer(); data.setData(READY_REF_MIME, '{bad')
    const counts = [moves.length, calendar.length, transfers.length]
    assert.equal(await dropPageTreeReference(data, { root: '/fixture', parentPath: '/fixture' }), false)
    assert.equal(await dropCalendarReference(data, '2026-11-12'), false)
    assert.equal(await dropAgentReference(data, () => assert.fail('unexpected attachment')), false)
    assert.deepEqual(counts, [moves.length, calendar.length, transfers.length])
    writeReadyRefTransfer(data, [{ kind: 'fastcard', id: 'card' }, { kind: 'fastcard', id: 'image' }], '文字\n图片')
    assert.deepEqual(data.types.sort(), [READY_REF_MIME, 'text/plain', 'text/uri-list'].sort())
    assert.equal(readReadyRefTransfers(data).length, 2)
    await dropCanvasReference(data, { x: 0, y: 0 }, { objectId: 'target', root: '/fixture', write: async () => assert.fail(), refresh: async () => {} })
    assert.deepEqual(transfers.at(-1).itemIds, ['card', 'image'])
  })
})
