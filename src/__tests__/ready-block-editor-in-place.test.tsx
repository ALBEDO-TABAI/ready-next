import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { editorFixture } from './helpers/ready-block-editor-fixture'
import { READY_REF_MIME, writeReadyRefTransfer } from '../shared/ready-ref'
import { cellMarkdown, deleteColumn, insertColumn, insertRow, moveColumn, moveRow, parseTable, setCell } from '../renderer/modules/document/block-editor/table-model'
import { SLASH_META, filterSlashItems } from '../renderer/modules/document/block-editor/slash-items'

// Design language plan §1.8 (round nine): what the page view lets a person do in place. Every expectation is the
// page's literal source; the fixture's head and tail must stay byte-identical.

type Fixture = Awaited<ReturnType<typeof editorFixture>>
class Transfer {
  values = new Map<string, string>()
  effectAllowed = 'all'
  get types() { return [...this.values.keys()] }
  setData(key: string, value: string) { this.values.set(key, value) }
  getData(key: string) { return this.values.get(key) || '' }
}
const item = (text: string) => {
  const el = [...document.querySelectorAll<HTMLElement>('[role="listitem"]')].find(node => node.textContent!.replace(/^•/, '') === text)
  assert.ok(el, `list entry ${text}`); return el
}
const shell = (el: Element) => el.closest<HTMLElement>('[data-block-start]')!
/** jsdom lays nothing out: give one block a box so "above / below its middle" means something. */
const box = (el: HTMLElement, top: number, height: number) => { el.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON() {} }) as DOMRect }
async function drag(f: Fixture, type: string, target: Element, data: Transfer, clientY = 0) {
  const event = new f.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY })
  Object.defineProperty(event, 'dataTransfer', { value: data })
  await act(async () => { target.dispatchEvent(event); await new Promise(resolve => setTimeout(resolve, 0)) })
  return event
}
async function menus(f: Fixture, t: test.TestContext) {
  const { createRoot } = await import('react-dom/client')
  const { FloatHost, closeAllFloats } = await import('../renderer/components/ui')
  // jsdom has no ResizeObserver; the float host only uses it to follow its anchor.
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
  t.after(() => { Reflect.deleteProperty(globalThis, 'ResizeObserver') })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(() => root.render(<FloatHost />))
  const choose = async (label: string) => {
    const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === label)
    assert.ok(entry, `menu item ${label}`); await act(() => entry.click())
  }
  // Unmounted by the test itself: the fixture's own cleanup removes the DOM globals first.
  return { choose, done: () => act(() => { closeAllFloats(); root.unmount() }) }
}

test('a task box ticks and unticks on click; each click is one undo step and only the box changes', async t => {
  const source = '- [x] 已做\r\n- [ ] 未做'
  const f = await editorFixture(t, source)
  const boxOf = (text: string) => item(text).querySelector<HTMLElement>('[role="checkbox"]')!
  assert.equal(boxOf('已做').getAttribute('aria-checked'), 'true')
  await act(() => boxOf('已做').click()); f.bytes('- [ ] 已做\r\n- [ ] 未做')
  assert.equal(boxOf('已做').getAttribute('aria-checked'), 'false')
  await act(() => boxOf('未做').click()); f.bytes('- [ ] 已做\r\n- [x] 未做')
  await act(() => boxOf('未做').click()); f.bytes('- [ ] 已做\r\n- [ ] 未做')
  assert.equal(f.buffer.history.entries.length, 3)
  for (let i = 0; i < 3; i++) await f.key(f.rich('已做'), 'z', { ctrlKey: true })
  f.bytes(source)
})

test('a callout edits in place: title, first body line and a task inside it; the marker line is never shown', async t => {
  const source = '> [!tip] 标题\r\n> 正文\r\n>\r\n> - [ ] 框内'
  const f = await editorFixture(t, source)
  const callout = document.querySelector<HTMLElement>('[data-block-type="callout"]')!
  assert.ok(callout.querySelector('aside.ready-callout[data-callout="tip"]'), 'the callout keeps its look')
  assert.ok(!callout.textContent!.includes('[!tip]'), 'no raw marker')
  assert.equal(callout.querySelector('.ready-block-source-edit'), null, 'no detour through source')
  await f.input(callout.querySelector<HTMLElement>('[data-callout-title] [data-rich-start]')!, '新标题')
  f.bytes('> [!tip] 新标题\r\n> 正文\r\n>\r\n> - [ ] 框内')
  await f.input(f.rich('正文'), '正文改')
  f.bytes('> [!tip] 新标题\r\n> 正文改\r\n>\r\n> - [ ] 框内')
  await act(() => item('框内').querySelector<HTMLElement>('[role="checkbox"]')!.click())
  f.bytes('> [!tip] 新标题\r\n> 正文改\r\n>\r\n> - [x] 框内')
  await act(() => item('框内').querySelector<HTMLElement>('[role="checkbox"]')!.click())
  f.bytes('> [!tip] 新标题\r\n> 正文改\r\n>\r\n> - [ ] 框内')
})

