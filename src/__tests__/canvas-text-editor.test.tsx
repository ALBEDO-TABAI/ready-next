import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import { applyCanvasOperations, type CanvasOperation, type ReadyCanvas } from '../shared/ready-canvas'
import { fragmentHash } from '../shared/document-blocks'

// M4-E2 contract: real card + shared editor + surface commit path. Only the
// host acknowledgement and browser geometry are substitutes; no document tab.
async function fixture(t: test.TestContext, body = '原文😀') {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true }
  const saved = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { createRoot } = await import('react-dom/client')
  const { TextCard } = await import('../renderer/components/canvas/cards/TextCard')
  const { CanvasSurface } = await import('../renderer/components/canvas/surface/CanvasSurface')
  const { setCaret } = await import('../renderer/modules/document/block-editor/dom-inline')
  let canvas: ReadyCanvas = { ready: { schemaVersion: 1, id: 'board' }, edges: [], nodes: [
    { id: 'one', type: 'text', text: body, x: 0, y: 0, width: 300, height: 300, ready: { kind: 'text' } },
    { id: 'two', x: 350, y: 0, width: 200, height: 200, type: 'text', text: '不改\r\n é😀', ready: { kind: 'text' } },
  ] }
  const untouched = JSON.stringify(canvas.nodes[1]), operations: CanvasOperation[][] = []
  let reject = false, wait: Promise<void> | undefined, update: (next: ReadyCanvas) => void = () => {}
  function Host() {
    const [value, setValue] = useState(canvas); update = setValue
    return <CanvasSurface canvas={value} onOperations={async ops => {
      operations.push(ops); await wait
      if (reject) throw new Error('version_conflict')
      canvas = applyCanvasOperations(canvas, ops).canvas; setValue(canvas)
    }} renderTextEditor={({ node, commit }) => node.type === 'text' && <TextCard node={node} commit={commit} />} />
  }
  const root = createRoot(document.getElementById('root')!)
  await act(() => root.render(<Host />))
  await act(() => document.querySelector('[data-node-id="one"]')!.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })))
  t.after(async () => {
    await act(() => root.unmount()); dom.window.close()
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
    }
  })
  const rich = () => { const el = document.querySelector<HTMLElement>('[contenteditable="true"]'); assert.ok(el, 'card has the shared editor'); return el }
  const input = async (value: string) => { const el = rich(); await act(() => { el.focus(); el.textContent = value; setCaret(el, value.length); el.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true })) }) }
  const key = async (key: string, options: KeyboardEventInit = {}, target = rich()) => { await act(() => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options }))) }
  const bytes = (expected: string) => {
    assert.equal(canvas.nodes[0].type === 'text' && canvas.nodes[0].text, expected)
    assert.equal(JSON.stringify(canvas.nodes[1]), untouched, 'other node bytes remain identical')
  }
  return { dom, rich, input, key, bytes, operations, setCaret, setReject: () => { reject = true }, hold: (promise: Promise<void>) => { wait = promise },
    async external(text: string) { canvas = { ...canvas, nodes: canvas.nodes.map(n => n.id === 'one' && n.type === 'text' ? { ...n, text } : n) }; await act(() => update(canvas)) } }
}

test('M4-E2 edits only one card with an expected version and supports local undo/redo', async t => {
  const f = await fixture(t); await f.input('修改😀'); f.bytes('修改😀')
  assert.deepEqual(f.operations[0], [{ type: 'textRanges', id: 'one', expectedTextVersion: fragmentHash('原文😀'),
    ranges: [{ start: 0, end: 4, expectedText: '原文😀', replacement: '修改😀' }] }])
  await f.key('z', { metaKey: true }); f.bytes('原文😀')
  await f.key('z', { metaKey: true, shiftKey: true }); f.bytes('修改😀')
})

