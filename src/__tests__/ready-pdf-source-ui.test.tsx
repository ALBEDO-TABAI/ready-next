import { memoryNavigationAPI } from './utils/navigation-memory'
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createHash } from 'node:crypto'
import { locatePdfQuote, pdfQuote, pdfAnchor, parsePdfAnchor } from '../shared/pdf-source-anchor'

const text = '前文 选中文字 后文'
test('PDF anchors relocate after whitespace/text shifts and reject ambiguous or missing quotes', () => {
  const anchor = pdfQuote(text, 8, 3, 7)
  assert.deepEqual(parsePdfAnchor(pdfAnchor(anchor)), anchor)
  assert.deepEqual(locatePdfQuote('新增 ' + text, anchor), { start: 6, end: 10 })
  assert.deepEqual(locatePdfQuote('前文 选中 文字 后文', anchor), { start: 3, end: 8 })
  assert.equal(locatePdfQuote(text + text, anchor), null)
  assert.equal(locatePdfQuote('原文已经删除', anchor), null)
})

test('PdfViewer enables a single-page selection, sends scoped IPC, and reveals ReadyRef quotes after page rendering', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = new Map<string, PropertyDescriptor | undefined>()
  const tick = () => new Promise(resolve => setTimeout(resolve, 20))
  class Observer { observe() {} disconnect() {} }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, NodeFilter: dom.window.NodeFilter, CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  let scrolledPage = 0
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolledPage = Number(this.dataset.page) }
  // Only PDF.js canvas/worker rendering is substituted; PdfViewer, DOM Range, IPC call and navigation are real.
  const pdf = 'data:text/javascript,' + encodeURIComponent(`
    import React from ${JSON.stringify(import.meta.resolve('react'))};
    export const pdfjs={GlobalWorkerOptions:{}};
    export function Document({children,onLoadSuccess}) {
      React.useEffect(()=>{ const timer=setTimeout(()=>onLoadSuccess({numPages:8,getData:async()=>new TextEncoder().encode('pdf bytes')}),0);return()=>clearTimeout(timer)},[onLoadSuccess]);
      return React.createElement('div',null,children)
    }
    export function Page({onLoadSuccess,onRenderTextLayerSuccess}) {
      React.useEffect(()=>{onLoadSuccess({getViewport:()=>({height:792})});onRenderTextLayerSuccess()},[]);
      return React.createElement('div',{className:'react-pdf__Page__textContent'},React.createElement('span',null,'前文 '),React.createElement('span',null,'选中文字'),React.createElement('span',null,' 后文'))
    }
  `)
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === 'react-pdf' ? { url: pdf, shortCircuit: true } : next(specifier, context)
  }, load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) } })
  const calls: unknown[] = [], opened: string[] = []
  let fail = false
  Object.defineProperty(dom.window, 'electronAPI', { value: { navigationHistory: memoryNavigationAPI(),
    sourceAnnotations: { pdf: async (input: unknown) => { calls.push(input); return fail ? { success: false, error: 'PDF 已变化，请重新打开后划线' } : { success: true, data: { persistence: 'saved' } } } },
    objects: { onMoved: () => () => {}, prepareMigration: async () => ({ resolved: [] }), completeMigration: async () => ({ state: 'completed' }), locate: async (id: string) => { assert.equal(id, 'pdf-object'); return { path: '/vault/改名.pdf' } } },
  } })
  const { default: PdfViewer } = await import('../renderer/components/document/PdfViewer')
  const { openReadyRef, usePdfReference } = await import('../renderer/modules/workbench/open-ready-ref')
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const previous = useDocTabs.getState().openTab
  useDocTabs.setState({ openTab: path => { opened.push(path) } })
  const root = createRoot(document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount()); useDocTabs.setState({ openTab: previous }); usePdfReference.setState({ target: null })
    hooks.deregister(); dom.window.close()
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  })
  await act(async () => { root.render(<PdfViewer tab={{ id: 'tab', objectId: 'pdf-object', path: '/vault/改名.pdf', title: '改名', content: '', isDirty: false }} fileUrl="file:///vault/改名.pdf" />) })
  await act(tick); await act(tick)
  const button = document.querySelector<HTMLButtonElement>('[aria-label="划线到来源页"]')!
  assert.equal(button.disabled, true)
  const layer = document.querySelector('[data-page="1"] .react-pdf__Page__textContent')!
  const range = document.createRange(); range.selectNodeContents(layer.children[1])
  await act(async () => { dom.window.getSelection()!.addRange(range); document.dispatchEvent(new dom.window.Event('selectionchange')) })
  assert.equal(button.disabled, false)
  await act(async () => button.click())
  assert.deepEqual(calls[0], { id: 'pdf-object', expectedHash: createHash('sha256').update('pdf bytes').digest('hex'), page: 1, text, start: 3, end: 7, exact: '选中文字' })
  assert.equal(document.querySelector('[role=status]')!.textContent, '已划线到来源页')
  fail = true; await act(async () => button.click())
  assert.match(document.querySelector('[role=alert]')!.textContent!, /PDF 已变化/)
  // A cross-page range must never be attributed to just its first page.
  range.setEnd(document.querySelector('[data-page="2"] .react-pdf__Page__textContent')!.lastChild!.firstChild!, 2)
  await act(async () => document.dispatchEvent(new dom.window.Event('selectionchange')))
  assert.equal(button.disabled, true)
  await act(async () => { dom.window.getSelection()!.removeAllRanges(); await openReadyRef({ kind: 'file', id: 'pdf-object', anchor: pdfAnchor(pdfQuote(text, 8, 3, 7)) }) })
  await act(tick)
  assert.deepEqual(opened, ['/vault/改名.pdf']); assert.equal(scrolledPage, 8)
  assert.equal(document.querySelector('[data-page="8"] [data-ready-pdf-highlight]')!.textContent, '选中文字')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)) })
  assert.equal(document.querySelector('[data-ready-pdf-highlight]'), null)
  await act(async () => openReadyRef({ kind: 'file', id: 'pdf-object', anchor: pdfAnchor(pdfQuote('已经删除', 8, 0, 4)) }))
  await act(tick)
  assert.match(document.querySelector('[role=alert]')!.textContent!, /无法定位引文/)
  assert.equal(document.querySelector('[data-ready-pdf-highlight]'), null)
})
