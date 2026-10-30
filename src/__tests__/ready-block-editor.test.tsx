import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { editorFixture, head, tail } from './helpers/ready-block-editor-fixture'

test('typing and a no-op blur preserve all unrelated UTF-8 bytes', async t => {
  const f = await editorFixture(t, '旧的段落。')
  let el = f.rich('旧的段落。'); await f.caret(el, 6); await f.blur(el)
  assert.equal(f.buffer.history.entries.length, 0)
  el = f.rich('旧的段落。'); await f.caret(el, 6); await f.input(el, '新的段落😀'); await f.blur(el)
  f.bytes('新的段落😀')
})

test('IME composition is one undo step and ignores Enter during composition', async t => {
  const f = await editorFixture(t, '起点')
  const el = f.rich('起点'); await f.caret(el, 2)
  await act(() => el.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
  await f.input(el, '起点中')
  await act(() => el.dispatchEvent(new f.dom.window.CompositionEvent('compositionupdate', { bubbles: true, data: '中文' })))
  await f.key(el, 'Enter', { isComposing: true })
  await f.input(el, '起点中文')
  await act(() => el.dispatchEvent(new f.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
  await f.blur(el); f.bytes('起点中文')
  await f.key(f.rich('起点中文'), 'z', { ctrlKey: true }); f.bytes('起点')
  await f.key(f.rich('起点'), 'z', { metaKey: true, shiftKey: true }); f.bytes('起点中文')
})

test('Enter splits and Backspace merges rich blocks with one history step each', async t => {
  const f = await editorFixture(t, '甲乙丙丁')
  const el = f.rich('甲乙丙丁'); await f.caret(el, 2); await f.key(el, 'Enter')
  f.bytes('甲乙\r\n\r\n丙丁')
  const second = f.rich('丙丁'); await f.caret(second, 0); await f.key(second, 'Backspace')
  f.bytes('甲乙丙丁')
  await f.key(f.rich('甲乙丙丁'), 'z', { ctrlKey: true }); f.bytes('甲乙\r\n\r\n丙丁')
})

for (const [typed, expected] of [['# ', '# '], ['- ', '- '], ['1. ', '1. '], ['> ', '> '], ['[] ', '- [ ] '], ['``` ', '```\r\n\r\n```'], ['---', '---']]) {
  test(`input rule ${JSON.stringify(typed)} produces contract Markdown`, async t => {
    const f = await editorFixture(t, '替换'); const el = f.rich('替换')
    await f.caret(el, 0); await f.input(el, typed); await f.blur(el); f.bytes(expected)
  })
}

test('multi-paragraph paste preserves text, selection and surrounding bytes', async t => {
  const f = await editorFixture(t, '甲乙'); const el = f.rich('甲乙'); await f.caret(el, 1)
  const event = new f.dom.window.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => type === 'text/plain' ? '一\n\n二' : '' } })
  await act(() => el.dispatchEvent(event)); f.bytes('甲一\r\n\r\n二乙')
  await f.key(f.rich('二乙'), 'z', { ctrlKey: true }); f.bytes('甲乙')
})

test('Widget source is replaced as one exact block', async t => {
  const source = '```show-widget\r\n{"title":"原卡","widget_code":"<p>原文</p>"}\r\n```'
  const f = await editorFixture(t, source)
  const shell = document.querySelector('[data-block-type="widget"]')!; await f.click('编辑源码', shell)
  const editor = shell.querySelector('textarea')!
  await act(() => {
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, source.replace('原文', '新文'))
    editor.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
  })
  await f.click('完成', shell); f.bytes(source.replace('原文', '新文'))
})

test('editing inside columns preserves every marker and the other column', async t => {
  const source = '<!-- ready:columns widths=2,1 -->\r\n左栏\r\n\r\n<!-- ready:column -->\n右栏\n\n<!-- ready:columns-end -->'
  const f = await editorFixture(t, source); const el = f.rich('左栏')
  await f.caret(el, 2); await f.input(el, '左栏新增'); await f.blur(el); f.bytes(source.replace('左栏', '左栏新增'))
  assert.equal(document.querySelectorAll('[data-block-type="column"]').length, 2)
})

test('append uses the editor and leaves original EOF bytes intact', async t => {
  const f = await editorFixture(t, '正文')
  await f.click('添加文字'); const el = f.rich(''); await f.input(el, '追加'); await f.blur(el)
  const content = f.useDocTabs.getState().tabs[0].content
  assert.deepEqual(Buffer.from(content), Buffer.from(head + '正文' + tail + '\r\n\r\n追加'))
})

test('rich paste accepts allowed inline marks, strips other styling, and preserves text', async t => {
  const f = await editorFixture(t, '甲乙'); const el = f.rich('甲乙'); await f.caret(el, 1)
  const event = new f.dom.window.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => type === 'text/html'
    ? '<b>粗</b><span style="font-size:90px;position:fixed">普通</span><u>下划线</u>' : '粗普通下划线' } })
  await act(() => el.dispatchEvent(event)); f.bytes('甲**粗**普通<u>下划线</u>乙')
})

