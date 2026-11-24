import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, StrictMode, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { useLeaveAsGhost } from '../renderer/components/ui/leave'

// Motion language M2–M3: a float or toast that closes is gone at once and an inert copy fades out in its place.
// Real React and the real hook; jsdom has no layout, so the element reports a box.

function setup(t: test.TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true })
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: dom.window.HTMLElement }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const proto = dom.window.HTMLElement.prototype
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get() { return 120 } })
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get() { return 40 } })
  proto.getBoundingClientRect = () => ({ left: 10, top: 20, right: 130, bottom: 60, width: 120, height: 40, x: 10, y: 20, toJSON() {} })
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  return { dom, root }
}

function Menu() {
  const ref = useRef<HTMLDivElement>(null)
  useLeaveAsGhost(ref, { zIndex: 42 })
  return (
    <div ref={ref} id="menu" data-float-id="f1" data-ready-native-overlay="" role="menu">
      <input id="search" defaultValue="" />
      <svg><defs><linearGradient id="g" /></defs></svg>
      <button type="button">打开</button>
    </div>
  )
}

test('a closed float leaves as an inert, id-free copy that keeps what was typed and goes when its fade ends', async t => {
  const { dom, root } = setup(t)
  const doc = dom.window.document
  await act(async () => root.render(<StrictMode><Menu /></StrictMode>))
  assert.equal(doc.querySelectorAll('[data-rn-leaving]').length, 0, 'mounting (StrictMode re-runs included) leaves no copy')
  ;(doc.getElementById('search') as HTMLInputElement).value = '模型'

  await act(async () => root.render(<StrictMode><div /></StrictMode>))
  await act(async () => { await Promise.resolve() })
  const ghost = doc.querySelector<HTMLElement>('[data-rn-leaving]')
  assert.ok(ghost, 'the copy is shown')
  assert.equal(doc.getElementById('menu'), null, 'the real menu is gone at once')
  assert.equal(ghost.getAttribute('aria-hidden'), 'true')
  assert.equal(ghost.inert, true)
  assert.equal(ghost.style.pointerEvents, 'none')
  assert.equal(ghost.style.zIndex, '42')
  assert.equal(ghost.hasAttribute('data-float-id'), false)
  assert.equal(ghost.querySelector('input')?.hasAttribute('id'), false, 'no duplicate ids')
  assert.ok(ghost.querySelector('svg [id="g"]'), 'ids inside an SVG stay for its url(#…) paints')
  assert.equal(ghost.querySelector('input')?.value, '模型', 'the typed value is copied')
  assert.equal(ghost.hasAttribute('data-ready-native-overlay'), false, 'the copy does not keep the web page hidden')
  assert.equal(ghost.style.minWidth, '120px', 'its measured size holds whatever its classes resolve to under body')
  assert.equal(ghost.style.left, '10px')
  assert.equal(ghost.style.top, '20px')

  ghost.dispatchEvent(new dom.window.Event('animationend', { bubbles: true }))
  assert.equal(doc.querySelectorAll('[data-rn-leaving]').length, 0, 'the copy is removed when its fade ends')
})
