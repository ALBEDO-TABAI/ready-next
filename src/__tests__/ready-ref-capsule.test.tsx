import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { importWithoutStyles } from './utils/import-without-styles'
import type { ReadyRef } from '../shared/ready-ref'

// W6 T1: the reference capsule behaves the same wherever it appears. Real stores, real openReadyRef and the real float
// host; only Main (electronAPI) and the clipboard are replaced.
const ui = await importWithoutStyles(() => import('../renderer/components/ui'))

async function mount(t: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const copied: string[] = []
  const globals = {
    window: dom.window, document: dom.window.document, navigator: Object.assign(dom.window.navigator, { clipboard: { writeText: async (text: string) => { copied.push(text) } } }),
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} },
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  dom.window.localStorage.setItem('ready-object-presentation-migration-v1', JSON.stringify({ migrationId: 'w6-capsule', applied: true, report: { state: 'completed', resolved: [], unresolved: [] } }))
  const { useMode } = await import('../renderer/stores/useMode')
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const { useDocumentNavigator } = await import('../renderer/modules/document/navigator/useDocumentNavigator')
  const stores = [useMode, useDocTabs, useWorkspace, useDocumentNavigator]
  const restore = stores.map(store => { const state = store.getState(); return () => store.setState(state, true) })
  const looks: ReadyRef[] = [], modes: string[] = []
  dom.window.addEventListener('ready:open-quick-look', event => looks.push((event as CustomEvent<{ ref: ReadyRef }>).detail.ref))
  dom.window.addEventListener('ready:workbench-mode-change-request', event => { const mode = (event as CustomEvent).detail.mode; modes.push(mode); useMode.setState({ workbenchMode: mode }) })
  Object.assign(dom.window, { electronAPI: {
    objects: { locate: async (id: string) => id === 'gone' ? null : ({ objectId: id, path: `/vault/${id}.md`, revision: 1 }), onMoved: () => () => {} },
    document: { readFile: async () => ({ success: true, content: '# 新书发布\n\n这是项目主页，周五前给出定稿。' }) },
    documentPages: { onChanged: () => () => {} },
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => { ui.closeAllFloats(); root.unmount() })
    restore.forEach(fn => fn())
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  })
  const settle = async (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
  const mouse = async (element: Element, type: string, init: MouseEventInit = {}) => {
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 30, ...init })) })
    await settle()
  }
  const key = async (element: Element | Window, value: string, init: KeyboardEventInit = {}) => {
    await act(async () => { element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init })) })
    await settle()
  }
  const render = async (node: React.ReactNode) => { await act(async () => root.render(<>{node}<ui.FloatHost /></>)) }
  const capsule = () => dom.window.document.querySelector<HTMLAnchorElement>('[data-ready-ref-capsule]')!
  const menuItems = () => [...dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent)
  const tabs = () => useDocTabs.getState().tabs.map(tab => tab.path)
  const oneTab = () => useDocTabs.setState({ tabs: [{ id: 'current', path: '/vault/current.md', title: 'current', content: '', isDirty: false }], activeTabId: 'current', splitTabId: null })
  return { dom, copied, looks, modes, render, capsule, mouse, key, settle, menuItems, tabs, oneTab, useMode, useDocTabs, useWorkspace, useDocumentNavigator }
}

test('W6 T1 capsule: type icon and title; click opens, ⌥-click quick-looks, ⌘-click opens in a new tab, drag carries the unified format', async t => {
  const h = await mount(t)
  h.useMode.setState({ workbenchMode: 'document' }); h.oneTab()
  await h.render(<p>见 <ui.RefCapsule reference={{ kind: 'page', id: 'target' }} title="新书发布" /> 一页</p>)
  const capsule = h.capsule()
  assert.equal(capsule.getAttribute('aria-label'), '页面 新书发布', 'the accessible name is the type and the title')
  assert.equal(capsule.textContent, '新书发布')
  assert.equal(capsule.dataset.refKind, 'page')
  assert.equal(capsule.getAttribute('href'), 'ready://doc/page/target')
  assert.equal(capsule.getAttribute('draggable'), 'true')

  // ⌘-click: the current tab stays, the page opens in a tab of its own.
  await h.mouse(capsule, 'click', { metaKey: true })
  assert.deepEqual(h.tabs(), ['/vault/current.md', '/vault/target.md'])
  assert.equal(h.useWorkspace.getState().selectedFile, '/vault/target.md')
  assert.deepEqual(h.modes, ['document'])

  // Click: inside Document mode the link navigates the current tab, as in Inkwell.
  h.oneTab()
  await h.mouse(h.capsule(), 'click')
  assert.deepEqual(h.tabs(), ['/vault/target.md'])

  // ⌥-click: a quick look of the same reference, nothing opens.
  h.oneTab()
  await h.mouse(h.capsule(), 'click', { altKey: true })
  assert.deepEqual(h.looks, [{ kind: 'page', id: 'target' }])
  assert.deepEqual(h.tabs(), ['/vault/current.md'])

  // Drag: application/x-ready-ref, text/uri-list and the title as plain text.
  const data = new Map<string, string>(), transfer = { setData: (format: string, value: string) => data.set(format, value), effectAllowed: 'none' }
  const drag = new h.dom.window.Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(drag, 'dataTransfer', { value: transfer })
  await act(async () => { h.capsule().dispatchEvent(drag) })
  assert.deepEqual(Object.fromEntries(data), { 'application/x-ready-ref': '{"kind":"page","id":"target"}', 'text/uri-list': 'ready://doc/page/target', 'text/plain': '新书发布' })
  assert.equal(transfer.effectAllowed, 'copyLink')
  assert.equal(drag.defaultPrevented, false)

  // A failed open says why, in the same toast everywhere.
  await h.render(<ui.RefCapsule reference={{ kind: 'page', id: 'gone' }} title="已删除" />)
  const { getToasts } = await import('../renderer/components/ui/toast-store')
  await h.mouse(h.capsule(), 'click')
  assert.equal(getToasts().at(-1)?.message, '引用文档已不存在')
})

