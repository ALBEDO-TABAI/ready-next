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

test('document vertical rail flyout caps at the available height and scrolls itself (no rail-scroll transform)', async () => {
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
    await act(async () => {
      rail.dispatchEvent(new handle.dom.window.MouseEvent('mouseover', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 160))
    })

    const flyout = handle.dom.window.document.querySelector('.document-vertical-tab-flyout') as HTMLElement | null
    assert.ok(flyout)
    // 30 rows overflow the 600px rail → the flyout caps at the available height, and
    // its inner list owns the scroll (overflow-y-auto) rather than mirroring the rail
    // via a translateY transform (which broke once group headers changed row heights).
    assert.equal(flyout.style.height, '600px')
    const flyoutList = flyout.firstElementChild as HTMLElement | null
    assert.ok(flyoutList)
    assert.equal(flyoutList.style.transform, '')
    assert.match(flyoutList.className, /overflow-y-auto/)
  } finally {
    await act(async () => { handle.root.unmount() })
    handle.restore()
  }
})

async function openFlyout(handle: ReturnType<typeof installDom>): Promise<HTMLElement> {
  const rail = handle.dom.window.document.querySelector('.document-vertical-tab-rail') as HTMLElement
  await act(async () => {
    rail.dispatchEvent(new handle.dom.window.MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 160))
  })
  return handle.dom.window.document.querySelector('.document-vertical-tab-flyout') as HTMLElement
}

test('flyout renders a group header (name + count) with its member rows visible', async () => {
  const handle = installDom()
  try {
    const tabs: DocumentVerticalTabItem[] = [
      { id: 'tab-1', label: 'Alpha', active: true, groupId: 'g1' },
      { id: 'tab-2', label: 'Bravo', groupId: 'g1' },
      { id: 'tab-3', label: 'Charlie' },
    ]
    const groups = [{ id: 'g1', name: 'Research', color: 'green' as const, collapsed: false }]
    await act(async () => {
      handle.root.render(createElement(DocumentVerticalTabRail, {
        tabs, groups,
        onTabClick: () => undefined, onTabClose: () => undefined, onNewTab: () => undefined,
        onReorderToRank: () => undefined, onCreateGroup: () => undefined,
      }))
    })
    const flyout = await openFlyout(handle)
    assert.ok(flyout)
    const text = flyout.textContent ?? ''
    assert.match(text, /Research/, 'group name shown in the header')
    assert.match(text, /Alpha/, 'grouped member visible when expanded')
    assert.match(text, /Bravo/, 'grouped member visible when expanded')
    assert.match(text, /Charlie/, 'ungrouped tab visible')
  } finally {
    await act(async () => { handle.root.unmount() })
    handle.restore()
  }
})

test('a collapsed group hides its members in the flyout but keeps the header', async () => {
  const handle = installDom()
  try {
    const tabs: DocumentVerticalTabItem[] = [
      { id: 'tab-1', label: 'Alpha', groupId: 'g1' },
      { id: 'tab-2', label: 'Bravo', groupId: 'g1' },
      { id: 'tab-3', label: 'Charlie', active: true },
    ]
    const groups = [{ id: 'g1', name: 'Refs', color: 'blue' as const, collapsed: true }]
    await act(async () => {
      handle.root.render(createElement(DocumentVerticalTabRail, {
        tabs, groups,
        onTabClick: () => undefined, onTabClose: () => undefined, onNewTab: () => undefined,
        onReorderToRank: () => undefined, onCreateGroup: () => undefined,
      }))
    })
    const flyout = await openFlyout(handle)
    assert.ok(flyout)
    const text = flyout.textContent ?? ''
    assert.match(text, /Refs/, 'collapsed group header still shows')
    assert.match(text, /Charlie/, 'ungrouped tab still shows')
    assert.doesNotMatch(text, /Bravo/, 'collapsed member is hidden in the flyout')
  } finally {
    await act(async () => { handle.root.unmount() })
    handle.restore()
  }
})

