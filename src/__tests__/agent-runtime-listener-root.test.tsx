import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { createElement, useEffect } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

type RuntimeEventKind = 'stream' | 'tool' | 'terminal'

test('root agent listener survives the workbench route subtree unmount', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/workbench',
  })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    navigator: globalThis.navigator,
    localStorage: globalThis.localStorage,
    actEnvironment: (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  }

  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'Node', { value: dom.window.Node, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'Event', { value: dom.window.Event, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true })

  try {
    const { AgentRuntimeListenerOwnerTestHarness } = await import(
      '../renderer/modules/agent/AgentRuntimeListenerRoot'
    )
    const listeners: Record<RuntimeEventKind, Set<() => void>> = {
      stream: new Set(),
      tool: new Set(),
      terminal: new Set(),
    }
    const consumed: RuntimeEventKind[] = []
    let installCount = 0
    let cleanupCount = 0
    let panelUnmountCount = 0

    const install = () => {
      installCount += 1
      const callbacks = {
        stream: () => consumed.push('stream'),
        tool: () => consumed.push('tool'),
        terminal: () => consumed.push('terminal'),
      }
      for (const kind of Object.keys(callbacks) as RuntimeEventKind[]) {
        listeners[kind].add(callbacks[kind])
      }
      return () => {
        cleanupCount += 1
        for (const kind of Object.keys(callbacks) as RuntimeEventKind[]) {
          listeners[kind].delete(callbacks[kind])
        }
      }
    }

    function WorkbenchPanel() {
      useEffect(() => () => {
        panelUnmountCount += 1
      }, [])
      return createElement('div', null, 'workbench')
    }

    function TestApp({ route }: { route: 'workbench' | 'settings' }) {
      return createElement(
        'div',
        null,
        createElement(AgentRuntimeListenerOwnerTestHarness, { install }),
        route === 'workbench'
          ? createElement(WorkbenchPanel)
          : createElement('div', null, 'settings'),
      )
    }

    const container = dom.window.document.getElementById('root')
    assert.ok(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(createElement(TestApp, { route: 'workbench' }))
    })
    assert.equal(installCount, 1)
    assert.deepEqual(
      Object.fromEntries(Object.entries(listeners).map(([kind, handlers]) => [kind, handlers.size])),
      { stream: 1, tool: 1, terminal: 1 },
    )

    await act(async () => {
      root.render(createElement(TestApp, { route: 'settings' }))
    })
    assert.equal(panelUnmountCount, 1, 'route switch must actually unmount the workbench panel')
    assert.equal(cleanupCount, 0, 'route subtree cleanup must not own the root listener cleanup')

    for (const kind of ['stream', 'tool', 'terminal'] as const) {
      for (const listener of listeners[kind]) listener()
    }
    assert.deepEqual(consumed, ['stream', 'tool', 'terminal'])

    await act(async () => {
      root.unmount()
    })
    assert.equal(cleanupCount, 1)
    assert.deepEqual(
      Object.fromEntries(Object.entries(listeners).map(([kind, handlers]) => [kind, handlers.size])),
      { stream: 0, tool: 0, terminal: 0 },
    )
  } finally {
    const { actEnvironment, ...globals } = previous
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) {
        delete (globalThis as Record<string, unknown>)[key]
      } else {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      }
    }
    if (actEnvironment === undefined) {
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    } else {
      Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
        value: actEnvironment,
        configurable: true,
        writable: true,
      })
    }
    dom.window.close()
  }
})
