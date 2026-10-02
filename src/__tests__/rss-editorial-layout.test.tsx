import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import RSSDigestPanel from '../renderer/components/rss/RSSDigestPanel'
import RSSDefinitionEditor from '../renderer/components/rss/RSSDefinitionEditor'
import { rankHotEvents, RSS_HOT_WINDOW_MS } from '../renderer/modules/rss/hot-events'
import { useRSSWorkspace } from '../renderer/modules/rss/useRSSWorkspace'
import { useRSSSession } from '../renderer/stores/useRSSSession'
import { RSSQuerySchema, type RSSQueryInput } from '../shared/rss-workspace'
import type { RSSEventSummary } from '../shared/rss-events'
import type { RSSDefinition } from '../shared/rss-organization'
import type { RSSDigestEntry, RSSDigestHeader } from '../shared/rss-digests'

async function withDOM(run: (root: ReturnType<typeof createRoot>, dom: JSDOM) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const replacements = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, CustomEvent: dom.window.CustomEvent,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, SVGElement: dom.window.SVGElement, Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
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

const texts = (dom: JSDOM, selector: string) => [...dom.window.document.querySelectorAll(selector)].map((node) => node.textContent)

test('current hot events need two sources within 48 hours and rank by sources, reports, then recency', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  const event = (id: string, sourceCount: number, memberCount: number, ageMs: number) => ({ id, title: id, sourceCount, memberCount, latestAt: now - ageMs } as RSSEventSummary)
  const ranked = rankHotEvents([
    event('single-source', 1, 6, 0),
    event('expired', 9, 9, RSS_HOT_WINDOW_MS + 1),
    event('wide', 4, 4, 3_600_000),
    event('deep', 3, 5, 7_200_000),
    event('fresh', 3, 5, 60_000),
    event('narrow', 2, 2, 0),
  ], now, 3)
  assert.deepEqual(ranked.map((entry) => entry.id), ['wide', 'fresh', 'deep'])
})

test('a remembered column that no longer exists falls back to all news instead of failing the workspace', async () => withDOM(async (root) => {
  useRSSSession.getState().reset()
  useRSSSession.getState().setQuery({ collectionId: 'deleted-column', scope: 'inbox', filter: 'all' })
  const queries: RSSQueryInput[] = []
  const all = { id: 'all', kind: 'all', name: '全部动态' } as RSSDefinition
  Object.assign(window, { electronAPI: { rss: {
    getSources: async () => ({ success: true, data: [] }),
    getDefinitions: async () => ({ success: true, data: [all] }),
    onOrganizationChanged: () => () => {}, onEventSeenChanged: () => () => {},
    queryCards: async (query: RSSQueryInput) => {
      queries.push(query)
      if (query.collectionId) return { success: false, error: '栏目已删除，请选择其他栏目。' }
      return { success: true, data: { definitions: [all], query: RSSQuerySchema.parse(query), items: [], total: 0, unreadTotal: 0, revision: 1, lastFetchAt: null, nextCursor: null } }
    },
  } } })
  let state!: ReturnType<typeof useRSSWorkspace>
  function Probe() { state = useRSSWorkspace(true); return null }
  await act(async () => root.render(<Probe />))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.equal(queries.some((query) => query.collectionId === 'deleted-column'), false, 'the stale column is never queried')
  assert.equal(useRSSSession.getState().query.collectionId, undefined)
  assert.equal(state.error, null)
  assert.equal(state.view?.query.collectionId, undefined)
}))

