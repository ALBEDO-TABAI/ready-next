import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { useRSSSelectionCommandBridge } from '../renderer/modules/rss/useRSSSelectionCommandBridge'
import { useRSSSession } from '../renderer/stores/useRSSSession'
import { requestModuleAgentAction } from '../renderer/utils/moduleAgentBridge'
import type { RSSItem } from '../renderer/components/rss/RSSFeed'

// 'mounted-hidden': an Agent selection made while another mode is in front still applies (0.8 behavior).
for (const change of ['none', 'mounted-hidden', 'selection', 'hidden', 'query-roundtrip', 'reveal']) test(`RSS selection read respects ${change} while Main is pending`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const values = { window: dom.window, document: dom.window.document, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true }
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true })
  const root = createRoot(document.getElementById('root')!)
  let complete!: (value: unknown) => void
  const reads = new Promise((resolve) => { complete = resolve })
  Object.assign(window, { electronAPI: { rss: { readArticle: () => reads } } })
  const selections: string[] = []
  const select = (item: RSSItem) => { selections.push(item.id); useRSSSession.getState().setSelection({ selectedItemId: item.id }) }
  function Host({ active }: { active: boolean }) { useRSSSelectionCommandBridge({ active, selectedItem: null, handleItemClick: select }); return null }
  try {
    useRSSSession.getState().reset()
    await act(async () => root.render(<Host active={change !== 'mounted-hidden'} />))
    const request = requestModuleAgentAction<{ applied: boolean }>({ module: 'rss', action: 'rss.selectItem', args: { itemId: 'A' } })
    const succeeds = change === 'none' || change === 'mounted-hidden'
    const rejection = succeeds ? null : assert.rejects(request, /rss_surface_generation_changed/)
    if (change === 'selection') useRSSSession.getState().setSelection({ selectedItemId: 'B' })
    if (change === 'hidden') await act(async () => root.render(<Host active={false} />))
    if (change === 'query-roundtrip') { useRSSSession.getState().setQuery({ search: 'B' }); useRSSSession.getState().setQuery({ search: '' }) }
    if (change === 'reveal') useRSSSession.getState().requestReveal({ kind: 'article', read: { itemId: 'B', expectedRevision: 'v1', offset: 0, length: 2 } })
    await act(async () => {
      complete({ success: true, data: { article: { id: 'A', title: 'A', source: 'Source', sourceId: 's', author: null, summary: '', coverImage: null, publishedAt: null, collectedAt: 1, revision: 'v1', read: false, starred: false, link: 'https://selection.invalid/A' } } })
      if (rejection) await rejection
      else assert.equal((await request).applied, true)
    })
    assert.deepEqual(selections, succeeds ? ['A'] : [])
    if (change === 'selection') assert.equal(useRSSSession.getState().selectedItemId, 'B')
  } finally {
    await act(async () => root.unmount()); useRSSSession.getState().reset(); dom.window.close()
    for (const [key, descriptor] of Object.entries(prior)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key] }
  }
})
