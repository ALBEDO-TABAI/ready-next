import RSSDigestPanel from '../renderer/components/rss/RSSDigestPanel'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { useRSSWorkspace } from '../renderer/modules/rss/useRSSWorkspace'
import { useRSSSession } from '../renderer/stores/useRSSSession'
import RSSArticleReader from '../renderer/components/rss/RSSArticleReader'
import RSSEventPanel from '../renderer/components/rss/RSSEventPanel'
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
    onOrganizationChanged: () => () => {}, onEventSeenChanged: () => () => {},
    queryCards: (query: RSSQueryInput) => new Promise((resolve) => requests.push({ query, resolve })),
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
  Object.assign(window, { electronAPI: { rss: { onOrganizationChanged: () => () => {}, onEventSeenChanged: () => () => {}, readArticle: async () => {
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
    onOrganizationChanged: () => () => {}, onEventSeenChanged: () => () => {},
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
    onOrganizationChanged: () => () => {}, onEventSeenChanged: () => () => {},
    queryCards: async (query: RSSQueryInput) => { reads += 1; return { success: true, data: { definitions: [], query: RSSQuerySchema.parse(query), revision: 1, items: [], total: 0, unreadTotal: 0, nextCursor: null, lastFetchAt: null } } },
  } } })
  function Host({ active }: { active: boolean }) { useRSSWorkspace(active); return null }
  await act(async () => root.render(<Host active={false} />))
  assert.equal(reads, 0)
  await act(async () => root.render(<Host active />))
  assert.equal(reads, 1)
}))

test('late related-article reads cannot reopen an unmounted event panel or override the latest choice', async () => withDOM(async (root, dom) => {
  const pending = new Map<string, (value: unknown) => void>(), selected: string[] = []
  const article = { id: 'current', title: 'Current', revision: 'v1', event: { eventId: 'event', articleRevision: 'v1', factId: 'fact', revision: 1, stale: false } } as never
  Object.assign(window, { electronAPI: { rss: {
    onOrganizationChanged: () => () => {}, markEventFactsSeen: async ({ factIds }: { factIds: string[] }) => ({ success: true, data: { changed: 0, seenIds: factIds } }),
    readArticle: async ({ itemId }: { itemId: string }) => itemId === 'current' ? { success: true, data: { article } } : new Promise((resolve) => pending.set(itemId, resolve)),
    readEvents: async ({ view }: { view: string }) => ({ success: true, data: { view, revision: 1, summary: { id: 'event', revision: 1 }, total: view === 'members' ? 2 : 0,
      nextOffset: null, ...(view === 'members' ? { members: [{ itemId: 'A', title: 'Related A' }, { itemId: 'B', title: 'Related B' }] } : { facts: [] }) } }),
  } } })
  const find = (text: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!
  await act(async () => root.render(<RSSEventPanel article={article} active onSelect={(item) => selected.push(item.id)} />))
  await act(async () => dom.window.document.querySelector<HTMLButtonElement>('.rss-event-panel > button')!.click())
  await act(async () => { find('Related A').click(); find('Related B').click() })
  const resolved = (id: string) => ({ success: true, data: { article: { id, title: id, revision: 'v1', publishedAt: null } } })
  await act(async () => pending.get('B')!(resolved('B')))
  assert.deepEqual(selected, ['B'])
  await act(async () => pending.get('A')!(resolved('A')))
  assert.deepEqual(selected, ['B'])
  await act(async () => find('Related A').click())
  await act(async () => root.render(<div>Reader B</div>))
  await act(async () => pending.get('A')!(resolved('A')))
  assert.deepEqual(selected, ['B'])
}))

test('reopening saved content during a refresh waits for its receipt and displays failure without losing the body', async () => withDOM(async (root, dom) => {
  let fetching = true, error: string | null = null, loads = 0
  let finish!: (result: unknown) => void
  Object.assign(window, { electronAPI: { rss: {
    onOrganizationChanged: () => () => {}, onEventSeenChanged: () => () => {},
    readArticle: async () => ({ success: true, data: { article: { id: 'a', title: 'Title', revision: 'saved-v1', read: true },
      body: { status: 'ready', fetching, error, sourceUrl: 'https://example.test/a' }, text: 'SAVED-BODY', textKind: 'body', nextOffset: null } }),
    loadArticle: () => { loads++; return new Promise((resolve) => { finish = resolve }) },
  } } })
  const item = { id: 'a', title: 'Title', revision: 'saved-v1', link: 'https://example.test/a' } as RSSItem
  await act(async () => root.render(<RSSArticleReader item={item} onClose={() => {}} onOpened={async () => {}} onToggleStar={() => {}} />))
  assert.match(dom.window.document.body.textContent!, /SAVED-BODY/)
  assert.match(dom.window.document.body.textContent!, /正在获取正文/)
  assert.equal(loads, 1)
  await act(async () => { fetching = false; error = 'fixture refresh failed'; finish({ success: false, error }) })
  assert.match(dom.window.document.body.textContent!, /SAVED-BODY/)
  assert.match(dom.window.document.body.textContent!, /fixture refresh failed/)
  assert.doesNotMatch(dom.window.document.body.textContent!, /正在获取正文/)
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>('.rss-reader-status button')?.disabled, false)
}))

