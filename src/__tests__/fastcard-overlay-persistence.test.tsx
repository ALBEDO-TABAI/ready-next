import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import FastCardOverlayWindow from '../renderer/pages/FastCardOverlayWindow'
import type { FastCardOverlaySnapshot, FastCardOverlayCommand, FastCardIPCResult } from '../shared/fastcard'

test('C7 overlay shows confirmed content and write errors; late startup reads cannot replace newer receipts', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  let push: (snapshot: FastCardOverlaySnapshot) => void = () => assert.fail('not subscribed')
  let resolveInitial: (result: FastCardIPCResult<FastCardOverlaySnapshot>) => void = () => assert.fail('not requested')
  const commands: FastCardOverlayCommand[] = []
  Object.defineProperty(dom.window, 'electronAPI', { value: { browser: {
    getFastCardOverlaySnapshot: () => new Promise(resolve => { resolveInitial = resolve }),
    onFastCardOverlaySnapshot: (callback: typeof push) => { push = callback; return () => undefined },
    sendFastCardOverlayCommand: async (command: FastCardOverlayCommand) => { commands.push(command); return { success: true } },
  } } })
  await act(async () => root.render(createElement(FastCardOverlayWindow)))
  const snapshot: FastCardOverlaySnapshot = {
    mode: 'fastcard', items: [{ id: 'saved', kind: 'text', createdAt: 1, text: '已落盘内容' }],
    syncState: { kind: 'error', message: '磁盘只读' },
    bounds: { left: 0, top: 0, width: 384, height: 480 },
  }
  await act(async () => push(snapshot))
  assert.match(dom.window.document.body.textContent || '', /已落盘内容/)
  assert.equal(dom.window.document.querySelector('[role="alert"]')?.textContent, '磁盘只读')
  await act(async () => resolveInitial({ success: true, data: { ...snapshot, items: [] } }))
  assert.match(dom.window.document.body.textContent || '', /已落盘内容/)
  await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="移除"]')!.click())
  assert.deepEqual(commands, [{ type: 'remove-item', id: 'saved' }])
  assert.match(dom.window.document.body.textContent || '', /已落盘内容/, 'command dispatch is not a deletion receipt')
  await act(async () => push({ ...snapshot, items: [], syncState: { kind: 'ready' } }))
  assert.doesNotMatch(dom.window.document.body.textContent || '', /已落盘内容|磁盘只读/)
  await act(async () => push({ ...snapshot, mode: 'result', resultPanel: {
    kind: 'translation', status: 'ready', originalText: 'hello', translatedText: '你好', targetLanguage: 'zh-CN',
  } }))
  assert.equal(dom.window.document.querySelector('[role="alert"]')?.textContent, '磁盘只读')
  assert.match(dom.window.document.body.textContent || '', /你好/)
})