test('a title-only callout: an untitled one shows its kind, takes a title, and Enter starts its body', async t => {
  const f = await editorFixture(t, '> [!NOTE]')
  const title = () => document.querySelector<HTMLElement>('[data-callout-title] [data-rich-start]')!
  assert.equal(title().textContent, '', 'the kind is a placeholder, not text in the source')
  assert.equal(title().parentElement!.style.getPropertyValue('--callout-placeholder'), '"笔记"')
  await f.caret(title(), 0); await f.input(title(), '要点')
  f.bytes('> [!NOTE] 要点')
  await f.key(title(), 'Enter'); f.bytes('> [!NOTE] 要点')
  const body = document.activeElement as HTMLElement
  assert.ok(body.closest('.ready-callout-body'), 'Enter moved into a new body line inside the callout')
  await f.input(body, '第一行')
  f.bytes('> [!NOTE] 要点\r\n> 第一行')
  assert.equal(f.rich('第一行').closest('.ready-callout-body') !== null, true)
})

test('a callout whose title carries a link shows the link, not its Markdown; a folded callout stays a source block', async t => {
  const source = '> [!quote|yellow] 书 · [原文](ready://read/book/b#c0:6+5)\r\n> 摘录\r\n\r\n> [!tip]- 折叠\r\n> 内容'
  const f = await editorFixture(t, source)
  const [quote, folded] = [...document.querySelectorAll<HTMLElement>('[data-block-type="callout"]')]
  assert.equal(quote.querySelector('[data-callout-title]')!.textContent, '书 · 原文')
  assert.ok(quote.querySelector('[data-callout-title] a[data-ready-ref-capsule]'))
  assert.equal(quote.querySelector('aside')!.dataset.calloutColor, 'yellow')
  assert.ok(folded.querySelector('.ready-block-source-edit'), 'folded: edited as source')
  f.bytes(source)
})

test('a quote paragraph that runs over two lines edits as text and keeps its line markers', async t => {
  const source = '> 第一行\r\n> 第二行'
  const f = await editorFixture(t, source)
  const quote = f.rich('第一行\n第二行')
  await f.input(quote, '第一行\n第二行改')
  f.bytes('> 第一行\r\n> 第二行改')
  await f.key(f.rich('第一行\n第二行改'), 'z', { ctrlKey: true }); f.bytes(source)
})

test('a table edits in place: a cell edit touches only that cell; rows and columns are added from its edges', async t => {
  const source = '| 阶段   | 负责人 |\r\n| :--- | ---: |\r\n| 初稿 | 白 |\r\n| 定稿 |  |'
  const f = await editorFixture(t, source)
  const table = document.querySelector<HTMLElement>('[data-ready-table]')!
  const cell = (row: number, column: number) => table.querySelector<HTMLElement>(`[data-table-cell="${row}:${column}"]`)!
  assert.equal(document.querySelector('[data-block-type="table"] .ready-block-source-edit'), null, 'no detour through source')
  assert.equal(cell(1, 1).textContent, '白'); assert.equal(cell(0, 1).style.textAlign, 'right')
  await f.input(cell(1, 1), '白|老师')
  f.bytes('| 阶段   | 负责人 |\r\n| :--- | ---: |\r\n| 初稿 | 白\\|老师 |\r\n| 定稿 |  |')
  await f.input(cell(2, 1), '编辑')
  f.bytes('| 阶段   | 负责人 |\r\n| :--- | ---: |\r\n| 初稿 | 白\\|老师 |\r\n| 定稿 | 编辑 |')
  await act(() => table.querySelector<HTMLElement>('[aria-label="添加一行"]')!.click())
  f.bytes('| 阶段 | 负责人 |\r\n| :--- | ---: |\r\n| 初稿 | 白\\|老师 |\r\n| 定稿 | 编辑 |\r\n|  |  |')
  assert.equal(document.activeElement, cell(3, 0), 'the caret continues in the new row')
  await act(() => table.querySelector<HTMLElement>('[aria-label="添加一列"]')!.click())
  f.bytes('| 阶段 | 负责人 |  |\r\n| :--- | ---: | --- |\r\n| 初稿 | 白\\|老师 |  |\r\n| 定稿 | 编辑 |  |\r\n|  |  |  |')
  // Tab walks the cells and adds a row after the last one; Enter goes down the column.
  await f.caret(cell(3, 2), 0); await f.key(cell(3, 2), 'Tab')
  assert.equal(document.activeElement, cell(4, 0))
  await f.caret(cell(0, 0), 0); await f.key(cell(0, 0), 'Enter')
  assert.equal(document.activeElement, cell(1, 0))
})

