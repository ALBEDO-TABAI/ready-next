import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { editorFixture, head } from './helpers/ready-block-editor-fixture'
import type { AnnotationCommand } from '../shared/document-comments'
import { createAnchor } from '../shared/document-anchors'

// Comments and synced blocks exist only in the library (W3 M4): the fixture page lives in a library at /vault.
async function libraryAt(t: test.TestContext, root: string) {
  const { useVault } = await import('../renderer/stores/useVault')
  const prior = useVault.getState().view
  await act(async () => useVault.setState({ view: { phase: 'loaded', data: { status: 'ready', root, defaultSuggestion: root } } }))
  t.after(() => useVault.setState({ view: prior }))
}

async function clickText(label: string) {
  const button = [...document.querySelectorAll('button')].find(button => button.textContent === label)
  assert.ok(button, label)
  await act(async () => button.click())
}

test('M5-D block menu submits comment without changing editor bytes', async t => {
  const f = await editorFixture(t, '评论块')
  const source = f.buffer.snapshot.content, commands: AnnotationCommand[] = []
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    documentPages: { onChanged: () => () => {} },
    documentAnnotations: { comments: async (input: AnnotationCommand) => {
      commands.push(input)
      return { ok: true, value: { objectId: 'object', revision: input.type === 'read' ? 0 : 1, threads: input.type === 'add' ? [{
        id: 'thread', anchorId: 'a', resolved: false, messages: [{ id: 'message', text: input.text, createdAt: 0 }], quote: '评论块',
        anchor: createAnchor(source, head.length, head.length + 3, input.expectedVersion, 'a'), location: { state: 'located', start: head.length, end: head.length + 3 },
      }] : [] } }
    } },
  } })
  await libraryAt(t, '/vault')
  await act(async () => f.useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, path: '/vault/page.md' })) })))
  const shell = f.rich('评论块').closest('[data-block-start]')!
  await act(() => shell.querySelector<HTMLButtonElement>('[aria-label="块菜单"]')!.click())
  await clickText('添加评论')
  const input = document.querySelector<HTMLTextAreaElement>('[aria-label="评论内容"]')!
  await act(() => {
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '意见')
    input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
  })
  await clickText('发表评论')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  assert.equal(commands.filter(command => command.type === 'add').length, 1)
  assert.equal(f.buffer.snapshot.content, source)
  assert.match(document.querySelector('[aria-label="评论面板"]')!.textContent!, /意见/)
})

test('M5-D slash template inserts through the real buffer and one undo restores exact bytes', async t => {
  const f = await editorFixture(t, '/')
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    documentPages: { onChanged: () => () => {} }, documentAnnotations: {
      comments: async () => ({ ok: true, value: { objectId: 'object', revision: 0, threads: [] } }),
      templates: async (input: {type: string}) => ({ ok: true, value: input.type === 'list' ? { kind: 'list', templates: ['模板.md'] } : { kind: 'expanded', content: '# 模板内容\r\n\r\n保留格式' } }),
    },
  } })
  await act(async () => f.useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, path: '/vault/page.md' })) })))
  const before = f.buffer.snapshot.content, el = f.rich('/')
  await f.caret(el, 1); await act(() => el.dispatchEvent(new f.dom.window.InputEvent('input', { bubbles: true })))
  await act(() => document.querySelector<HTMLElement>('.ready-slash-menu [data-slash-item="template"]')!.click()); await clickText('插入模板内容')
  assert.match(f.buffer.snapshot.content, /# 模板内容\r\n\r\n保留格式/)
  await f.key(document.querySelector<HTMLElement>('[data-ready-block-editor]')!, 'z', { ctrlKey: true })
  assert.equal(f.buffer.snapshot.content, before)
})

test('M5-D moving a fenced block moves its standalone persistent marker in the same undo step', async t => {
  const f = await editorFixture(t, '```txt\r\n源块\r\n```\r\n\r\n^source\r\n\r\n目标')
  const before = f.buffer.snapshot.content
  const shell = document.querySelector('[data-block-type="code"]')!
  await act(() => shell.querySelector<HTMLButtonElement>('[aria-label="块菜单"]')!.click())
  await clickText('下移')
  const content = f.buffer.snapshot.content
  assert.ok(content.indexOf('目标') < content.indexOf('源块'))
  assert.match(content, /源块\r\n```\r\n\r\n\^source/)
  await f.key(document.querySelector<HTMLElement>('[data-ready-block-editor]')!, 'z', { ctrlKey: true })
  assert.equal(f.buffer.snapshot.content, before)
})

test('W3 M4 a file in a mounted folder offers no comments, synced blocks or sub-pages; templates stay', async t => {
  const f = await editorFixture(t, '/')
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    documentPages: { onChanged: () => () => {} }, documentAnnotations: {
      comments: async () => ({ ok: true, value: { objectId: 'object', revision: 0, threads: [] } }),
    },
  } })
  await libraryAt(t, '/vault')
  const menus = async (path: string) => {
    await act(async () => f.useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, path })) })))
    const el = f.rich('/')
    await f.caret(el, 1); await act(() => el.dispatchEvent(new f.dom.window.InputEvent('input', { bubbles: true })))
    const slash = [...document.querySelectorAll<HTMLElement>('.ready-slash-menu [role="option"]')].map(item => item.dataset.slashItem ?? '')
    await f.key(el, 'Escape')
    const shell = el.closest('[data-block-start]')!
    await act(() => shell.querySelector<HTMLButtonElement>('[aria-label="块菜单"]')!.click())
    const block = [...document.querySelectorAll<HTMLElement>('button')].map(item => item.textContent ?? '')
    await f.key(document.body, 'Escape')
    return { slash, block }
  }
  const inside = await menus('/vault/page.md')
  for (const id of ['synced', 'page', 'template']) assert.ok(inside.slash.includes(id), `library slash: ${id}`)
  for (const label of ['添加评论', '转为同步块引用']) assert.ok(inside.block.includes(label), `library block menu: ${label}`)
  const outside = await menus('/外部素材/page.md')
  assert.ok(outside.slash.includes('template'), 'templates stay for any Markdown')
  for (const id of ['synced', 'page', 'board']) assert.ok(!outside.slash.includes(id), `mounted slash hides ${id}`)
  assert.ok(outside.block.includes('下移'), 'the block menu itself opened')
  for (const label of ['添加评论', '转为同步块引用']) assert.ok(!outside.block.includes(label), `mounted block menu hides ${label}`)
})