test('group options open a PORTALED edit popup whose action buttons are reachable (not clipped)', async () => {
  const handle = installDom()
  try {
    const tabs: DocumentVerticalTabItem[] = [
      { id: 'tab-1', label: 'Alpha', active: true, groupId: 'g1' },
      { id: 'tab-2', label: 'Bravo', groupId: 'g1' },
    ]
    const groups = [{ id: 'g1', name: 'G', color: 'blue' as const, collapsed: false }]
    let disbanded = false
    await act(async () => {
      handle.root.render(createElement(DocumentVerticalTabRail, {
        tabs, groups,
        onTabClick: () => undefined, onTabClose: () => undefined, onNewTab: () => undefined,
        onReorderToRank: () => undefined, onCreateGroup: () => undefined,
        onDisbandGroup: () => { disbanded = true },
      }))
    })
    const flyout = await openFlyout(handle)
    const optionsBtn = Array.from(flyout.querySelectorAll('button')).find((b) => b.getAttribute('title') === '群组选项')
    assert.ok(optionsBtn, 'group options button present')
    await act(async () => { optionsBtn.dispatchEvent(new handle.dom.window.MouseEvent('click', { bubbles: true })) })

    const doc = handle.dom.window.document
    const disbandBtn = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === '取消群组')
    assert.ok(disbandBtn, 'disband action button rendered')
    assert.ok(!flyout.contains(disbandBtn), 'popup is PORTALED outside the overflow-hidden flyout (escapes the clip)')
    await act(async () => { disbandBtn.dispatchEvent(new handle.dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(disbanded, true, 'the (previously clipped) disband action actually fires')
  } finally {
    await act(async () => { handle.root.unmount() })
    handle.restore()
  }
})

test('switching between group edit popups shows the new group and never renames the wrong group', async () => {
  const handle = installDom()
  try {
    const tabs: DocumentVerticalTabItem[] = [
      { id: 'a', label: 'A', active: true, groupId: 'g1' },
      { id: 'b', label: 'B', groupId: 'g2' },
    ]
    const groups = [
      { id: 'g1', name: 'Alpha', color: 'blue' as const, collapsed: false },
      { id: 'g2', name: 'Beta', color: 'green' as const, collapsed: false },
    ]
    const renameCalls: Array<{ id: string; name: string }> = []
    await act(async () => {
      handle.root.render(createElement(DocumentVerticalTabRail, {
        tabs, groups,
        onTabClick: () => undefined, onTabClose: () => undefined, onNewTab: () => undefined,
        onReorderToRank: () => undefined, onCreateGroup: () => undefined,
        onRenameGroup: (id, name) => { renameCalls.push({ id, name }) },
        onDisbandGroup: () => undefined,
      }))
    })
    const flyout = await openFlyout(handle)
    const optionsBtns = Array.from(flyout.querySelectorAll('button')).filter((b) => b.getAttribute('title') === '群组选项')
    assert.equal(optionsBtns.length, 2, 'two group headers present')
    const doc = handle.dom.window.document
    // Open g1's popup, then switch to g2's WITHOUT closing.
    await act(async () => { optionsBtns[0].dispatchEvent(new handle.dom.window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { optionsBtns[1].dispatchEvent(new handle.dom.window.MouseEvent('click', { bubbles: true })) })
    const input = doc.querySelector('input') as HTMLInputElement | null
    assert.ok(input)
    assert.equal(input.value, 'Beta', 'popup remounts with the newly-selected group name (not the stale one)')
    // Close the popup (disband) — the unmount-commit must NOT rename g2 to a stale value.
    const disbandBtn = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === '取消群组')
    assert.ok(disbandBtn)
    await act(async () => { disbandBtn.dispatchEvent(new handle.dom.window.MouseEvent('click', { bubbles: true })) })
    assert.deepEqual(renameCalls, [], 'no spurious rename of the wrong group on close')
  } finally {
    await act(async () => { handle.root.unmount() })
    handle.restore()
  }
})
