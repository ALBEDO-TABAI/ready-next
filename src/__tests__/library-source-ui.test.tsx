import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import type { BookSourcesAPI, SourceJob } from '../shared/library-sources'
import { FindSheet } from '../renderer/modules/library/find/FindSheet'
import { JobView } from '../renderer/modules/library/find/JobView'
const require = createRequire(import.meta.url)

test('C11 search/download, pushed task states, captcha, cancel/retry/manual and settings feature entry', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  // JSDOM has no layout engine; glass measurement is unrelated to these search controls.
  class Observer { observe() {} disconnect() {} }
  const globals = { ResizeObserver: Observer, MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    localStorage: dom.window.localStorage, window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => { await act(async () => root.unmount()); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } dom.window.close() })
  const calls: string[] = []
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
    openManual: async () => { calls.push('manual'); return { success: true, data: undefined } },
    onChanged: listener => { push = listener; return () => {} },
  }
  const click = async (text: string) => { const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(button, text); await act(async () => button.click()) }
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
  assert.ok(calls.includes('retry')); assert.ok(calls.includes('manual'))
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
  Object.defineProperty(dom.window, 'electronAPI', { configurable: true, value: {
    bookSources: api,
    library: { get: async () => ({ success: true, data: { status: 'no_vault' } }), onChanged: () => () => {} },
  } })
  const { Library } = await import('../renderer/modules/library/Library')
  await act(async () => root.render(<Library />))
  const library = dom.window.document.querySelector<HTMLElement>('.rn-library')!
  await act(async () => library.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true })))
  assert.ok(dom.window.document.querySelector('[aria-label="找书"]'))
  await click('关闭找书'); assert.equal(dom.window.document.querySelector('[aria-label="找书"]'), null)
  await click('找书 F'); assert.ok(dom.window.document.querySelector('[aria-label="找书"]'))
})
