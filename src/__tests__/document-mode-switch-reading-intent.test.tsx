import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
const previousGlobals = new Map<string, unknown>()
for (const key of [
  'window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'navigator',
  'requestAnimationFrame', 'cancelAnimationFrame',
]) {
  previousGlobals.set(key, (globalThis as Record<string, unknown>)[key])
  const value = key === 'requestAnimationFrame' || key === 'cancelAnimationFrame'
    ? (dom.window as unknown as Record<string, (...args: unknown[]) => unknown>)[key].bind(dom.window)
    : (dom.window as unknown as Record<string, unknown>)[key]
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
}

process.on('exit', () => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
    else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  dom.window.close()
})

const { default: DraggableModeSwitch } = await import('../renderer/components/document/DraggableModeSwitch')

test('阅读覆盖层可消费已激活模式的再次点击，退出阅读但不误触预览内编辑', () => {
  const host = dom.window.document.getElementById('root')
  assert.ok(host)
  const root = createRoot(host)
  const intents: string[] = []
  const changes: string[] = []
  let toggles = 0

  flushSync(() => {
    root.render(createElement(DraggableModeSwitch, {
      mode: 'preview',
      onChange: (mode) => changes.push(mode),
      onModeIntent: (mode) => {
        intents.push(mode)
        return true
      },
      onTogglePreviewEdit: () => { toggles += 1 },
    }))
  })

  const preview = host.querySelector('.draggable-mode-switch__label--preview') as HTMLButtonElement
  const edit = host.querySelector('.draggable-mode-switch__label--edit') as HTMLButtonElement
  preview.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  assert.deepEqual(intents, ['preview'])
  assert.equal(toggles, 0)
  assert.deepEqual(changes, [])

  edit.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  assert.deepEqual(intents, ['preview', 'edit'])
  assert.deepEqual(changes, ['edit'], '选择另一模式仍要完成真实模式切换')

  flushSync(() => root.unmount())
})