test('W6 T1 capsule menu: 打开 / 速览 / 复制引用 / 在文件视角中显示, the last only for files', async t => {
  const h = await mount(t)
  h.useMode.setState({ workbenchMode: 'calendar' })
  const revealed: string[] = []
  h.useWorkspace.setState({ sidebarVisible: false, toggleSidebar: () => h.useWorkspace.setState({ sidebarVisible: true }), revealFile: async (path: string) => { revealed.push(path) } })
  h.useDocumentNavigator.setState({ view: 'pages' })
  await h.render(<ui.RefCapsule reference={{ kind: 'canvas', id: 'board' }} title="灵感" />)
  await h.mouse(h.capsule(), 'contextmenu')
  assert.equal(h.dom.window.document.querySelector('[role="menu"]')?.getAttribute('aria-label'), '画板 灵感')
  assert.deepEqual(h.menuItems(), ['打开', '速览空格', '复制引用', '在文件视角中显示'])

  const choose = async (label: string) => {
    await h.mouse(h.capsule(), 'contextmenu')
    const item = [...h.dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent?.startsWith(label))!
    await act(async () => item.click()); await h.settle(); await h.settle()
  }
  await choose('复制引用')
  assert.deepEqual(h.copied, ['[灵感](ready://canvas/board)'])
  await choose('在文件视角中显示')
  assert.deepEqual(revealed, ['/vault/board.md'])
  assert.equal(h.useDocumentNavigator.getState().view, 'files')
  assert.equal(h.useWorkspace.getState().sidebarVisible, true)
  assert.equal(h.useMode.getState().workbenchMode, 'document')
  await choose('速览')
  assert.deepEqual(h.looks, [{ kind: 'canvas', id: 'board' }])
  await choose('打开')
  assert.equal(h.useWorkspace.getState().selectedFile, '/vault/board.md')

  // A web page has no file to show.
  await h.render(<ui.RefCapsule reference={{ kind: 'web', url: 'https://example.com/a' }} title="example.com/a" />)
  await h.mouse(h.capsule(), 'contextmenu')
  assert.deepEqual(h.menuItems(), ['打开', '速览空格', '复制引用'])
})

test('W6 T1 capsule keyboard and hover: Space on a focused or hovered capsule quick-looks; typing keeps Space; the preview follows the pause', async t => {
  const h = await mount(t)
  await h.render(<><input aria-label="正文" /><ui.RefCapsule reference={{ kind: 'page', id: 'target' }} title="新书发布" /></>)
  const capsule = h.capsule()
  // Focused with the keyboard: Space quick-looks.
  capsule.focus()
  await h.key(capsule, ' ')
  assert.deepEqual(h.looks, [{ kind: 'page', id: 'target' }])
  capsule.blur()

  // Hovered: after the tooltip pause a short preview shows the type, title and the first lines.
  await h.mouse(capsule, 'mouseover')
  await h.settle(600)
  const preview = h.dom.window.document.querySelector('[role="tooltip"].rn-ref-preview')
  assert.ok(preview, 'the hover preview opens')
  assert.match(preview!.textContent!, /页面/); assert.match(preview!.textContent!, /新书发布/); assert.match(preview!.textContent!, /周五前给出定稿/)
  assert.doesNotMatch(preview!.textContent!, /\/vault\//, 'never a path')

  // Hover + Space quick-looks while nothing is being typed …
  await h.key(h.dom.window, ' ')
  assert.equal(h.looks.length, 2)
  assert.equal(h.dom.window.document.querySelector('.rn-ref-preview'), null, 'the preview steps aside')
  // … but Space typed into a field stays a space.
  const input = h.dom.window.document.querySelector<HTMLInputElement>('input')!
  input.focus()
  await h.key(input, ' ')
  assert.equal(h.looks.length, 2)
  // Leaving the capsule forgets it.
  input.blur()
  await h.mouse(capsule, 'mouseout', { relatedTarget: input })
  await h.key(h.dom.window, ' ')
  assert.equal(h.looks.length, 2)
})

export const __breaksInvariants = ['renderer navigation stores restored after the isolated capsule test'] as const
