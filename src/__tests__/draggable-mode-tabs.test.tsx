import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { WorkbenchMode } from '../renderer/stores/useMode'

// The real slot (V20, V21) in a DOM: React, Lucide, the lenses and the motion helpers stay real; the shell's handlers
// are recorders.
test('the mode switch slot shows the workbench state, switches on click, splits on ⇧/⌥-click and snaps a dragged thumb', async t => {
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
  assert.ok(tab('document').classList.contains('is-active'))
  assert.equal(slot().style.getPropertyValue('--dmt-thumb-pos'), '1')
  assert.equal(slot().style.getPropertyValue('--dmt-thumb-span'), '1')
  // V21: the pill is liquid glass projecting the conversation behind it, the thumb a lens (the glyph twins it lights are
  // checked at the end).
  assert.ok(slot().querySelector('.draggable-mode-tabs__surface .draggable-mode-tabs__projection'))
  assert.ok(slot().querySelector('.draggable-mode-tabs__thumb .draggable-mode-tabs__thumb-lens'))

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

  // A split selects both modes; the thumb grows to span them and the split mode moves in beside the primary one.
  await render('browser', 'calendar')
  assert.deepEqual(selected(), ['browser', 'calendar'])
  assert.equal(slot().getAttribute('aria-multiselectable'), 'true')
  assert.equal(slot().getAttribute('data-split-active'), 'true')
  await new Promise(done => setTimeout(done, 300))
  assert.equal(slot().style.getPropertyValue('--dmt-thumb-span'), '2')
  assert.equal(tab('calendar').style.getPropertyValue('--dmt-icon-index'), '1')
  assert.equal(tab('calendar').style.getPropertyValue('--dmt-icon-shift'), '-2')

  // A press on an icon under the thumb grabs it: drag 1.6 cells to the right and it snaps to the nearest mode.
  await render('document')
  slot().getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 176, bottom: 40, width: 176, height: 40, toJSON: () => ({}) })
  await new Promise(done => setTimeout(done, 300)) // let the thumb settle back on 文档
  changes.length = 0
  await press(tab('document'), 'mousedown', { clientX: 40 })
  assert.equal(slot().getAttribute('data-dragging'), 'true')
  await press(doc, 'mousemove', { clientX: 40 + 44 * 1.6 })
  assert.equal(Number(slot().style.getPropertyValue('--dmt-thumb-pos')).toFixed(1), '2.6')
  await press(doc, 'mouseup', { clientX: 40 + 44 * 1.6 })
  assert.equal(slot().getAttribute('data-dragging'), 'false')
  assert.deepEqual(changes, ['calendar'])

  // A press on an icon the thumb does not cover starts no drag.
  await render('calendar')
  await press(tab('browser'), 'mousedown', { clientX: 10 })
  assert.equal(slot().getAttribute('data-dragging'), 'false')

  // The lens never leaves the pill: sampled through every glide that changes its span (into a split ending at the last
  // cell, out of it, and from a split at the first cell to the last cell), its near end stays at or after the pill's
  // start and its far end at or before the pill's end, and it lands where the mode is.
  const glide = async (activeMode: WorkbenchMode, splitMode: WorkbenchMode | null, pos: string, span: string) => {
    await new Promise(done => setTimeout(done, 300))
    await render(activeMode, splitMode)
    for (let elapsed = 0; elapsed < 320; elapsed += 8) {
      const place = Number(slot().style.getPropertyValue('--dmt-thumb-pos'))
      const width = Number(slot().style.getPropertyValue('--dmt-thumb-span'))
      assert.ok(place >= 0 && place + width <= 4 + 1e-9, `inside the pill: ${place} + ${width}`)
      await new Promise(done => setTimeout(done, 8))
    }
    assert.deepEqual([slot().style.getPropertyValue('--dmt-thumb-pos'), slot().style.getPropertyValue('--dmt-thumb-span')], [pos, span])
  }
  await glide('calendar', 'rss', '2', '2')
  await glide('calendar', null, '3', '1')
  await glide('browser', 'document', '0', '2')
  await glide('calendar', null, '3', '1')

  // The look follows the lens alone, never the active class. Every mode has a resting twin and a lit twin (资讯's lit
  // twin is its own outline at a heavier stroke); how lit an icon is comes from the lens's place (mode-switch.css's
  // --dmt-icon-lit-amount, mirrored here).
  for (const mode of ['browser', 'document', 'rss', 'calendar'] as const) {
    assert.equal(tab(mode).querySelectorAll('.draggable-mode-tabs__glyph.is-rest').length, 1)
    assert.equal(tab(mode).querySelectorAll('.draggable-mode-tabs__glyph.is-lit').length, 1)
  }
  assert.equal(tab('rss').querySelector('.is-lit')?.getAttribute('stroke-width'), '2')
  const litAmount = (mode: WorkbenchMode) => {
    const index = Number(tab(mode).style.getPropertyValue('--dmt-icon-index'))
    const place = Number(slot().style.getPropertyValue('--dmt-thumb-pos'))
    const span = Number(slot().style.getPropertyValue('--dmt-thumb-span'))
    const distance = Math.max(0, place - index, index - (place + span - 1))
    return Math.min(1, Math.max(0, (Math.max(0, 1 - distance * 0.8) - 0.5) * 2))
  }
  // Dragging from 日历 to 文档 lights 文档 and empties 日历 while the mode is still 日历 (the prop has not changed), and the
  // lens stays there after the release until the mode commits.
  await press(tab('calendar'), 'mousedown', { clientX: 150 })
  await press(doc, 'mousemove', { clientX: 150 - 44 * 1.5 })
  assert.ok(litAmount('calendar') < 1 && litAmount('rss') > 0, 'half way, both are part lit')
  await press(doc, 'mousemove', { clientX: 150 - 44 * 2 })
  assert.equal(tab('calendar').getAttribute('aria-selected'), 'true')
  assert.deepEqual([litAmount('document'), litAmount('calendar')], [1, 0])
  await press(doc, 'mouseup', { clientX: 150 - 44 * 2 })
  await new Promise(done => setTimeout(done, 400))
  assert.equal(tab('calendar').getAttribute('aria-selected'), 'true')
  assert.deepEqual([litAmount('document'), litAmount('calendar')], [1, 0])
  // When a mode commits, the icon the lens leaves only empties and the one it reaches only fills, frame by frame.
  await render('document')
  await new Promise(done => setTimeout(done, 300))
  await render('browser')
  let lastLit = [litAmount('document'), litAmount('browser')]
  for (let elapsed = 0; elapsed < 320; elapsed += 8) {
    const lit = [litAmount('document'), litAmount('browser')]
    assert.ok(lit[0] <= lastLit[0] + 1e-9 && lit[1] >= lastLit[1] - 1e-9, `document empties, browser fills: ${lastLit} -> ${lit}`)
    lastLit = lit
    await new Promise(done => setTimeout(done, 8))
  }
  assert.deepEqual(lastLit, [0, 1])
})