test('a column and a row are inserted in the middle, moved and deleted from their handles', async t => {
  const source = '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'
  const f = await editorFixture(t, source)
  const { choose, done } = await menus(f, t)
  const table = () => document.querySelector<HTMLElement>('[data-ready-table]')!
  const handle = async (row: number, column: number, name: string) => {
    await f.caret(table().querySelector<HTMLElement>(`[data-table-cell="${row}:${column}"]`)!, 0)
    const button = table().querySelector<HTMLElement>(`[aria-label="${name}"]`)
    assert.ok(button, `${name} shows for the cell being edited`); await act(() => button.click())
  }
  assert.equal(table().querySelector('[aria-label="列操作"]'), null, 'handles are absent until a cell is pointed at or edited')
  await handle(0, 0, '列操作'); await choose('在右侧插入列')
  f.bytes('| 甲 |  | 乙 |\n| --- | --- | --- |\n| 1 |  | 2 |\n| 3 |  | 4 |')
  await handle(0, 1, '列操作'); await choose('右移')
  f.bytes('| 甲 | 乙 |  |\n| --- | --- | --- |\n| 1 | 2 |  |\n| 3 | 4 |  |')
  await handle(0, 2, '列操作'); await choose('删除列')
  f.bytes(source)
  await handle(1, 0, '行操作'); await choose('在下方插入行')
  f.bytes('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n| 3 | 4 |')
  await handle(2, 0, '行操作'); await choose('下移')
  f.bytes('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n|  |  |')
  await handle(3, 0, '行操作'); await choose('删除行')
  f.bytes(source)
  assert.equal(f.buffer.history.entries.length, 6, 'each structural change is one undo step')
  await done()
})

test('table model: escaped pipes, short rows and tables this editor must leave to source', () => {
  const table = parseTable('| a \\| b | c |\n|---|---|\n| 1 |')!
  assert.deepEqual(table.rows.map(row => row.map(cell => cell.raw)), [['a \\| b', 'c'], ['1', '']])
  const raw = '| a \\| b | c |\n|---|---|\n| 1 |'
  const short = setCell(raw, table, 1, 1, '补')
  assert.equal(raw.slice(0, short.start) + short.replacement + raw.slice(short.end), '| a \\| b | c |\n| --- | --- |\n| 1 | 补 |')
  assert.equal(cellMarkdown('x | y\nz'), 'x \\| y z'); assert.equal(cellMarkdown('x \\| y'), 'x \\| y')
  assert.throws(() => cellMarkdown('`a|b`'))
  assert.equal(parseTable('| `a\\|b` |\n| --- |\n| 1 |'), null, 'a pipe escaped inside code')
  assert.equal(parseTable('只是一段文字'), null)
  const model = parseTable('| 甲 | 乙 |\n| :-: | --- |\n| 1 | 2 |')!
  assert.equal(insertColumn(model, 1), '| 甲 |  | 乙 |\n| :-: | --- | --- |\n| 1 |  | 2 |')
  assert.equal(moveColumn(model, 0, 1), '| 乙 | 甲 |\n| --- | :-: |\n| 2 | 1 |')
  assert.equal(insertRow(model, 1), '| 甲 | 乙 |\n| :-: | --- |\n|  |  |\n| 1 | 2 |')
  assert.throws(() => moveRow(model, 0, 1)); assert.throws(() => deleteColumn(parseTable('| 甲 |\n| --- |\n| 1 |')!, 0))
})

