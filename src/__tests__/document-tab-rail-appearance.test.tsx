import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

/**
 * 行为合同（功能：文件管理外观同步到文档标签栏）：
 * tab 携带 customIcon 时，52px 竖条渲染该 emoji/文字图标；未携带时保持
 * 默认 FileText 矢量图标；高亮态自定义图标使用外观颜色。
 */

function installDomGlobals(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const keys = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'Element', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'] as const
  const previous = new Map<string, unknown>()
  for (const key of keys) {
    previous.set(key, (globalThis as Record<string, unknown>)[key])
  }
  const setGlobal = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Event', dom.window.Event)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('Element', dom.window.Element)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  setGlobal('cancelAnimationFrame', () => undefined)
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  return {
    dom,
    restore: () => {
      for (const key of keys) {
        const previousValue = previous.get(key)
        if (previousValue === undefined) {
          delete (globalThis as unknown as Record<string, unknown>)[key]
        } else {
          Object.defineProperty(globalThis, key, { value: previousValue, configurable: true, writable: true })
        }
      }
      try { dom.window.close() } catch { /* silent-catch: jsdom close best-effort */ }
    },
  }
}

const domHandle = installDomGlobals()
process.on('exit', () => {
  try { domHandle.restore() } catch { /* silent-catch: best-effort restore */ }
})

// Import AFTER the DOM globals exist (the component reads window at render time).
const { default: DocumentVerticalTabRail } = await import('../renderer/components/document/DocumentVerticalTabRail')
type DocumentVerticalTabItem = import('../renderer/components/document/DocumentVerticalTabRail').DocumentVerticalTabItem

function renderRail(tabs: DocumentVerticalTabItem[]): { container: HTMLElement; cleanup: () => void } {
  const host = globalThis.document.getElementById('root')
  if (!host) throw new Error('jsdom root element missing')
  host.innerHTML = ''
  const container = globalThis.document.createElement('div')
  host.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(createElement(DocumentVerticalTabRail, {
      tabs,
      onTabClick: () => {},
      onTabClose: () => {},
      onNewTab: () => {},
    }))
  })
  return { container, cleanup: () => flushSync(() => root.unmount()) }
}

test('document tab rail renders custom appearance icons and falls back to FileText', () => {
  const { container, cleanup } = renderRail([
    { id: 't1', label: '红皮书.md', customIcon: '📕', dotColor: '#ff453a', active: true },
    { id: 't2', label: '普通.md', dotColor: '#E97A2B' },
  ])
  try {
    assert.ok(container.textContent?.includes('📕'), 'custom icon emoji should render in the strip')
    const svgIcons = container.querySelectorAll('svg.lucide-file-text')
    assert.equal(svgIcons.length >= 1, true, 'the non-custom tab keeps the FileText icon')
    const customSpans = Array.from(container.querySelectorAll('span')).filter((node) => node.textContent === '📕')
    assert.equal(customSpans.length, 1, 'exactly one strip row shows the custom icon')
    const styleAttr = customSpans[0].getAttribute('style') || ''
    assert.ok(
      styleAttr.includes('rgb(255, 69, 58)') || styleAttr.includes('#ff453a'),
      `active custom icon uses the appearance color (got: ${styleAttr})`,
    )
  } finally {
    cleanup()
  }
})
