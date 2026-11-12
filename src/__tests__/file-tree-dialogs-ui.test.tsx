import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'

// B13: the file tree's delete / remove-from-list confirmation and its 自定图标 prompt are the shared dialog (W1 §5)
// in the app's one float layer, replacing the old ui/Modal.
test('file tree removal confirm and icon prompt resolve through the shared dialog', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} },
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { createRoot } = await import('react-dom/client')
  const ui = await import('../renderer/components/ui')
  const { confirmFileTreeRemoval, promptFileIcon } = await import('../renderer/components/layout/file-tree/dialogs')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => { ui.closeAllFloats(); root.unmount() })
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  await act(async () => root.render(<ui.FloatHost />))
  const doc = dom.window.document
  const dialog = () => doc.querySelector<HTMLElement>('[role="dialog"]')
  const button = (label: string) => [...doc.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((node) => node.textContent === label)

  // Bulk delete: the count is in the title and body; 删除 confirms.
  let answer: Promise<boolean> | undefined
  await act(async () => { answer = confirmFileTreeRemoval({ kind: 'fs', targets: [{ path: '/w/a.md', name: 'a.md' }, { path: '/w/b.md', name: 'b.md' }] }) })
  assert.equal(dialog()?.getAttribute('aria-label'), '删除 2 项')
  assert.match(dialog()!.textContent!, /确定删除选中的 2 项吗？此操作不可恢复。/)
  assert.equal(button('删除')?.getAttribute('data-variant'), 'danger')
  await act(async () => { button('删除')!.click() })
  assert.equal(await answer, true)
  assert.equal(dialog(), null)

  // Removing a folder from the list: 取消 answers false and closes.
  await act(async () => { answer = confirmFileTreeRemoval({ kind: 'unpin', path: '/w', name: 'w' }) })
  assert.equal(dialog()?.getAttribute('aria-label'), '从列表中移除')
  assert.match(dialog()!.textContent!, /不会删除磁盘上的实际文件夹/)
  await act(async () => { button('取消')!.click() })
  assert.equal(await answer, false)
  assert.equal(dialog(), null)

  // 自定图标: the field starts with the current icon and takes focus; Enter applies what was typed.
  let typed: Promise<string | null> | undefined
  await act(async () => { typed = promptFileIcon('📁') })
  const input = doc.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="自定图标"]')!
  assert.equal(input.value, '📁')
  assert.equal(doc.activeElement, input)
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    setValue.call(input, '🎬')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  assert.equal(await typed, '🎬')
  assert.equal(dialog(), null)

  // Esc cancels the prompt.
  await act(async () => { typed = promptFileIcon('') })
  await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(await typed, null)
  assert.equal(dialog(), null)
})
