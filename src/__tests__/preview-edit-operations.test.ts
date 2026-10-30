import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { editorFixture, head, tail } from './helpers/ready-block-editor-fixture'

// Replacement and append now exercise the real block editor. Dragging belongs
// to T4b; the old moving/image-reordering intent stays on the shared command.
import { createBlockCommand, parseDocumentBlocks, replaceRanges } from '../shared/document-blocks'

test('replacement and deletion leave separators and fenced interiors byte-identical', async t => {
  const f = await editorFixture(t, '第一段。\n\n要删除的段。\n\n第三段。')
  const el = f.rich('要删除的段。'); await f.caret(el, 0); await f.input(el, ''); await f.blur(el)
  f.bytes('第一段。\n\n\n\n第三段。')
})

test('display-promoted about is edited as its actual source paragraph', async t => {
  const f = await editorFixture(t, '正文第一段。\n\nabout\n\n关于内容。')
  const el = f.rich('about'); await f.caret(el, 5); await f.input(el, 'about 新内容'); await f.blur(el)
  f.bytes('正文第一段。\n\nabout 新内容\n\n关于内容。')
})

test('empty append performs no write; actual append preserves existing EOF', async t => {
  const f = await editorFixture(t, '已有内容。')
  await f.click('添加文字'); await f.blur(f.rich(''))
  f.bytes('已有内容。'); assert.equal(f.buffer.history.entries.length, 0)
  await f.click('添加文字'); const el = f.rich(''); await f.input(el, '新增的一段'); await f.blur(el)
  assert.deepEqual(Buffer.from(f.useDocTabs.getState().tabs[0].content), Buffer.from(head + '已有内容。' + tail + '\r\n\r\n新增的一段'))
})

test('an outdated source editor cannot overwrite a newer buffer', async t => {
  const source = '```mermaid\nA-->B\n```'
  const f = await editorFixture(t, source); const shell = document.querySelector('[data-block-type="mermaid"]')!
  await f.click('编辑源码', shell)
  const textarea = shell.querySelector('textarea')!
  await act(() => {
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, source.replace('B', 'C'))
    textarea.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
    f.useDocTabs.getState().updateTabContent(t.name, head + source + tail + '\n外部更新')
  })
  await f.click('完成', shell)
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /版本|revision/)
  assert.deepEqual(Buffer.from(f.useDocTabs.getState().tabs[0].content), Buffer.from(head + source + tail + '\n外部更新'))
  assert.ok(shell.querySelector('textarea'), 'uncommitted source is retained for recovery')
})

for (const placement of ['before', 'after'] as const) {
  test(`shared move command keeps image ordering intent (${placement}) without the retired UI`, () => {
    const content = '首段\r\n\r\n![图](a.png)\n\n```js\r\na\r\n\r\nb\r\n```\n\n尾段'
    const blocks = parseDocumentBlocks(content).blocks
    const image = blocks.find(block => block.type === 'image')!
    const target = placement === 'before' ? blocks[0] : blocks.at(-1)!
    const edit = createBlockCommand({ content, version: 0 }, { type: 'move', block: image, target, placement, prefix: placement === 'after' ? '\n\n' : '', suffix: placement === 'before' ? '\n\n' : '' })
    const next = replaceRanges(content, edit.operation, 0)
    assert.equal(next, placement === 'before'
      ? '![图](a.png)\n\n首段\r\n\r\n\n\n```js\r\na\r\n\r\nb\r\n```\n\n尾段'
      : '首段\r\n\r\n\n\n```js\r\na\r\n\r\nb\r\n```\n\n尾段\n\n![图](a.png)')
    assert.equal(replaceRanges(next, edit.inverse, 1), content)
    assert.throws(() => replaceRanges(next, edit.operation, 1), /revision/)
  })
}