test('a reference dragged in from outside shows a line and lands there: a new entry in a list, a paragraph elsewhere', async t => {
  const source = '段落\r\n\r\n- [[甲]]\r\n- [[乙]]'
  const f = await editorFixture(t, source)
  const data = new Transfer(); writeReadyRefTransfer(data, { kind: 'page', id: 'p1' }, '拖入')
  assert.ok(data.types.includes(READY_REF_MIME))
  const second = shell(item('乙')); box(second, 100, 20)
  const over = await drag(f, 'dragover', item('乙'), data, 102)
  assert.equal(over.defaultPrevented, true); assert.equal(second.dataset.refDrop, 'before', 'the line is above the entry under the pointer')
  await drag(f, 'dragover', item('乙'), data, 118); assert.equal(second.dataset.refDrop, 'after')
  await drag(f, 'dragover', item('乙'), data, 102)
  await drag(f, 'drop', item('乙'), data, 102)
  assert.equal(document.querySelector('[data-ref-drop]'), null, 'the line goes when the drop is done')
  f.bytes('段落\r\n\r\n- [[甲]]\r\n- [拖入](ready://doc/page/p1)\r\n- [[乙]]')
  const paragraph = shell(f.rich('段落')); box(paragraph, 0, 20)
  await drag(f, 'dragover', paragraph, data, 15); assert.equal(paragraph.dataset.refDrop, 'after')
  await drag(f, 'drop', paragraph, data, 15)
  f.bytes('段落\r\n\r\n[拖入](ready://doc/page/p1)\r\n\r\n- [[甲]]\r\n- [拖入](ready://doc/page/p1)\r\n- [[乙]]')
})

test('a list entry moves among its siblings by dragging its marker, as whole lines and one undo step', async t => {
  const source = '段落\r\n\r\n- 甲\r\n- 乙\r\n- 丙'
  const f = await editorFixture(t, source)
  const move = async (from: string, to: string, clientY: number) => {
    const data = new Transfer(), target = shell(item(to)); box(target, 100, 20)
    await drag(f, 'dragstart', item(from).querySelector('.ready-block-marker')!, data)
    await drag(f, 'dragover', target, data, clientY)
    assert.ok(target.dataset.drop, 'the landing line shows on the sibling')
    await drag(f, 'drop', target, data, clientY)
    await drag(f, 'dragend', item(from).querySelector('.ready-block-marker')!, data)
  }
  await move('丙', '甲', 101); f.bytes('段落\r\n\r\n- 丙\r\n- 甲\r\n- 乙')
  await move('丙', '乙', 119); f.bytes(source)
  assert.equal(f.buffer.history.entries.length, 2)
  // A top-level block is not a sibling: an entry cannot land beside it.
  const data = new Transfer(), paragraph = shell(f.rich('段落'))
  await drag(f, 'dragstart', item('甲').querySelector('.ready-block-marker')!, data)
  const over = await drag(f, 'dragover', paragraph, data, 0)
  assert.equal(over.defaultPrevented, false); assert.equal(paragraph.dataset.drop, undefined)
  await drag(f, 'dragend', item('甲').querySelector('.ready-block-marker')!, data)
  f.bytes(source)
})

test('a block that is not edited in place opens its own source on double-click, never the whole page', async t => {
  const source = '```mermaid\r\ngraph TD\r\n```'
  const f = await editorFixture(t, source)
  const block = document.querySelector<HTMLElement>('[data-block-type="mermaid"]')!
  assert.equal(block.querySelector('textarea'), null)
  await act(() => { block.querySelector('pre')!.dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true })) })
  const textarea = block.querySelector<HTMLTextAreaElement>('textarea[aria-label="块源码"]')!
  assert.equal(textarea.value, '```mermaid\ngraph TD\n```')
  assert.equal(document.querySelectorAll('textarea').length, 1)
  await f.key(textarea, 'Escape'); f.bytes(source)
})

test('/链接页面, /引用文件 and the old /引用对象 all find the link search', () => {
  const items = Object.entries(SLASH_META).map(([id, meta]) => ({ ...meta, id, run() {} }))
  for (const query of ['链接页面', '链接', '引用文件', '引用对象', 'link', 'lj']) assert.equal(filterSlashItems(items, query).some(entry => entry.id === 'reference'), true, query)
  assert.equal(filterSlashItems(items, '链接页面')[0].id, 'reference')
})
