import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import type { LibraryArchiveAPI, LibraryArchiveProgress, LibraryArchiveReport, LibraryResult } from '../shared/library'
import type { BookSourcesAPI } from '../shared/library-sources'

test('L5 the 藏书阁 import is a Settings › 阅读 row: the chooser shows the suggestion without importing, a dismissed import carries on and reports, progress and failures render, and it unsubscribes', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  // jsdom has no layout observer; the float host only uses it to re-place a float that changes size.
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } }
  const previous = Object.fromEntries(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { createRoot } = await import('react-dom/client')
  const { ReadingSettingsPanel } = await import('../renderer/pages/settings/ReadingSettingsPanel')
  const { FloatHost } = await import('../renderer/components/ui')
  const root = createRoot(dom.window.document.getElementById('root')!)
  let calls = 0, unsubscribed = false, listener: ((p: LibraryArchiveProgress) => void) | undefined
  let resolve: ((r: LibraryResult<LibraryArchiveReport | null>) => void) | undefined
  const api: LibraryArchiveAPI = {
    archiveSuggestion: async () => ({ success: true, data: '/suggestion/library' }),
    pickAndImportArchive: () => { calls++; return new Promise(r => { resolve = r }) },
    onArchiveProgress: fn => { listener = fn; return () => { unsubscribed = true } },
  }
  // The section's other card (书源) reads its own settings; only what it asks for is answered.
  const sources = {
    settings: async () => ({ success: true, data: { settings: { executable: '', format: 'epub', treasure: false, ctfile: false }, extraSources: false } }),
    status: async () => ({ success: true, data: { state: 'available' } }),
  } as unknown as BookSourcesAPI
  const d = dom.window.document
  const button = (text: string) => [...d.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)
  const click = async (text: string) => { const target = button(text); assert.ok(target, text); await act(async () => target.click()) }
  const dialog = () => d.querySelector<HTMLElement>('[role="dialog"][aria-label="从藏书阁导入"]')
  const escape = async () => act(async () => { dialog()!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  const outside = async () => act(async () => { d.querySelector('.rn-dialog-backdrop')!.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })) })
  const report: LibraryArchiveReport = { success: [{ id: '1', title: '夹具书', bookId: 'b' }], skipped: [], failed: [{ id: '2', title: '缺文件', reason: '书文件缺失' }], unlocated: 1 }
  try {
    await act(async () => root.render(<><ReadingSettingsPanel sources={sources} archive={api} /><FloatHost /></>))
    // One settings row with a short description and a secondary W1 button; nothing on the page imports by itself.
    const row = [...d.querySelectorAll('.sx-row')].find(r => r.querySelector('.sx-row__label')?.textContent === '从藏书阁导入')
    assert.ok(row, 'the 阅读 section has a 从藏书阁导入 row')
    assert.match(row.querySelector('.sx-row__desc')!.textContent!, /原目录保持不变/)
    const trigger = row.querySelector<HTMLButtonElement>('button')!
    assert.deepEqual([trigger.textContent, trigger.classList.contains('rn-btn'), trigger.dataset.variant], ['导入…', true, 'secondary'])
    assert.ok(d.body.textContent!.includes('书源'), 'the book source card stays in the section')

    await click('导入…')
    assert.ok(dialog()); assert.equal(dialog()!.closest('#root'), null, 'the dialog is the shared float, not part of the row')
    assert.ok(dialog()!.classList.contains('rn-dialog') && dialog()!.classList.contains('rn-float') && dialog()!.getAttribute('aria-modal') === 'true', 'W1 dialog')
    assert.match(dialog()!.textContent!, /不会自动读取.*\/suggestion\/library/)
    assert.equal(calls, 0)
    assert.equal(d.activeElement, button('选择目录并导入'))
    await click('选择目录并导入')
    await act(async () => listener!({ completed: 1, total: 2, title: '夹具书' }))
    assert.match(dialog()!.querySelector('[role="status"]')!.textContent!, /1 \/ 2：夹具书/)
    const bar = dialog()!.querySelector('[role="progressbar"]')!
    assert.deepEqual([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')], ['1', '2'])
    // Esc closes it like any W1 dialog; the import carries on, the button says so, and the report opens when it ends.
    await escape()
    assert.equal(dialog(), null)
    assert.deepEqual([trigger.textContent, trigger.disabled], ['正在导入…', true])
    await act(async () => resolve!({ success: true, data: report }))
    assert.match(dialog()!.querySelector('[role="status"]')!.textContent!, /成功 1 本.*失败 1 本.*未定位划线 1 条/)
    const details = dialog()!.querySelector('details')!
    assert.equal(details.open, false); assert.match(details.textContent!, /缺文件：书文件缺失/)
    assert.deepEqual([trigger.textContent, trigger.disabled], ['导入…', false])
    assert.equal(d.activeElement, button('关闭'))
    await click('关闭')
    assert.equal(dialog(), null); assert.equal(d.activeElement, trigger)
    // A failed import keeps the chooser and shows the reason.
    await click('导入…'); await click('选择目录并导入')
    await act(async () => resolve!({ success: false, error: 'library.json 结构不正确' }))
    assert.match(dialog()!.querySelector('[role="alert"]')!.textContent!, /结构不正确/)
    assert.ok(button('选择目录并导入'))
    await click('取消'); assert.equal(dialog(), null)
    // Dismissed while the folder chooser is up, then cancelled there: nothing comes back.
    await click('导入…'); await click('选择目录并导入'); await outside()
    assert.equal(dialog(), null)
    await act(async () => resolve!({ success: true, data: null }))
    assert.equal(dialog(), null); assert.deepEqual([trigger.textContent, trigger.disabled], ['导入…', false])
    assert.equal(calls, 3)
    // Without the archive API, the section has no such row.
    await act(async () => root.render(<><ReadingSettingsPanel sources={sources} /><FloatHost /></>))
    assert.equal([...d.querySelectorAll('.sx-row__label')].some(label => label.textContent === '从藏书阁导入'), false)
  } finally {
    await act(async () => root.unmount()); assert.equal(unsubscribed, true)
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
})