test('M4-E2 Chinese composition commits only at compositionend', async t => {
  const f = await fixture(t), el = f.rich()
  await act(() => el.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
  await f.input('原文中'); await f.key('Enter', { isComposing: true }); await f.input('原文中文')
  assert.equal(f.operations.length, 0); f.bytes('原文😀')
  await act(() => el.dispatchEvent(new f.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
  f.bytes('原文中文'); assert.equal(f.operations.length, 1)
  await f.key('z', { ctrlKey: true }); f.bytes('原文😀')
})

test('M4-E2 external node changes join the same history; stale menu does not write', async t => {
  const f = await fixture(t)
  await f.key('Enter', {}, document.querySelector<HTMLElement>('[aria-label="块菜单"]')!)
  await f.external('外部正文')
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent === '标题 1')!
  assert.ok(option); await act(() => option.click())
  assert.equal(f.operations.length, 0); f.bytes('外部正文')
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /版本|原文|range|revision/)
  await f.key('z', { metaKey: true }); f.bytes('原文😀')
  await f.key('z', { metaKey: true, shiftKey: true }); f.bytes('外部正文')
})

test('M4-E2 rejected writes report a conflict without changing the board', async t => {
  const f = await fixture(t); f.setReject(); await f.input('未获接受')
  f.bytes('原文😀'); assert.match(document.body.textContent!, /冲突|版本/)
})

test('M4-E2 rapid input waits for acknowledgement and does not drop later text', async t => {
  const f = await fixture(t); let release!: () => void
  f.hold(new Promise<void>(resolve => { release = resolve }))
  await f.input('第一笔'); await f.input('第二笔'); assert.equal(f.operations.length, 1)
  await act(async () => { release(); await Promise.resolve() })
  f.bytes('第二笔'); assert.equal(f.operations.length, 2)
})

test('M4-E2 hides page-only actions when the canvas path is unavailable', async t => {
  const f = await fixture(t, '/')
  await f.input('/')
  assert.ok(document.querySelector('[role="listbox"]'), 'slash menu available')
  assert.doesNotMatch(document.querySelector('[role="listbox"]')!.textContent!, /子页面|保存到/)
  await f.key('Escape', {}, document.querySelector<HTMLElement>('[aria-label="搜索操作"]')!)
  await f.input('[[')
  assert.equal(document.querySelector('[aria-label="页面和标题"]'), null)
  await f.key('Enter', {}, document.querySelector<HTMLElement>('[aria-label="块菜单"]')!)
  assert.doesNotMatch(document.querySelector('[role="listbox"]')!.textContent!, /复制块引用/)
})


test('M4-E2 inline toolbar formats the card and its undo never touches a neighbor', async t => {
  const f = await fixture(t), el = f.rich()
  await act(() => { el.focus(); f.setCaret(el, 0, 2) })
  await f.key('F10', { altKey: true })
  const toolbar = document.querySelector('[aria-label="文字格式"]')!
  assert.ok(toolbar)
  const bold = [...toolbar.querySelectorAll('button')].find(button => button.textContent === '粗体')!
  assert.ok(bold); await act(() => bold.click()); f.bytes('**原文**😀')
  await f.key('z', { metaKey: true }); f.bytes('原文😀')
})

test('M4-E2 an external version invalidates pending edits before the next write', async t => {
  const f = await fixture(t); let release!: () => void
  f.hold(new Promise<void>(resolve => { release = resolve }))
  await f.input('第一笔'); await f.input('第二笔')
  await f.external('另一位作者')
  await act(async () => { release(); await Promise.resolve() })
  f.bytes('另一位作者'); assert.equal(f.operations.length, 1, 'dependent edit must not be submitted')
  assert.match(document.body.textContent!, /版本冲突/)
  await f.input('基于最新正文'); f.bytes('基于最新正文')
  const last = f.operations.at(-1)![0]
  assert.equal(last.type === 'textRanges' && last.expectedTextVersion, fragmentHash('另一位作者'))
})

test('M4-E2 composition against an externally changed version reports instead of writing', async t => {
  const f = await fixture(t), el = f.rich()
  await act(() => el.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
  await f.input('尚在组合')
  await f.external('外部正文')
  await act(() => el.dispatchEvent(new f.dom.window.CompositionEvent('compositionend', { bubbles: true })))
  f.bytes('外部正文'); assert.equal(f.operations.length, 0)
  assert.match(document.body.textContent!, /版本|revision|range/)
})


test('M4-E2 finishing waits for the canvas acknowledgement and keeps a rejected editor open', async t => {
  const f = await fixture(t); let release!: () => void
  f.hold(new Promise<void>(resolve => { release = resolve })); f.setReject()
  await f.input('未确认文字')
  const done = [...document.querySelectorAll('button')].find(button => button.textContent === '完成编辑')!
  await act(() => done.click())
  assert.ok(document.querySelector('[aria-label="文字卡编辑"]'), 'pending editor must stay mounted')
  await act(async () => { release(); await Promise.resolve() })
  f.bytes('原文😀'); assert.ok(document.querySelector('[aria-label="文字卡编辑"]'))
  assert.match(document.body.textContent!, /版本|冲突/)
})

test('M4-E2 finishing flushes a source block before unmounting', async t => {
  const f = await fixture(t, '```js\nold\n```')
  const source = [...document.querySelectorAll('button')].find(button => button.textContent === '编辑源码')!
  await act(() => source.click())
  const area = document.querySelector('textarea')!
  await act(() => {
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '```js\nnew\n```')
    area.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
  })
  const done = [...document.querySelectorAll('button')].find(button => button.textContent === '完成编辑')!
  await act(() => done.click())
  f.bytes('```js\nnew\n```'); assert.equal(document.querySelector('[aria-label="文字卡编辑"]'), null)
})