// The lenses as Chromium gets them: the track keeps a plain displacement; the thumb is clear glass whose rim splits the
// colour channels and takes its coverage from the centre channel, so the fringe does not darken a translucent backdrop.
test('the thumb lens refracts with a colour fringe that keeps the backdrop coverage; the track lens has none', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  // Only the browser surfaces jsdom lacks are stood in: element sizes, a 2D context and ImageData; the map math is real.
  const sizes: Record<string, [number, number]> = { 'draggable-mode-tabs__thumb-lens': [44, 40], 'draggable-mode-tabs__surface': [176, 40] }
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
  const filterOf = (lens: string) => {
    const filter = doc.querySelector(`.${lens} filter`)
    assert.ok(filter, `${lens} has its refraction filter`)
    return filter
  }
  const thumb = filterOf('draggable-mode-tabs__thumb-lens')
  const channels = [...thumb.querySelectorAll('feColorMatrix')].map(node => node.getAttribute('values')?.trim().split(/\s+/).slice(15))
  assert.deepEqual(channels, [['0', '0', '0', '0', '1'], ['0', '0', '0', '0', '1'], ['0', '0', '0', '0', '1']], 'each channel is recombined opaque')
  const coverage = thumb.querySelector('feComposite')
  assert.equal(coverage?.getAttribute('operator'), 'in')
  assert.equal(coverage?.getAttribute('in2'), 'dispG')
  assert.equal(coverage?.getAttribute('result'), 'lensOut')
  const shifts = [...thumb.querySelectorAll('feDisplacementMap')].map(node => Number(node.getAttribute('scale')))
  assert.equal(shifts.length, 3)
  assert.ok(shifts[0] > shifts[1] && shifts[1] > shifts[2], 'red bends further than green, blue less: the fringe')

  const track = filterOf('draggable-mode-tabs__surface')
  assert.equal(track.querySelectorAll('feDisplacementMap').length, 1)
  assert.equal(track.querySelector('feComposite'), null)
})
