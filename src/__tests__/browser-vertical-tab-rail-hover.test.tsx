import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import VerticalTabRail from '../renderer/components/browser/VerticalTabRail'

test('browser tab overlay stays open while the real pointer is inside either native window', async () => {
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
  let pointerInside = true
  let showCount = 0
  let hideCount = 0

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
        showVerticalRailOverlay: async () => { showCount += 1; return { success: true } },
        hideVerticalRailOverlay: async () => { hideCount += 1; return { success: true } },
        isVerticalRailOverlayPointerInside: async () => ({ success: true, data: pointerInside }),
        onVerticalRailOverlayCommand: () => () => undefined,
      },
    },
  })
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains('vertical-tab-rail')) {
      return { x: 0, y: 0, left: 0, top: 0, right: 52, bottom: 600, width: 52, height: 600, toJSON: () => ({}) } as DOMRect
    }
    return originalRect.call(this)
  }

  const root = createRoot(dom.window.document.getElementById('root') as HTMLElement)
  try {
    await act(async () => {
      root.render(createElement(VerticalTabRail, {
        isActive: true,
        tabs: [{ id: 'tab-1', title: 'Example', url: 'https://example.com', domain: 'example.com' }],
        tabGroups: [],
        activeTabId: 'tab-1',
        splitTabId: null,
        bookmarkedUrls: [],
        onTabClick: () => undefined,
        onTabClose: () => undefined,
        onNewTab: () => undefined,
        onReorderToRank: () => undefined,
        onCreateGroup: () => undefined,
        onAddToGroup: () => undefined,
        onRemoveFromGroup: () => undefined,
        onRenameGroup: () => undefined,
        onRecolorGroup: () => undefined,
        onSetGroupCollapsed: () => undefined,
        onDisbandGroup: () => undefined,
        onDeleteGroup: () => undefined,
        onNewTabInGroup: () => undefined,
        onToggleBookmarkForTab: () => undefined,
      }))
    })
    const railElement = dom.window.document.querySelector('.vertical-tab-rail') as HTMLElement
    await act(async () => {
      railElement.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 160))
    })
    assert.equal(showCount, 1)

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)) })
    assert.equal(hideCount, 0, 'cross-window event loss must not close over a pointer that is physically inside')

    pointerInside = false
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)) })
    assert.equal(hideCount, 1, 'the overlay closes after the pointer leaves both physical windows even when mouseleave is missed')
  } finally {
    await act(async () => { root.unmount() })
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect
    Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true })
    Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true })
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true })
    Object.defineProperty(globalThis, 'HTMLElement', { value: previous.HTMLElement, configurable: true })
    Object.defineProperty(globalThis, 'MouseEvent', { value: previous.MouseEvent, configurable: true })
    globalWithAct.IS_REACT_ACT_ENVIRONMENT = previousAct
    dom.window.close()
  }
})
