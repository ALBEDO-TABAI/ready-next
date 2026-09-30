import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { useRSSWorkspace } from '../renderer/modules/rss/useRSSWorkspace'
import { useRSSSession } from '../renderer/stores/useRSSSession'
import RSSArticleReader from '../renderer/components/rss/RSSArticleReader'
import { RSSQuerySchema, type RSSQueryInput } from '../shared/rss-workspace'
import type { RSSItem } from '../renderer/components/rss/RSSFeed'

async function withDOM(run: (root: ReturnType<typeof createRoot>, dom: JSDOM) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const replacements = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const root = createRoot(dom.window.document.getElementById('root')!)
  try { await run(root, dom) } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}

test('a late save reload uses the current query and cannot strand its loading owner', async () => withDOM(async (root) => {
  useRSSSession.getState().reset()
  const requests: Array<{ query: RSSQueryInput; resolve: (value: unknown) => void }> = []
  Object.assign(window, { electronAPI: { rss: {
    getSources: async () => ({ success: true, data: [] }),
    getDefinitions: async () => ({ success: true, data: [] }),
    onOrganizationChanged: () => () => {},
    queryItems: (query: RSSQueryInput) => new Promise((resolve) => requests.push({ query, resolve })),
  } } })
  let state!: ReturnType<typeof useRSSWorkspace>
  function Probe() { state = useRSSWorkspace(true); return null }
  const finish = (index: number) => requests[index].resolve({ success: true, data: {
    definitions: [], query: RSSQuerySchema.parse(requests[index].query), items: [], total: 0, unreadTotal: 0, revision: index + 1, lastFetchAt: null, nextCursor: null,
  } })
  await act(async () => root.render(<Probe />))
  await act(async () => finish(0))
  const oldReload = state.reload
  await act(async () => useRSSSession.getState().setQuery({ search: 'B' }))
  let operation!: Promise<void>
  await act(async () => { operation = oldReload() })
  assert.equal(requests[2].query.search, 'B')
  await act(async () => { finish(1); finish(2); await operation })
  assert.equal(state.view?.query.search, 'B')
  assert.equal(state.loading, false)
}))

test('an open article consumes the new Main revision even when its title and link stay the same', async () => withDOM(async (root, dom) => {
  let revision = 'v1', reads = 0
  Object.assign(window, { electronAPI: { rss: { readArticle: async () => {
    reads += 1
    return { success: true, data: { article: { id: 'a', title: 'Title', revision, source: 'Source' },
      body: { status: 'ready', sourceUrl: 'https://example.test/a' }, text: revision === 'v1' ? 'OLD-BODY' : 'NEW-BODY', textKind: 'body', nextOffset: null } }
  } } } })
  const item = { id: 'a', title: 'Title', link: 'https://example.test/a', revision: 'v1', summary: '', author: '', source: 'Source' } as RSSItem
  const props = { onClose() {}, onOpened: async () => {}, onToggleStar() {} }
  await act(async () => root.render(<RSSArticleReader item={item} {...props} />))
  assert.match(dom.window.document.body.textContent!, /OLD-BODY/)
  revision = 'v2'
  await act(async () => root.render(<RSSArticleReader item={{ ...item, revision }} {...props} />))
  assert.equal(reads, 2)
  assert.match(dom.window.document.body.textContent!, /NEW-BODY/)
  assert.doesNotMatch(dom.window.document.body.textContent!, /OLD-BODY/)
}))

test('a newly fetched body acknowledged by the list does not refetch or leave the reader busy', async () => withDOM(async (root, dom) => {
  let ready = false, reads = 0, loads = 0
  Object.assign(window, { electronAPI: { rss: {
    readArticle: async () => {
      reads += 1
      return { success: true, data: { article: { id: 'a', title: 'Title', revision: ready ? 'body-v1' : 'missing', read: true }, body: { status: ready ? 'ready' : 'missing', sourceUrl: 'https://example.test' }, text: ready ? 'BODY-READY' : 'Summary', textKind: ready ? 'body' : 'source_summary', nextOffset: null } }
    },
    loadArticle: async () => { loads += 1; ready = true; return { success: true } },
  } } })
  function Host() {
    const [item, setItem] = React.useState({ id: 'a', title: 'Title', revision: 'missing', link: 'https://example.test/a' } as RSSItem)
    return <RSSArticleReader item={item} onClose={() => {}} onOpened={async () => {}} onToggleStar={() => {}} onBodyLoaded={async (article) => setItem((previous) => ({ ...previous, revision: article.revision }))} />
  }
  await act(async () => root.render(<Host />))
  assert.equal(reads, 2)
  assert.equal(loads, 1)
  assert.match(dom.window.document.body.textContent!, /BODY-READY/)
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>('.rss-reader-status button')?.disabled, false)
}))

test('an inactive RSS workspace does not query until it is shown', async () => withDOM(async (root) => {
  useRSSSession.getState().reset()
  let reads = 0
  Object.assign(window, { electronAPI: { rss: {
    getSources: async () => ({ success: true, data: [] }),
    getDefinitions: async () => ({ success: true, data: [] }),
    onOrganizationChanged: () => () => {},
    queryItems: async (query: RSSQueryInput) => { reads += 1; return { success: true, data: { definitions: [], query: RSSQuerySchema.parse(query), revision: 1, items: [], total: 0, unreadTotal: 0, nextCursor: null, lastFetchAt: null } } },
  } } })
  function Host({ active }: { active: boolean }) { useRSSWorkspace(active); return null }
  await act(async () => root.render(<Host active={false} />))
  assert.equal(reads, 0)
  await act(async () => root.render(<Host active />))
  assert.equal(reads, 1)
}))
