import assert from 'node:assert/strict'
import test from 'node:test'
import { posix } from 'node:path'
import React, { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import { applyCanvasOperations, type CanvasOperation, type ReadyCanvas } from '../shared/ready-canvas'
import { fragmentHash } from '../shared/document-blocks'

// M4-E2 contract: real card + shared editor + surface commit path. Only the
// host acknowledgement and browser geometry are substitutes; no document tab.
async function fixture(t: test.TestContext, body = '原文😀', canvasPath?: string) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    CustomEvent: dom.window.CustomEvent,
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
    }} renderTextEditor={({ node, commit }) => node.type === 'text' && <TextCard node={node} commit={commit} canvasPath={canvasPath} />} />
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
  const input = async (value: string) => { const el = rich(); await act(async () => { el.focus(); el.textContent = value; setCaret(el, value.length); el.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true })) }) }
  const key = async (key: string, options: KeyboardEventInit = {}, target = rich()) => { await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options })) }) }
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

// NODE-BUFFER contract: after an acknowledged undo, both the visible editor
// and its next range must use the restored body; finishing waits for that write.
test('NODE-BUFFER input, persisted undo, input and finish save the new text and close', async t => {
  const f = await fixture(t, '新文字卡')
  await f.input('中文画板验收'); f.bytes('中文画板验收')
  await f.key('z', { metaKey: true }); f.bytes('新文字卡')
  assert.equal(f.rich().textContent, '新文字卡')
  await f.input('中文成文验收')
  const done = [...document.querySelectorAll('button')].find(button => button.textContent === '完成编辑')!
  await act(async () => done.click())
  assert.ok(!document.querySelector('[role="alert"]'), document.querySelector('[role="alert"]')?.textContent ?? '')
  f.bytes('中文成文验收')
  assert.equal(document.querySelector('[aria-label="文字卡编辑"]'), null)
})

