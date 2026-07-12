import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import VerticalRailOverlayWindow from '../renderer/pages/VerticalRailOverlayWindow'
import type { VerticalRailOverlayCommand, VerticalRailOverlaySnapshot } from '../shared/browser-vertical-rail-overlay'

test('overlay mouse movement confirms presence when cross-window mouseenter is missed', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
  }
  const globalWithAct = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousAct = globalWithAct.IS_REACT_ACT_ENVIRONMENT
  const commands: VerticalRailOverlayCommand[] = []
  const snapshot: VerticalRailOverlaySnapshot = {
    tabs: [],
    groups: [],
    bounds: { left: 0, top: 0, width: 52, height: 120 },
    scrollTop: 0,
  }

  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true })
  Object.defineProperty(globalThis, 'MouseEvent', { value: dom.window.MouseEvent, configurable: true })
  globalWithAct.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(dom.window, 'electronAPI', {
    configurable: true,
    value: {
      browser: {
        onVerticalRailOverlaySnapshot: () => () => undefined,
        getVerticalRailOverlaySnapshot: async () => ({ success: true, data: snapshot }),
        sendVerticalRailOverlayCommand: async (command: VerticalRailOverlayCommand) => {
          commands.push(command)
          return { success: true }
        },
      },
    },
  })

  const root = createRoot(dom.window.document.getElementById('root') as HTMLElement)
  try {
    await act(async () => { root.render(createElement(VerticalRailOverlayWindow)); await Promise.resolve() })
    const overlay = dom.window.document.querySelector('.vertical-rail-overlay-root') as HTMLElement
    assert.ok(overlay)

    await act(async () => {
      overlay.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true }))
      overlay.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true }))
    })
    assert.deepEqual(commands, [{ type: 'hover-enter' }])

    await act(async () => {
      overlay.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
    })
    assert.deepEqual(commands, [{ type: 'hover-enter' }, { type: 'hover-leave' }])
  } finally {
    await act(async () => { root.unmount() })
    Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true })
    Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true })
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true })
    Object.defineProperty(globalThis, 'HTMLElement', { value: previous.HTMLElement, configurable: true })
    Object.defineProperty(globalThis, 'MouseEvent', { value: previous.MouseEvent, configurable: true })
    globalWithAct.IS_REACT_ACT_ENVIRONMENT = previousAct
    dom.window.close()
  }
})
