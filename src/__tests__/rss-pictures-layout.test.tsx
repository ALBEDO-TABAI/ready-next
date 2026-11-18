import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import React, { act, createElement } from 'react'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mountPrimitives } from './utils/primitives-ui-harness'
import type { RSSSieveItem } from '../shared/rss-sieve'
import type { RSSDigestEntry, RSSDigestHeader } from '../shared/rss-digests'
import type { RSSDefinition } from '../shared/rss-organization'
import type { RSSPictureLookupInput } from '../shared/rss-pictures'
import type { RSSItem } from '../renderer/components/rss/RSSFeed'

// 资讯配图 (plan 2026-11-18), renderer side: P8 the 列表 / 图册 switch and its memory, P9 and P10 the two layouts on
// the three surfaces, and how an item without a feed cover asks Main for its picture (P7). Main is a double here;
// its own rules are tested in rss-pictures.test.ts.
const { coverWords } = await import('../renderer/modules/rss/feed-item')
const { galleryColumns, galleryRows } = await import('../renderer/modules/rss/gallery-rows')
const pictures = await import('../renderer/modules/rss/pictures')
const { useRSSLayout } = await import('../renderer/stores/useRSSLayout')
const { RSSSieveView } = await import('../renderer/components/rss/RSSSieveView')
const { default: RSSDigestPanel } = await import('../renderer/components/rss/RSSDigestPanel')
const { default: RSSPicture } = await import('../renderer/components/rss/RSSPicture')
const { RSSTopbarContext } = await import('../renderer/components/rss/rss-topbar-context')

const ok = <T,>(data: T) => Promise.resolve({ success: true as const, data })
const LAYOUTS = 'ready-rss-layouts'

async function mount(t: TestContext, api: Record<string, unknown> = {}) {
  const h = await mountPrimitives(t)
  const asked: string[][] = []
  // Main's answer: an id that ends in "-page" has a picture on its page, anything else has none.
  const lookupPictures = async (input: RSSPictureLookupInput) => {
    asked.push(input.itemIds)
    return ok({ pictures: input.itemIds.map(itemId => itemId.endsWith('-page')
      ? { itemId, coverImage: `https://pictures.test/${itemId}.jpg`, state: 'page' as const } : { itemId, coverImage: null, state: 'none' as const }) })
  }
  Object.assign(h.dom.window, { electronAPI: { rss: { lookupPictures, ...api } } })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: h.dom.window.localStorage, configurable: true, writable: true })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage') })
  pictures.resetRSSPicturesForTests()
  useRSSLayout.setState({ layouts: { feed: 'list', sieve: 'list', digest: 'list' } })
  const settle = async (ms = 0) => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
  const choose = async (label: '列表' | '图册', within: ParentNode = h.body) => {
    const radio = within.querySelector<HTMLElement>(`.rss-layout-switch [role="radio"][aria-label="${label}"]`)
    assert.ok(radio, `no ${label} button`)
    await h.click(radio)
  }
  const sources = (selector: string) => [...h.body.querySelectorAll<HTMLImageElement>(selector)].map(image => image.getAttribute('src'))
  return { ...h, asked, settle, choose, sources }
}

