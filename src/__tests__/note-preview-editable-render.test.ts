import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { editorFixture } from './helpers/ready-block-editor-fixture'

test('NotePreview page mode directly edits text and keeps embeds on the source path', async t => {
  const f = await editorFixture(t, '第一段。\n\n![图](a.png)')
  const { default: NotePreview } = await import('../renderer/components/document/NotePreview')
  await act(() => f.root.render(React.createElement(NotePreview, { content: f.buffer.snapshot.content, editorTabId: t.name, notePath: '/tmp/note.md' })))
  const el = f.rich('第一段。'); await f.caret(el, 4); await f.input(el, '第一段改好了。'); await f.blur(el)
  f.bytes('第一段改好了。\n\n![图](a.png)')
  assert.ok(document.querySelector('[data-block-type="image"] button'), 'embed has a source entrance')
  // T4b: each actionable block carries a draggable handle; the image embed keeps its own source entrance.
  assert.ok(document.querySelectorAll('[aria-label="块菜单"][draggable="true"]').length > 0, 'block handles are present')
})

test('NotePreview without a tab stays read-only', async t => {
  const f = await editorFixture(t, '第一段。')
  const { default: NotePreview } = await import('../renderer/components/document/NotePreview')
  await act(() => f.root.render(React.createElement(NotePreview, { content: '第一段。\n\n![图](a.png)', notePath: '/tmp/note.md' })))
  assert.equal(document.querySelectorAll('[contenteditable], textarea').length, 0)
  assert.equal(document.querySelectorAll('[data-ready-block-editor]').length, 0)
})

test('a retained page keeps its displayed snapshot until its parent releases the freeze', async t => {
  const f = await editorFixture(t, '原正文')
  const { default: NotePreview } = await import('../renderer/components/document/NotePreview')
  const original = f.buffer.snapshot.content
  await act(() => f.root.render(React.createElement(NotePreview, { content: original, editorTabId: t.name })))
  await act(() => f.useDocTabs.getState().updateTabContent(t.name, original.replace('原正文', '后台更新')))
  assert.ok(f.rich('原正文'), 'hidden retained page must not follow live text')
  await act(() => f.root.render(React.createElement(NotePreview, { content: f.buffer.snapshot.content, editorTabId: t.name })))
  assert.ok(f.rich('后台更新'), 'visible page catches up with the latest buffer')
})
