import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { useShellPresentation } from '../renderer/modules/workbench/shell/useShellPresentation'

for (const [width, initialOpen] of [[700, true], [980, true], [1440, true], [700, false]] as const) {
  test(`shell toggles at ${width}px (remembered open: ${initialOpen}) preserve floating state separately from remembered docked state`, async t => {
    const dom = new JSDOM('<div id="root"></div>')
    Object.defineProperty(dom.window, 'innerWidth', { value: width, writable: true })
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
    let assistantToggles = 0, sidebarToggles = 0
    function Harness() {
      const [assistant, setAssistant] = React.useState<boolean>(initialOpen)
      const [sidebar, setSidebar] = React.useState<boolean>(initialOpen)
      const shell = useShellPresentation({ sidebarVisible: sidebar, chatPanelVisible: assistant,
        sidebarWidth: 248, chatPanelWidth: 380,
        toggleDockedAssistant: () => { assistantToggles += 1; setAssistant(value => !value) },
        toggleDockedSidebar: () => { sidebarToggles += 1; setSidebar(value => !value) },
      })
      return <><button onClick={shell.toggleAssistant}>assistant</button><button onClick={shell.toggleSidebar}>sidebar</button>
        <output>{JSON.stringify({ assistant, sidebar, drawer: shell.assistantDrawerOpen, peek: shell.sidebarPeek,
          visible: shell.assistantVisible, assistantDock: shell.layout.assistant, sidebarDock: shell.layout.sidebar,
          assistantWidth: shell.assistantPanelWidth })}</output></>
    }
    await act(async () => root.render(<Harness />))
    const state = () => JSON.parse(dom.window.document.querySelector('output')!.textContent!)
    const click = (index: number) => act(async () => dom.window.document.querySelectorAll('button')[index].click())
    if (!initialOpen) {
      await click(0); await click(1)
      assert.deepEqual({ assistantToggles, sidebarToggles }, { assistantToggles: 0, sidebarToggles: 0 }, 'narrow floating panels must not change remembered docking')
      assert.equal(state().assistant, false)
      assert.equal(state().sidebar, false)
      assert.equal(state().drawer, true)
      assert.equal(state().peek, true)
      await act(async () => { dom.window.innerWidth = 1440; dom.window.dispatchEvent(new dom.window.Event('resize')) })
      assert.equal(state().assistantDock, 'hidden')
      assert.equal(state().sidebarDock, 'hidden')
      return
    }
    assert.equal(state().assistantDock, width < 1240 ? 'floating' : 'docked')
    assert.equal(state().sidebarDock, width < 860 ? 'floating' : 'docked')
    await click(0)
    assert.equal(assistantToggles, width < 1240 ? 0 : 1)
    assert.equal(state().assistant, width < 1240)
    assert.equal(state().drawer, width < 1240)
    assert.equal(state().visible, width < 1240)
    if (width === 1440) assert.equal(state().assistantWidth, 0)
    await click(0)
    assert.equal(state().assistant, true)
    assert.equal(state().drawer, false)
    await click(1)
    assert.equal(sidebarToggles, width < 860 ? 0 : 1)
    assert.equal(state().sidebar, width < 860)
    assert.equal(state().peek, width < 860)
    await click(1)
    assert.equal(state().sidebar, true)
    assert.equal(state().peek, false)
    await act(async () => { dom.window.innerWidth = 1440; dom.window.dispatchEvent(new dom.window.Event('resize')) })
    assert.equal(state().assistantDock, 'docked')
    assert.equal(state().sidebarDock, 'docked')
    assert.equal(state().visible, true)
    await click(0); await click(1)
    assert.equal(assistantToggles, width < 1240 ? 1 : 3)
    assert.equal(sidebarToggles, width < 860 ? 1 : 3)
  })
}