test('a board of covers: how many across, where a day starts a new row, and what stands in for a missing cover', () => {
  assert.deepEqual([400, 559, 560, 879, 880, 1279, 1280, 1800].map(galleryColumns), [1, 1, 2, 2, 3, 3, 4, 4])
  const at = (id: string, day: number, hour: number) => ({ id, publishedAtMs: new Date(2026, 10, day, hour).getTime() }) as RSSItem
  const rows = galleryRows([at('a', 18, 21), at('b', 18, 20), at('c', 18, 19), at('d', 18, 18), at('e', 17, 23), at('f', 17, 9)], 3)
  assert.deepEqual(rows.map(row => row.items.map(item => item.id).join('')), ['abc', 'd', 'ef'], 'a day does not share a row with the next')
  assert.deepEqual(rows.map(row => row.heading?.main ?? null), ['11月18日', null, '11月17日'])
  assert.deepEqual(rows.map(row => row.key), ['row:a', 'row:d', 'row:e'])
  assert.deepEqual(coverWords({ title: 'T', link: 'https://www.example.com/a', summary: '一段足够长的摘要，可以当作封面上的文字。' }), { text: '一段足够长的摘要，可以当作封面上的文字。', site: false })
  assert.deepEqual(coverWords({ title: 'T', link: 'https://www.example.com/a', summary: 'Comments' }), { text: 'example.com', site: true }, 'a link-only item shows where it leads')
  assert.deepEqual(coverWords({ title: 'Same', link: 'https://example.com/a', summary: 'Same' }), { text: 'example.com', site: true })
  assert.deepEqual(coverWords({ title: 'No address', link: 'not a url', summary: '' }), { text: 'No address', site: false })
})

test('an item without a feed cover asks once; what is asked within a moment goes to Main as one request of at most 24', async t => {
  const h = await mount(t)
  for (let i = 0; i < 30; i++) pictures.requestRSSPicture(i === 3 ? 'i3-page' : `i${i}`)
  pictures.requestRSSPicture('i0'); pictures.requestRSSPicture('i3-page')
  await h.settle(60)
  assert.deepEqual(h.asked.map(ids => ids.length), [24, 6])
  assert.equal(new Set(h.asked.flat()).size, 30, 'no item is asked twice')
  assert.equal(pictures.useRSSPictures.getState().found['i3-page'], 'https://pictures.test/i3-page.jpg')
  assert.equal(pictures.useRSSPictures.getState().found.i0, null)
  pictures.requestRSSPicture('i0')
  await h.settle(60)
  assert.equal(h.asked.length, 2, 'an answered item is not asked again in the session')

  // The picture component: a feed cover asks nothing; a missing one asks and takes the answer; a failed load shows the fallback.
  h.asked.length = 0
  await h.render(<>
    <RSSPicture itemId="with-cover" link="https://example.test/a" coverImage="https://example.test/a.jpg" frame="thumb" />
    <RSSPicture itemId="late-page" link="https://example.test/b" coverImage={null} frame="feature" />
    <RSSPicture itemId="nothing" link="https://example.test/c" coverImage={null} frame="tile" fallback={<p className="words">words</p>} />
  </>)
  assert.deepEqual(h.sources('.rss-pic img'), ['https://example.test/a.jpg'])
  assert.equal(h.body.querySelector('.words')?.textContent, 'words', 'no placeholder picture: the fallback stands until a picture is known')
  await h.settle(60)
  assert.deepEqual(h.asked, [['late-page', 'nothing']])
  assert.deepEqual(h.sources('.rss-pic img'), ['https://example.test/a.jpg', 'https://pictures.test/late-page.jpg'])
  const late = h.get<HTMLImageElement>('.rss-pic--feature img')
  // A wide frame shows a panorama whole instead of cutting it; a narrow one never changes its fit.
  Object.defineProperties(late, { naturalWidth: { value: 1200 }, naturalHeight: { value: 400 } })
  await act(async () => { late.dispatchEvent(new h.dom.window.Event('load')) })
  assert.equal(h.get('.rss-pic--feature').getAttribute('data-fit'), 'whole')
  const first = h.get<HTMLImageElement>('.rss-pic--thumb img')
  Object.defineProperties(first, { naturalWidth: { value: 1200, configurable: true }, naturalHeight: { value: 400, configurable: true } })
  await act(async () => { first.dispatchEvent(new h.dom.window.Event('load')) })
  assert.equal(h.get('.rss-pic--thumb').hasAttribute('data-fit'), false)
  await act(async () => { late.dispatchEvent(new h.dom.window.Event('error')) })
  assert.equal(h.body.querySelector('.rss-pic--feature'), null, 'a picture that does not load leaves no broken frame')
  // A counting pixel or a tiny badge is not a picture of the item.
  Object.defineProperties(first, { naturalWidth: { value: 1, configurable: true }, naturalHeight: { value: 1, configurable: true } })
  await act(async () => { first.dispatchEvent(new h.dom.window.Event('load')) })
  assert.equal(h.body.querySelector('.rss-pic--thumb'), null)
})

