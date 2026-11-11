import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { DocumentWidgetData } from '../shared/document-widget-parse'

type GlobalKey =
  | 'window'
  | 'document'
  | 'HTMLElement'
  | 'HTMLAnchorElement'
  | 'Node'
  | 'Event'
  | 'MutationObserver'
  | 'getComputedStyle'
  | 'navigator'
  | 'IS_REACT_ACT_ENVIRONMENT'

async function withDom(run: (container: HTMLElement, root: Root) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><html data-theme="light"><body><div id="root"></div></body></html>', {
    url: 'http://localhost/workbench',
  })
  const keys: GlobalKey[] = ['window', 'document', 'HTMLElement', 'HTMLAnchorElement', 'Node', 'Event', 'MutationObserver', 'getComputedStyle', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = new Map<GlobalKey, PropertyDescriptor | undefined>()
  for (const key of keys) previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  const values: Record<GlobalKey, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLAnchorElement: dom.window.HTMLAnchorElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const key of keys) Object.defineProperty(globalThis, key, { value: values[key], configurable: true, writable: true })
  const container = dom.window.document.getElementById('root') as unknown as HTMLElement
  const root = createRoot(container)
  try {
    await run(container, root)
  } finally {
    await act(async () => root.unmount())
    for (const key of keys) {
      const descriptor = previous.get(key)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}

const STATIC_CARD = '<div class="card"><div class="title">静态卡片</div><a href="https://example.com">来源</a></div>'
const INTERACTIVE_CARD = '<div class="card"><div class="title">交互卡片</div><button onclick="steal()">切换</button><script>window.ran = true</script></div>'

function projectionHtml(container: HTMLElement): string {
  const host = container.querySelector('[data-widget-static-projection]')
  return host?.shadowRoot?.innerHTML ?? ''
}

test('a live widget boots in a sandboxed srcdoc iframe while the static projection holds the layout', async () => {
  const { default: WidgetRenderer } = await import('../renderer/components/document/WidgetRenderer')
  await withDom(async (container, root) => {
    await act(async () => root.render(createElement(WidgetRenderer, { widgetCode: STATIC_CARD })))

    const shell = container.querySelector('.document-widget-shell')
    assert.equal(shell?.getAttribute('data-widget-stage'), 'loading')
    const iframe = container.querySelector('iframe.document-widget-frame')
    assert.ok(iframe, 'live widget mounts its iframe runtime')
    assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts')
    assert.match(iframe.getAttribute('srcdoc') || '', /静态卡片/)
    assert.equal(iframe.getAttribute('aria-hidden'), 'true', 'iframe stays hidden from assistive tech until the receiver is ready')

    const projection = projectionHtml(container)
    assert.match(projection, /静态卡片/)
    assert.match(projection, /--widget-bg-primary:#FFFFFF/, 'projection consumes the same Ready tokens as the iframe')
    assert.match(projection, /\.widget-root \.card/, 'projection ships the shared base class layer')
  })
})

test('dormant widgets render as script-free static projections without mounting an iframe', async () => {
  const { default: WidgetRenderer } = await import('../renderer/components/document/WidgetRenderer')
  await withDom(async (container, root) => {
    await act(async () => root.render(createElement(WidgetRenderer, { widgetCode: STATIC_CARD, preferManualPreview: true })))

    assert.equal(container.querySelector('.document-widget-shell')?.getAttribute('data-widget-stage'), 'static')
    assert.equal(container.querySelector('iframe'), null)
    assert.equal(container.textContent?.includes('启用交互预览'), false, 'non-interactive cards need no activation control')
    assert.match(projectionHtml(container), /静态卡片/)
  })
})

test('interactive dormant widgets keep scripts out of the host and offer an explicit activation', async () => {
  const { default: WidgetRenderer } = await import('../renderer/components/document/WidgetRenderer')
  await withDom(async (container, root) => {
    await act(async () => root.render(createElement(WidgetRenderer, { widgetCode: INTERACTIVE_CARD, preferManualPreview: true })))

    const projection = projectionHtml(container)
    assert.match(projection, /交互卡片/)
    assert.doesNotMatch(projection, /<script/i)
    assert.doesNotMatch(projection, /onclick|steal\(\)/, 'inline handlers are stripped from the static projection')
    const activate = container.querySelector('.document-widget-fallback-shell button') as HTMLButtonElement | null
    assert.ok(activate, 'uncontrolled renderer offers its own activation row')
    assert.match(activate.textContent || '', /启用交互预览/)
    assert.equal(container.querySelector('iframe'), null)

    await act(async () => activate.click())
    assert.ok(container.querySelector('iframe.document-widget-frame'), 'activation mounts the sandboxed runtime')
  })
})

test('document cards show a figure caption and move activation into the caption when the preview is controlled', async () => {
  const { default: DocumentWidgetPreviewBlock } = await import('../renderer/components/document/DocumentWidgetPreviewBlock')
  const widget: DocumentWidgetData = {
    id: 'w-1',
    title: '参与方关系',
    widgetCode: INTERACTIVE_CARD,
    rawFence: '',
  } as DocumentWidgetData
  await withDom(async (container, root) => {
    await act(async () => root.render(createElement(DocumentWidgetPreviewBlock, {
      renderIdentity: 'w-1',
      figureIndex: 3,
      widget,
      renderCode: INTERACTIVE_CARD,
      widgetState: null,
      widgetStateSignature: 'null',
      preferManualPreview: true,
      canEdit: false,
      onWidgetQuote: () => undefined,
    })))

    const caption = container.querySelector('figcaption.ready-doc-widget-card-header')
    assert.ok(caption, 'card renders a figure caption')
    assert.match(caption.textContent || '', /FIG 03/)
    assert.match(caption.textContent || '', /参与方关系/)
    assert.equal(container.querySelectorAll('.document-widget-fallback-shell').length, 0, 'controlled renderer leaves activation to the caption')

    const activate = caption.querySelector('.ready-doc-widget-card-activate') as HTMLButtonElement | null
    assert.ok(activate)
    assert.equal(container.querySelector('iframe'), null)
    await act(async () => activate.click())
    assert.ok(container.querySelector('iframe.document-widget-frame'))
    assert.equal(caption.querySelector('.ready-doc-widget-card-activate'), null, 'activation disappears once the runtime is mounted')
  })
})

test('document widget chrome exposes working edit, quote and export actions after Tiptap retirement', async () => {
  const { default: Shell } = await import('../renderer/components/document/DocumentWidgetCardShell')
  await withDom(async (container, root) => {
    const calls: string[] = []
    await act(() => root.render(<Shell title="保留的卡片"
      onEdit={() => calls.push('编辑')} onQuote={() => calls.push('引用')} onExport={() => calls.push('导出')}>内容</Shell>))
    assert.equal(container.querySelector('figcaption .ready-doc-widget-card-title')?.textContent, '保留的卡片')
    for (const label of ['编辑', '引用', '导出']) {
      const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)
      assert.ok(button, label)
      await act(() => button.click())
    }
    assert.deepEqual(calls, ['编辑', '引用', '导出'])
  })
})
