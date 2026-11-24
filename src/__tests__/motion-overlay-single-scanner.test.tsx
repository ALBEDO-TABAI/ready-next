import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { useNativeSurfaceAwareOverlay } from '../renderer/modules/overlay/useNativeSurfaceAwareOverlay'

// Two outlets (a split view) each mount the overlay hook; one scan runs, so a float masks the web page once, and it keeps
// running while any outlet is left (no hand-over that would drop and re-take the mask under an open menu).
test('one overlay scan runs however many outlets mount it, and keeps running while any is left', async t => {
  const dom = new JSDOM('<div id="root"></div><div data-ready-native-surface="browser"></div>', { pretendToBeVisual: true })
  const hides: string[] = []
  const ackListeners = new Set<(ack: unknown) => void>()
  ;(dom.window as unknown as { electronAPI: unknown }).electronAPI = {
    // The main process acknowledges each hide, as it does in the app.
    browser: {
      sendIntent: (intent: { kind: string; intentId: number }) => { hides.push(intent.kind); setTimeout(() => ackListeners.forEach(listener => listener({ intentId: intent.intentId, kind: intent.kind, ok: true })), 5) },
      onIntentAck: (listener: (ack: unknown) => void) => { ackListeners.add(listener); return () => ackListeners.delete(listener) },
    },
  }
  const globals = { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200, x: 0, y: 0, toJSON() {} })
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  function Outlet() { useNativeSurfaceAwareOverlay(); return null }
  const frames = () => new Promise(r => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(r)))
  await act(async () => root.render([<Outlet key="first" />, <Outlet key="second" />]))
  const float = dom.window.document.createElement('div')
  float.setAttribute('data-ready-native-overlay', 'float')
  await act(async () => { dom.window.document.body.appendChild(float); await frames(); await frames() })
  assert.deepEqual(hides, ['hide-all'], 'one scanner masks the page once')

  // Both outlets remount in one commit (a split view closing) while a float is up: the mask is kept, never dropped and
  // taken again.
  await act(async () => root.render([<Outlet key="third" />, <Outlet key="fourth" />]))
  await act(async () => { await frames() })
  assert.deepEqual(hides, ['hide-all'], 'the mask under the open float is not released and re-taken')

  // The first outlet goes (split view closed): the scan goes on for the remaining one.
  float.remove()
  await act(async () => root.render([<Outlet key="fourth" />]))
  await act(async () => { await frames() })
  hides.length = 0
  await act(async () => { dom.window.document.body.appendChild(float); await frames(); await frames(); await new Promise(r => setTimeout(r, 300)); await frames() })
  assert.deepEqual(hides, ['hide-all'], 'still scanning with one outlet left')
})
