import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { act, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'

export async function mountDatabase(t: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  const { createRoot } = await import('react-dom/client')
  const host = dom.window.document.getElementById('root')!, root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } dom.window.close() })
  const ui = { dom, host, render: async (node: ReactNode) => { await act(async () => root.render(node)); await settle(ui) } }
  return ui
}
export type DatabaseUI = Awaited<ReturnType<typeof mountDatabase>>
export async function click(ui: DatabaseUI, selector: string) {
  const node = ui.host.querySelector<HTMLElement>(selector); assert.ok(node, selector)
  await act(async () => node.click()); await settle(ui)
}
export async function input(ui: DatabaseUI, selector: string, value: string) {
  const node = ui.host.querySelector<HTMLInputElement | HTMLSelectElement>(selector); assert.ok(node, selector)
  await act(async () => {
    const prototype = node.tagName === 'SELECT' ? ui.dom.window.HTMLSelectElement.prototype : ui.dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new ui.dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}
export async function drop(ui: DatabaseUI, source: string, target: string) {
  const data = new Map<string, string>()
  const dataTransfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) ?? '' }
  for (const [selector, event] of [[source, 'dragstart'], [target, 'drop']]) {
    const node = ui.host.querySelector(selector); assert.ok(node, selector)
    await act(async () => { const e = new ui.dom.window.Event(event, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'dataTransfer', { value: dataTransfer }); node.dispatchEvent(e) }); await settle(ui)
  }
}

export async function settle(ui: Pick<DatabaseUI, 'host'>) {
  const deadline = performance.now() + 5000
  while (ui.host.querySelector('[aria-busy="true"]') || [...ui.host.querySelectorAll('[role="status"]')].some(node => node.textContent?.startsWith('正在'))) {
    assert.ok(performance.now() < deadline, `Database did not settle: ${ui.host.textContent}`)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  }
}