test('订阅更新: 列表 gives a pick its picture large and the rest a small one; 图册 is a board of covers; the choice is remembered', async t => {
  const h = await mount(t)
  // The virtual list reads these from the global scope and measures rows; jsdom lays nothing out.
  const view = h.dom.window
  const globals = { HTMLElement: view.HTMLElement, Element: view.Element, SVGElement: view.SVGElement, Node: view.Node, navigator: view.navigator,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: view.getComputedStyle.bind(view), requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0), cancelAnimationFrame: (id: number) => clearTimeout(id) }
  const before = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  t.after(() => { for (const [key, descriptor] of Object.entries(before)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  Object.defineProperties(view.HTMLElement.prototype, {
    clientHeight: { get: () => 768 }, offsetHeight: { get: () => 120 }, offsetParent: { get() { return view.document.body } },
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
  const definitions = [{ id: 'curated', kind: 'curated', name: '精选' }] as RSSDefinition[]
  const base = { source: 'Publisher', author: '', sourceId: 's', publishedAt: '2026-10-02T03:00:00Z', publishedAtMs: Date.parse('2026-10-02T03:00:00Z'), read: false, starred: false }
  const items = [
    { ...base, id: 'pick', title: 'A pick', summary: 'A concrete release note.', link: 'https://example.test/pick', coverImage: 'https://example.test/pick.png',
      classifications: [{ definitionId: 'curated', name: '精选', kind: 'curated', included: true, origin: 'model', reason: 'Primary source.' }] },
    { ...base, id: 'plain', title: 'Plain report', summary: 'An ordinary report with a cover.', link: 'https://example.test/plain', coverImage: 'https://example.test/plain.png', read: true },
    { ...base, id: 'words', title: 'Only words', summary: 'This item has a summary long enough to stand as its cover.', link: 'https://example.test/words' },
    { ...base, id: 'link', title: 'Only a link', summary: 'Comments', link: 'https://www.linked.example/story' },
    { ...base, id: 'late-page', title: 'Its page has a picture', summary: 'Comments', link: 'https://late.example/story' },
  ]
  const props = {
    items, sources: [], filter: 'all' as const, selectedSource: null, selectedItemId: null, loading: false, refreshing: false, isMock: true, hasPreview: false,
    newItemIds: new Set<string>(), analysisProgressMap: {}, analysisJobs: [], settingsOpen: false, definitions, query: {},
    onFilterChange: noop, onSourceChange: noop, onItemClick: noop, onMarkItemRead: noop, onToggleStar: noop, onDeleteItem: noop, onOpenAnalysisOutput: noop, onRefresh: noop,
    onAddSource: noop, onDeleteSource: noop, onClearRead: noop, onOpenSettings: noop, onPauseAnalysisJob: noop, onResumeAnalysisJob: noop, onDeleteAnalysisJob: noop,
  }
  await h.render(createElement(RSSFeed, props as never))
  const row = (id: string) => h.get(`.rss-news-card[data-rss-item-id="${id}"]`)
  assert.ok(row('pick').querySelector(':scope > .rss-pic--feature img'))
  assert.ok(row('plain').querySelector('.rss-card-main > .rss-pic--thumb img'))
  assert.equal(row('words').querySelector('.rss-pic'), null, 'an item without a picture stays as words: no placeholder')
  assert.deepEqual([...h.body.querySelectorAll('.rss-layout-switch [role="radio"]')].map(radio => `${radio.getAttribute('aria-label')}:${radio.getAttribute('aria-checked')}`), ['列表:true', '图册:false'])
  // The items without a cover asked Main; the one whose page declares a picture gets it.
  await h.settle(60)
  assert.deepEqual(h.asked, [['words', 'link', 'late-page']])
  assert.deepEqual(h.sources('[data-rss-item-id="late-page"] .rss-pic--thumb img'), ['https://pictures.test/late-page.jpg'])

  await h.choose('图册')
  assert.equal(h.body.querySelector('.rss-news-card'), null)
  const tile = (id: string) => h.get(`.rss-tile[data-rss-item-id="${id}"]`)
  assert.equal(h.body.querySelectorAll('.rss-tile').length, 5)
  assert.equal(h.get('.rss-gallery__covers').style.getPropertyValue('--rss-gallery-columns'), '3')
  assert.equal(h.body.querySelectorAll('.rss-gallery__row').length, 2, 'five covers, three across')
  assert.ok(tile('pick').querySelector('.rss-pic--tile img'))
  assert.equal(tile('pick').querySelector('.rss-card-curated')?.textContent, '精选')
  assert.equal(tile('plain').classList.contains('is-read'), true)
  assert.equal(tile('plain').querySelector('.rss-tile__dot'), null, 'only an unread item wears the dot')
  assert.equal(tile('words').querySelector('.rss-pic--words:not(.is-site) p')?.textContent, 'This item has a summary long enough to stand as its cover.')
  assert.equal(tile('link').querySelector('.rss-pic--words.is-site p')?.textContent, 'linked.example')
  assert.deepEqual(h.sources('[data-rss-item-id="late-page"] .rss-pic--tile img'), ['https://pictures.test/late-page.jpg'])
  assert.equal(h.get('.rss-date-heading').textContent, '10月2日星期五')
  assert.deepEqual(JSON.parse(h.dom.window.localStorage.getItem(LAYOUTS) || '{}'), { feed: 'gallery', sieve: 'list', digest: 'list' }, 'each surface keeps its own choice')
  await h.choose('列表')
  assert.ok(row('pick'))
  assert.equal(JSON.parse(h.dom.window.localStorage.getItem(LAYOUTS) || '{}').feed, 'list')
})

const sieveItem = (id: string, coverImage: string | null, extra: Partial<RSSSieveItem> = {}): RSSSieveItem => ({
  id, revision: 'r1', sourceRevision: 's1', sourceId: 'src', source: '少数派', title: `标题 ${id}`, link: `https://example.com/${id}`, summary: '一段足够长的摘要，可以当作封面上的文字。',
  author: null, publishedAt: Date.now() - 3600000, collectedAt: Date.now() - 3600000, coverImage, read: false, starred: false, inboxVisible: true,
  bodyStatus: 'missing', classifications: [], sieve: { score: 80, eligible: true, pinned: false, reason: `理由 ${id}`, factors: [] }, relevance: null, ...extra,
} as RSSSieveItem)

test('为你筛过的: 列表 opens with the first card\'s picture and gives the others a small one; 图册 is covers with the words under them', async t => {
  const h = await mount(t, {
    sieveQuery: () => ok({ items: [sieveItem('a', 'https://example.com/a.jpg'), sieveItem('b', 'https://example.com/b.jpg'), sieveItem('c', null)], remaining: [], remainingCount: 0 }),
    getSources: () => ok([{ id: 'src' }]),
    processingStatus: () => ok({ settings: { enabled: true, dailyLimit: 100 }, callsToday: 0, pending: 0, running: 0, unresolved: 0, blocked: null }),
    sievePrivacy: () => ok({ answer: 'enabled', enabled: true, pages: true, calendar: true, books: true }),
    sieveWorkContext: () => ok({ text: '', entries: [] }), sieveCalibration: () => ok(null), onOrganizationChanged: () => () => {},
  })
  await h.render(<RSSSieveView shown onOpen={() => {}} />)
  await h.settle()
  const card = (id: string) => h.get(`[data-sieve-item="${id}"]`)
  assert.equal(h.get('.rss-sieve').getAttribute('data-layout'), 'list')
  assert.ok(card('a').querySelector(':scope > .rss-pic--sieve-hero img'), 'the first card opens the page with its picture')
  assert.equal(card('a').querySelector('.rss-pic--sieve-thumb'), null)
  assert.ok(card('b').querySelector('.rss-sieve__main > .rss-pic--sieve-thumb img'))
  assert.equal(card('c').querySelector('.rss-pic'), null)
  assert.equal(card('b').querySelector('.rss-sieve__words .rss-sieve__reason')?.textContent, '理由 b', 'the reason stays with the words')
  await h.choose('图册')
  assert.equal(h.get('.rss-sieve').getAttribute('data-layout'), 'gallery')
  assert.deepEqual(h.sources('.rss-pic--sieve-cover img'), ['https://example.com/a.jpg', 'https://example.com/b.jpg'])
  assert.equal(card('c').querySelector('.rss-pic--sieve-cover.rss-pic--words p')?.textContent, '一段足够长的摘要，可以当作封面上的文字。')
  assert.equal(h.body.querySelector('.rss-pic--sieve-hero, .rss-pic--sieve-thumb'), null)
  assert.equal(JSON.parse(h.dom.window.localStorage.getItem(LAYOUTS) || '{}').sieve, 'gallery')
})

test('日报: 列表 is a front page, 图册 a cover; every entry shows the picture the app read with it', async t => {
  const header = (id: string): RSSDigestHeader => ({
    id, kind: 'daily', editionKey: id, version: 1, from: Date.parse('2026-10-01T08:00:00Z'), until: Date.parse('2026-10-02T08:00:00Z'), timezone: 'UTC', createdAt: Date.parse('2026-10-02T08:00:00Z'),
    query: null, scopeLabel: '精选', ruleCount: 1, total: 5, referenceCount: 8, needsUpdate: false, lead: { title: 'Big story', source: 'Publisher' },
    coverage: { matchingArticles: 8, pendingArticles: 0, unresolvedArticles: 0, failedArticles: 0, missingBodies: 0, carriedOverArticles: 0, duplicateOrPublishedArticles: 0 },
  })
  const entry = (groupKey: string, section: string, referenceCount: number, title: string, coverImage: string | null): RSSDigestEntry => ({ section, groupKey, referenceCount, coverImage, source: {
    itemId: groupKey, articleRevision: 'r1', title, link: `https://example.test/${groupKey}`, sourceId: `source-${groupKey}`, source: `Source ${groupKey}`,
    quote: `${title} quote`, quoteKind: 'source_summary', quoteTruncated: false, sourceRole: 'unknown', bodyStatus: 'ready', factId: null, eventId: null, evidenceId: null,
    availableAt: 0, carriedOver: false, curation: null, topics: [],
  } })
  const entries = [
    entry('big', 'Dev', 4, 'Big story', 'https://example.test/big.jpg'), entry('mid', 'AI', 3, 'Mid story', 'https://example.test/mid.jpg'),
    entry('bare', 'AI', 2, 'Bare story', null), entry('small', 'Design', 2, 'Small story', 'https://example.test/small.jpg'), entry('last', 'Design', 1, 'Last story', null),
  ]
  const h = await mount(t, {
    readDigests: async (input: { view?: string }) => input.view === 'entries'
      ? ok({ view: 'entries', report: header('daily-oct-2'), entries, total: 5, nextOffset: null })
      : ok({ view: 'editions', editions: [header('daily-oct-2')], total: 1, nextOffset: null, snapshot: 1 }),
    digestSettings: () => ok({ enabled: true, localTime: '08:00', timezone: 'UTC', nextRunAt: null, error: null }),
    onDigestsChanged: () => () => {}, onOrganizationChanged: () => () => {},
  })
  const lead = h.dom.window.document.createElement('div'), tools = h.dom.window.document.createElement('div')
  h.body.append(lead, tools)
  await h.render(<RSSTopbarContext.Provider value={{ lead, tools }}><RSSDigestPanel active view={null} /></RSSTopbarContext.Provider>)
  await h.settle()
  assert.ok(tools.querySelector('.rss-layout-switch'), 'the switch sits in the panel\'s head')
  assert.equal(h.get('.rss-paper-grid').getAttribute('data-layout'), 'list')
  // 列表: the lead's picture across the column, the next three as a strip, a picture beside each entry.
  assert.deepEqual(h.sources('.rss-paper-lead > .rss-pic--hero img'), ['https://example.test/big.jpg'])
  assert.deepEqual([...h.body.querySelectorAll('.rss-paper-strip strong')].map(node => node.textContent), ['Mid story', 'Bare story', 'Small story'])
  assert.deepEqual(h.sources('.rss-paper-strip span.rss-pic--strip img'), ['https://example.test/mid.jpg', 'https://example.test/small.jpg'])
  assert.equal(h.get('.rss-paper-strip span.rss-pic--strip.rss-pic--words').textContent, 'Bare story quote', 'a pick without a picture shows its own words')
  assert.equal(h.body.querySelector('.rss-paper-strip button figure'), null, 'only phrasing content inside a button')
  assert.deepEqual([...h.body.querySelectorAll('.rss-paper-contents strong')].map(node => node.textContent), ['AI', 'Design'])
  assert.deepEqual(h.sources('.rss-paper-entry > .rss-pic--side img'), ['https://example.test/mid.jpg', 'https://example.test/small.jpg'])
  assert.equal(h.body.querySelectorAll('.rss-paper-entry').length, 4)
  assert.equal(h.body.querySelector('.rss-paper-guide, .rss-paper-highlights, .rss-paper-index'), null)
  await h.settle(60)
  assert.deepEqual(h.asked, [['bare', 'last']], 'only the entries that came without a picture ask for one')

  await h.choose('图册', tools)
  assert.equal(h.get('.rss-paper-grid').getAttribute('data-layout'), 'gallery')
  assert.deepEqual(h.sources('.rss-paper-lead--cover > .rss-pic--cover img'), ['https://example.test/big.jpg'])
  assert.equal(h.get('.rss-paper-lead--cover > :first-child').classList.contains('rss-pic--cover'), true, 'the picture comes before the headline')
  assert.deepEqual([...h.body.querySelectorAll('.rss-paper-mosaic__words strong')].map(node => node.textContent), ['Mid story', 'Bare story', 'Small story'])
  assert.equal(h.body.querySelectorAll('.rss-paper-mosaic .rss-pic--mosaic').length, 3)
  assert.equal(h.body.querySelectorAll('.rss-paper-mosaic .rss-pic--blank').length, 1)
  assert.equal(h.body.querySelectorAll('.rss-paper-card').length, 4)
  assert.deepEqual(h.sources('.rss-paper-card > .rss-pic--card img'), ['https://example.test/mid.jpg', 'https://example.test/small.jpg'])
  assert.equal(h.body.querySelector('.rss-paper-entry, .rss-paper-strip, .rss-pic--hero'), null)
  assert.equal(JSON.parse(h.dom.window.localStorage.getItem(LAYOUTS) || '{}').digest, 'gallery')
})

test('a surface that was never switched is 列表; a stored value that is not a layout is ignored', async t => {
  const h = await mount(t)
  h.dom.window.localStorage.setItem(LAYOUTS, JSON.stringify({ feed: 'gallery', sieve: 'mosaic', digest: 7 }))
  const fresh = await import(`../renderer/stores/useRSSLayout?fresh=${Date.now()}`) as typeof import('../renderer/stores/useRSSLayout')
  assert.deepEqual(fresh.useRSSLayout.getState().layouts, { feed: 'gallery', sieve: 'list', digest: 'list' })
  fresh.useRSSLayout.getState().setLayout('digest', 'gallery')
  assert.deepEqual(JSON.parse(h.dom.window.localStorage.getItem(LAYOUTS) || '{}'), { feed: 'gallery', sieve: 'list', digest: 'gallery' })
})
