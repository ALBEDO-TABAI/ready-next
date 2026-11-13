import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import TopBar from '../../renderer/components/layout/TopBar'
import StatusBar from '../../renderer/components/layout/StatusBar'
import { WORKBENCH_EDGE_RAIL_SIZE, WORKBENCH_TOPBAR_HEIGHT, WORKBENCH_STATUSBAR_HEIGHT, WORKBENCH_TOPBAR_PADDING_RIGHT } from '../../renderer/modules/workbench/chrome'

test('top and bottom bands share the 52px rail geometry; the wordmark alone sits left, today stays at the right and the bottom stays quiet', () => {
  assert.equal(WORKBENCH_EDGE_RAIL_SIZE, 52)
  assert.equal(WORKBENCH_TOPBAR_HEIGHT, 52)
  assert.equal(WORKBENCH_STATUSBAR_HEIGHT, 52)
  const dom = new JSDOM(renderToStaticMarkup(createElement('main', null, createElement(TopBar), createElement(StatusBar))))
  try {
    const top = dom.window.document.querySelector<HTMLElement>('[data-shell-band="top"]')!
    const bottom = dom.window.document.querySelector<HTMLElement>('[data-shell-band="bottom"]')!
    assert.equal(top.style.height, '52px')
    assert.equal(bottom.style.height, '52px')
    assert.equal(top.style.paddingRight, `${WORKBENCH_TOPBAR_PADDING_RIGHT}px`)
    assert.ok(top.classList.contains('justify-between'))
    assert.ok(top.classList.contains('drag-region'))
    assert.equal(top.style.background, 'transparent')
    assert.equal(bottom.style.background, 'transparent')
    assert.equal(bottom.style.borderTop, '')
    assert.equal(bottom.textContent, '')
    assert.equal(bottom.querySelector('button'), null)
    // V23: no sidebar switch beside the wordmark (the rail's current icon and ⌘B open and close the sidebar); V12: the
    // wordmark is the first thing after the traffic lights, a label that drags the window.
    const lead = top.firstElementChild!
    assert.equal(lead.querySelector('button'), null)
    assert.equal(lead.querySelector('[data-shell-sidebar-control]'), null)
    assert.equal(lead.firstElementChild?.className, 'shell-wordmark')
    assert.equal(lead.querySelector('.shell-wordmark')?.textContent, 'Ready')
    assert.equal(top.querySelectorAll('button').length, 1)
    const dot = top.querySelector<HTMLElement>('button[aria-label="今日"] [role="img"][aria-label="Ready"]')
    assert.ok(dot)
    assert.equal(dot.style.background, 'var(--rn-accent)')
  } finally { dom.window.close() }
})