test('the digest view opens the latest daily issue as an edition led by its most-reported story', async () => withDOM(async (root, dom) => {
  useRSSSession.getState().reset(); useRSSSession.getState().setDigestView(true)
  const header = (id: string, kind: 'daily' | 'range', until: string, lead: string | null): RSSDigestHeader => ({
    id, kind, editionKey: id, version: 1, from: Date.parse(until) - 86_400_000, until: Date.parse(until), timezone: 'UTC', createdAt: Date.parse(until), query: null,
    scopeLabel: kind === 'daily' ? '精选' : 'AI 与模型', ruleCount: 1, total: 3, referenceCount: 6, needsUpdate: false, lead: lead ? { title: lead, source: 'Publisher' } : null,
    coverage: { matchingArticles: 6, pendingArticles: 0, unresolvedArticles: 0, failedArticles: 0, missingBodies: 0, carriedOverArticles: 0, duplicateOrPublishedArticles: 0 },
  })
  const editions = [
    header('range-today', 'range', '2026-10-02T10:00:00Z', 'Range story'),
    header('daily-oct-2', 'daily', '2026-10-02T08:00:00Z', 'Big story'),
    header('daily-oct-1', 'daily', '2026-10-01T08:00:00Z', 'Yesterday story'),
    header('daily-sep-29', 'daily', '2026-09-29T08:00:00Z', null),
  ]
  const entry = (groupKey: string, section: string, referenceCount: number, title: string): RSSDigestEntry => ({ section, groupKey, referenceCount, source: {
    itemId: groupKey, articleRevision: 'r1', title, link: `https://example.test/${groupKey}`, sourceId: `source-${groupKey}`, source: `Source ${groupKey}`,
    quote: `${title} quote`, quoteKind: 'source_summary', quoteTruncated: false, sourceRole: 'unknown', bodyStatus: 'ready', factId: null, eventId: null, evidenceId: null,
    availableAt: 0, carriedOver: false, curation: { definitionId: 'curated', name: '精选', kind: 'curated', included: true, origin: 'model', reason: `${title} reason` } as never, topics: [],
  } })
  const entries = [entry('small', 'AI', 1, 'Small story'), entry('big', 'Dev', 3, 'Big story'), entry('mid', 'AI', 2, 'Mid story')]
  const opened: string[] = []
  Object.assign(window, { electronAPI: { rss: {
    readDigests: async (input: { view?: string; reportId?: string }) => {
      if (input.view === 'entries') { opened.push(input.reportId!); return { success: true, data: { view: 'entries', report: editions.find((edition) => edition.id === input.reportId), entries, total: 3, nextOffset: null } } }
      return { success: true, data: { view: 'editions', editions, total: editions.length, nextOffset: null, snapshot: 4 } }
    },
    digestSettings: async () => ({ success: true, data: { enabled: true, localTime: '08:00', timezone: 'UTC', nextRunAt: null, error: null } }),
    readArticle: async () => ({ success: false, error: 'not needed' }),
    onDigestsChanged: () => () => {}, onOrganizationChanged: () => () => {},
  } } })
  await act(async () => root.render(<RSSDigestPanel active view={null} onReadArticle={() => {}} />))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.equal(useRSSSession.getState().selectedDigestId, 'daily-oct-2', 'the newest daily issue, not the newer range brief')
  assert.deepEqual(opened, ['daily-oct-2'])
  assert.match(dom.window.document.querySelector('.rss-paper h1')!.textContent!, /资讯日报 · 第 1 版/)
  assert.equal(dom.window.document.querySelector('.rss-paper-lead h2')!.textContent, 'Big story')
  assert.deepEqual(texts(dom, '.rss-paper-highlights strong'), ['Mid story', 'Small story'])
  assert.deepEqual(texts(dom, '.rss-paper-index strong'), ['AI'], 'the headline does not leave an empty section behind')
  assert.match(dom.window.document.body.textContent!, /推荐理由：Big story reason/)
  assert.deepEqual(texts(dom, '.rss-digest-month__head span'), ['2026 年 10 月', '2026 年 9 月'])
  assert.deepEqual(texts(dom, '.rss-digest-issue__title').map((title) => title?.trim()), ['Big story', 'Yesterday story', '3 项入选'])
  assert.equal(dom.window.document.querySelectorAll('.rss-paper-calendar__grid button').length, 2, 'only October days with a daily issue are links')
  await act(async () => [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === '简报')!.click())
  assert.deepEqual(texts(dom, '.rss-digest-issue__title').map((title) => title?.trim()), ['Range story'])
}))

