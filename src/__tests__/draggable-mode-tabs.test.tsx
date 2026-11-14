import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { WorkbenchMode } from '../renderer/stores/useMode'

// The real slot (V20, V21, V32) in a DOM: React, Lucide and the track's lens stay real; the shell's handlers are
// recorders.
test('the mode switch slot lights the current modes, switches on click and splits on ⇧/⌥-click; nothing slides or drags', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  const globals = {
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  // Imported once the DOM exists: the theme store it reads for 减少透明 touches the window when it is created.
  const { default: DraggableModeTabs } = await import('../renderer/components/layout/DraggableModeTabs')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })

  const changes: WorkbenchMode[] = [], splits: WorkbenchMode[] = []
  const render = (activeMode: WorkbenchMode, splitMode: WorkbenchMode | null = null) => act(async () => root.render(
    <DraggableModeTabs activeMode={activeMode} splitMode={splitMode}
      onChange={mode => changes.push(mode)} onSplitToggle={mode => splits.push(mode)} />,
  ))
  const doc = dom.window.document
  const slot = () => doc.querySelector<HTMLElement>('[role="tablist"]')!
  const tab = (mode: WorkbenchMode) => doc.querySelector<HTMLButtonElement>(`[role="tab"][data-mode="${mode}"]`)!
  const selected = () => [...doc.querySelectorAll('[role="tab"][aria-selected="true"]')].map(el => el.getAttribute('data-mode'))
  const press = (el: EventTarget, type: string, init: MouseEventInit = {}) => act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }))
  })

  await render('document')
  assert.equal(slot().getAttribute('aria-label'), '模式')
  assert.deepEqual([...doc.querySelectorAll('[role="tab"]')].map(el => [el.getAttribute('aria-label'), el.getAttribute('title')]),
    [['浏览器', '浏览器 ⌘1'], ['文档', '文档 ⌘2'], ['资讯', '资讯 ⌘3'], ['日历', '日历 ⌘4']])
  assert.deepEqual(selected(), ['document'])
  assert.equal(slot().getAttribute('aria-multiselectable'), 'false')
  // V21: the pill is liquid glass projecting the conversation behind it. V32: no thumb on it.
  assert.ok(slot().querySelector('.draggable-mode-tabs__surface .draggable-mode-tabs__projection'))
  assert.equal(slot().querySelector('[class*="thumb"]'), null)
  // Every mode is a real button (so Enter and Space switch too) with a resting twin and a lit twin; 资讯's lit twin is
  // its own outline at a heavier stroke.
  for (const mode of ['browser', 'document', 'rss', 'calendar'] as const) {
    assert.equal(tab(mode).tagName, 'BUTTON')
    assert.equal(tab(mode).querySelectorAll('.draggable-mode-tabs__glyph.is-rest').length, 1)
    assert.equal(tab(mode).querySelectorAll('.draggable-mode-tabs__glyph.is-lit').length, 1)
  }
  assert.equal(tab('rss').querySelector('.is-lit')?.getAttribute('stroke-width'), '2')

  // A click switches through the shell's handler; ⇧ and ⌥ toggle the split instead.
  for (const mode of ['browser', 'rss', 'calendar', 'document'] as const) {
    changes.length = 0; splits.length = 0
    await press(tab(mode), 'click')
    assert.deepEqual(changes, [mode]); assert.deepEqual(splits, [])
    for (const modifier of ['shiftKey', 'altKey'] as const) {
      splits.length = 0
      await press(tab(mode), 'click', { [modifier]: true })
      assert.deepEqual(splits, [mode]); assert.deepEqual(changes, [mode])
    }
  }

  // The lit icon follows the mode the shell reports, not the click.
  await render('rss')
  assert.deepEqual(selected(), ['rss'])

  // A split lights both modes; the icons keep their places.
  await render('browser', 'calendar')
  assert.deepEqual(selected(), ['browser', 'calendar'])
  assert.equal(slot().getAttribute('aria-multiselectable'), 'true')
  assert.deepEqual([...doc.querySelectorAll('[role="tab"]')].map(el => el.getAttribute('data-mode')), ['browser', 'document', 'rss', 'calendar'])
  // A split mode equal to the primary one is no split.
  await render('rss', 'rss')
  assert.deepEqual(selected(), ['rss'])
  assert.equal(slot().getAttribute('aria-multiselectable'), 'false')

  // Pressing and moving over the slot switches nothing: there is no thumb to drag.
  await render('document')
  changes.length = 0
  await press(tab('document'), 'mousedown', { clientX: 40 })
  await press(doc, 'mousemove', { clientX: 40 + 44 * 1.6 })
  await press(doc, 'mouseup', { clientX: 40 + 44 * 1.6 })
  assert.deepEqual(changes, [])
  assert.deepEqual(selected(), ['document'])
})

// The track's lens as Chromium gets it: a plain displacement, no colour fringe.
test('the slot\'s track lens refracts without a colour fringe', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  // Only the browser surfaces jsdom lacks are stood in: element sizes, a 2D context and ImageData; the map math is real.
  const sizes: Record<string, [number, number]> = { 'draggable-mode-tabs__surface': [176, 40] }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const size = Object.entries(sizes).find(([name]) => this.classList.contains(name))?.[1] ?? [0, 0]
    return new dom.window.DOMRect(0, 0, size[0], size[1])
  }
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({ putImageData() {} })) as never
  dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,'
  const globals = {
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ImageData: class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} },
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { default: DraggableModeTabs } = await import('../renderer/components/layout/DraggableModeTabs')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  await act(async () => root.render(<DraggableModeTabs activeMode="rss" onChange={() => {}} />))
  await act(async () => { await new Promise(done => setTimeout(done, 80)) }) // the maps are built on the next frame

  const doc = dom.window.document
  const track = doc.querySelector('.draggable-mode-tabs__surface filter')
  assert.ok(track, 'the track has its refraction filter')
  assert.equal(doc.querySelectorAll('.draggable-mode-tabs filter').length, 1)
  assert.equal(track.querySelectorAll('feDisplacementMap').length, 1)
  assert.equal(track.querySelector('feComposite'), null)
})
