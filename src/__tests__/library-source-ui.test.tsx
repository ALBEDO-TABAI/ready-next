import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import type { BookSourcesAPI, SourceJob } from '../shared/library-sources'
import type { LibraryState } from '../shared/library'
import { FindSheet } from '../renderer/modules/library/find/FindSheet'
import { JobView } from '../renderer/modules/library/find/JobView'
const require = createRequire(import.meta.url)

test('C11 search/download, pushed task states, captcha, cancel/retry/manual, settings feature entry and the shelf 导入 menu', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  // JSDOM has no layout engine; glass measurement is unrelated to these search controls.
  class Observer { observe() {} disconnect() {} }
  const globals = { ResizeObserver: Observer, MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage, window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => { await act(async () => root.unmount()); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } dom.window.close() })
  const calls: string[] = []
  Object.assign(dom.window, { electronAPI: { browser: { createTab: async (url: string) => { calls.push(`web:${url}`); return { success: true, tabId: 'manual-tab' } } } } })
  let push = (_jobs: SourceJob[]) => {}, extraSources = false
  const job: SourceJob = { id: 'job', source: 'treasure', ref: 'share', status: 'captcha', progress: 15, error: null, book_id: null, created_at: 1, updated_at: 1, captcha: { token: 'token', image: 'data:image/png;base64,AQID' } }
  const api: BookSourcesAPI = {
    settings: async () => ({ success: true, data: { settings: { executable: '', format: 'epub', treasure: extraSources, ctfile: extraSources }, extraSources } }),
    configure: async settings => { calls.push('configure'); return { success: true, data: settings } },
    status: async () => ({ success: true, data: { state: 'available' } }),
    search: async input => { calls.push(`search:${input.format}`); return { success: true, data: [{ source: 'zlib', ref: 'one', title: '山海', author: '作者', format: input.format }] } },
    categories: async () => ({ success: true, data: ['文学'] }),
    jobs: async () => ({ success: true, data: [] }),
    download: async () => { calls.push('download'); return { success: true, data: job } },
    cancel: async () => { calls.push('cancel'); return { success: true, data: job } },
    retry: async () => { calls.push('retry'); return { success: true, data: job } },
    answer: async input => { calls.push(`answer:${input.text}:${input.token}`); return { success: true, data: undefined } },
    manualLink: async () => { calls.push('manual'); return { success: true, data: 'https://example.com/book' } },
    onChanged: listener => { push = listener; return () => {} },
  }
  // A button by its text, or an icon button by its name (关闭找书 is the sheet's close icon).
  const click = async (text: string) => { const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === text || b.getAttribute('aria-label') === text); assert.ok(button, text); await act(async () => button.click()) }
  await act(async () => root.render(<><FindSheet api={api} onClose={() => calls.push('close')} /><JobView api={api} /></>))
  await act(async () => dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
  assert.ok(calls.includes('search:epub')); assert.match(dom.window.document.body.textContent || '', /山海/)
  await click('下载上架'); assert.ok(calls.includes('download'))
  await act(async () => push([job])); assert.equal(dom.window.document.querySelector('progress')?.value, 15)
  // Drive the real input handler through the native value setter and input event.
  const input = dom.window.document.querySelector<HTMLInputElement>('[aria-label="验证码"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'human')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await click('提交验证码'); assert.ok(calls.includes('answer:human:token'))
  await click('取消'); assert.ok(calls.includes('cancel'))
  await act(async () => push([{ ...job, status: 'failed', captcha: undefined, error: '断线' }]))
  await click('重试下载'); await click('去网盘手动下载')
  assert.ok(calls.includes('retry')); assert.ok(calls.includes('manual')); assert.ok(calls.includes('web:https://example.com/book'))
  await click('关闭找书'); assert.ok(calls.includes('close'))
  const dir = await mkdtemp(resolve('node_modules/.cache/ready-l3-ui-')); t.after(() => rm(dir, { recursive: true, force: true }))
  for (const enabled of [false, true]) {
    extraSources = true // Even a stale/incorrect host response must not expose a compiled-out feature.
    const outfile = join(dir, `${enabled}.cjs`)
    await build({ entryPoints: ['src/renderer/pages/settings/BookSourceSettingsPanel.tsx'], outfile, bundle: true, loader: { '.css': 'empty' }, platform: 'node', format: 'cjs', packages: 'external', define: { __READY_FEATURE_CTFILE__: String(enabled) } })
    const { BookSourceSettingsPanel } = require(outfile)
    await act(async () => root.render(<BookSourceSettingsPanel api={api} />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(dom.window.document.body.textContent!.includes('更多书源…'), enabled)
    assert.match(dom.window.document.body.textContent || '', /可用/)
    await click('保存并检查连接')
  }
  assert.ok(calls.includes('configure'))
  let pushLibrary = (_state: LibraryState) => {}, picked = 0
  Object.defineProperty(dom.window, 'electronAPI', { configurable: true, value: {
    bookSources: api,
    library: {
      get: async () => ({ success: true, data: { status: 'no_vault' } }), onChanged: (listener: (state: LibraryState) => void) => { pushLibrary = listener; return () => {} },
      pickAndImport: async () => { picked++; return { success: true, data: { imported: [], failed: [] } } },
    },
  } })
  const { Library } = await import('../renderer/modules/library/Library')
  const { FloatHost } = await import('../renderer/components/ui')
  await act(async () => root.render(<><Library /><FloatHost /></>))
  const d = dom.window.document, sheet = () => d.querySelector('[role="dialog"][aria-label="找书"]')
  const library = d.querySelector<HTMLElement>('.rn-library')!
  await act(async () => library.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true })))
  assert.ok(sheet())
  await click('关闭找书'); assert.equal(sheet(), null)
  // The bottom bar keeps 找书 as a button; its tooltip names the key.
  const find = [...d.querySelectorAll('button')].find(b => b.textContent === '找书')!
  assert.equal(find.title, '找书（F）'); assert.equal(find.getAttribute('aria-keyshortcuts'), 'F')
  await act(async () => find.click()); assert.ok(sheet())
  await click('关闭找书')
  // One 导入 button replaces 导入本地书 and 从藏书阁导入; with book sources it opens a menu: local files or 找书.
  const imports = [...d.querySelectorAll<HTMLButtonElement>('button')].filter(b => /导入|藏书阁/.test(b.textContent ?? ''))
  assert.deepEqual(imports.map(b => b.textContent), ['导入'])
  const importButton = imports[0]
  const menuItems = async () => {
    await act(async () => importButton.click())
    assert.equal(importButton.getAttribute('aria-expanded'), 'true')
    return [...d.querySelectorAll<HTMLElement>('[role="menu"][aria-label="导入"] [role="menuitem"]')]
  }
  let items = await menuItems()
  assert.deepEqual(items.map(item => [item.querySelector('.rn-menu__label')?.textContent, item.querySelector('.rn-menu__hint')?.textContent ?? null]), [['本地文件…', null], ['找书…', 'F']])
  assert.equal(items[0].getAttribute('aria-disabled'), 'true', 'no vault: nothing to import into')
  await act(async () => items[1].click())
  assert.equal(d.querySelector('[role="menu"]'), null); assert.ok(sheet())
  await click('关闭找书')
  await act(async () => pushLibrary({ status: 'ready', vaultRoot: '/vault', books: [], issues: [] }))
  items = await menuItems()
  assert.equal(items[0].getAttribute('aria-disabled'), null)
  await act(async () => items[0].click())
  assert.equal(picked, 1); assert.equal(d.querySelector('[role="menu"]'), null); assert.equal(sheet(), null)
  assert.equal(importButton.getAttribute('aria-expanded'), 'false')
})