test('curated rows carry a large preview and their reason while other columns use a thumbnail beside the text', async () => withDOM(async (root, dom) => {
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: { get: () => 768 }, offsetHeight: { get: () => 120 }, offsetParent: { get() { return dom.window.document.body } },
  })
  // Bundle the same browser entry as Vite; rc's CJS default export is not Node ESM interop.
  const compiled = buildSync({
    entryPoints: ['src/renderer/components/rss/RSSFeed.tsx'], bundle: true, write: false, platform: 'browser', format: 'cjs', jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  }).outputFiles[0].text
  const module = { exports: {} as { default: typeof import('../renderer/components/rss/RSSFeed').default } }
  new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), module, module.exports)
  const RSSFeed = module.exports.default
  const noop = () => undefined
  const definitions = [{ id: 'curated', kind: 'curated', name: '精选' }, { id: 'ai', kind: 'topic', name: 'AI 与模型' }] as RSSDefinition[]
  const item = {
    id: 'a', title: 'Model release', source: 'Publisher', author: '', sourceId: 's', summary: 'A concrete release note.', publishedAt: '2026-10-02T03:00:00Z', read: false, starred: false,
    link: 'https://example.test/a', coverImage: 'https://example.test/cover.png', classifications: [
      { definitionId: 'curated', name: '精选', kind: 'curated', included: true, origin: 'model', reason: 'Primary source with clear limits.' },
      { definitionId: 'ai', name: 'AI 与模型', kind: 'topic', included: true, origin: 'model', reason: 'About a model.' },
    ],
  }
  const props = (collectionId?: string) => ({
    items: [item], sources: [], filter: 'all' as const, selectedSource: null, selectedItemId: null, loading: false, refreshing: false, isMock: true, hasPreview: false,
    newItemIds: new Set<string>(), analysisProgressMap: {}, analysisJobs: [], settingsOpen: false, definitions, query: { collectionId },
    onFilterChange: noop, onSourceChange: noop, onItemClick: noop, onMarkItemRead: noop, onToggleStar: noop, onDeleteItem: noop, onOpenAnalysisOutput: noop, onRefresh: noop,
    onAddSource: noop, onDeleteSource: noop, onClearRead: noop, onOpenSettings: noop, onPauseAnalysisJob: noop, onResumeAnalysisJob: noop, onDeleteAnalysisJob: noop,
  })
  const card = () => dom.window.document.querySelector('[data-rss-item-id="a"]')!
  await act(async () => root.render(createElement(RSSFeed, props('curated') as never)))
  assert.ok(card().querySelector('.rss-card-preview img'))
  assert.equal(card().querySelector('.rss-card-thumb'), null)
  assert.equal(card().querySelector('.rss-card-reason')!.textContent, '推荐理由：Primary source with clear limits.')
  assert.deepEqual(texts(dom, '[data-rss-item-id="a"] .rss-classification-labels span'), ['#AI 与模型'], 'curation is the 精选 mark, not a tag')
  assert.ok(dom.window.document.querySelector('.rss-date-heading'))
  await act(async () => root.render(createElement(RSSFeed, props(undefined) as never)))
  assert.ok(card().querySelector('.rss-card-main .rss-card-thumb img'))
  assert.equal(card().querySelector('.rss-card-preview'), null)
}))

const scheduleOff = async () => ({ success: true, data: { enabled: true, localTime: '08:00', timezone: 'UTC', nextRunAt: null, error: null } })
const noEditions = async () => ({ success: true, data: { view: 'editions', editions: [], total: 0, nextOffset: null, snapshot: 0 } })
const briefDefinitions = [
  { id: 'all', kind: 'all', name: '全部动态', visible: true },
  { id: 'curated', kind: 'curated', name: '精选', visible: true, description: 'Primary sources with concrete progress.' },
  { id: 'ai', kind: 'topic', name: 'AI 与模型', visible: true },
] as RSSDefinition[]

