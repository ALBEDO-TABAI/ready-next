import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'

test('RSS keeps a bounded row window, reaches the last item, and retains its position while hidden', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, SVGElement: dom.window.SVGElement, Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: { get: () => 768 },
    offsetHeight: { get() { return (this as HTMLElement).dataset.rssItemId ? 84 : 768 } },
    offsetParent: { get() { return dom.window.document.body } },
  })
  const root = createRoot(document.getElementById('root')!)
  try {
    // Bundle the same browser entry as Vite; rc's CJS default export is not Node ESM interop.
    const compiled = buildSync({
      entryPoints: ['src/renderer/components/rss/RSSFeed.tsx'], bundle: true, write: false,
      platform: 'browser', format: 'cjs', jsx: 'automatic',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    }).outputFiles[0].text
    const module = { exports: {} as { default: typeof import('../renderer/components/rss/RSSFeed').default } }
    new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), module, module.exports)
    const RSSFeed = module.exports.default
    const noop = () => undefined
    const items = Array.from({ length: 10000 }, (_, index) => ({
      id: `item-${index}`, title: `Title ${index}`, source: 'Fixture', author: '', sourceId: 'source',
      summary: index % 2 ? 'Two lines of summary' : '', publishedAt: '', read: false, starred: false, link: '',
    }))
    let starredId = ''
    const props = {
      items, sources: [], filter: 'all' as 'all' | 'unread' | 'starred', selectedSource: null, selectedItemId: null as string | null,
      loading: false, refreshing: false, isMock: true, hasPreview: false, newItemIds: new Set<string>(),
      analysisProgressMap: {}, analysisJobs: [], settingsOpen: false,
      onFilterChange: noop, onSourceChange: noop, onItemClick: noop, onMarkItemRead: noop,
      onToggleStar: (id: string) => { starredId = id }, onDeleteItem: noop, onOpenAnalysisOutput: noop, onRefresh: noop,
      onAddSource: noop, onDeleteSource: noop, onClearRead: noop, onOpenSettings: noop,
      onPauseAnalysisJob: noop, onResumeAnalysisJob: noop, onDeleteAnalysisJob: noop,
    }
    const render = async () => { await act(async () => { root.render(createElement(RSSFeed, props)) }) }
    await render()
    const count = () => document.querySelectorAll('.rss-item-row').length
    assert.ok(count() > 0 && count() <= 80, `mounted ${count()} rows`)
    props.selectedItemId = 'item-9999'
    await render()
    assert.ok(document.querySelector('[data-rss-item-id="item-9999"]'))
    assert.ok(count() <= 80)
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-rss-item-id="item-9999"] [title="收藏"]')!.click() })
    assert.equal(starredId, 'item-9999')
    const holder = document.querySelector<HTMLElement>('[data-liquid-scroll-root="rss-feed-list"]')!
    const offset = holder.scrollTop
    assert.ok(offset > 0)
    holder.parentElement!.style.display = 'none'
    await render()
    holder.parentElement!.style.display = ''
    await render()
    assert.equal(holder.scrollTop, offset)
    assert.ok(document.querySelector('[data-rss-item-id="item-9999"]'))
    props.items = items.map((item) => item.id === 'item-123' ? { ...item, starred: true } : item)
    props.filter = 'starred'
    props.selectedItemId = null
    await render()
    assert.equal(count(), 1)
    assert.ok(document.querySelector('[data-rss-item-id="item-123"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
