import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createDraftFixture } from './ready-drafts-fixture'

// M3-E/C4: real editor + tab store. Only browser geometry and the durable draft
// transport are replaced. Expectations are literal source bytes, never reserialized trees.
export const head = '\uFEFF---\r\ntitle: "保留" # 注释\r\n---\r\n\r\n'
export const tail = '\r\n\r\n```js\r\nconst untouched = "😀";\r\n```\n\n尾段 é'
export async function editorFixture(t: test.TestContext, body: string) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  // jsdom has no matchMedia; the theme store (reached through the keyboard shortcuts) reads it on import.
  dom.window.matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), MutationObserver: dom.window.MutationObserver,
    localStorage: dom.window.localStorage, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { createRoot } = await import('react-dom/client')
  const { useDocTabs } = await import('../../renderer/stores/useDocTabs')
  const { configureDrafts } = await import('../../renderer/modules/document/drafts/runtime')
  const f = createDraftFixture()
  configureDrafts({ ...f.port, tabs: () => useDocTabs.getState().tabs,
    patch: (id, patch) => useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })),
  }, () => {})
  const { ReadyBlockEditor } = await import('../../renderer/modules/document/block-editor/ReadyBlockEditor')
  const { getTabBuffer } = await import('../../renderer/modules/document/block-editor/tab-buffer')
  useDocTabs.setState({ tabs: [{ id: t.name, title: '夹具', path: null, content: head + body + tail, isDirty: false }] })
  const buffer = getTabBuffer(t.name)
  const root = createRoot(document.getElementById('root')!)
  await act(() => root.render(<ReadyBlockEditor tabId={t.name} renderSource={block => <pre>{block.raw}</pre>} />))
  t.after(async () => {
    await act(() => root.unmount())
    useDocTabs.setState({ tabs: [] })
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  })
  const bytes = (expected: string) => {
    const actual = useDocTabs.getState().tabs.find(tab => tab.id === t.name)!.content
    assert.deepEqual(Buffer.from(actual), Buffer.from(head + expected + tail))
    assert.deepEqual(Buffer.from(actual.slice(0, head.length)), Buffer.from(head), 'unedited prefix bytes')
    assert.deepEqual(Buffer.from(actual.slice(-tail.length)), Buffer.from(tail), 'unedited suffix bytes')
  }
  const rich = (text: string) => {
    const el = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')].find(item => item.textContent === text)
    assert.ok(el, `editable ${JSON.stringify(text)}`); return el
  }
  const caret = async (el: HTMLElement, at: number) => {
    const { setCaret } = await import('../../renderer/modules/document/block-editor/dom-inline')
    await act(() => { el.focus(); setCaret(el, at) })
  }
  const input = async (el: HTMLElement, text: string) => {
    await act(() => { el.textContent = text; el.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' })) })
  }
  const key = async (el: HTMLElement, key: string, options: KeyboardEventInit = {}) => {
    await act(() => { el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })) })
  }
  const blur = async (el: HTMLElement) => { await act(() => el.blur()) }
  const click = async (text: string, scope: ParentNode = document) => {
    const button = [...scope.querySelectorAll('button')].find(el => el.textContent === text)
    assert.ok(button, text); await act(() => button.click())
  }
  return { dom, root, buffer, bytes, rich, caret, input, key, blur, click, useDocTabs }
}
