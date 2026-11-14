import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

// A lens with chromatic aberration as Chromium gets it: its rim splits the colour channels and takes its coverage from
// the centre channel, so the fringe does not darken a translucent backdrop.
test('a lens with aberration refracts with a colour fringe that keeps the backdrop coverage', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  // Only the browser surfaces jsdom lacks are stood in: element sizes, a 2D context and ImageData; the map math is real.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('fringe-lens') ? new dom.window.DOMRect(0, 0, 44, 40) : new dom.window.DOMRect(0, 0, 0, 0)
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
  const { LiquidLens } = await import('../renderer/components/ui/liquid-glass/LiquidLens')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  await act(async () => root.render(
    <LiquidLens className="fringe-lens" radius={20} bevel={12} depth={18} ior={1.5} dome={0} profile="squircle"
      strength={2} blur={0} frost={0} saturation={1} brightness={1} contrast={1} aberration={3} />,
  ))
  await act(async () => { await new Promise(done => setTimeout(done, 80)) }) // the maps are built on the next frame

  const lens = dom.window.document.querySelector('.fringe-lens filter')
  assert.ok(lens, 'the lens has its refraction filter')
  const channels = [...lens.querySelectorAll('feColorMatrix')].map(node => node.getAttribute('values')?.trim().split(/\s+/).slice(15))
  assert.deepEqual(channels, [['0', '0', '0', '0', '1'], ['0', '0', '0', '0', '1'], ['0', '0', '0', '0', '1']], 'each channel is recombined opaque')
  const coverage = lens.querySelector('feComposite')
  assert.equal(coverage?.getAttribute('operator'), 'in')
  assert.equal(coverage?.getAttribute('in2'), 'dispG')
  assert.equal(coverage?.getAttribute('result'), 'lensOut')
  const shifts = [...lens.querySelectorAll('feDisplacementMap')].map(node => Number(node.getAttribute('scale')))
  assert.equal(shifts.length, 3)
  assert.ok(shifts[0] > shifts[1] && shifts[1] > shifts[2], 'red bends further than green, blue less: the fringe')
})
