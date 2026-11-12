import assert from 'node:assert/strict'
import test from 'node:test'
import { NavigationController } from '../renderer/modules/workbench/navigation-controller'
import { emptyNavigation, recentNavigation, type NavigationEntry } from '../shared/navigation-history'
import { recentOpenedResults } from '../renderer/modules/workbench/object-ui/recent-opened'

const entry = (id: string, mode: NavigationEntry['mode'] = 'document'): NavigationEntry => ({ mode, ref: mode === 'browser' ? { kind: 'web', url: `https://example.test/${id}` } : mode === 'calendar' ? { kind: 'event', id } : mode === 'rss' ? { kind: 'rss-item', id } : { kind: 'page', id }, title: id, openedAt: 1, anchor: [] })
function setup() {
  let saved = emptyNavigation(), writes = 0
  const controller = new NavigationController(() => ({ read: async () => saved, save: async state => { writes++; return saved = structuredClone({ ...state, revision: state.revision + 1 }) } }))
  return { controller, writes: () => writes }
}
test('only successful opens record history, idle reads/scroll/input do not, replay keeps four entries', async () => {
  const { controller: c, writes } = setup()
  await c.load(); c.getSnapshot(); assert.equal(writes(), 0)
  await assert.rejects(c.open(entry('failed'), async () => { throw new Error('unavailable') }), /unavailable/)
  assert.equal(writes(), 0)
  const states = [entry('origin'), entry('article', 'rss'), entry('event', 'calendar'), entry('web', 'browser')]
  for (const state of states) await c.open(state, async () => {})
  const seen: string[] = []
  for (let i = 0; i < 3; i++) await c.step(-1, async entry => { seen.push(entry.title) })
  assert.deepEqual(seen, ['event', 'article', 'origin']); assert.equal(c.getSnapshot().entries.length, 4)
  for (let i = 0; i < 3; i++) await c.step(1, async () => {})
  assert.equal(c.getSnapshot().cursor, 3)
  await assert.rejects(c.step(-1, async () => { throw new Error('deleted') }), /deleted/)
  assert.equal(c.getSnapshot().cursor, 3)
})
test('tab history consumes its matching entry before continuing global history', async () => {
  const { controller: c } = setup()
  for (const value of [entry('rss', 'rss'), entry('a'), entry('b')]) await c.open(value, async () => {})
  const seen: string[] = []
  await c.step(-1, async entry => { seen.push(entry.title) }, undefined, () => ({ matches: async entry => entry.title === 'a', perform: () => { seen.push('a') } }))
  await c.step(-1, async entry => { seen.push(entry.title) })
  assert.deepEqual(seen, ['a', 'rss'])
  assert.equal(c.getSnapshot().cursor, 0)
})
test('rapid opens serialize, stale origin cannot erase an open, branching drops future and caps at 50', async () => {
  const { controller: c } = setup()
  await c.open(entry('origin'), async () => {})
  await Promise.all(['a', 'b', 'c'].map(id => c.open(entry(id), async () => {}, entry('origin'))))
  assert.deepEqual(c.getSnapshot().entries.map(e => e.title), ['origin', 'a', 'b', 'c'])
  await c.step(-1, async () => {}); await c.open(entry('branch'), async () => {})
  assert.deepEqual(c.getSnapshot().entries.map(e => e.title), ['origin', 'a', 'b', 'branch'])
  for (let i = 0; i < 55; i++) await c.open(entry(String(i)), async () => {})
  assert.equal(c.getSnapshot().entries.length, 50); assert.equal(c.getSnapshot().entries[0].title, '5')
})
test('a jump from a place no open recorded (a new tab, a draft) records that place first, so back returns there', async () => {
  const { controller: c } = setup()
  await c.open(entry('book-a'), async () => {})
  const draft: NavigationEntry = { ...entry('draft'), ref: { kind: 'draft', id: 'draft' } }
  await c.open(entry('book-b'), async () => {}, draft)
  assert.deepEqual(c.getSnapshot().entries.map(e => e.title), ['book-a', 'draft', 'book-b'])
  const seen: string[] = []
  await c.step(-1, async target => { seen.push(target.title) })
  assert.deepEqual(seen, ['draft'])
  // The same place as the entry it replaces only refreshes that entry.
  await c.open(entry('book-c'), async () => {}, { ...draft, anchor: [{ selector: ':scope', top: 40, left: 0 }] })
  assert.deepEqual(c.getSnapshot().entries.map(e => e.title), ['book-a', 'draft', 'book-c'])
  assert.deepEqual(c.getSnapshot().entries[1].anchor, [{ selector: ':scope', top: 40, left: 0 }])
})

test('recent objects deduplicate across anchors and modes, most recently opened first', async () => {
  const { controller: c } = setup()
  for (const item of [entry('a'), entry('b', 'rss'), entry('c', 'calendar'), entry('d', 'browser'), { ...entry('a'), ref: { kind: 'page' as const, id: 'a', anchor: 'section' } }]) await c.open(item, async () => {})
  assert.deepEqual(recentNavigation(c.getSnapshot()).map(e => e.title), ['a', 'd', 'c', 'b'])
  assert.deepEqual(recentOpenedResults(c.getSnapshot()).map(e => e.typeLabel), ['页面', '书签', '日程', '资讯'])
})

test('scroll restoration waits for the requested article rather than scrolling the previous article', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<div data-workbench-mode-panel="rss"><section data-rss-article-id="old" data-navigation-loaded="true"></section></div>', { pretendToBeVisual: true })
  const { captureNavigationScroll, restoreNavigationScroll } = await import('../renderer/modules/workbench/navigation-scroll')
  const before = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ document: dom.window.document, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window) })) {
    before.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true })
  }
  try {
    const article = dom.window.document.querySelector('section')!
    article.scrollTop = 420
    const anchor = captureNavigationScroll('rss'); article.scrollTop = 0
    const restoring = restoreNavigationScroll({ ...entry('target', 'rss'), anchor })
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(article.scrollTop, 0)
    article.dataset.rssArticleId = 'target'; article.dataset.navigationLoaded = 'false'
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(article.scrollTop, 0)
    article.dataset.navigationLoaded = 'true'; await restoring; assert.equal(article.scrollTop, 420)
  } finally {
    for (const [key, descriptor] of before) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
})