for (const change of ['redo', 'external'] as const) test(`NODE-BUFFER typing after ${change} starts a new undo step`, async t => {
  const f = await fixture(t, '新文字卡')
  await f.input('中文画板验收'); f.bytes('中文画板验收')
  if (change === 'redo') {
    await f.key('z', { metaKey: true }); f.bytes('新文字卡')
    await f.key('z', { metaKey: true, shiftKey: true })
  } else await f.external('外')
  const restored = change === 'redo' ? '中文画板验收' : '外'
  f.bytes(restored); assert.equal(f.rich().textContent, restored)
  await f.input('再次编辑')
  assert.ok(!document.querySelector('[role="alert"]'), document.querySelector('[role="alert"]')?.textContent ?? '')
  f.bytes('再次编辑')
  await f.key('z', { metaKey: true }); f.bytes(restored)
  await f.key('z', { metaKey: true }); f.bytes(change === 'redo' ? '新文字卡' : '中文画板验收')
  if (change === 'external') { await f.key('z', { metaKey: true }); f.bytes('新文字卡') }
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
  await f.key('Escape', {}, document.querySelector<HTMLElement>('[data-rich-start]')!)
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
  const bold = toolbar.querySelector<HTMLButtonElement>('button[aria-label="粗体"]')!
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

// M4-E3: services are IPC substitutes; rendering, selection, navigation and
// canvas range application remain real. Native tests cover the same writes on disk.
async function linkAPI(t: test.TestContext) {
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const previous = useWorkspace.getState(), tabs = useDocTabs.getState()
  useWorkspace.setState({ workspaceRoot: '/vault', pinnedFolders: [] })
  useDocTabs.setState({ tabs: [], activeTabId: null })
  t.after(() => { useWorkspace.setState(previous); useDocTabs.setState(tabs) })
  const requests: Array<{ operationId: string; parentPath: string; title: string }> = []
  const resolved: string[] = [], copied: string[] = []
  const api = {
    document: {
      searchIndex: async () => ({ success: true, data: { items: [{ path: '/vault/资料/某页.md', name: '某页', sourceType: 'document' }] } }),
      readFile: async () => ({ success: true, data: { content: '正文' } }),
      stat: async (path: string) => ({ success: posix.normalize(path) === '/vault/资料/某页.md' }),
    },
    objects: {
      onMoved: () => () => {},
      prepareMigration: async () => ({ resolved: [], state: 'prepared' }),
      completeMigration: async () => ({ state: 'completed' }),
      resolvePath: async (path: string) => { resolved.push(posix.normalize(path)); return { path: posix.normalize(path), objectId: path.endsWith('.canvas') ? 'board' : 'page', revision: 1 } },
      locate: async (id: string) => ({ path: id === 'board' ? '/vault/项目/X.canvas' : '/vault/资料/某页.md', objectId: id, revision: 1 }),
    },
    documentPages: { operate: async (request: typeof requests[number]) => {
      requests.push(request)
      return { ok: true, value: { path: '/vault/项目/X/子页.md' } }
    } },
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  return { api, requests, resolved, copied, useDocTabs }
}

test('M4-E3 wiki picker inserts a canvas-folder-relative target through the exact node range', async t => {
  const f = await fixture(t, '前缀 [[某页', '/vault/项目/X.canvas')
  await linkAPI(t)
  await f.input('前缀 [[某页')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent?.includes('某页'))
  assert.ok(option, 'canvas wiki picker available')
  await act(() => option.click())
  f.bytes('前缀 [[../资料/某页]]')
  assert.deepEqual(f.operations.at(-1), [{ type: 'textRanges', id: 'one', expectedTextVersion: fragmentHash('前缀 [[某页'),
    ranges: [{ start: 0, end: 7, expectedText: '前缀 [[某页', replacement: '前缀 [[../资料/某页]]' }] }])
  await f.key('z', { metaKey: true }); f.bytes('前缀 [[某页')
})

for (const changed of [false, true]) test(`M4-E3 subpage confirmation respects the canvas parent and intervening edits (${changed})`, async t => {
  const f = await fixture(t, '/', '/vault/项目/X.canvas'), api = await linkAPI(t)
  await f.input('/')
  const option = document.querySelector<HTMLElement>('.ready-slash-menu [data-slash-item="page"]')
  assert.ok(option); await act(() => option.click())
  const input = document.querySelector<HTMLInputElement>('[aria-label="子页面标题"]')!
  await act(() => {
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '子页')
    input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
  })
  let confirm!: () => void
  const operate = api.api.documentPages.operate
  api.api.documentPages.operate = async request => { await new Promise<void>(resolve => { confirm = resolve }); return operate(request) }
  await act(() => input.closest('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })))
  f.bytes('/'); assert.equal(f.operations.length, 0)
  if (changed) await f.external('外部正文')
  await act(async () => { confirm() })
  assert.equal(api.requests[0].parentPath, '/vault/项目/X.canvas')
  assert.equal(api.requests[0].title, '子页')
  if (changed) {
    f.bytes('外部正文'); assert.equal(f.operations.length, 0)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /页面已创建在.*X\/子页.md.*未插入链接/)
  } else {
    f.bytes('[[X/子页]]'); assert.equal(f.operations.at(-1)![0].type, 'textRanges')
  }
})

test('M4-E3 opening a card wiki link selects its page without a document owner', async t => {
  const f = await fixture(t, '[[../资料/某页]]', '/vault/项目/X.canvas'), api = await linkAPI(t)
  const anchor = f.rich().querySelector('a')!
  await act(async () => { anchor.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, metaKey: true })) })
  const state = api.useDocTabs.getState()
  assert.equal(state.tabs.find(tab => tab.id === state.activeTabId)?.path, '/vault/资料/某页.md')
  assert.ok(api.resolved.includes('/vault/资料/某页.md'))
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.equal(f.operations.length, 0)
})

test('M4-E3 copy block reference addresses the stable card and leaves its body untouched', async t => {
  const f = await fixture(t, '原文😀', '/vault/项目/X.canvas'), api = await linkAPI(t)
  await f.key('Enter', {}, document.querySelector<HTMLElement>('[aria-label="块菜单"]')!)
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent === '复制块引用')
  assert.ok(option); await act(async () => option.click())
  assert.deepEqual(api.copied, ['ready://canvas/board#node=one'])
  f.bytes('原文😀'); assert.equal(f.operations.length, 0)
  const { openReadyRef } = await import('../renderer/modules/workbench/open-ready-ref')
  const { useCanvasNavigation } = await import('../renderer/modules/canvas/navigation')
  await act(() => openReadyRef(api.copied[0], 'document'))
  assert.equal(useCanvasNavigation.getState().target?.objectId, 'board')
  assert.equal(useCanvasNavigation.getState().target?.nodeId, 'one')
})
