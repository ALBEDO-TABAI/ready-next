import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import type { LibraryArchiveAPI, LibraryArchiveProgress, LibraryArchiveReport, LibraryResult } from '../shared/library'
import { ArchiveImport } from '../renderer/modules/library/ArchiveImport'

test('L5 chooser shows suggestion without importing, renders progress and expandable failures, and unsubscribes', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  let calls = 0, unsubscribed = false, listener: ((p: LibraryArchiveProgress) => void) | undefined
  let resolve: ((r: LibraryResult<LibraryArchiveReport | null>) => void) | undefined
  const api: LibraryArchiveAPI = {
    archiveSuggestion: async () => ({ success: true, data: '/suggestion/library' }),
    pickAndImportArchive: () => { calls++; return new Promise(r => { resolve = r }) },
    onArchiveProgress: fn => { listener = fn; return () => { unsubscribed = true } },
  }
  const busy: boolean[] = []
  const click = async (text: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === text)
    assert.ok(button); await act(async () => button.click())
  }
  try {
    await act(async () => root.render(<ArchiveImport api={api} disabled={false} onBusy={value => busy.push(value)} />))
    await click('从藏书阁导入…')
    assert.match(dom.window.document.body.textContent!, /不会自动读取.*\/suggestion\/library/)
    assert.equal(calls, 0)
    await click('选择目录并导入')
    await act(async () => listener!({ completed: 1, total: 2, title: '夹具书' }))
    assert.match(dom.window.document.querySelector('[role="status"]')!.textContent!, /1 \/ 2：夹具书/)
    assert.equal(dom.window.document.querySelector('progress')!.value, 1)
    await act(async () => resolve!({ success: true, data: { success: [{ id: '1', title: '夹具书', bookId: 'b' }], skipped: [], failed: [{ id: '2', title: '缺文件', reason: '书文件缺失' }], unlocated: 1 } }))
    assert.match(dom.window.document.querySelector('[role="status"]')!.textContent!, /成功 1 本.*失败 1 本.*未定位划线 1 条/)
    const details = dom.window.document.querySelector('details')!
    assert.equal(details.open, false); assert.match(details.textContent!, /缺文件：书文件缺失/)
    assert.deepEqual(busy, [true, false]); await click('关闭')
    assert.equal(dom.window.document.querySelector('[role="dialog"]'), null)
    await click('从藏书阁导入…'); await click('选择目录并导入')
    await act(async () => resolve!({ success: false, error: 'library.json 结构不正确' }))
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /结构不正确/)
  } finally {
    await act(async () => root.unmount()); assert.equal(unsubscribed, true)
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
})