test('a completed digest generation cannot reopen a panel the user has left', async () => withDOM(async (root, dom) => {
  useRSSSession.getState().reset(); useRSSSession.getState().setDigestView(true)
  let finish!: (value: unknown) => void
  Object.assign(window, { electronAPI: { rss: {
    readDigests: async () => ({ success: true, data: { view: 'editions', editions: [], total: 0, nextOffset: null, snapshot: 0 } }),
    digestSettings: async () => ({ success: true, data: { enabled: true, localTime: '08:00', timezone: 'UTC', nextRunAt: null, error: null } }),
    onDigestsChanged: () => () => {}, onOrganizationChanged: () => () => {},
    generateDigest: () => new Promise((resolve) => { finish = resolve }),
  } } })
  await act(async () => root.render(<RSSDigestPanel active view={{ query: RSSQuerySchema.parse({}), revision: 1 } as never} onReadArticle={() => { throw new Error('unexpected navigation') }} />))
  const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '生成当前筛选范围简报')!
  await act(async () => button.click())
  await act(async () => { useRSSSession.getState().setDigestView(false); root.render(<p>Another surface</p>) })
  await act(async () => finish({ success: true, data: { id: 'old-request-report' } }))
  assert.equal(useRSSSession.getState().digestVisible, false)
  assert.equal(useRSSSession.getState().selectedDigestId, null)
}))

test('a digest citation pins the very first full-body request and cannot silently show a newer version', async () => withDOM(async (root, dom) => {
  const reads: Array<{ expectedRevision?: string }> = []
  Object.assign(window, { electronAPI: { rss: {
    onOrganizationChanged: () => () => {}, onEventSeenChanged: () => () => {},
    readArticle: async (input: { expectedRevision?: string }) => {
      reads.push(input)
      return input.expectedRevision === 'v1' ? { success: false, error: 'article_changed' } : { success: true, data: { article: { id: 'a', title: 'Title', revision: 'v2', read: true }, body: { status: 'ready' }, text: 'BODY VERSION TWO', textKind: 'body', nextOffset: null } }
    },
  } } })
  const item = { id: 'a', title: 'Title', link: 'https://example.test/a', revision: 'v1' } as RSSItem
  await act(async () => root.render(<RSSArticleReader item={item} expectedRevision="v1" onClose={() => {}} onOpened={async () => {}} onToggleStar={() => {}} />))
  assert.equal(reads[0].expectedRevision, 'v1')
  assert.doesNotMatch(dom.window.document.body.textContent!, /BODY VERSION TWO/)
  assert.match(dom.window.document.body.textContent!, /无法打开指定版本/)
}))

test('digest export receipts stay with their edition and corrections refresh the open header', async () => withDOM(async (root, dom) => {
  useRSSSession.getState().reset(); useRSSSession.getState().setDigestView(true, 'A')
  let finish!: (value: unknown) => void, correction = () => {}, outdated = false
  const header = (id: string) => ({ id, kind: 'daily', version: id === 'A' ? 1 : 2, from: 0, until: 1000, createdAt: 1000, timezone: 'UTC', total: 0, referenceCount: 0,
    scopeLabel: 'Saved scope', needsUpdate: outdated, coverage: { unresolvedArticles: 0, failedArticles: 0, pendingArticles: 0, missingBodies: 0, carriedOverArticles: 0 } })
  Object.assign(window, { electronAPI: { rss: {
    readDigests: async (input: { view?: string; reportId?: string }) => ({ success: true, data: input.view === 'entries'
      ? { view: 'entries', report: header(input.reportId!), entries: [], total: 0, nextOffset: null }
      : { view: 'editions', editions: [header('A'), header('B')], total: 2, nextOffset: null, snapshot: 2 } }),
    digestSettings: async () => ({ success: true, data: { enabled: true, localTime: '08:00', timezone: 'UTC', nextRunAt: null, error: null } }),
    onDigestsChanged: () => () => {}, onOrganizationChanged: (handler: () => void) => { correction = handler; return () => {} },
    exportDigest: () => new Promise((resolve) => { finish = resolve }),
  } } })
  await act(async () => root.render(<RSSDigestPanel active view={null} onReadArticle={() => {}} />))
  const find = (text: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
  await act(async () => find('导出本刊').click())
  await act(async () => useRSSSession.getState().setDigestView(true, 'B'))
  await act(async () => finish({ success: true, data: { canceled: false, path: '/synthetic/A-v1.md', reportId: 'A' } }))
  assert.match(dom.window.document.querySelector('h1')!.textContent!, /第 2 版/)
  assert.doesNotMatch(dom.window.document.body.textContent!, /A-v1.md/)
  await act(async () => { outdated = true; correction() })
  assert.match(dom.window.document.body.textContent!, /来源、标准或归属已经变化/)
}))
