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

test('PdfViewer: a single-page selection gets the shared bar (划线 sends scoped IPC, 问 AI hands the PDF and quote to the composer); ReadyRef quotes reveal after rendering', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = new Map<string, PropertyDescriptor | undefined>()
  const tick = () => new Promise(resolve => setTimeout(resolve, 20))
  class Observer { observe() {} disconnect() {} }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver, IntersectionObserver: Observer, ResizeObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true,
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
  const calls: unknown[] = [], removed: unknown[] = [], opened: string[] = []
  let fail = false
  Object.defineProperty(dom.window, 'electronAPI', { value: { navigationHistory: memoryNavigationAPI(),
    sourceAnnotations: { pdf: async (input: unknown) => { calls.push(input); return fail ? { success: false, error: 'PDF 已变化，请重新打开后划线' } : { success: true, data: { persistence: 'saved', version: 'v1', sourcePath: '/vault/PDF/改名.md', sourceId: 'source-' + 'a'.repeat(32), highlights: [{ id: 'hl-1', text: '选中文字', sourceLine: 3 }], anchors: 'synced' } } },
      removeHighlight: async (input: unknown) => { removed.push(input); return { success: true, data: { sourcePath: '/vault/PDF/改名.md', version: 'v2', persistence: 'saved' } } } },
    objects: { onMoved: () => () => {}, prepareMigration: async () => ({ resolved: [] }), completeMigration: async () => ({ state: 'completed' }), locate: async (id: string) => { assert.equal(id, 'pdf-object'); return { path: '/vault/改名.pdf' } } },
    document: { stat: async () => ({ success: true, data: { isDirectory: false } }) },
  } })
  const { default: PdfViewer } = await import('../renderer/components/document/PdfViewer')
  const { FloatHost, ToastHost } = await import('../renderer/components/ui')
  const { useAgent } = await import('../renderer/stores/useAgent')
  const agentBefore = useAgent.getState()
  const { openReadyRef, usePdfReference } = await import('../renderer/modules/workbench/open-ready-ref')
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const previous = useDocTabs.getState().openTab
  useDocTabs.setState({ openTab: path => { opened.push(path) } })
  const root = createRoot(document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount()); useDocTabs.setState({ openTab: previous }); usePdfReference.setState({ target: null }); useAgent.setState(agentBefore, true)
    hooks.deregister(); dom.window.close()
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  })
  await act(async () => { root.render(<><PdfViewer tab={{ id: 'tab', objectId: 'pdf-object', path: '/vault/改名.pdf', title: '改名', content: '', isDirty: false }} fileUrl="file:///vault/改名.pdf" /><FloatHost /><ToastHost /></>) })
  await act(tick); await act(tick)
  const bar = () => document.querySelector('[data-ready-selection-bar]')
  const action = (label: string) => [...bar()!.querySelectorAll('button')].find(button => button.textContent === label)!
  const toast = () => [...document.querySelectorAll('.rn-toast')].at(-1)
  assert.equal(bar(), null)
  // jsdom has no layout: the selection and the scroll area get boxes, as a rendered page has.
  const box = (top: number, bottom: number) => ({ left: 0, right: 800, top, bottom, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}) })
  dom.window.Range.prototype.getBoundingClientRect = () => box(200, 220)
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => box(0, 1000)
  const layer = document.querySelector('[data-page="1"] .react-pdf__Page__textContent')!
  const select = async (range: Range) => {
    await act(async () => { dom.window.getSelection()!.removeAllRanges(); dom.window.getSelection()!.addRange(range); layer.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true })) })
    await act(tick)
  }
  const range = () => { const value = document.createRange(); value.selectNodeContents(layer.children[1]); return value }
  await select(range())
  assert.deepEqual([...bar()!.querySelectorAll('button')].map(button => button.textContent), ['划线', '存入 FastCard', '引用到文档', '问 AI', '保存到画板'])
  await act(async () => action('划线').click()); await act(tick)
  assert.deepEqual(calls[0], { id: 'pdf-object', expectedHash: createHash('sha256').update('pdf bytes').digest('hex'), page: 1, text, start: 3, end: 7, exact: '选中文字' })
  assert.match(toast()!.textContent!, /^已划线到来源页撤销打开$/)
  await act(async () => [...toast()!.querySelectorAll('button')].find(button => button.textContent === '撤销')!.click()); await act(tick)
  assert.deepEqual(removed, [{ sourceId: 'source-' + 'a'.repeat(32), id: 'hl-1', expectedVersion: 'v1' }], '撤销 removes the new mark from the source page')
  assert.match(toast()!.textContent!, /已撤销/)
  fail = true
  await select(range())
  await act(async () => action('划线').click()); await act(tick)
  assert.equal(toast()!.getAttribute('data-tone'), 'bad')
  assert.match(toast()!.textContent!, /PDF 已变化/)
  // 问 AI: the PDF itself as a resource, the selected words quoted in the composer; nothing is sent.
  await select(range())
  await act(async () => action('问 AI').click()); await act(tick)
  assert.ok(useAgent.getState().attachments.some(item => item.path === '/vault/改名.pdf'))
  assert.match(useAgent.getState().inputValue, /> 选中文字/)
  // A cross-page range must never be attributed to just its first page: no bar for it.
  const across = range(); across.setEnd(document.querySelector('[data-page="2"] .react-pdf__Page__textContent')!.lastChild!.firstChild!, 2)
  await select(across)
  assert.equal(bar(), null)
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
