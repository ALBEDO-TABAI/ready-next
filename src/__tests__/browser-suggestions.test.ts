import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserSuggestionService } from '../main/modules/browser-engine/suggestion-service'
import { SEARCH_ENGINE_KEY, SEARCH_SUGGESTIONS_KEY } from '../shared/search-engines'
import type { BrowserSuggestions } from '../shared/browser-shell'

const now = 1_800_000_000
function fixture(fetcher: typeof fetch = async () => { assert.fail('network must be disabled') }) {
  const settings = new Map<string, string>()
  const tabs: BrowserSuggestions['tabs'] = [{ tabId: 'tab-1', browserTaskId: 'task-1', url: 'https://example.test/a#tab', title: 'Example tab', favicon: 'icon' }]
  const bookmarks = [{ url: 'https://www.example.test/a', title: 'Example saved duplicate', favicon: null }, { url: 'https://example.test/book', title: 'BOOK', favicon: null }]
  const history = [
    { url: 'https://example.test/a', title: 'duplicate tab', visited_at: now, visit_count: 1 },
    { url: 'https://example.test/book#hash', title: 'duplicate bookmark', visited_at: now, visit_count: 1 },
    ...Array.from({ length: 7 }, (_, index) => ({ url: 'https://example.test/frequent', title: 'Frequent', visited_at: now - 86400, visit_count: index + 1 })),
    { url: 'https://example.test/recent', title: 'Recent', visited_at: now, visit_count: 1 },
    { url: 'https://other.test/example', title: 'Contains', visited_at: now, visit_count: 1 },
    { url: 'https://example.test/old', title: 'Old', visited_at: now - 86400 * 90, visit_count: 2 },
  ]
  const service = new BrowserSuggestionService({ data: { getSetting: key => settings.get(key), getBookmarks: () => bookmarks, getHistory: () => history }, tabs: () => tabs, fetch: fetcher, now: () => now * 1000 })
  return { settings, service }
}

test('local suggestions match case-insensitively, rank domains/frequency/recency and deduplicate across groups', async () => {
  const { service } = fixture()
  const result = await service.suggest({ query: 'EXAMPLE' })
  assert.equal(result.tabs[0].tabId, 'tab-1')
  assert.equal(result.tabs[0].browserTaskId, 'task-1')
  assert.equal(result.tabs[0].favicon, 'icon')
  assert.deepEqual(result.bookmarks.map(row => row.title), ['BOOK'])
  assert.deepEqual(result.history.map(row => row.title), ['Frequent', 'Recent', 'Old', 'Contains'])
  assert.equal(result.history[0].visitCount, 7)
  assert.equal(result.history[2].visitCount, 2, 'uses the persisted visit count even when earlier rows have been pruned')
  assert.deepEqual(result.search, [])
  const empty = await service.suggest({ query: '', limit: 2 })
  assert.deepEqual(empty.tabs, [])
  assert.deepEqual(empty.bookmarks, [])
  assert.equal(empty.history.length, 2)
  assert.equal(empty.history[0].lastVisitedAt, now)
  assert.deepEqual((await service.suggest({ query: 'bOoK' })).bookmarks.map(row => row.title), ['BOOK'])
  await assert.rejects(service.suggest({ query: 'x', limit: 100 }))
})

test('remote suggestions are opt-in, selected-engine-only, credential-free and cannot redirect input elsewhere', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const { settings, service } = fixture(async (url, init) => {
    calls.push({ url: String(url), init })
    return Response.json(['a', ['one', 'two', 'one', 3]])
  })
  await service.suggest({ query: 'a' })
  assert.equal(calls.length, 0)
  settings.set(SEARCH_SUGGESTIONS_KEY, 'true')
  settings.set(SEARCH_ENGINE_KEY, 'bing')
  assert.deepEqual((await service.suggest({ query: 'a & b', limit: 2 })).search, ['one', 'two'])
  assert.equal(calls[0].url, 'https://api.bing.com/osjson.aspx?query=a%20%26%20b')
  assert.equal(calls[0].init?.credentials, 'omit')
  assert.equal(calls[0].init?.redirect, 'error')
  settings.set(SEARCH_ENGINE_KEY, 'https://custom.test/?q=%s')
  await service.suggest({ query: 'private' })
  await service.suggest({ query: '' })
  assert.equal(calls.length, 1)
})

test('new request invalidates old fetch even when the provider ignores abort', async () => {
  let finish!: (response: Response) => void
  const { settings, service } = fixture(async () => new Promise<Response>(resolve => { finish = resolve }))
  settings.set(SEARCH_SUGGESTIONS_KEY, 'true')
  const first = service.suggest({ query: 'old' })
  settings.set(SEARCH_SUGGESTIONS_KEY, 'false')
  await service.suggest({ query: 'new' })
  assert.deepEqual((await first).search, [])
  finish(Response.json(['old', ['stale']]))
})

test('800ms timeout bounds a nonresponsive provider; malformed responses and fetch failures are empty', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { settings, service } = fixture(async () => new Promise<Response>(() => {}))
  settings.set(SEARCH_SUGGESTIONS_KEY, 'true')
  const request = service.suggest({ query: 'timeout' })
  t.mock.timers.tick(800)
  assert.deepEqual((await request).search, [])
  for (const fetcher of [async () => { throw new Error('offline') }, async () => Response.json({ suggestions: 'bad' }), async () => new Response('', { status: 503 })]) {
    const failed = fixture(fetcher)
    failed.settings.set(SEARCH_SUGGESTIONS_KEY, 'true')
    assert.deepEqual((await failed.service.suggest({ query: 'x' })).search, [])
  }
})
