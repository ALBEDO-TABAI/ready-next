import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import DocumentVerticalTabRail, {
  type DocumentVerticalTabItem,
} from '../renderer/components/document/DocumentVerticalTabRail'
import {
  resolveVerticalRailFlyoutHeight,
  resolveVerticalRailFlyoutScrollOffset,
  VERTICAL_RAIL_FLYOUT_RADIUS,
  VERTICAL_RAIL_FLYOUT_ROW_HEIGHT,
  VERTICAL_RAIL_FLYOUT_ROW_RADIUS,
} from '../shared/vertical-rail-flyout-layout'

function installDom(): { dom: JSDOM; root: Root; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousNavigator = globalThis.navigator
  const previousHTMLElement = globalThis.HTMLElement
  const previousMouseEvent = globalThis.MouseEvent
  const globalWithAct = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousISReactActEnvironment = globalWithAct.IS_REACT_ACT_ENVIRONMENT

  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true })
  Object.defineProperty(globalThis, 'MouseEvent', { value: dom.window.MouseEvent, configurable: true })
  globalWithAct.IS_REACT_ACT_ENVIRONMENT = true

  const originalGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this instanceof dom.window.HTMLElement && this.classList.contains('document-vertical-tab-rail')) {
      return {
        x: 0,
        y: 100,
        left: 0,
        top: 100,
        right: 52,
        bottom: 700,
        width: 52,
        height: 600,
        toJSON: () => ({}),
      } as DOMRect
    }
    return originalGetBoundingClientRect.call(this)
  }

  const root = createRoot(dom.window.document.getElementById('root') as HTMLElement)
  return {
    dom,
    root,
    restore: () => {
      dom.window.HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
      Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
      Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
      Object.defineProperty(globalThis, 'navigator', { value: previousNavigator, configurable: true })
      Object.defineProperty(globalThis, 'HTMLElement', { value: previousHTMLElement, configurable: true })
      Object.defineProperty(globalThis, 'MouseEvent', { value: previousMouseEvent, configurable: true })
      globalWithAct.IS_REACT_ACT_ENVIRONMENT = previousISReactActEnvironment
      dom.window.close()
    },
  }
}

function makeTabs(count: number): DocumentVerticalTabItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `tab-${index + 1}`,
    label: `Document ${index + 1}`,
    pathLabel: `/tmp/doc-${index + 1}.md`,
    active: index === 0,
    dirty: index === 1,
  }))
}

test('document vertical rail flyout shrinks to its tab rows instead of the full rail height', async () => {
  const handle = installDom()
  try {
    const tabs = makeTabs(6)
    await act(async () => {
      handle.root.render(createElement(DocumentVerticalTabRail, {
        tabs,
        onTabClick: () => undefined,
        onTabClose: () => undefined,
        onNewTab: () => undefined,
      }))
    })

    const rail = handle.dom.window.document.querySelector('.document-vertical-tab-rail') as HTMLElement | null
    assert.ok(rail)
    await act(async () => {
      rail.dispatchEvent(new handle.dom.window.MouseEvent('mouseover', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 160))
    })

    const flyout = handle.dom.window.document.querySelector('.document-vertical-tab-flyout') as HTMLElement | null
    assert.ok(flyout)
    assert.equal(flyout.style.left, '52px')
    assert.equal(flyout.style.top, '100px')
    assert.equal(flyout.style.height, `${resolveVerticalRailFlyoutHeight(tabs.length, 600)}px`)
    assert.notEqual(flyout.style.height, '600px')
    assert.equal(flyout.style.borderRadius, `${VERTICAL_RAIL_FLYOUT_RADIUS}px`)

    const firstRow = flyout.firstElementChild?.firstElementChild as HTMLElement | null
    assert.ok(firstRow)
    assert.equal(firstRow.style.height, `${VERTICAL_RAIL_FLYOUT_ROW_HEIGHT}px`)
    assert.equal(firstRow.style.borderRadius, `${VERTICAL_RAIL_FLYOUT_ROW_RADIUS}px`)
    assert.doesNotMatch(flyout.textContent ?? '', /●/)
  } finally {
    await act(async () => { handle.root.unmount() })
    handle.restore()
  }
})

test('document vertical rail flyout follows the icon rail scroll instead of showing its own scrollbar', async () => {
  const handle = installDom()
  try {
    const tabs = makeTabs(30)
    await act(async () => {
      handle.root.render(createElement(DocumentVerticalTabRail, {
        tabs,
        onTabClick: () => undefined,
        onTabClose: () => undefined,
        onNewTab: () => undefined,
      }))
    })

    const rail = handle.dom.window.document.querySelector('.document-vertical-tab-rail') as HTMLElement | null
    assert.ok(rail)
    const railList = rail.firstElementChild as HTMLElement | null
    assert.ok(railList)
    await act(async () => {
      railList.scrollTop = 120
      railList.dispatchEvent(new handle.dom.window.Event('scroll', { bubbles: true }))
      rail.dispatchEvent(new handle.dom.window.MouseEvent('mouseover', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 160))
    })

    const flyout = handle.dom.window.document.querySelector('.document-vertical-tab-flyout') as HTMLElement | null
    assert.ok(flyout)
    const flyoutList = flyout.firstElementChild as HTMLElement | null
    assert.ok(flyoutList)
    assert.equal(flyoutList.style.overflowY, '')
    assert.equal(
      flyoutList.style.transform,
      `translateY(-${resolveVerticalRailFlyoutScrollOffset(120, tabs.length, 600)}px)`,
    )
  } finally {
    await act(async () => { handle.root.unmount() })
    handle.restore()
  }
})
