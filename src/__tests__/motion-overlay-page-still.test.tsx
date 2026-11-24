import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { beginBrowserMask, endPersistentBrowserMask } from '../renderer/modules/overlay/browserViewMask'
import { useOverlayPageStill } from '../renderer/modules/overlay/useOverlayPageStill'

// Motion language M2: a float over a native page gets a still of the page first, so the page never goes blank under it.
test('overlapping masks share one capture, the still is up before the view steps aside, and it goes after the last unmask', async t => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true })
  let captures = 0
  class FakeImage { src = ''; decode() { return Promise.resolve() } }
  const hidden: string[] = []
  ;(dom.window as unknown as { electronAPI: unknown }).electronAPI = {
    browser: {
      captureWindowSnapshot: async () => { captures += 1; await new Promise(r => setTimeout(r, 20)); return { success: true, data: 'AAAA' } },
      sendIntent: (intent: { kind: string }) => { hidden.push(intent.kind) },
      onIntentAck: () => () => {},
    },
  }
  const globals = { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, Image: FakeImage, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window) }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} })
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  function Host() { const ref = useRef<HTMLDivElement>(null); useOverlayPageStill(ref, true); return <div ref={ref} data-host="" /> }
  await act(async () => root.render(<Host />))
  const host = dom.window.document.querySelector<HTMLElement>('[data-host]')!

  let stillWhenHidden = ''
  const realSend = (dom.window as any).electronAPI.browser.sendIntent
  ;(dom.window as any).electronAPI.browser.sendIntent = (intent: { kind: string }) => { stillWhenHidden = host.style.backgroundImage; realSend(intent) }
  await act(async () => { await Promise.all([beginBrowserMask({ persistent: true }), beginBrowserMask({ persistent: true })]) })
  assert.equal(captures, 1, 'two masks at once share one capture')
  assert.match(stillWhenHidden, /data:image\/png;base64,AAAA/, 'the still is painted before the page steps aside')
  assert.deepEqual(hidden, ['hide-all', 'hide-all'])

  await act(async () => { await endPersistentBrowserMask() })
  await act(async () => { await new Promise(r => setTimeout(r, 260)) })
  assert.match(host.style.backgroundImage, /AAAA/, 'one mask still hides the page: the still stays')
  await act(async () => { await endPersistentBrowserMask() })
  assert.match(host.style.backgroundImage, /AAAA/, 'kept a moment while the page comes back')
  await act(async () => { await new Promise(r => setTimeout(r, 260)) })
  assert.equal(host.style.backgroundImage, '', 'gone once the last mask has let go and the page is back')
})
