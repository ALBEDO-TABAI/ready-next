import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { WorkbenchMode } from '../renderer/stores/useMode'
import { ShellNavigator, ShellSidebarSlotProvider } from '../renderer/modules/workbench/shell/ShellSidebar'
import { SHELL_RAIL_ORDER, useNavigatorMotion } from '../renderer/modules/workbench/shell/navigator-motion'
import { WORKBENCH_MODE_SCENE_TRANSITION_MS } from '../renderer/modules/workbench/mode-transition'

// V23: switching modes moves the sidebar's navigators vertically, in the rail's direction; the old navigator stays on
// screen (inert) until it has left and only then is hidden. Real React, the real slot and navigators, real timers.

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('navigators change vertically in the rail\'s direction and the old one is hidden only after it has left', async t => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true })
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })

  function Harness({ mode, animate }: { mode: WorkbenchMode; animate: boolean }) {
    const [element, setElement] = useState<HTMLElement | null>(null)
    const motion = useNavigatorMotion(mode, animate)
    return (
      <ShellSidebarSlotProvider value={{ element, mode, motion }}>
        <div ref={setElement} data-slot="" />
        {SHELL_RAIL_ORDER.map(item => <ShellNavigator key={item} mode={item} label={item}><button type="button">{item}</button></ShellNavigator>)}
      </ShellSidebarSlotProvider>
    )
  }
  const render = (mode: WorkbenchMode, animate = true) => act(async () => root.render(<Harness mode={mode} animate={animate} />))
  const section = (mode: WorkbenchMode) => dom.window.document.querySelector<HTMLElement>(`[data-shell-navigator="${mode}"]`)!
  const shown = () => SHELL_RAIL_ORDER.filter(mode => !section(mode).hidden)

  await render('document')
  await render('document')
  assert.deepEqual(shown(), ['document'])
  assert.equal(dom.window.document.querySelector('[data-nav-motion]'), null, 'nothing moves before a change')

  // Down the rail (document → calendar): the new navigator rises from below, the old one leaves upward.
  await render('calendar')
  assert.equal(section('calendar').dataset.navMotion, 'enter')
  assert.equal(section('calendar').dataset.navDirection, 'down')
  assert.equal(section('document').dataset.navMotion, 'leave')
  assert.equal(section('document').dataset.navDirection, 'down')
  assert.equal(section('document').hidden, false, 'the old navigator stays on screen while it leaves')
  assert.equal(section('document').hasAttribute('inert'), true, 'and takes no focus or pointer meanwhile')
  assert.equal(section('calendar').hasAttribute('inert'), false)
  assert.deepEqual(shown(), ['document', 'calendar'])
  await act(async () => { await wait(WORKBENCH_MODE_SCENE_TRANSITION_MS + 80) })
  assert.deepEqual(shown(), ['calendar'], 'after the exit only the new navigator is shown')
  assert.equal(dom.window.document.querySelector('[data-nav-motion]'), null, 'and nothing is left mid-transition')
  assert.equal(section('document').hasAttribute('inert'), false)

  // Up the rail (calendar → browser): the reverse.
  await render('browser')
  assert.equal(section('browser').dataset.navDirection, 'up')
  assert.equal(section('calendar').dataset.navMotion, 'leave')
  assert.equal(section('calendar').dataset.navDirection, 'up')
  await act(async () => { await wait(WORKBENCH_MODE_SCENE_TRANSITION_MS + 80) })
  assert.deepEqual(shown(), ['browser'])

  // An immediate change (or a collapsed sidebar) swaps at once.
  await render('rss', false)
  assert.deepEqual(shown(), ['rss'])
  assert.equal(dom.window.document.querySelector('[data-nav-motion]'), null)

  // The navigators stay mounted throughout, so their state survives the switch.
  assert.equal(dom.window.document.querySelectorAll('[data-shell-navigator]').length, 4)
})