test('arrow keys move between blocks; ordinary typing is durable in the shared buffer before blur', async t => {
  const f = await editorFixture(t, '第一段\r\n\r\n第二段'); const el = f.rich('第一段')
  await f.caret(el, 3); await f.input(el, '第一段新增'); f.bytes('第一段新增\r\n\r\n第二段')
  await f.caret(el, 5); await f.key(el, 'ArrowDown'); assert.equal(document.activeElement, f.rich('第二段'))
  await f.caret(f.rich('第二段'), 0); await f.key(f.rich('第二段'), 'ArrowUp'); assert.equal(document.activeElement, f.rich('第一段新增'))
})

test('format repair warning does not block edits in other paragraphs', async t => {
  const source = '<!-- ready:columns widths=1,2 -->\n坏格式\n\n<!-- ready:columns-end -->\n\n正常'
  const f = await editorFixture(t, source); assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /分栏格式需修复/)
  const el = f.rich('正常'); await f.caret(el, 2); await f.input(el, '正常可写'); f.bytes(source.replace('正常', '正常可写'))
})

test('empty split stays editable at its actual position and one undo restores the bytes', async t => {
  const f = await editorFixture(t, '首段\r\n\r\n尾段'); const el = f.rich('首段')
  await f.caret(el, 2); await f.key(el, 'Enter'); f.bytes('首段\r\n\r\n\r\n\r\n尾段')
  const empty = f.rich('')
  assert.ok(empty.closest('[data-ready-block-editor]')?.querySelectorAll('[contenteditable]')[1] === empty, 'empty paragraph stays between its siblings')
  await f.input(empty, '新段'); f.bytes('首段\r\n\r\n新段\r\n\r\n尾段')
})

test('list item split and merge preserve its enclosing list and unrelated bytes', async t => {
  const f = await editorFixture(t, '- 甲乙丙丁\r\n- 旁项'); const el = f.rich('甲乙丙丁')
  await f.caret(el, 2); await f.key(el, 'Enter'); f.bytes('- 甲乙\r\n- 丙丁\r\n- 旁项')
  await f.caret(f.rich('丙丁'), 0); await f.key(f.rich('丙丁'), 'Backspace'); f.bytes('- 甲乙丙丁\r\n- 旁项')
})

test('the real MarkdownEditor source view shares undo with page edits and external updates', async t => {
  const f = await editorFixture(t, '初始😀')
  const el = f.rich('初始😀'); await f.caret(el, 4); await f.input(el, '页面中文😀'); await f.blur(el)
  f.bytes('页面中文😀')
  const { registerHooks } = await import('node:module')
  // Node has no CSS loader; styling is verified by the separate Electron script.
  const css = registerHooks({ load(url, context, next) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context)
  } })
  t.after(() => css.deregister())
  const { default: MarkdownEditor } = await import('../renderer/components/document/MarkdownEditor')
  const { createElement } = await import('react')
  const Source = () => {
    const tab = f.useDocTabs(state => state.tabs.find(item => item.id === t.name)!)
    return createElement(MarkdownEditor, { tab, viewMode: 'edit' })
  }
  await act(() => f.root.render(createElement(Source)))
  const editor = document.querySelector<HTMLTextAreaElement>('textarea.document-source-textarea')!
  assert.ok(editor, 'actual source editor mounts')
  await f.key(editor, 'z', { ctrlKey: true }); f.bytes('初始😀')
  await f.key(editor, 'z', { metaKey: true, shiftKey: true }); f.bytes('页面中文😀')
  await act(() => {
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, editor.value.replace('页面中文', '源码修改'))
    editor.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
  })
  f.bytes('源码修改😀')
  await act(() => f.useDocTabs.getState().updateTabContent(t.name, head + '外部更新😀' + tail))
  f.bytes('外部更新😀')
  await f.key(editor, 'z', { ctrlKey: true }); f.bytes('源码修改😀')
  await f.key(editor, 'z', { ctrlKey: true }); f.bytes('页面中文😀')
  await f.key(editor, 'z', { ctrlKey: true }); f.bytes('初始😀')
})

test('external HTML paragraphs paste as separate blocks with inline styles retained', async t => {
  const f = await editorFixture(t, '甲乙'); const el = f.rich('甲乙'); await f.caret(el, 1)
  const event = new f.dom.window.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => type === 'text/html' ? '<p><b>一</b></p><p>二</p>' : '一\n二' } })
  await act(() => el.dispatchEvent(event)); f.bytes('甲**一**\r\n\r\n二乙')
})

test('inserting before a source card preserves its mounted preview and an open source draft', async t => {
  const code = '```mermaid\nA-->B\n```'
  const f = await editorFixture(t, '首段\r\n\r\n' + code)
  const shell = document.querySelector('[data-block-type="mermaid"]')!; await f.click('编辑源码', shell)
  const textarea = shell.querySelector('textarea')!
  const first = f.rich('首段'); await f.caret(first, 1); await f.key(first, 'Enter')
  assert.ok(document.querySelector('[data-block-type="mermaid"] textarea') === textarea, 'source editor stays mounted when offsets shift')
  f.bytes('首\r\n\r\n段\r\n\r\n' + code)
})

test('deleting the last character leaves a focused empty paragraph that accepts more text', async t => {
  const f = await editorFixture(t, '甲'); const el = f.rich('甲'); await f.caret(el, 1); await f.input(el, '')
  f.bytes('')
  const empty = f.rich(''); assert.ok(document.activeElement === empty)
  await f.input(empty, '乙'); f.bytes('乙')
})
