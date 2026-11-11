import assert from 'node:assert/strict'
import { importWithoutStyles } from './import-without-styles'
import type { TestContext } from 'node:test'
import { act, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'

export const { ui, DesignSystem } = await importWithoutStyles(async () => ({
  ui: await import('../../renderer/components/ui'),
  DesignSystem: (await import('../../renderer/pages/DesignSystem')).default,
}))

export async function mountPrimitives(t: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = {
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    // jsdom has no layout observer or CSS.escape. Hex escapes preserve selector identity.
    ResizeObserver: class { observe() {} disconnect() {} },
    CSS: { escape: (value: string) => Array.from(value, char => `\\${char.codePointAt(0)!.toString(16)} `).join('') },
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => { ui.closeAllFloats(); root.unmount() })
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const body = dom.window.document.body
  function get<E extends HTMLElement = HTMLElement>(selector: string, within: ParentNode = body): E {
    const element = within.querySelector<E>(selector)
    assert.ok(element, `Missing element: ${selector}`)
    return element
  }
  const render = async (node: ReactNode) => { await act(async () => root.render(node)) }
  const click = async (element: HTMLElement) => { await act(async () => element.click()) }
  const pointer = async (element: HTMLElement) => { await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })) }) }
  const key = async (element: HTMLElement, value: string) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
    })
  }
  // jsdom does not perform a button's native Space/Enter activation. Simulate only that
  // browser default, after the real key handlers; never call a component callback directly.
  const activateButton = async (button: HTMLButtonElement, value: ' ' | 'Enter') => {
    assert.equal(button.tagName, 'BUTTON')
    await act(async () => {
      button.focus()
      const down = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
      button.dispatchEvent(down)
      if (value === 'Enter' && !down.defaultPrevented) button.click()
      const up = new dom.window.KeyboardEvent('keyup', { key: value, bubbles: true, cancelable: true })
      button.dispatchEvent(up)
      if (value === ' ' && !down.defaultPrevented && !up.defaultPrevented) button.click()
    })
  }
  return { dom, body, get, render, click, pointer, key, activateButton }
}