test('a new brief starts from the feed scope, can be narrowed in place, and pins the revision it was counted at', async () => withDOM(async (root, dom) => {
  useRSSSession.getState().reset(); useRSSSession.getState().setDigestView(true)
  const counts: RSSQueryInput[] = [], generated: unknown[] = []
  let revision = 7
  Object.assign(window, { electronAPI: { rss: {
    readDigests: noEditions, digestSettings: scheduleOff, onDigestsChanged: () => () => {}, onOrganizationChanged: () => () => {},
    queryCards: async (query: RSSQueryInput) => { counts.push(query); return { success: true, data: { definitions: [], query: RSSQuerySchema.parse(query), items: [], total: 3, unreadTotal: 0, revision: revision++, lastFetchAt: null, nextCursor: null } } },
    generateDigest: async (input: unknown) => { generated.push(input); return { success: true, data: { id: 'brief-1' } } },
  } } })
  const view = { query: RSSQuerySchema.parse({ collectionId: 'all', categoryId: 'ai', sourceId: 's1', search: 'model' }), revision: 1 } as never
  await act(async () => root.render(<RSSDigestPanel active view={view} definitions={briefDefinitions} feedSources={[{ id: 's1', name: 'Publisher' }]} onReadArticle={() => {}} />))
  const button = (text: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
  await act(async () => button('新建简报').click())
  const form = dom.window.document.querySelector('form[aria-label="新建简报"]')!
  assert.equal(form.querySelector<HTMLSelectElement>('#rss-brief-column')!.value, 'all')
  assert.equal(form.querySelector<HTMLSelectElement>('#rss-brief-source')!.value, 's1')
  assert.equal(form.querySelector<HTMLInputElement>('#rss-brief-search')!.value, 'model')
  assert.equal(form.querySelector('[role="radio"][aria-checked="true"]')!.textContent, 'AI 与模型')
  await act(async () => button('近 7 天').click())
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
  assert.match(form.querySelector('[role="status"]')!.textContent!, /共 3 篇资讯/)
  const before = Date.now()
  await act(async () => button('生成简报').click())
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  const request = generated[0] as { kind: string; query: RSSQueryInput & { expectedRevision: number } }
  assert.equal(request.kind, 'range')
  assert.equal(request.query.categoryId, 'ai'); assert.equal(request.query.sourceId, 's1'); assert.equal(request.query.search, 'model')
  assert.ok(Math.abs(request.query.from! - (before - 7 * 86_400_000)) < 5000, 'a rolling seven-day window')
  assert.equal(request.query.expectedRevision, counts.length + 6, 'generation pins the revision read right before it')
  assert.equal(useRSSSession.getState().selectedDigestId, 'brief-1')
  assert.equal(dom.window.document.querySelector('form[aria-label="新建简报"]'), null)
}))

test('daily settings name the curated standard that scopes every issue and open it for editing', async () => withDOM(async (root, dom) => {
  useRSSSession.getState().reset(); useRSSSession.getState().setDigestView(true)
  Object.assign(window, { electronAPI: { rss: { readDigests: noEditions, digestSettings: scheduleOff, onDigestsChanged: () => () => {}, onOrganizationChanged: () => () => {} } } })
  const edited: string[] = []
  await act(async () => root.render(<RSSDigestPanel active view={null} definitions={briefDefinitions} onReadArticle={() => {}} onEditDefinition={(id) => edited.push(id)} />))
  await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="日报设置"]')!.click())
  assert.match(dom.window.document.body.textContent!, /收录范围每天收录“精选”栏目里新入选的资讯/)
  assert.match(dom.window.document.body.textContent!, /标准：Primary sources with concrete progress\./)
  await act(async () => [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '编辑精选标准')!.click())
  assert.deepEqual(edited, ['curated'])
  await act(async () => root.render(<RSSDefinitionEditor definitions={briefDefinitions.map((d) => ({ ...d, icon: 'sparkles', revision: 1, position: 1, filterIds: [] })) as never} initialId="curated" onSaved={() => {}} onClose={() => {}} />))
  assert.equal(dom.window.document.querySelector('.rss-definition-form h1')!.textContent, '精选')
}))
