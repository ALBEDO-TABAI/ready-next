import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { importWithoutAssets } from './utils/import-without-styles'

// Motion language M2: switching the document navigator between 页面 and 文件 moves the two lists on the switch's own
// (horizontal) axis. The view that leaves stays on screen, inert, until it has gone; a quick switch back turns it
// around. Real React, the real navigator and its store, real timers.

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('页面 ↔ 文件 slides the views the way the switch went, and the old view is hidden only after it has left', async t => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' })
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0) as unknown as number,
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  // The page tree and file manager behind the two views: calls never answer (nothing here needs data), subscriptions are no-ops.
  // Each group is one object, as in the preload bridge (the page tree keys its store on it).
  const groups = new Map<PropertyKey, unknown>()
  const group = () => new Proxy({}, { get: (_, name) => String(name).startsWith('on') ? () => () => {} : () => new Promise(() => {}) })
  const api: unknown = new Proxy({}, { get: (_, name) => {
    if (name === 'then') return undefined
    if (!groups.has(name)) groups.set(name, group())
    return groups.get(name)
  } })
  Object.defineProperty(dom.window, 'electronAPI', { configurable: true, value: api })
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })

  const [{ default: DocumentNavigator }, { useDocumentNavigator }, { SCENE_SETTLE_MS }] = await importWithoutAssets(() => Promise.all([
    import('../renderer/modules/document/navigator/DocumentNavigator'),
    import('../renderer/modules/document/navigator/useDocumentNavigator'),
    import('../renderer/modules/workbench/scene-motion'),
  ]))
  const priorView = useDocumentNavigator.getState().view
  t.after(() => useDocumentNavigator.setState({ view: priorView }))
  await act(async () => { useDocumentNavigator.setState({ view: 'pages' }) })
  await act(async () => root.render(<DocumentNavigator roots={[]} visible={false} onShowFiles={() => {}} />))

  const views = () => [...dom.window.document.querySelectorAll<HTMLElement>('.document-navigator__view')]
  const [pages, files] = views()
  const radio = (name: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(item => item.textContent === name)!
  const shown = () => views().filter(view => !view.hidden).map(view => view === pages ? 'pages' : 'files')
  assert.deepEqual(shown(), ['pages'])
  assert.equal(dom.window.document.querySelector('[data-view-motion]'), null, 'nothing moves before a change')

  // 页面 → 文件, rightwards in the switch: 文件 comes in (from the right), 页面 leaves (to the left) and takes no input.
  await act(async () => { radio('文件').click() })
  assert.equal(files.dataset.viewMotion, 'enter')
  assert.equal(files.dataset.viewDirection, 'forward')
  assert.equal(pages.dataset.viewMotion, 'leave')
  assert.equal(pages.dataset.viewDirection, 'forward')
  assert.equal(pages.hasAttribute('inert'), true)
  assert.deepEqual(shown(), ['pages', 'files'], 'the old view stays on screen while it leaves')
  await act(async () => { await wait(SCENE_SETTLE_MS + 40) })
  assert.deepEqual(shown(), ['files'])
  assert.equal(dom.window.document.querySelector('[data-view-motion]'), null, 'nothing is left mid-transition')
  assert.equal(pages.hasAttribute('inert'), false)

  // Back, and back again before it has settled: the view that is leaving turns around from where it is.
  await act(async () => { radio('页面').click() })
  assert.equal(pages.dataset.viewDirection, 'backward')
  assert.equal(files.dataset.viewMotion, 'leave')
  await act(async () => { await wait(40) })
  await act(async () => { radio('文件').click() })
  assert.equal(files.dataset.viewMotion, 'enter')
  assert.equal(files.hasAttribute('inert'), false)
  assert.equal(pages.dataset.viewMotion, 'leave')
  await act(async () => { await wait(SCENE_SETTLE_MS + 40) })
  assert.deepEqual(shown(), ['files'])
  assert.equal(useDocumentNavigator.getState().view, 'files')
})
